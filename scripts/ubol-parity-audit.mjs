import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultOwnershipMapPath = path.join(scriptDir, 'ubol-source-ownership.json');

const BUILTIN_EXCLUDED_UPSTREAM_RULESETS = new Set([
  'ubol-tests',
  'ublock-experimental',
]);

const RULESET_HASH_ROOTS = [
  'rulesets/main',
  'rulesets/regex',
  'rulesets/strictblock',
  'rulesets/urlskip',
  'rulesets/scripting/generic',
  'rulesets/scripting/specific',
  'rulesets/scripting/popup',
  'rulesets/scripting/scriptlet',
];

const RULESET_DETAILS_HASH_PATHS = new Set([
  'rulesets/generic-details.json',
  'rulesets/scriptlet-details.json',
  'rulesets/ruleset-details.json',
]);

const LOCAL_ONLY_RULESET_PATHS = new Set([
  'rulesets/ruleset-license-policy.json',
]);

const DETAILS_COUNT_PATHS = [
  'filters.accepted',
  'rules.total',
  'rules.plain',
  'rules.regex',
  'rules.strictblock',
  'rules.urlskip',
  'rules.rejected',
  'css.generic',
  'css.generichigh',
  'css.specific',
  'css.procedural',
  'scriptlets',
  'popups',
];

const normalizeRelativePath = value =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();

const sortStrings = values => Array.from(new Set(values.filter(Boolean))).sort();

const pathExists = async absPath => {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
};

const readJson = async absPath => JSON.parse(await fs.readFile(absPath, 'utf8'));

const readJsonOr = async (absPath, fallback) => {
  try {
    return await readJson(absPath);
  } catch {
    return fallback;
  }
};

const fileHash = async absPath => {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(absPath));
  return hash.digest('hex');
};

const contentHash = value => {
  const hash = crypto.createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
};

const walkFiles = async (rootDir, relativeDir = '', out = []) => {
  const absDir = path.join(rootDir, relativeDir);
  let entries = [];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(
      relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    );
    if (entry.isDirectory()) {
      await walkFiles(rootDir, relativePath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(relativePath);
    }
  }
  return out;
};

const globToRegExp = pattern => {
  const normalized = normalizeRelativePath(pattern);
  let out = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === '*' && next === '*') {
      out += '.*';
      i += 1;
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out);
};

const matchesAnyPattern = (relativePath, patterns = []) => {
  const normalized = normalizeRelativePath(relativePath);
  return patterns.some(pattern => globToRegExp(pattern).test(normalized));
};

const getNested = (source, dottedPath) => {
  let current = source;
  for (const part of dottedPath.split('.')) {
    if (current instanceof Object === false) { return undefined; }
    current = current[part];
  }
  return current;
};

const compareArrays = (localValues, upstreamValues) => {
  const localSet = new Set(localValues);
  const upstreamSet = new Set(upstreamValues);
  return {
    added: upstreamValues.filter(value => localSet.has(value) === false),
    removed: localValues.filter(value => upstreamSet.has(value) === false),
  };
};

const normalizeExceptionMap = value => {
  if (isObject(value) === false) { return new Map(); }
  return new Map(Object.keys(value).map(key => [normalizeRelativePath(key), value[key]]));
};

const normalizePermissionExceptionMap = value => {
  if (isObject(value) === false) { return new Map(); }
  return new Map(Object.keys(value).map(key => [String(key || '').trim(), value[key]]));
};

const applyDiffExceptions = (diff, { added = new Map(), removed = new Map() } = {}) => {
  const ignoredAdded = [];
  const ignoredRemoved = [];
  const filteredAdded = [];
  const filteredRemoved = [];
  for (const value of diff.added || []) {
    if (added.has(value)) {
      ignoredAdded.push(value);
    } else {
      filteredAdded.push(value);
    }
  }
  for (const value of diff.removed || []) {
    if (removed.has(value)) {
      ignoredRemoved.push(value);
    } else {
      filteredRemoved.push(value);
    }
  }
  return {
    added: filteredAdded,
    removed: filteredRemoved,
    ignoredAdded,
    ignoredRemoved,
  };
};

const flattenWebAccessibleResources = manifest => {
  const out = [];
  for (const entry of manifest?.web_accessible_resources || []) {
    for (const resource of entry?.resources || []) {
      out.push(normalizeRelativePath(resource));
    }
  }
  return sortStrings(out);
};

const getRuleResources = manifest => {
  const entries = Array.isArray(manifest?.declarative_net_request?.rule_resources)
    ? manifest.declarative_net_request.rule_resources
    : [];
  return entries
    .filter(entry => typeof entry?.id === 'string' && entry.id.trim() !== '')
    .map(entry => ({
      id: entry.id.trim(),
      enabled: entry.enabled === true,
      path: normalizeRelativePath(entry.path),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
};

const detailsById = details => {
  const out = new Map();
  if (Array.isArray(details) === false) { return out; }
  for (const entry of details) {
    if (typeof entry?.id !== 'string' || entry.id.trim() === '') { continue; }
    out.set(entry.id.trim(), entry);
  }
  return out;
};

const rulesetIdFromAssetPath = relativePath => {
  const normalized = normalizeRelativePath(relativePath);
  const patterns = [
    /^rulesets\/(?:main|regex|strictblock|urlskip)\/([^/]+)\.json$/,
    /^rulesets\/scripting\/(?:generic|popup)\/([^/]+)\.js$/,
    /^rulesets\/scripting\/specific\/([^/]+)\.(?:js|json)$/,
    /^rulesets\/scripting\/scriptlet\/(?:main|isolated)\/([^/]+)\.js$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match) { return match[1]; }
  }
  return '';
};

const isExcludedRulesetAssetPath = (relativePath, excludedRuleIds = new Set()) => {
  const rulesetId = rulesetIdFromAssetPath(relativePath);
  return rulesetId !== '' && excludedRuleIds.has(rulesetId);
};

const normalizedDetailsForHash = (relativePath, details, excludedRuleIds = new Set()) => {
  if (Array.isArray(details) === false) { return details; }
  if (relativePath === 'rulesets/ruleset-details.json') {
    return details.filter(entry => excludedRuleIds.has(entry?.id) === false);
  }
  if (RULESET_DETAILS_HASH_PATHS.has(relativePath)) {
    return details.filter(entry => excludedRuleIds.has(entry?.[0]) === false);
  }
  return details;
};

const hashPath = async (rootDir, relativePath, { excludedRuleIds = new Set() } = {}) => {
  const absPath = path.join(rootDir, relativePath);
  if (RULESET_DETAILS_HASH_PATHS.has(relativePath)) {
    const normalized = normalizedDetailsForHash(
      relativePath,
      await readJson(absPath),
      excludedRuleIds
    );
    return contentHash(JSON.stringify(normalized));
  }
  return fileHash(absPath);
};

const collectHashMap = async (rootDir, relativePaths, options = {}) => {
  const out = {};
  for (const relativePath of sortStrings(relativePaths.map(normalizeRelativePath))) {
    const absPath = path.join(rootDir, relativePath);
    if (await pathExists(absPath) === false) { continue; }
    out[relativePath] = await hashPath(rootDir, relativePath, options);
  }
  return out;
};

const collectRulesetHashPaths = async rootDir => {
  const out = [];
  for (const relativeRoot of RULESET_HASH_ROOTS) {
    await walkFiles(rootDir, relativeRoot, out);
  }
  for (const relativePath of [
    'rulesets/generic-details.json',
    'rulesets/scriptlet-details.json',
    'rulesets/ruleset-details.json',
  ]) {
    if (await pathExists(path.join(rootDir, relativePath))) {
      out.push(relativePath);
    }
  }
  return sortStrings(out);
};

const collectOwnedHashPaths = async (rootDir, ownershipMap) => {
  const files = await walkFiles(rootDir);
  return sortStrings(
    files.filter(relativePath =>
      LOCAL_ONLY_RULESET_PATHS.has(relativePath) === false &&
      matchesAnyPattern(relativePath, ownershipMap.upstreamOwnedPaths || [])
    )
  );
};

const compareHashMaps = (localHashes, upstreamHashes) => {
  const localPaths = sortStrings(Object.keys(localHashes));
  const upstreamPaths = sortStrings(Object.keys(upstreamHashes));
  const localSet = new Set(localPaths);
  const upstreamSet = new Set(upstreamPaths);
  const changed = [];
  for (const relativePath of upstreamPaths) {
    if (localSet.has(relativePath) === false) { continue; }
    if (localHashes[relativePath] === upstreamHashes[relativePath]) { continue; }
    changed.push(relativePath);
  }
  return {
    added: upstreamPaths.filter(relativePath => localSet.has(relativePath) === false),
    removed: localPaths.filter(relativePath => upstreamSet.has(relativePath) === false),
    changed,
  };
};

const filterExcludedRulesetHashPaths = (relativePaths, excludedRuleIds = new Set()) =>
  sortStrings(
    relativePaths
      .map(normalizeRelativePath)
      .filter(relativePath => isExcludedRulesetAssetPath(relativePath, excludedRuleIds) === false)
  );

const hashDeltaPaths = hashDeltas =>
  sortStrings([
    ...hashDeltas.added,
    ...hashDeltas.removed,
    ...hashDeltas.changed,
  ]);

const hasRulesetHashDrift = hashDeltas =>
  hashDeltaPaths(hashDeltas).some(relativePath => relativePath.startsWith('rulesets/'));

const hasRuntimeHashDrift = hashDeltas =>
  hashDeltaPaths(hashDeltas).some(relativePath => relativePath.startsWith('rulesets/') === false);

const totalFileBytes = async (rootDir, relativePaths) => {
  let total = 0;
  for (const relativePath of relativePaths) {
    try {
      const stat = await fs.stat(path.join(rootDir, relativePath));
      if (stat.isFile()) {
        total += stat.size;
      }
    } catch {
    }
  }
  return total;
};

const collectScriptingLayout = async rootDir => {
  const files = await walkFiles(rootDir, 'rulesets/scripting');
  const layout = new Set();
  for (const relativePath of files) {
    const pathParts = normalizeRelativePath(relativePath)
      .replace(/^rulesets\/scripting\//, '')
      .split('/')
      .filter(Boolean);
    if (pathParts.length === 0) { continue; }
    const fileName = pathParts.at(-1);
    const dirParts = pathParts.slice(0, -1);
    for (let depth = 1; depth <= dirParts.length; depth += 1) {
      layout.add(dirParts.slice(0, depth).join('/'));
    }
    const ext = path.posix.extname(fileName) || '.[no-ext]';
    layout.add([...dirParts, `*${ext}`].filter(Boolean).join('/'));
  }
  return sortStrings([...layout]);
};

const collectRuntimeSchema = async rootDir => {
  const files = await walkFiles(rootDir, 'js');
  return {
    hasOffscreen: await pathExists(path.join(rootDir, 'js/offscreen')),
    usesUserScripts: await textExistsInFiles(rootDir, files, 'userScripts'),
    usesOffscreen: await textExistsInFiles(rootDir, files, 'offscreen'),
    hasPreventPopupRuntime:
      await pathExists(path.join(rootDir, 'js/scripting/prevent-popup.js')) ||
      await pathExists(path.join(rootDir, 'js/prevent-popup.js')),
  };
};

const textExistsInFiles = async (rootDir, relativePaths, needle) => {
  for (const relativePath of relativePaths) {
    if (relativePath.endsWith('.js') === false) { continue; }
    try {
      const text = await fs.readFile(path.join(rootDir, relativePath), 'utf8');
      if (text.includes(needle)) { return true; }
    } catch {
    }
  }
  return false;
};

const readInventory = async rootDir => {
  const manifest = await readJson(path.join(rootDir, 'manifest.json'));
  const ruleResources = getRuleResources(manifest);
  const details = await readJsonOr(path.join(rootDir, 'rulesets/ruleset-details.json'), []);
  const licensePolicy = await readJsonOr(
    path.join(rootDir, 'rulesets/ruleset-license-policy.json'),
    { rulesets: {} }
  );
  const rulesetHashPaths = await collectRulesetHashPaths(rootDir);
  const rulesetHashes = await collectHashMap(rootDir, rulesetHashPaths);
  const scriptingLayout = await collectScriptingLayout(rootDir);
  const runtimeSchema = await collectRuntimeSchema(rootDir);
  return {
    rootDir,
    manifest,
    manifestSummary: {
      permissions: sortStrings(manifest.permissions || []),
      hostPermissions: sortStrings(manifest.host_permissions || []),
      minimumChromeVersion: manifest.minimum_chrome_version || '',
      webAccessibleResources: flattenWebAccessibleResources(manifest),
    },
    ruleResources,
    details,
    detailsById: detailsById(details),
    licensePolicy,
    rulesetHashPaths,
    rulesetHashes,
    scriptingLayout,
    runtimeSchema,
    rulesetBytes: await totalFileBytes(rootDir, rulesetHashPaths),
    scriptingAssetCount: rulesetHashPaths.filter(pathName =>
      pathName.startsWith('rulesets/scripting/')
    ).length,
  };
};

const hasText = value => typeof value === 'string' && value.trim() !== '';

const isObject = value =>
  value !== null &&
  typeof value === 'object' &&
  Array.isArray(value) === false;

const getCommercialUse = entry => hasText(entry?.commercialUse)
  ? entry.commercialUse.trim().toLowerCase()
  : '';

const hasLicenseProof = (licensePolicy, id, entry) => {
  const allowlistedUnknown = isObject(licensePolicy?.allowlistedUnknown)
    ? licensePolicy.allowlistedUnknown
    : {};
  return hasText(allowlistedUnknown[id]) || hasText(entry?.proof);
};

const isApprovedLicenseEntry = (licensePolicy, id, entry) => {
  if (isObject(entry) === false) { return false; }
  const commercialUse = getCommercialUse(entry);
  if (commercialUse === 'allowed') { return true; }
  if (commercialUse === 'unknown') {
    return hasLicenseProof(licensePolicy, id, entry);
  }
  return false;
};

const getApprovedRuleIds = licensePolicy =>
  new Set(Object.entries(licensePolicy?.rulesets || {})
    .filter(([id, entry]) => isApprovedLicenseEntry(licensePolicy, id, entry))
    .map(([id]) => id));

const getExcludedUpstreamRuleIds = licensePolicy =>
  new Set([
    ...BUILTIN_EXCLUDED_UPSTREAM_RULESETS,
    ...Object.keys(licensePolicy?.excludedUpstreamRulesets || {}),
  ]);

const rulesetIdsFromResources = (
  resources,
  {
    includeExcluded = false,
    excludedRuleIds = BUILTIN_EXCLUDED_UPSTREAM_RULESETS,
  } = {}
) =>
  sortStrings(
    resources
      .map(entry => entry.id)
      .filter(id => includeExcluded || excludedRuleIds.has(id) === false)
  );

const compareRulesetCounts = (localInventory, upstreamInventory, upstreamRuleIds) => {
  const localDetails = localInventory.detailsById;
  const upstreamDetails = upstreamInventory.detailsById;
  const deltas = [];
  for (const id of upstreamRuleIds) {
    const local = localDetails.get(id);
    const upstream = upstreamDetails.get(id);
    if (upstream === undefined) { continue; }
    for (const countPath of DETAILS_COUNT_PATHS) {
      const localValue = Number(getNested(local, countPath) || 0);
      const upstreamValue = Number(getNested(upstream, countPath) || 0);
      if (localValue === upstreamValue) { continue; }
      deltas.push({
        id,
        path: countPath,
        local: localValue,
        upstream: upstreamValue,
        delta: upstreamValue - localValue,
      });
    }
  }
  return deltas;
};

const classifyDrift = ({
  manifestDiffs,
  rulesetIdDiff,
  rulesetCountDeltas,
  hashDeltas,
  scriptingLayoutDiff,
  runtimeSchemaDiffs,
  licenseBlockedRuleIds,
}) => {
  const classes = new Set();
  if (rulesetIdDiff.added.length || rulesetIdDiff.removed.length || rulesetCountDeltas.length) {
    classes.add('rules-data-only');
  }
  if (hasRulesetHashDrift(hashDeltas)) {
    classes.add('rules-data-only');
  }
  if (hasRuntimeHashDrift(hashDeltas)) {
    classes.add('runtime-code');
  }
  if (scriptingLayoutDiff.added.length || scriptingLayoutDiff.removed.length) {
    classes.add('compiled-layout');
  }
  if (runtimeSchemaDiffs.length) {
    classes.add('runtime-code');
  }
  if (manifestDiffs.permissions.added.length || manifestDiffs.permissions.removed.length) {
    classes.add('manifest-permission');
  }
  if (manifestDiffs.minimumChromeVersion.local !== manifestDiffs.minimumChromeVersion.upstream) {
    classes.add('browser-support');
  }
  if (
    manifestDiffs.resources.added.length ||
    manifestDiffs.resources.removed.length ||
    manifestDiffs.hostPermissions.added.length ||
    manifestDiffs.hostPermissions.removed.length
  ) {
    classes.add('store-packaging');
  }
  if (licenseBlockedRuleIds.length) {
    classes.add('license-blocked');
  }
  if (classes.size === 0) {
    return [];
  }
  return Array.from(classes).sort();
};

const compareRuntimeSchema = (localSchema, upstreamSchema) => {
  const out = [];
  for (const key of Object.keys(upstreamSchema)) {
    if (localSchema[key] === upstreamSchema[key]) { continue; }
    out.push({ key, local: localSchema[key], upstream: upstreamSchema[key] });
  }
  return out;
};

const findOwnershipViolations = (changedPaths, ownershipMap) =>
  sortStrings(
    changedPaths.filter(relativePath =>
      matchesAnyPattern(relativePath, ownershipMap.talonOwnedPaths || [])
    )
  );

export async function buildParityReport({
  extensionDir = process.cwd(),
  upstreamDir,
  ownershipMapPath = defaultOwnershipMapPath,
} = {}) {
  if (typeof upstreamDir !== 'string' || upstreamDir.trim() === '') {
    throw new Error('Missing required upstreamDir');
  }

  const resolvedExtensionDir = path.resolve(extensionDir);
  const resolvedUpstreamDir = path.resolve(upstreamDir);
  const ownershipMap = await readJson(ownershipMapPath);
  const [localInventory, upstreamInventory] = await Promise.all([
    readInventory(resolvedExtensionDir),
    readInventory(resolvedUpstreamDir),
  ]);

  const excludedRuleIds = getExcludedUpstreamRuleIds(localInventory.licensePolicy);
  const upstreamOwnedPaths = filterExcludedRulesetHashPaths(
    sortStrings([
      ...await collectOwnedHashPaths(resolvedExtensionDir, ownershipMap),
      ...await collectOwnedHashPaths(resolvedUpstreamDir, ownershipMap),
    ]),
    excludedRuleIds
  );
  const [localOwnedHashes, upstreamOwnedHashes] = await Promise.all([
    collectHashMap(resolvedExtensionDir, upstreamOwnedPaths, { excludedRuleIds }),
    collectHashMap(resolvedUpstreamDir, upstreamOwnedPaths, { excludedRuleIds }),
  ]);
  const hashDeltas = compareHashMaps(localOwnedHashes, upstreamOwnedHashes);
  const localRulesetHashPaths = filterExcludedRulesetHashPaths(
    localInventory.rulesetHashPaths,
    excludedRuleIds
  );
  const upstreamRulesetHashPaths = filterExcludedRulesetHashPaths(
    upstreamInventory.rulesetHashPaths,
    excludedRuleIds
  );
  const [localRulesetBytes, upstreamRulesetBytes] = await Promise.all([
    totalFileBytes(resolvedExtensionDir, localRulesetHashPaths),
    totalFileBytes(resolvedUpstreamDir, upstreamRulesetHashPaths),
  ]);
  const localRuleIds = rulesetIdsFromResources(localInventory.ruleResources);
  const upstreamRuleIds = rulesetIdsFromResources(upstreamInventory.ruleResources, {
    excludedRuleIds,
  });
  const upstreamSkippedRuleIds = sortStrings(
    rulesetIdsFromResources(upstreamInventory.ruleResources, { includeExcluded: true })
      .filter(id => excludedRuleIds.has(id))
  );
  const rulesetIdDiff = compareArrays(localRuleIds, upstreamRuleIds);
  const rulesetCountDeltas = compareRulesetCounts(
    localInventory,
    upstreamInventory,
    upstreamRuleIds
  );
  const permissionExceptionConfig = ownershipMap.manifestPermissionExceptions || {};
  const resourceExceptionConfig = ownershipMap.webAccessibleResourceExceptions || {};
  const permissionExceptions = {
    added: normalizePermissionExceptionMap(permissionExceptionConfig.upstreamExtra),
    removed: normalizePermissionExceptionMap(permissionExceptionConfig.localExtra),
  };
  const resourceExceptions = {
    added: normalizeExceptionMap(resourceExceptionConfig.upstreamExtra),
    removed: normalizeExceptionMap(resourceExceptionConfig.localExtra),
  };
  const rawManifestDiffs = {
    permissions: compareArrays(
      localInventory.manifestSummary.permissions,
      upstreamInventory.manifestSummary.permissions
    ),
    hostPermissions: compareArrays(
      localInventory.manifestSummary.hostPermissions,
      upstreamInventory.manifestSummary.hostPermissions
    ),
    resources: compareArrays(
      localInventory.manifestSummary.webAccessibleResources,
      upstreamInventory.manifestSummary.webAccessibleResources
    ),
    minimumChromeVersion: {
      local: localInventory.manifestSummary.minimumChromeVersion,
      upstream: upstreamInventory.manifestSummary.minimumChromeVersion,
    },
  };
  const manifestDiffs = {
    ...rawManifestDiffs,
    permissions: applyDiffExceptions(rawManifestDiffs.permissions, permissionExceptions),
    resources: applyDiffExceptions(rawManifestDiffs.resources, resourceExceptions),
  };
  const scriptingLayoutDiff = compareArrays(
    localInventory.scriptingLayout,
    upstreamInventory.scriptingLayout
  );
  const runtimeSchemaDiffs = compareRuntimeSchema(
    localInventory.runtimeSchema,
    upstreamInventory.runtimeSchema
  );
  const approvedRuleIds = getApprovedRuleIds(localInventory.licensePolicy);
  const licenseBlockedRuleIds = upstreamRuleIds.filter(id => approvedRuleIds.has(id) === false);
  const changedFiles = sortStrings([
    ...hashDeltas.added,
    ...hashDeltas.removed,
    ...hashDeltas.changed,
    ...(manifestDiffs.permissions.added.length || manifestDiffs.permissions.removed.length ? ['manifest.json'] : []),
    ...(manifestDiffs.resources.added.length || manifestDiffs.resources.removed.length ? ['manifest.json'] : []),
    ...(manifestDiffs.hostPermissions.added.length || manifestDiffs.hostPermissions.removed.length ? ['manifest.json'] : []),
  ]);
  const ownershipViolations = findOwnershipViolations(changedFiles, ownershipMap);
  const driftClasses = classifyDrift({
    manifestDiffs,
    rulesetIdDiff,
    rulesetCountDeltas,
    hashDeltas,
    scriptingLayoutDiff,
    runtimeSchemaDiffs,
    licenseBlockedRuleIds,
  });
  const mixedDrift = driftClasses.length > 1;
  const localScriptingAssetCount = localRulesetHashPaths.filter(pathName =>
    pathName.startsWith('rulesets/scripting/')
  ).length;
  const upstreamScriptingAssetCount = upstreamRulesetHashPaths.filter(pathName =>
    pathName.startsWith('rulesets/scripting/')
  ).length;
  const automationBlocked =
    ownershipViolations.length !== 0 ||
    driftClasses.includes('unknown') ||
    driftClasses.includes('runtime-code') ||
    driftClasses.includes('manifest-permission') ||
    driftClasses.includes('browser-support') ||
    driftClasses.includes('store-packaging') ||
    driftClasses.includes('license-blocked') ||
    driftClasses.includes('policy-risk') ||
    mixedDrift;

  return {
    generatedAtUtc: new Date().toISOString(),
    mode: 'read-only',
    sourceOfTruth: 'pinned uBO Lite chromium tree',
    extensionDir: resolvedExtensionDir,
    upstreamDir: resolvedUpstreamDir,
    excludedUpstreamRuleIds: upstreamSkippedRuleIds,
    driftClasses,
    mixedDrift,
    automationBlocked,
    manualReviewRequired: automationBlocked,
    ownershipViolations,
    manifestDiffExceptions: {
      permissions: {
        added: manifestDiffs.permissions.ignoredAdded,
        removed: manifestDiffs.permissions.ignoredRemoved,
      },
      resources: {
        added: manifestDiffs.resources.ignoredAdded,
        removed: manifestDiffs.resources.ignoredRemoved,
      },
    },
    manifestDiffs,
    rulesetIdDiff,
    rulesetCountDeltas,
    hashDeltas,
    changedFiles,
    scriptingLayoutDiff,
    runtimeSchemaDiffs,
    licenseBlockedRuleIds,
    impact: {
      localRulesetBytes,
      upstreamRulesetBytes,
      rulesetByteDelta: upstreamRulesetBytes - localRulesetBytes,
      localScriptingAssetCount,
      upstreamScriptingAssetCount,
      scriptingAssetCountDelta: upstreamScriptingAssetCount - localScriptingAssetCount,
      localRulesetCount: localRuleIds.length,
      upstreamRulesetCount: upstreamRuleIds.length,
      rulesetCountDelta: upstreamRuleIds.length - localRuleIds.length,
    },
  };
}

const parseArgs = argv => {
  const out = {
    extensionDir: process.cwd(),
    upstreamDir: '',
    ownershipMapPath: defaultOwnershipMapPath,
    json: false,
    failOnBlocked: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--extension-dir') {
      out.extensionDir = argv[++i];
      continue;
    }
    if (arg === '--upstream-dir') {
      out.upstreamDir = argv[++i];
      continue;
    }
    if (arg === '--ownership-map') {
      out.ownershipMapPath = argv[++i];
      continue;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--fail-on-blocked') {
      out.failOnBlocked = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
};

const printTextReport = report => {
  console.log('uBO Lite parity audit (read-only)');
  console.log(`Extension: ${report.extensionDir}`);
  console.log(`Upstream:  ${report.upstreamDir}`);
  console.log(`Drift:     ${report.driftClasses.length ? report.driftClasses.join(', ') : 'none'}`);
  console.log(`Blocked:   ${report.automationBlocked ? 'yes' : 'no'}`);
  if (report.excludedUpstreamRuleIds.length) {
    console.log(`Skipped upstream rule IDs: ${report.excludedUpstreamRuleIds.join(', ')}`);
  }
  if (report.licenseBlockedRuleIds.length) {
    console.log(`License exceptions: ${report.licenseBlockedRuleIds.join(', ')}`);
  }
  if (report.ownershipViolations.length) {
    console.log(`Ownership violations: ${report.ownershipViolations.join(', ')}`);
  }
  console.log(`Changed files: ${report.changedFiles.length}`);
  console.log(`Ruleset byte delta: ${report.impact.rulesetByteDelta}`);
  console.log(`Scripting asset count delta: ${report.impact.scriptingAssetCountDelta}`);
};

const printUsage = () => {
  console.log([
    'Usage: node scripts/ubol-parity-audit.mjs --upstream-dir <path-to-ubol-chromium> [options]',
    '',
    'Options:',
    '  --extension-dir <path>    Talon Extension root. Defaults to cwd.',
    '  --ownership-map <path>    Ownership map JSON. Defaults to scripts/ubol-source-ownership.json.',
    '  --json                    Print full JSON report.',
    '  --fail-on-blocked         Exit nonzero when automation is blocked.',
  ].join('\n'));
};

const isMain = () => {
  if (process.argv[1] === undefined) { return false; }
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
};

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.upstreamDir === '') {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }
  try {
    const report = await buildParityReport(args);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printTextReport(report);
    }
    if (args.failOnBlocked && report.automationBlocked) {
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

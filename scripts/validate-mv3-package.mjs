import fs from 'node:fs/promises';
import path from 'node:path';

import { getDefaultRulesetIdsFromRuleResources } from '../js/default-rulesets.js';

const argv = process.argv.slice(2);

const getArgValue = (flag) => {
  const idx = argv.indexOf(flag);
  if (idx === -1) { return undefined; }
  return argv[idx + 1];
};

const targetDir = path.resolve(process.cwd(), getArgValue('--dir') || 'dist/extension');

const violations = [];

const addViolation = (filePath, message, line) => {
  if (line === undefined) {
    violations.push(`${filePath}: ${message}`);
    return;
  }
  violations.push(`${filePath}:${line}: ${message}`);
};

const collectFiles = async (rootDir, currentDir = rootDir, out = []) => {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(rootDir, absPath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(absPath);
    }
  }
  return out;
};

const pathExists = async (absPath) => {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (absPath) => {
  const raw = await fs.readFile(absPath, 'utf8');
  return JSON.parse(raw);
};

const lineFromIndex = (text, index) => {
  if (index <= 0) { return 1; }
  return text.slice(0, index).split(/\r?\n/).length;
};

const stripJsComments = (text) => {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlock.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
};

const stripJsStringLiterals = (text) => {
  const scrub = (src, re) =>
    src.replace(re, (match) => ' '.repeat(match.length));
  // Keep length stable so line/offset mapping remains valid for reporting.
  let out = text;
  out = scrub(out, /"(?:\\.|[^"\\])*"/g);
  out = scrub(out, /'(?:\\.|[^'\\])*'/g);
  out = scrub(out, /`(?:\\.|[^`\\])*`/g);
  return out;
};

const findMatches = (text, re) => {
  const out = [];
  for (const match of text.matchAll(re)) {
    if (match.index === undefined) { continue; }
    out.push(match.index);
  }
  return out;
};

const getRelPath = (absPath) => path.relative(targetDir, absPath).replace(/\\/g, '/');

const isExternalReference = (refValue) => {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(refValue);
};

const isHttpsUrl = (value) => {
  if (typeof value !== 'string') { return false; }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const getManifestRulesetIds = (manifest) => {
  const entries = Array.isArray(manifest?.declarative_net_request?.rule_resources)
    ? manifest.declarative_net_request.rule_resources
    : [];
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (id === '' || seen.has(id)) { continue; }
    seen.add(id);
    out.push(id);
  }
  return out;
};

const getRulesetDetailsDefaultIds = (details) => {
  if (Array.isArray(details) === false) { return []; }
  const out = [];
  const seen = new Set();
  for (const entry of details) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (id === '' || seen.has(id)) { continue; }
    if (entry?.enabled !== true) { continue; }
    seen.add(id);
    out.push(id);
  }
  return out;
};

const hasWebAccessibleResource = (manifest, expectedPath) => {
  const normalizedExpected = String(expectedPath || '').replace(/^\/+/, '');
  const entries = Array.isArray(manifest?.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];
  for (const entry of entries) {
    const resources = Array.isArray(entry?.resources) ? entry.resources : [];
    for (const resource of resources) {
      if (typeof resource !== 'string') { continue; }
      if (resource.replace(/^\/+/, '') === normalizedExpected) {
        return true;
      }
    }
  }
  return false;
};

const checkPackagedComplianceFiles = async () => {
  const requiredFiles = [
    'LICENSE.txt',
    'ATTRIBUTION.md',
    'THIRD_PARTY_NOTICES.md',
    'source-code.json',
    'automation/directives.json',
  ];
  for (const relativePath of requiredFiles) {
    const absPath = path.join(targetDir, relativePath);
    if (await pathExists(absPath)) { continue; }
    addViolation(relativePath, 'Required compliance artifact missing from packaged extension');
  }
};

const checkSourceCodeMetadata = async (manifest) => {
  const sourceCodePath = path.join(targetDir, 'source-code.json');
  if (await pathExists(sourceCodePath) === false) { return; }

  let payload;
  try {
    payload = await readJson(sourceCodePath);
  } catch {
    addViolation('source-code.json', 'source-code.json is not valid JSON');
    return;
  }

  const expectedVersion = typeof manifest?.version === 'string' ? manifest.version.trim() : '';
  const sourceCodeUrl = payload?.sourceCodeUrl;
  if (isHttpsUrl(sourceCodeUrl) === false) {
    addViolation('source-code.json', 'sourceCodeUrl must be a valid HTTPS URL');
  }
  const sourceRef = typeof payload?.sourceRef === 'string' ? payload.sourceRef.trim() : '';
  if (expectedVersion !== '' && sourceRef !== `v${expectedVersion}`) {
    addViolation(
      'source-code.json',
      `sourceRef must match manifest version tag v${expectedVersion}`
    );
  }
  if (
    expectedVersion !== '' &&
    typeof sourceCodeUrl === 'string' &&
    sourceCodeUrl.includes(`v${expectedVersion}`) === false
  ) {
    addViolation(
      'source-code.json',
      `sourceCodeUrl must include the version tag v${expectedVersion}`
    );
  }
};

const checkSourceCodeLinkInUi = async () => {
  const optionsHtmlPath = path.join(targetDir, 'options/options.html');
  if (await pathExists(optionsHtmlPath)) {
    const text = await fs.readFile(optionsHtmlPath, 'utf8');
    if (/id=["']footerSourceCode["']/i.test(text) === false) {
      addViolation('options/options.html', 'Missing "Source code for this version" link in options UI');
    }
  }

  const attributionHtmlPath = path.join(targetDir, 'options/attributions.html');
  if (await pathExists(attributionHtmlPath)) {
    const text = await fs.readFile(attributionHtmlPath, 'utf8');
    if (/id=["']sourceCodeLink["']/i.test(text) === false) {
      addViolation('options/attributions.html', 'Missing source-code link on attribution page');
    }
  }
};

const checkRulesetLicensingPolicy = async (manifest) => {
  const policyPath = path.join(targetDir, 'rulesets', 'ruleset-license-policy.json');
  if (await pathExists(policyPath) === false) {
    addViolation('rulesets/ruleset-license-policy.json', 'Missing ruleset license policy file');
    return;
  }

  const detailsPath = path.join(targetDir, 'rulesets', 'ruleset-details.json');
  if (await pathExists(detailsPath) === false) {
    addViolation('rulesets/ruleset-details.json', 'Missing ruleset details file');
    return;
  }

  let policy;
  let details;
  try {
    policy = await readJson(policyPath);
  } catch {
    addViolation('rulesets/ruleset-license-policy.json', 'ruleset-license-policy.json is not valid JSON');
    return;
  }
  try {
    details = await readJson(detailsPath);
  } catch {
    addViolation('rulesets/ruleset-details.json', 'ruleset-details.json is not valid JSON');
    return;
  }

  const detailIds = new Set(
    Array.isArray(details)
      ? details
        .filter(entry => entry instanceof Object && typeof entry.id === 'string')
        .map(entry => entry.id)
      : []
  );

  const policyRulesets = policy?.rulesets instanceof Object ? policy.rulesets : {};
  const allowlistedUnknown = policy?.allowlistedUnknown instanceof Object
    ? policy.allowlistedUnknown
    : {};

  const bundledRulesetIds = getManifestRulesetIds(manifest);
  for (const id of bundledRulesetIds) {
    if (detailIds.has(id) === false) {
      addViolation('manifest.json', `Bundled ruleset "${id}" missing from rulesets/ruleset-details.json`);
    }

    const entry = policyRulesets[id];
    if (entry instanceof Object === false) {
      addViolation('rulesets/ruleset-license-policy.json', `Missing licensing policy entry for bundled ruleset "${id}"`);
      continue;
    }

    const commercialUse = typeof entry.commercialUse === 'string'
      ? entry.commercialUse.trim().toLowerCase()
      : '';
    if (commercialUse === 'non-commercial') {
      addViolation('rulesets/ruleset-license-policy.json', `Bundled ruleset "${id}" is non-commercial and must not be distributed`);
      continue;
    }

    if (commercialUse === 'unknown') {
      const allowlistedProof = allowlistedUnknown[id];
      const inlineProof = entry.proof;
      const hasProof = (
        (typeof allowlistedProof === 'string' && allowlistedProof.trim() !== '') ||
        (typeof inlineProof === 'string' && inlineProof.trim() !== '')
      );
      if (hasProof === false) {
        addViolation(
          'rulesets/ruleset-license-policy.json',
          `Bundled ruleset "${id}" has UNKNOWN license status and is not allowlisted with proof`
        );
      }
      continue;
    }

    if (commercialUse !== 'allowed') {
      addViolation(
        'rulesets/ruleset-license-policy.json',
        `Bundled ruleset "${id}" has invalid commercialUse value "${String(entry.commercialUse)}"`
      );
    }
  }
};

const checkRulesetDefaultConsistency = async (manifest) => {
  const detailsPath = path.join(targetDir, 'rulesets', 'ruleset-details.json');
  if (await pathExists(detailsPath) === false) {
    addViolation('rulesets/ruleset-details.json', 'Missing ruleset details file');
    return;
  }

  let details;
  try {
    details = await readJson(detailsPath);
  } catch {
    addViolation('rulesets/ruleset-details.json', 'ruleset-details.json is not valid JSON');
    return;
  }

  const bundledRulesetIds = getManifestRulesetIds(manifest);
  const manifestDefaultIds = new Set(
    getDefaultRulesetIdsFromRuleResources(manifest?.declarative_net_request?.rule_resources)
  );
  const detailDefaultIds = new Set(getRulesetDetailsDefaultIds(details));
  const detailIds = new Set(
    Array.isArray(details)
      ? details
        .filter(entry => entry instanceof Object && typeof entry.id === 'string')
        .map(entry => entry.id)
      : []
  );

  for (const id of bundledRulesetIds) {
    if (detailIds.has(id) === false) { continue; }
    const manifestEnabled = manifestDefaultIds.has(id);
    const detailsEnabled = detailDefaultIds.has(id);
    if (manifestEnabled === detailsEnabled) { continue; }
    addViolation(
      'rulesets/ruleset-details.json',
      `Bundled ruleset "${id}" default-enabled mismatch between manifest.json and ruleset-details.json`
    );
  }
};

const checkManifest = async () => {
  const manifestPath = path.join(targetDir, 'manifest.json');
  let manifestRaw;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    addViolation('manifest.json', 'Missing manifest.json in packaged extension');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    addViolation('manifest.json', 'manifest.json is not valid JSON');
    return;
  }

  if (manifest.manifest_version !== 3) {
    addViolation('manifest.json', `manifest_version must be 3 (found ${String(manifest.manifest_version)})`);
  }

  const bannedKeys = ['browser_action', 'page_action'];
  for (const key of bannedKeys) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      addViolation('manifest.json', `Banned MV2 key present: ${key}`);
    }
  }

  const background = manifest.background;
  if (background && typeof background === 'object') {
    if (Object.prototype.hasOwnProperty.call(background, 'page')) {
      addViolation('manifest.json', 'Banned MV2 key present: background.page');
    }
    if (background.persistent === true) {
      addViolation('manifest.json', 'Banned MV2 setting present: background.persistent=true');
    }
  }

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (permissions.includes('webRequestBlocking')) {
    addViolation('manifest.json', 'Banned MV2-era permission present: webRequestBlocking');
  }

  const csp = manifest.content_security_policy;
  const cspValues = [];
  if (typeof csp === 'string') {
    cspValues.push(csp);
  } else if (csp && typeof csp === 'object') {
    for (const value of Object.values(csp)) {
      if (typeof value === 'string') {
        cspValues.push(value);
      }
    }
  }
  for (const value of cspValues) {
    if (/\bunsafe-inline\b/i.test(value)) {
      addViolation('manifest.json', 'CSP contains unsafe-inline');
    }
    if (/\bunsafe-eval\b/i.test(value)) {
      addViolation('manifest.json', 'CSP contains unsafe-eval');
    }
  }

  const warEntries = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];
  for (const entry of warEntries) {
    const resources = Array.isArray(entry?.resources) ? entry.resources : [];
    for (const resource of resources) {
      if (typeof resource !== 'string' || resource.trim() === '') { continue; }
      const normalized = resource.replace(/^\/+/, '');
      const absPath = path.join(targetDir, normalized);
      if (await pathExists(absPath)) { continue; }
      addViolation(
        'manifest.json',
        `web_accessible_resources target missing from package: ${resource}`
      );
    }
  }

  const requiredAutomationResources = [
    'automation/directives.json',
    'automation/native-heuristics.json',
  ];
  for (const relativePath of requiredAutomationResources) {
    if (hasWebAccessibleResource(manifest, relativePath)) { continue; }
    addViolation(
      'manifest.json',
      `Missing required web_accessible_resource for runtime content-script fetch: ${relativePath}`
    );
  }
};

const checkHtmlFile = async (absPath) => {
  const relPath = getRelPath(absPath);
  const text = await fs.readFile(absPath, 'utf8');

  const inlineScriptRe = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi;
  for (const index of findMatches(text, inlineScriptRe)) {
    addViolation(relPath, 'Inline <script> tag found (MV3 CSP violation risk)', lineFromIndex(text, index));
  }

  const inlineHandlerRe = /\son[a-z]+\s*=/gi;
  for (const index of findMatches(text, inlineHandlerRe)) {
    addViolation(relPath, 'Inline event handler attribute found', lineFromIndex(text, index));
  }

  const javascriptUrlRe = /javascript:/gi;
  for (const index of findMatches(text, javascriptUrlRe)) {
    addViolation(relPath, 'javascript: URL found', lineFromIndex(text, index));
  }

  const remoteScriptSrcRe = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi;
  for (const index of findMatches(text, remoteScriptSrcRe)) {
    addViolation(relPath, 'Remote script src found in HTML', lineFromIndex(text, index));
  }

  const localRefRe = /\b(src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(localRefRe)) {
    if (match.index === undefined) { continue; }
    const attr = (match[1] || '').toLowerCase();
    const rawRef = (match[2] || '').trim();
    if (rawRef === '') { continue; }
    if (isExternalReference(rawRef)) { continue; }

    const cleanRef = rawRef.split(/[?#]/)[0];
    if (cleanRef === '') { continue; }

    const candidatePath = cleanRef.startsWith('/')
      ? path.join(targetDir, cleanRef.replace(/^\/+/, ''))
      : path.resolve(path.dirname(absPath), cleanRef);

    if (await pathExists(candidatePath)) { continue; }
    addViolation(
      relPath,
      `Broken local ${attr} reference: ${rawRef}`,
      lineFromIndex(text, match.index)
    );
  }
};

const checkJsFile = async (absPath) => {
  const relPath = getRelPath(absPath);
  const raw = await fs.readFile(absPath, 'utf8');
  const withoutComments = stripJsComments(raw);
  const text = stripJsStringLiterals(withoutComments);

  const checks = [
    { re: /\b(?:chrome|browser)\.browserAction\b/g, message: 'MV2 API detected: browserAction' },
    { re: /\b(?:chrome|browser)\.pageAction\b/g, message: 'MV2 API detected: pageAction' },
    { re: /\b(?:chrome|browser)\.tabs\.(?:executeScript|insertCSS)\b/g, message: 'MV2 API detected: tabs.executeScript/insertCSS' },
    { re: /\b(?:chrome|browser)\.webRequest\b/g, message: 'webRequest API detected (check MV3 compatibility)' },
    { re: /\bimportScripts\s*\(/g, message: 'importScripts() detected (service worker module incompatibility risk)' },
    { re: /\bnew\s+Function\s*\(/g, message: 'new Function() detected (CSP risk)' },
    { re: /(^|[^\w$])eval\s*\(/g, message: 'eval() detected (CSP risk)' },
    { re: /\bTEST-PAID-LICENSE\b/g, message: 'Test entitlement bypass token detected' },
  ];

  for (const check of checks) {
    for (const index of findMatches(text, check.re)) {
      addViolation(relPath, check.message, lineFromIndex(text, index));
    }
  }

  // Checks that rely on string literals should run on comment-stripped text.
  const stringLiteralChecks = [
    {
      re: /\bimport\s+(?:[^"'`]+?\s+from\s+)?["']https?:\/\/[^"']+["']/g,
      message: 'Remote JS import detected',
    },
    {
      re: /\bimport\s*\(\s*["']https?:\/\/[^"']+["']\s*\)/g,
      message: 'Remote dynamic JS import detected',
    },
    {
      re: /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/g,
      message: 'String-based timer execution detected',
    },
    {
      re: /\bcreateElement\s*\(\s*["']script["']\s*\)[\s\S]{0,300}\.src\s*=\s*["']https?:\/\/[^"']+["']/g,
      message: 'Dynamic remote script element creation detected',
    },
    {
      re: /\b(?:script|el)\.src\s*=\s*["']https?:\/\/[^"']+["']/g,
      message: 'Remote script src assignment detected',
    },
    {
      re: /\bnew\s+Worker\s*\(\s*["']https?:\/\/[^"']+["']/g,
      message: 'Remote Worker script URL detected',
    },
  ];

  for (const check of stringLiteralChecks) {
    for (const index of findMatches(withoutComments, check.re)) {
      addViolation(relPath, check.message, lineFromIndex(withoutComments, index));
    }
  }
};

const main = async () => {
  try {
    await fs.access(targetDir);
  } catch {
    console.error(`MV3 validation failed: directory does not exist: ${targetDir}`);
    process.exit(1);
  }

  let manifest = null;
  await checkManifest();
  try {
    manifest = await readJson(path.join(targetDir, 'manifest.json'));
  } catch {
    manifest = null;
  }

  await checkPackagedComplianceFiles();
  if (manifest) {
    await checkSourceCodeMetadata(manifest);
    await checkRulesetLicensingPolicy(manifest);
    await checkRulesetDefaultConsistency(manifest);
  }
  await checkSourceCodeLinkInUi();

  const files = await collectFiles(targetDir);
  for (const absPath of files) {
    const relPath = getRelPath(absPath);
    if (relPath.startsWith('keys/')) {
      addViolation(relPath, 'Sensitive key material folder must not be packaged');
      continue;
    }
    if (relPath.startsWith('_metadata/')) { continue; }

    const ext = path.extname(absPath).toLowerCase();
    if (ext === '.html') {
      await checkHtmlFile(absPath);
      continue;
    }
    if (ext === '.js') {
      await checkJsFile(absPath);
    }
  }

  if (violations.length !== 0) {
    console.error(`MV3 validation failed (${violations.length} issue${violations.length === 1 ? '' : 's'}):`);
    for (const line of violations) {
      console.error(`  - ${line}`);
    }
    process.exit(1);
  }

  console.log(`MV3 validation passed for ${targetDir}`);
};

main().catch((error) => {
  const reason = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`MV3 validation failed with exception:\n${reason}`);
  process.exit(1);
});

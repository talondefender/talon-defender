import fs from 'node:fs/promises';
import path from 'node:path';

import {
  applyDefaultRulesetFlagsToDetails,
  getDefaultRulesetIdsFromRuleResources,
} from '../js/default-rulesets.js';

const argv = process.argv.slice(2);

const getArgValue = (flag) => {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
};

const outDir = getArgValue('--out') || 'dist/extension';
const rootDir = process.cwd();
const absOutDir = path.resolve(rootDir, outDir);
const DEFAULT_REPOSITORY_URL = 'https://github.com/talondefender/talon-defender';

const INCLUDE = [
  '_locales',
  'automation',
  'css',
  'icons',
  'img',
  'js',
  'lib',
  'options',
  'popup',
  'rulesets',
  'shared',
  'web_accessible_resources',
  'manifest.json',
  'managed_storage.json',
  'picker-ui.html',
  'unpicker-ui.html',
  'strictblock.html',
  'LICENSE.txt',
  'ATTRIBUTION.md',
  'THIRD_PARTY_NOTICES.md',
];

const EXCLUDE = [
  'css/develop.css',
  'css/matched-rules.css',
  'icons/converter.html',
  'icons/preview.html',
  'icons/generate_icons.py',
  'js/develop.js',
  'js/dnr-editor.js',
  'js/matched-rules.js',
  'js/mode-editor.js',
  'js/mode-parser.js',
  'js/ro-dnr-editor.js',
  'js/rw-dnr-editor.js',
];

const PRUNE_FILE_PATTERNS = [
  /^icons\/.*\.(?:html?|py)$/i,
];

const pathExists = async (p) => {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (absPath) => {
  const raw = await fs.readFile(absPath, 'utf8');
  return JSON.parse(raw);
};

const writeJson = async (absPath, payload) => {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(absPath, text, 'utf8');
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const removeDirWithRetries = async (target, attempts = 6) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error?.code || '';
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY';
      if (retryable === false || i === attempts - 1) {
        throw error;
      }
      await wait(150 * (i + 1));
    }
  }
};

const collectFiles = async (rootDir, currentDir = rootDir, out = []) => {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(rootDir, abs, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
};

const matchesPrunePattern = (relativePath) => {
  const normalized = relativePath.replace(/\\/g, '/');
  return PRUNE_FILE_PATTERNS.some(re => re.test(normalized));
};

const normalizeRepositoryUrl = (value) => {
  if (typeof value !== 'string') { return DEFAULT_REPOSITORY_URL; }
  const trimmed = value.trim();
  if (trimmed === '') { return DEFAULT_REPOSITORY_URL; }
  return trimmed
    .replace(/^git\+/, '')
    .replace(/\.git$/i, '');
};

const fileNameWithoutExtension = (name) => {
  const ext = path.extname(name);
  return name.slice(0, name.length - ext.length);
};

const readBundledRulesetIds = async () => {
  const manifestPath = path.join(absOutDir, 'manifest.json');
  const manifest = await readJson(manifestPath);
  const entries = Array.isArray(manifest?.declarative_net_request?.rule_resources)
    ? manifest.declarative_net_request.rule_resources
    : [];
  const out = new Set();
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (id !== '') {
      out.add(id);
    }
  }
  return { manifest, ids: out };
};

const pruneRulesetDirectoryById = async (relativeDir, allowedIds, mode = 'basename') => {
  const dirPath = path.join(absOutDir, relativeDir);
  if (await pathExists(dirPath) === false) { return; }
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() === false) { continue; }
    const filePath = path.join(dirPath, entry.name);
    let rulesetId = '';
    if (mode === 'basename') {
      rulesetId = fileNameWithoutExtension(entry.name);
    } else if (mode === 'prefix-before-dot') {
      const idx = entry.name.indexOf('.');
      rulesetId = idx >= 0 ? entry.name.slice(0, idx) : fileNameWithoutExtension(entry.name);
    }
    if (allowedIds.has(rulesetId)) { continue; }
    await fs.rm(filePath, { force: true });
  }
};

const pruneTupleDetailsFile = async (relativePath, allowedIds) => {
  const absPath = path.join(absOutDir, relativePath);
  if (await pathExists(absPath) === false) { return; }
  const payload = await readJson(absPath);
  if (Array.isArray(payload) === false) { return; }
  const filtered = payload.filter(entry =>
    Array.isArray(entry) &&
    typeof entry[0] === 'string' &&
    allowedIds.has(entry[0])
  );
  await writeJson(absPath, filtered);
};

const pruneRulesetDetailsFile = async (allowedIds) => {
  const detailsPath = path.join(absOutDir, 'rulesets/ruleset-details.json');
  if (await pathExists(detailsPath) === false) { return; }
  const payload = await readJson(detailsPath);
  if (Array.isArray(payload) === false) { return; }
  const filtered = payload.filter(entry =>
    entry instanceof Object &&
    typeof entry.id === 'string' &&
    allowedIds.has(entry.id)
  );
  await writeJson(detailsPath, filtered);
};

const syncRulesetDetailsDefaultFlags = async (manifest) => {
  const detailsPath = path.join(absOutDir, 'rulesets/ruleset-details.json');
  if (await pathExists(detailsPath) === false) { return; }
  const payload = await readJson(detailsPath);
  if (Array.isArray(payload) === false) { return; }
  const defaultRulesetIds = getDefaultRulesetIdsFromRuleResources(
    manifest?.declarative_net_request?.rule_resources
  );
  const synced = applyDefaultRulesetFlagsToDetails(payload, defaultRulesetIds);
  await writeJson(detailsPath, synced);
};

const pruneUnbundledRulesetArtifacts = async (allowedIds) => {
  await pruneRulesetDirectoryById('rulesets/main', allowedIds);
  await pruneRulesetDirectoryById('rulesets/regex', allowedIds);
  await pruneRulesetDirectoryById('rulesets/strictblock', allowedIds);
  await pruneRulesetDirectoryById('rulesets/urlskip', allowedIds);
  await pruneRulesetDirectoryById('rulesets/scripting/generic', allowedIds);
  await pruneRulesetDirectoryById('rulesets/scripting/procedural', allowedIds);
  await pruneRulesetDirectoryById('rulesets/scripting/specific', allowedIds);
  await pruneRulesetDirectoryById('rulesets/scripting/generichigh', allowedIds);
  await pruneRulesetDirectoryById('rulesets/scripting/scriptlet', allowedIds, 'prefix-before-dot');

  await pruneRulesetDetailsFile(allowedIds);
  await pruneTupleDetailsFile('rulesets/generic-details.json', allowedIds);
  await pruneTupleDetailsFile('rulesets/scriptlet-details.json', allowedIds);
};

const writeSourceCodeMetadata = async (manifest) => {
  const pkgPath = path.join(rootDir, 'package.json');
  let repositoryUrl = DEFAULT_REPOSITORY_URL;
  try {
    const pkg = await readJson(pkgPath);
    const repoField = typeof pkg?.repository === 'string'
      ? pkg.repository
      : pkg?.repository?.url;
    repositoryUrl = normalizeRepositoryUrl(repoField);
  } catch {
    repositoryUrl = DEFAULT_REPOSITORY_URL;
  }

  const version = typeof manifest?.version === 'string' ? manifest.version.trim() : '';
  const sourceRef = version ? `v${version}` : '';
  const sourceCodeUrl = sourceRef
    ? `${repositoryUrl}/tree/${sourceRef}`
    : repositoryUrl;
  const sourceTarballUrl = sourceRef
    ? `${repositoryUrl}/archive/refs/tags/${sourceRef}.tar.gz`
    : '';

  const payload = {
    version,
    sourceRef,
    repositoryUrl,
    sourceCodeUrl,
    sourceTarballUrl,
    license: 'GPL-3.0-or-later',
    generatedAtUtc: new Date().toISOString(),
  };
  await writeJson(path.join(absOutDir, 'source-code.json'), payload);
};

await removeDirWithRetries(absOutDir);
await fs.mkdir(absOutDir, { recursive: true });

for (const entry of INCLUDE) {
  const src = path.join(rootDir, entry);
  if (await pathExists(src) === false) continue;
  const dest = path.join(absOutDir, entry);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true, force: true });
}

for (const entry of EXCLUDE) {
  const target = path.join(absOutDir, entry);
  await fs.rm(target, { force: true, recursive: true });
}

const packagedFiles = await collectFiles(absOutDir);
for (const absFilePath of packagedFiles) {
  const relativePath = path.relative(absOutDir, absFilePath);
  if (matchesPrunePattern(relativePath) === false) { continue; }
  await fs.rm(absFilePath, { force: true });
}

const { manifest, ids: bundledRulesetIds } = await readBundledRulesetIds();
await pruneUnbundledRulesetArtifacts(bundledRulesetIds);
await syncRulesetDetailsDefaultFlags(manifest);
await writeSourceCodeMetadata(manifest);

console.log(`Packaged extension to ${absOutDir}`);

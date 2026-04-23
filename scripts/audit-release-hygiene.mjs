import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const allowlistPath = path.join(rootDir, 'public-safe-allowlist.txt');

const PACKAGE_INCLUDE = [
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

const PACKAGE_EXCLUDE = new Set([
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
]);

const IGNORED_TOP_LEVEL = new Set([
  '.git',
  'artifacts',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const violations = [];

const normalizeRelativePath = value =>
  String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();

const pathExists = async absPath => {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
};

const readJson = async relativePath => {
  const raw = await fs.readFile(path.join(rootDir, relativePath), 'utf8');
  return JSON.parse(raw);
};

const readAllowlist = async () => {
  const raw = await fs.readFile(allowlistPath, 'utf8');
  return new Set(
    raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== '' && line.startsWith('#') === false)
      .map(normalizeRelativePath)
  );
};

const collectFiles = async (dir, relativeDir = '', out = []) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (relativeDir === '' && IGNORED_TOP_LEVEL.has(entry.name)) { continue; }
    const relativePath = normalizeRelativePath(
      relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    );
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolutePath, relativePath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(relativePath);
    }
  }
  return out;
};

const isPackageIncluded = relativePath =>
  PACKAGE_INCLUDE.some(entry =>
    relativePath === entry ||
    relativePath.startsWith(`${entry}/`)
  );

const isPackageExcluded = relativePath =>
  PACKAGE_EXCLUDE.has(relativePath) ||
  /^icons\/.*\.(?:html?|py)$/i.test(relativePath);

const isPackageableSourceFile = relativePath =>
  isPackageIncluded(relativePath) && isPackageExcluded(relativePath) === false;

const gitOutput = args =>
  execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });

const checkUntrackedPackageableFiles = () => {
  const raw = gitOutput(['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = raw
    .split('\0')
    .map(normalizeRelativePath)
    .filter(Boolean)
    .filter(isPackageableSourceFile);
  for (const relativePath of untracked) {
    violations.push(
      `${relativePath}: packageable runtime file is untracked; add it before release`
    );
  }
};

const checkPublicSafeCoverage = async allowlist => {
  const actualFiles = await collectFiles(rootDir);
  for (const relativePath of actualFiles) {
    if (isPackageableSourceFile(relativePath) === false) { continue; }
    if (allowlist.has(relativePath)) { continue; }
    violations.push(`${relativePath}: packageable source file missing from public-safe-allowlist.txt`);
  }
};

const checkManifestReferences = async allowlist => {
  const manifest = await readJson('manifest.json');
  const referenced = new Set();
  const addReference = value => {
    const relativePath = normalizeRelativePath(value);
    if (relativePath !== '') {
      referenced.add(relativePath);
    }
  };

  addReference(manifest?.background?.service_worker);
  addReference(manifest?.action?.default_popup);
  addReference(manifest?.options_page);

  for (const entry of manifest?.declarative_net_request?.rule_resources || []) {
    addReference(entry?.path);
  }
  for (const entry of manifest?.web_accessible_resources || []) {
    for (const resource of entry?.resources || []) {
      addReference(resource);
    }
  }

  for (const relativePath of referenced) {
    if (await pathExists(path.join(rootDir, relativePath)) === false) {
      violations.push(`${relativePath}: manifest references a missing source file`);
      continue;
    }
    if (allowlist.has(relativePath) === false) {
      violations.push(`${relativePath}: manifest-referenced source missing from public-safe-allowlist.txt`);
    }
  }
};

try {
  const allowlist = await readAllowlist();
  checkUntrackedPackageableFiles();
  await checkPublicSafeCoverage(allowlist);
  await checkManifestReferences(allowlist);
} catch (error) {
  violations.push(error instanceof Error ? error.message : String(error));
}

if (violations.length !== 0) {
  console.error(`Release hygiene audit failed (${violations.length} issue${violations.length === 1 ? '' : 's'}):`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Release hygiene audit passed.');

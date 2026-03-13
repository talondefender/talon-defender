import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);

const getArgValue = (flag) => {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
};

const rootDir = process.cwd();
const outDir = getArgValue('--out') || 'dist/edge-extension';
const absOutDir = path.resolve(rootDir, outDir);
const packageScript = path.join(rootDir, 'scripts/package-extension.mjs');

const readJson = async (absPath) => {
  const raw = await fs.readFile(absPath, 'utf8');
  return JSON.parse(raw);
};

const writeJson = async (absPath, payload) => {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(absPath, text, 'utf8');
};

const pathExists = async (absPath) => {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
};

const run = spawnSync(
  process.execPath,
  [packageScript, '--out', outDir],
  { stdio: 'inherit' }
);

if (typeof run.status === 'number' && run.status !== 0) {
  process.exit(run.status);
}
if (run.error) {
  throw run.error;
}

const manifestPath = path.join(absOutDir, 'manifest.json');
const manifest = await readJson(manifestPath);
const removedKeys = [];
const stripLeadingSlash = (value) => (
  typeof value === 'string' ? value.replace(/^\/+/, '') : value
);

for (const key of ['key', 'update_url']) {
  if (Object.prototype.hasOwnProperty.call(manifest, key)) {
    delete manifest[key];
    removedKeys.push(key);
  }
}

// Edge Add-ons validation can treat leading slash paths as absolute ZIP paths.
// Normalize extension paths to relative form for the Edge-specific package.
if (manifest?.background && typeof manifest.background === 'object') {
  manifest.background.service_worker = stripLeadingSlash(manifest.background.service_worker);
}

const ruleResources = manifest?.declarative_net_request?.rule_resources;
if (Array.isArray(ruleResources)) {
  for (const resource of ruleResources) {
    if (resource && typeof resource === 'object') {
      resource.path = stripLeadingSlash(resource.path);
    }
  }
}

const warEntries = manifest?.web_accessible_resources;
if (Array.isArray(warEntries)) {
  for (const entry of warEntries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.resources)) { continue; }
    entry.resources = entry.resources.map(stripLeadingSlash);
  }
}

await writeJson(manifestPath, manifest);

const sourceCodePath = path.join(absOutDir, 'source-code.json');
if (await pathExists(sourceCodePath)) {
  const sourceCode = await readJson(sourceCodePath);
  sourceCode.distributionTarget = 'microsoft-edge-addons';
  await writeJson(sourceCodePath, sourceCode);
}

const metadata = {
  target: 'microsoft-edge-addons',
  generatedAtUtc: new Date().toISOString(),
  outputDirectory: outDir.replace(/\\/g, '/'),
  extensionVersion: manifest?.version || '',
  manifestTweaks: {
    removedKeys,
  },
};

await writeJson(path.join(absOutDir, 'edge-build-target.json'), metadata);

console.log(`Prepared Edge extension package at ${absOutDir}`);

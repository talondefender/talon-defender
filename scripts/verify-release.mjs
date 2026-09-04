import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'all';
if (![ 'chrome', 'edge', 'all' ].includes(target)) throw new Error('invalid release target');
const release = args.includes('--release');
const recordHandoff = args.includes('--record-handoff');
const checkEvidence = args.includes('--check-evidence') || recordHandoff;
if (checkEvidence && !release) throw new Error('handoff evidence requires release mode');
const targets = target === 'all' ? [ 'chrome', 'edge' ] : [target];
const root = process.cwd();
const minimumBrowser = process.env.TALON_CHROME_MIN_PATH;
if (!checkEvidence && !process.env.TALON_CHROME_PATH) {
  throw new Error('TALON_CHROME_PATH must select current Stable Chrome for Testing (see install-current-chrome.ps1)');
}
if (!checkEvidence && !minimumBrowser) {
  throw new Error('TALON_CHROME_MIN_PATH must select the declared-minimum Chrome 122 binary (see RELEASE.md)');
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root, stdio: 'inherit', windowsHide: true, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandArgs.join(' ')} failed (${result.status})`);
  return result.stdout?.trim();
}
const node = (...commandArgs) => run(process.execPath, commandArgs);
const npm = (...commandArgs) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...commandArgs])
  : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', commandArgs, { shell: process.platform === 'win32' });
const head = () => run('git', ['rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' });
const hashFile = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const canonicalFiles = files => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
const sourceSnapshot = async () => {
  const files = {};
  const list = (await fs.readFile('public-safe-allowlist.txt', 'utf8')).split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const name of list) {
    if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('invalid public source path');
    if ((await fs.lstat(name)).isSymbolicLink()) throw new Error(`public source symlink: ${name}`);
    files[name] = await hashFile(name);
  }
  const canonical = canonicalFiles(files);
  return { files: canonical, digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
};
const archiveHashes = archive => canonicalFiles(JSON.parse(run('powershell', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/archive-entry-hashes.ps1',
  '-ArchivePath', path.resolve(archive),
], { stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })));
const hashTree = async directory => {
  const files = {};
  const visit = async (relative = '') => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`package symlink is not permitted: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files[name] = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
    }
  };
  await visit();
  return canonicalFiles(files);
};

if (release) node('scripts/audit-release-hygiene.mjs');
const source = await sourceSnapshot();
if (!checkEvidence) {
  npm('test');
  node('scripts/audit-public-safe.mjs');
  node('scripts/audit-public-content.mjs');
  npm('audit');
  npm('audit', '--omit=dev');
}
for (const browser of targets) {
  const directory = browser === 'chrome' ? 'dist/extension' : 'dist/edge-extension';
  const evidencePath = path.join(root, `dist/release-verification-${browser}.json`);
  if (checkEvidence) {
    const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
    if (evidence.schema !== 2 || evidence.release !== true || evidence.sourceCommit !== head() ||
        evidence.sourceTreeDigest !== source.digest ||
        JSON.stringify(evidence.files) !== JSON.stringify(await hashTree(directory))) {
      throw new Error(`${browser} release artifact no longer matches verified evidence`);
    }
    if (recordHandoff) {
      const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
      const packageZip = `dist/talon-defender-${browser === 'edge' ? 'edge-' : ''}extension.zip`;
      const sourceZip = `dist/talon-defender-extension-source-v${manifest.version}.zip`;
      if (JSON.stringify(archiveHashes(packageZip)) !== JSON.stringify(evidence.files)) {
        throw new Error(`${browser} ZIP contents differ from the browser-tested artifact`);
      }
      if (JSON.stringify(archiveHashes(sourceZip)) !== JSON.stringify(source.files)) {
        throw new Error('public source ZIP contents differ from the verified source tree');
      }
      evidence.handoff = {
        verifiedAt: new Date().toISOString(), packageZip: path.basename(packageZip),
        packageZipSha256: await hashFile(packageZip), sourceZip: path.basename(sourceZip),
        sourceZipSha256: await hashFile(sourceZip),
      };
      const buildInfoPath = `dist/${browser === 'edge' ? 'edge-' : ''}extension-build-info.json`;
      const buildInfo = JSON.parse(await fs.readFile(buildInfoPath, 'utf8'));
      buildInfo.verification = { ...evidence, files: undefined };
      await fs.writeFile(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n');
      const sourceInfo = JSON.parse(await fs.readFile('dist/source-release.json', 'utf8'));
      sourceInfo.sourceCommit = evidence.sourceCommit;
      sourceInfo.sourceTreeDigest = source.digest;
      sourceInfo.sourceArchiveSha256 = evidence.handoff.sourceZipSha256;
      await fs.writeFile('dist/source-release.json', JSON.stringify(sourceInfo, null, 2) + '\n');
      await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
    continue;
  }
  node(browser === 'chrome' ? 'scripts/package-extension.mjs' : 'scripts/package-edge-extension.mjs');
  node('scripts/validate-mv3-package.mjs', '--dir', directory);
  const files = await hashTree(directory);
  const smokeReportPath = path.join(root, `dist/smoke-${browser}.json`);
  node('scripts/chrome-smoke.mjs', '--browser', browser, '--dir', directory,
    '--existing-package', '--required', '--headless', '--report', smokeReportPath);
  const currentBrowser = JSON.parse(await fs.readFile(smokeReportPath, 'utf8'));
  run(process.execPath, ['scripts/chrome-smoke.mjs', '--browser', 'chrome', '--dir', directory,
    '--existing-package', '--required', '--headless', '--expect-major', '122', '--report', smokeReportPath], {
    env: { ...process.env, TALON_CHROME_PATH: minimumBrowser },
  });
  const minimumChromium = JSON.parse(await fs.readFile(smokeReportPath, 'utf8'));
  if (JSON.stringify(files) !== JSON.stringify(await hashTree(directory))) {
    throw new Error(`${browser} package changed during browser verification`);
  }
  if ((await sourceSnapshot()).digest !== source.digest) {
    throw new Error('public source changed during artifact verification');
  }
  await fs.writeFile(evidencePath, JSON.stringify({
    schema: 2, browser, release, sourceCommit: head(), sourceTreeDigest: source.digest, node: process.version,
    verifiedAt: new Date().toISOString(), currentBrowser, minimumChromium, files,
  }, null, 2) + '\n');
}
if (release) node('scripts/audit-release-hygiene.mjs');
console.log(`Verified ${target} ${release ? 'release' : 'development'} artifacts.`);

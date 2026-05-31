import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const controlCenterRoot = path.dirname(rootDir);
const latestRoot = path.join(controlCenterRoot, 'Talon Defender Latest');

const normalizeRelativePath = value =>
  String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();

const pathExists = async absPath => {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
};

const fileHash = async absPath => {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(absPath));
  return hash.digest('hex');
};

const walkFiles = async (root, relativeDir = '', out = []) => {
  const absDir = path.join(root, relativeDir);
  let entries = [];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, relativePath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(relativePath);
    }
  }
  return out;
};

const copyTree = async (sourceRoot, destinationRoot) => {
  const copied = [];
  if (await pathExists(sourceRoot) === false) { return copied; }
  const files = await walkFiles(sourceRoot);
  for (const relativePath of files) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const destinationPath = path.join(destinationRoot, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    const stat = await fs.stat(destinationPath);
    copied.push({
      path: normalizeRelativePath(path.relative(destinationRoot, destinationPath)),
      bytes: stat.size,
      sha256: await fileHash(destinationPath),
    });
  }
  return copied.sort((left, right) => left.path.localeCompare(right.path));
};

const gitOutput = args => {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
};

const parseArgs = argv => {
  const out = {
    outDir: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      out.outDir = argv[++i];
    }
  }
  return out;
};

const manifest = JSON.parse(await fs.readFile(path.join(rootDir, 'manifest.json'), 'utf8'));
const args = parseArgs(process.argv.slice(2));
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const version = String(manifest.version || 'unknown');
const backupRoot = path.resolve(
  rootDir,
  args.outDir || path.join('dist', 'release-backups', `v${version}-${timestamp}`)
);

const backupTargets = [
  { id: 'chrome', source: path.join(latestRoot, 'chrome') },
  { id: 'edge', source: path.join(latestRoot, 'edge') },
  { id: 'source', source: path.join(latestRoot, 'source') },
];

await fs.mkdir(backupRoot, { recursive: true });

const targets = [];
for (const target of backupTargets) {
  const destination = path.join(backupRoot, target.id);
  const files = await copyTree(target.source, destination);
  targets.push({
    id: target.id,
    source: target.source,
    destination,
    copied: files.length !== 0,
    files,
  });
}

const metadata = {
  generatedAtUtc: new Date().toISOString(),
  purpose: 'known-good release backup before parity or store-submission work',
  manifestVersion: version,
  gitCommit: gitOutput(['rev-parse', 'HEAD']),
  gitDescribe: gitOutput(['describe', '--tags', '--always', '--dirty']),
  latestRoot,
  backupRoot,
  targets,
  rollbackNotes: [
    'Use the copied latest artifacts as the last known-good handoff package.',
    'Chrome and Edge rollback generally require a new version number and store resubmission.',
    'Disable signed backend overlays independently through the backend kill switch before or during rollback if needed.',
  ],
};

await fs.writeFile(
  path.join(backupRoot, 'release-backup.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
  'utf8'
);

console.log(`Archived current release artifacts to ${backupRoot}`);

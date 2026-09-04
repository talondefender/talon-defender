import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDir, "..");
const tempRelativePath = "js/__public_safe_audit_probe__.txt";
const tempAbsolutePath = path.join(workspaceRoot, tempRelativePath);

const readText = relativePath =>
  fs.readFile(path.join(workspaceRoot, relativePath), "utf8");

async function cleanupProbe() {
  await fs.rm(tempAbsolutePath, { force: true }).catch(() => {});
}

async function hasWorkspaceGitCheckout() {
  try {
    await fs.access(path.join(workspaceRoot, ".git"));
    return true;
  } catch {
    return false;
  }
}

test("public-safe audit fails when an unlisted file appears", async () => {
  await cleanupProbe();
  await fs.writeFile(tempAbsolutePath, "temporary audit probe\n", "utf8");

  try {
    const result = spawnSync(process.execPath, ["scripts/audit-public-safe.mjs"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unexpected file detected: js\/__public_safe_audit_probe__\.txt/);
  } finally {
    await cleanupProbe();
  }
});

test("release hygiene fails when versioned source metadata would be built from a dirty tree", async (t) => {
  if ((await hasWorkspaceGitCheckout()) === false) {
    t.skip("release hygiene is a git-checkout gate");
    return;
  }

  const probeRelativePath = "RELEASE_HYGIENE_PROBE.txt";
  const probeAbsolutePath = path.join(workspaceRoot, probeRelativePath);
  await fs.rm(probeAbsolutePath, { force: true }).catch(() => {});
  await fs.writeFile(probeAbsolutePath, "temporary release hygiene probe\n", "utf8");

  try {
    const result = spawnSync(process.execPath, ["scripts/audit-release-hygiene.mjs"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /working tree has uncommitted changes; commit and tag source before creating a versioned store handoff/
    );
    assert.match(`${result.stdout}\n${result.stderr}`, /RELEASE_HYGIENE_PROBE\.txt/);
  } finally {
    await fs.rm(probeAbsolutePath, { force: true }).catch(() => {});
  }
});

test("public source archive includes every public npm test file", async () => {
  const packageJson = JSON.parse(await readText("package.json"));
  const sourcePackageScript = await readText("scripts/package-public-source.ps1");
  const testScript = String(packageJson?.scripts?.test || "");
  const referencedTestFiles = Array.from(
    testScript.matchAll(/test\/[^\s"]+\.test\.js/g),
    match => match[0]
  ).sort();

  assert.ok(referencedTestFiles.length > 0, "package.json must keep explicit public test files");
  assert.match(
    sourcePackageScript,
    /"test"/,
    "public source package must include the full public test directory"
  );
  assert.match(
    sourcePackageScript,
    /"public-safe-allowlist\.txt"/,
    "public source package must include the public-safe release manifest used by public tests"
  );
  assert.doesNotMatch(
    sourcePackageScript,
    /"test\/auto-backoff\.test\.js"/,
    "source packaging should not drift by enumerating a partial test subset"
  );
  const publicRoots = new Set((await readText('public-safe-allowlist.txt')).split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => line.split('/')[0]));
  for (const root of publicRoots) {
    assert.ok(sourcePackageScript.includes(`"${root}"`), `source archive omits public root: ${root}`);
  }

  for (const relativePath of referencedTestFiles) {
    await fs.access(path.join(workspaceRoot, relativePath));
  }
});

test("store entrypoints require shared artifact and browser evidence before zip creation", async () => {
  const gate = await readText('scripts/verify-release.mjs');
  assert.match(gate, /TALON_CHROME_MIN_PATH/);
  assert.match(gate, /TALON_CHROME_PATH/);
  assert.match(gate, /'--existing-package', '--required', '--headless'/);
  assert.match(gate, /'--expect-major', '122'/);
  assert.match(gate, /JSON\.stringify\(files\) !== JSON\.stringify\(await hashTree\(directory\)\)/);
  assert.match(gate, /evidence\.release !== true/);
  for (const [name, target] of [['release-extension.ps1', 'chrome'], ['release-edge-extension.ps1', 'edge']]) {
    const script = await readText(`scripts/${name}`);
    const verification = `node scripts/verify-release.mjs --release --target ${target}`;
    assert.ok(script.includes(verification));
    assert.ok(script.includes(`${verification} --check-evidence`));
    assert.ok(script.includes(`${verification} --record-handoff`));
    assert.match(script, /\[switch\]\$StageOnly/);
    assert.ok(script.indexOf('--record-handoff') < script.indexOf('if (-not $StageOnly)'));
    assert.ok(script.indexOf('--check-evidence') < script.indexOf('New-ZipFromDirectoryFilesOnly -SourceDir $distExtension'));
  }
  const packageJson = JSON.parse(await readText('package.json'));
  assert.match(packageJson.scripts['release:gate'], /scripts\/verify-release\.mjs --release --target all/);
  const ci = await readText('.github/workflows/extension-ci.yml');
  assert.match(ci, /npm run verify:ci/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /scripts\/install-minimum-chrome\.ps1/);
  assert.match(ci, /scripts\/install-current-chrome\.ps1/);
  assert.match(ci, /TALON_CHROME_PATH=/);
  const pin = JSON.parse(await readText('scripts/minimum-chrome.json'));
  assert.equal(pin.version.split('.')[0], '122');
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
});

test('archive verification hashes file contents and rejects duplicate entries', async t => {
  if (process.platform !== 'win32') { t.skip('PowerShell store packaging runs on Windows'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'talon-archive-test-'));
  try {
    await fs.mkdir(path.join(directory, 'source'));
    await fs.writeFile(path.join(directory, 'source', 'example.txt'), 'abc');
    const fixtureScript = path.join(directory, 'fixture.ps1');
    await fs.writeFile(fixtureScript, `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSCommandPath
[System.IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $root 'source'), (Join-Path $root 'source.zip'))
[System.IO.File]::Copy((Join-Path $root 'source.zip'), (Join-Path $root 'duplicate.zip'))
$archive = [System.IO.Compression.ZipFile]::Open((Join-Path $root 'duplicate.zip'), 'Update')
try { $archive.CreateEntry('example.txt') | Out-Null } finally { $archive.Dispose() }
`);
    const invoke = scriptArgs => spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...scriptArgs,
    ], { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true });
    const built = invoke([fixtureScript]);
    assert.equal(built.status, 0, built.stderr);
    const hashes = invoke(['scripts/archive-entry-hashes.ps1', '-ArchivePath', path.join(directory, 'source.zip')]);
    assert.equal(hashes.status, 0, hashes.stderr);
    assert.deepEqual(JSON.parse(hashes.stdout), {
      'example.txt': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    const duplicate = invoke(['scripts/archive-entry-hashes.ps1', '-ArchivePath', path.join(directory, 'duplicate.zip')]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate archive path/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), 'talon-archive-test-')));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
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

  for (const relativePath of referencedTestFiles) {
    await fs.access(path.join(workspaceRoot, relativePath));
  }
});

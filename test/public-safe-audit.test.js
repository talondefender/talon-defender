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

async function cleanupProbe() {
  await fs.rm(tempAbsolutePath, { force: true }).catch(() => {});
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

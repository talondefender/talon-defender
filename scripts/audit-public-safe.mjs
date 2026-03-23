import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const allowlistPath = path.join(rootDir, "public-safe-allowlist.txt");

const ignoredTopLevel = new Set([
  ".git",
  "artifacts",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

async function readAllowlist() {
  const raw = await fs.readFile(allowlistPath, "utf8");
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(normalizeRelativePath)
  );
}

async function walk(dir, relativeDir = "", out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const normalizedPath = normalizeRelativePath(relativePath);
    if (!relativeDir && ignoredTopLevel.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, normalizedPath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(normalizedPath);
    }
  }
  return out;
}

const violations = [];
let expectedFiles;

try {
  expectedFiles = await readAllowlist();
} catch (error) {
  console.error("Public-safe audit failed.");
  console.error(`- Unable to read allowlist: ${allowlistPath}`);
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const actualFiles = new Set(await walk(rootDir));

for (const relativePath of actualFiles) {
  if (!expectedFiles.has(relativePath)) {
    violations.push(`Unexpected file detected: ${relativePath}`);
  }
}

for (const relativePath of expectedFiles) {
  if (!actualFiles.has(relativePath)) {
    violations.push(`Allowlisted file is missing: ${relativePath}`);
  }
}

if (violations.length > 0) {
  console.error("Public-safe audit failed.");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Public-safe audit passed.");

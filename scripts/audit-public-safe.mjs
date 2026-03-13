import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();

const allowedTopLevel = new Set([
  ".gitignore",
  "AGENTS.md",
  "ATTRIBUTION.md",
  "CHANGE_PROCESS.md",
  "CURRENT_STATE.md",
  "GITHUB_PUBLISHING.md",
  "LICENSE.txt",
  "OPERATIONS.md",
  "PUBLIC_RELEASE_BOUNDARY.md",
  "README.md",
  "RELEASE.md",
  "THIRD_PARTY_NOTICES.md",
  "_locales",
  "automation",
  "css",
  "icons",
  "img",
  "js",
  "lib",
  "managed_storage.json",
  "manifest.json",
  "options",
  "package-lock.json",
  "package.json",
  "picker-ui.html",
  "popup",
  "rulesets",
  "scripts",
  "shared",
  "strictblock.html",
  "test",
  "unpicker-ui.html",
  "web_accessible_resources"
]);

const ignoredTopLevel = new Set([
  ".git",
  "artifacts",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results"
]);

const forbiddenPathPatterns = [
  /^website(?:\/|$)/i,
  /^services(?:\/|$)/i,
  /^ops(?:\/|$)/i,
  /^docs(?:\/|$)/i,
  /^deploy\.(?:ps1|sh)$/i,
  /^seo(?:\/|$)/i,
  /(^|\/)\.env(?:$|\.)/i,
  /^keys(?:\/|$)/i,
  /project_log/i,
  /support-runbook/i,
  /stripe_staging_test_matrix/i,
  /google-ads-basic-access-design-doc/i,
  /\.rtf$/i
];

const walk = async (dir, relativeDir = "", out = []) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (!relativeDir && ignoredTopLevel.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, relativePath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(relativePath);
    }
  }
  return out;
};

const violations = [];
const topLevelEntries = await fs.readdir(rootDir, { withFileTypes: true });
for (const entry of topLevelEntries) {
  if (allowedTopLevel.has(entry.name) || ignoredTopLevel.has(entry.name)) {
    continue;
  }
  violations.push(`Unexpected top-level entry: ${entry.name}`);
}

const files = await walk(rootDir);
for (const relativePath of files) {
  if (forbiddenPathPatterns.some((pattern) => pattern.test(relativePath))) {
    violations.push(`Forbidden private path detected: ${relativePath}`);
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

import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const testDir = path.join(rootDir, "test");

const allowedTestFiles = new Set([
  "test/auto-backoff.test.js",
  "test/automation-directives.test.js",
  "test/breakage-policy.test.js",
  "test/default-rulesets.test.js",
  "test/entitlement-regression.test.js",
]);

const allowedTestUrlHostnames = new Set([
  "127.0.0.1",
  "api.talondefender.com",
  "example.com",
  "example.org",
  "localhost",
  "talondefender.com",
  "www.example.com",
  "www.example.org",
]);

const suspiciousTestBasenamePatterns = [
  /capture/i,
  /corpus/i,
  /fixture/i,
  /manual/i,
  /notes?/i,
  /sample/i,
];

const urlPattern = /\bhttps?:\/\/[^\s"'`<>\\]+/g;

const walk = async (dir, relativeDir = "", out = []) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
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
let testFiles = [];

try {
  testFiles = await walk(testDir);
} catch (error) {
  if (error && error.code !== "ENOENT") {
    throw error;
  }
}

for (const relativePath of testFiles) {
  const normalizedPath = `test/${relativePath.replace(/\\/g, "/")}`;
  const baseName = path.basename(normalizedPath);

  if (!allowedTestFiles.has(normalizedPath)) {
    violations.push(`Unexpected public test file: ${normalizedPath}`);
    continue;
  }

  if (suspiciousTestBasenamePatterns.some((pattern) => pattern.test(baseName))) {
    violations.push(`Suspicious public test file name: ${normalizedPath}`);
    continue;
  }

  const absolutePath = path.join(rootDir, normalizedPath);
  const content = await fs.readFile(absolutePath, "utf8");
  const matches = content.match(urlPattern) ?? [];

  for (const rawUrl of matches) {
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      violations.push(`Invalid URL in public test file: ${normalizedPath} -> ${rawUrl}`);
      continue;
    }

    if (!allowedTestUrlHostnames.has(parsedUrl.hostname.toLowerCase())) {
      violations.push(
        `Unexpected live URL in public test file: ${normalizedPath} -> ${rawUrl}`
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Public content audit failed.");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Public content audit passed.");

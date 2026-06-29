import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOTS = [
  "apps/web/src",
  "packages/visual-engine/src",
];

const FORBIDDEN = /\bconsole\.(log|warn|error|debug|info)\s*\(/g;
const ALLOWED_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
];

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
    } else if (/\.(ts|tsx|js|jsx)$/.test(path) && !ALLOWED_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
      files.push(path);
    }
  }
  return files;
}

export function checkFrontendDebugLogs(cwd = process.cwd()) {
  const violations = [];
  for (const root of ROOTS) {
    for (const file of walk(join(cwd, root))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(FORBIDDEN)) {
        const before = text.slice(0, match.index);
        const line = before.split(/\r?\n/).length;
        violations.push(`${relative(cwd, file)}:${line}: remove ${match[0].replace(/\s*\($/, "")} from frontend product code`);
      }
    }
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = checkFrontendDebugLogs();
  if (violations.length) {
    console.error("Frontend debug log policy check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log("Frontend debug log policy check passed.");
}

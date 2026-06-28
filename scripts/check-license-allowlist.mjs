import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_PACKAGE_MANIFESTS = [
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
  "packages/visual-engine/package.json",
  "sidecars/api/package.json"
];

const DEFAULT_CARGO_MANIFESTS = [
  "apps/desktop/src-tauri/Cargo.toml"
];

const AUDIT_PATH = "docs/migration/LICENSE_GATE.md";
const AUDIT_TABLE_HEADER = "| Dependency | Ecosystem | License | Purpose | Distribution Risk | Decision |";
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const CARGO_DEPENDENCY_SECTIONS = new Set(["dependencies", "build-dependencies", "dev-dependencies"]);
const PASS_DECISION_PATTERN = /通过|接入/;
const PENDING_DECISION_PATTERN = /待审核/;

export function collectManifestDependenciesFromJson(manifestJson, manifest) {
  const deps = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = manifestJson?.[section];
    if (!entries || typeof entries !== "object") continue;
    for (const [name, version] of Object.entries(entries)) {
      if (isWorkspaceDependency(name, version)) continue;
      deps.push({ ecosystem: "npm", manifest, name });
    }
  }
  return dedupeDependencies(deps);
}

export function collectCargoDependenciesFromToml(toml, manifest) {
  const deps = [];
  let currentSection = "";
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }
    if (!CARGO_DEPENDENCY_SECTIONS.has(currentSection)) continue;

    const depMatch = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (!depMatch) continue;
    deps.push({ ecosystem: "Rust", manifest, name: depMatch[1] });
  }
  return dedupeDependencies(deps);
}

export function parseDependencyAuditRows(markdown) {
  const rows = new Map();
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === AUDIT_TABLE_HEADER);
  if (headerIndex < 0) return rows;

  for (const rawLine of lines.slice(headerIndex + 2)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) break;
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 6) continue;
    const dependency = cleanMarkdownCell(cells[0]);
    if (!dependency || dependency === "---") continue;
    const canonicalName = canonicalDependencyName(dependency);
    rows.set(canonicalName, {
      dependency,
      ecosystem: cleanMarkdownCell(cells[1]),
      license: cleanMarkdownCell(cells[2]),
      decision: cleanMarkdownCell(cells[5])
    });
  }
  return rows;
}

export function evaluateDependenciesAgainstAudit(dependencies, auditRows) {
  const errors = [];
  for (const dep of dedupeDependencies(dependencies)) {
    const row = auditRows.get(canonicalDependencyName(dep.name));
    if (!row) {
      errors.push(`${dep.manifest}: ${dep.name} is not recorded in ${AUDIT_PATH} Dependency Audit 表`);
      continue;
    }
    if (PENDING_DECISION_PATTERN.test(row.decision)) {
      errors.push(`${dep.manifest}: ${dep.name} is still 待审核 in ${AUDIT_PATH} Dependency Audit 表`);
      continue;
    }
    if (!PASS_DECISION_PATTERN.test(row.decision)) {
      errors.push(`${dep.manifest}: ${dep.name} has non-passing decision "${row.decision}" in ${AUDIT_PATH} Dependency Audit 表`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function collectWorkspaceDirectDependencies(rootDir = process.cwd()) {
  const deps = [];
  for (const manifest of DEFAULT_PACKAGE_MANIFESTS) {
    const path = resolve(rootDir, manifest);
    if (!existsSync(path)) continue;
    const json = JSON.parse(readFileSync(path, "utf8"));
    deps.push(...collectManifestDependenciesFromJson(json, manifest));
  }
  for (const manifest of DEFAULT_CARGO_MANIFESTS) {
    const path = resolve(rootDir, manifest);
    if (!existsSync(path)) continue;
    deps.push(...collectCargoDependenciesFromToml(readFileSync(path, "utf8"), manifest));
  }
  return dedupeDependencies(deps);
}

export function checkLicenseAllowlist(rootDir = process.cwd()) {
  const auditPath = resolve(rootDir, AUDIT_PATH);
  const auditRows = parseDependencyAuditRows(readFileSync(auditPath, "utf8"));
  const dependencies = collectWorkspaceDirectDependencies(rootDir);
  return evaluateDependenciesAgainstAudit(dependencies, auditRows);
}

function isWorkspaceDependency(name, version) {
  return name.startsWith("@mineradio/") || String(version).startsWith("workspace:");
}

function stripTomlComment(line) {
  const index = line.indexOf("#");
  return index >= 0 ? line.slice(0, index) : line;
}

function splitMarkdownTableRow(line) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function cleanMarkdownCell(cell) {
  return cell
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

function canonicalDependencyName(name) {
  const cleaned = cleanMarkdownCell(name).toLowerCase();
  const backtickMatch = name.match(/`([^`]+)`/);
  if (backtickMatch) return backtickMatch[1].toLowerCase();
  const npmMatch = cleaned.match(/npm\s+([@a-z0-9._/-]+)/);
  if (npmMatch) return npmMatch[1].replace(/^`|`$/g, "");
  const leading = cleaned.match(/^([@a-z0-9._/-]+)/);
  return leading ? leading[1] : cleaned;
}

function dedupeDependencies(dependencies) {
  const seen = new Set();
  const out = [];
  for (const dep of dependencies) {
    const key = `${dep.ecosystem}:${dep.manifest}:${dep.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dep);
  }
  return out;
}

if (import.meta.main) {
  const result = checkLicenseAllowlist(process.cwd());
  if (!result.ok) {
    console.error("License allowlist check failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("License allowlist check passed.");
}

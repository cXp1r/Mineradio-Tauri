import { describe, expect, test } from "bun:test";

import {
  collectCargoDependenciesFromToml,
  collectManifestDependenciesFromJson,
  evaluateDependenciesAgainstAudit,
  parseDependencyAuditRows
} from "./check-license-allowlist.mjs";

describe("license allowlist check", () => {
  test("collects external package dependencies while ignoring workspace packages", () => {
    const deps = collectManifestDependenciesFromJson(
      {
        dependencies: {
          "@mineradio/shared": "workspace:*",
          react: "^19.0.0",
          zod: "^4.0.0"
        },
        devDependencies: {
          typescript: "^5.0.0"
        }
      },
      "apps/web/package.json"
    );

    expect(deps).toEqual([
      { ecosystem: "npm", manifest: "apps/web/package.json", name: "react" },
      { ecosystem: "npm", manifest: "apps/web/package.json", name: "zod" },
      { ecosystem: "npm", manifest: "apps/web/package.json", name: "typescript" }
    ]);
  });

  test("collects Rust direct dependencies and build dependencies from Cargo.toml", () => {
    const deps = collectCargoDependenciesFromToml(
      `
[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`,
      "apps/desktop/src-tauri/Cargo.toml"
    );

    expect(deps).toEqual([
      { ecosystem: "Rust", manifest: "apps/desktop/src-tauri/Cargo.toml", name: "tauri-build" },
      { ecosystem: "Rust", manifest: "apps/desktop/src-tauri/Cargo.toml", name: "tauri" },
      { ecosystem: "Rust", manifest: "apps/desktop/src-tauri/Cargo.toml", name: "serde" },
      { ecosystem: "Rust", manifest: "apps/desktop/src-tauri/Cargo.toml", name: "serde_json" }
    ]);
  });

  test("parses dependency audit rows by dependency name and decision", () => {
    const rows = parseDependencyAuditRows(`
| Dependency | Ecosystem | License | Purpose | Distribution Risk | Decision |
| --- | --- | --- | --- | --- | --- |
| React | npm | MIT | UI | compatible | 通过 |
| serde_json | Rust (crate) | MIT/Apache-2.0 | JSON | pending | 待审核 |
`);

    expect(rows.get("react")?.decision).toBe("通过");
    expect(rows.get("serde_json")?.decision).toBe("待审核");
  });

  test("fails direct dependencies missing from the audit table or still pending", () => {
    const audit = parseDependencyAuditRows(`
| Dependency | Ecosystem | License | Purpose | Distribution Risk | Decision |
| --- | --- | --- | --- | --- | --- |
| React | npm | MIT | UI | compatible | 通过 |
| serde_json | Rust (crate) | MIT/Apache-2.0 | JSON | pending | 待审核 |
`);
    const result = evaluateDependenciesAgainstAudit(
      [
        { ecosystem: "npm", manifest: "apps/web/package.json", name: "react" },
        { ecosystem: "npm", manifest: "apps/web/package.json", name: "zustand" },
        { ecosystem: "Rust", manifest: "apps/desktop/src-tauri/Cargo.toml", name: "serde_json" }
      ],
      audit
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("apps/web/package.json: zustand is not recorded in docs/migration/LICENSE_GATE.md Dependency Audit 表");
    expect(result.errors).toContain("apps/desktop/src-tauri/Cargo.toml: serde_json is still 待审核 in docs/migration/LICENSE_GATE.md Dependency Audit 表");
  });
});

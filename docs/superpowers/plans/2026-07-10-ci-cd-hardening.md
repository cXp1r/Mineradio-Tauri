# CI/CD Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI cover the Windows/Rust code path and make each public updater release provably correspond to its triggering semantic-version tag.

**Architecture:** A tested Node/Bun version guard owns release-version validation. GitHub Actions call that guard before any privileged build, run language-specific validation in separate jobs, and publish Tauri assets as a draft before verifying and exposing the release.

**Tech Stack:** GitHub Actions, Bun 1.3.14, TypeScript/JavaScript, Rust 1.95.0, Tauri 2, PowerShell.

---

### Task 1: Deterministic release version guard

**Files:**
- Create: `scripts/release/verify-release-version.mjs`
- Create: `scripts/release/verify-release-version.test.ts`
- Modify: `package.json`

- [ ] Write tests for valid matching versions, invalid tag format, tag mismatch, and file-version mismatch.
- [ ] Run `bun test scripts/release/verify-release-version.test.ts` and confirm the module is missing.
- [ ] Implement pure parsing/validation helpers and the CLI entry point.
- [ ] Run the focused test and `bun run release:verify-version -- v0.1.0`.

### Task 2: Remove QQ test network dependency

**Files:**
- Modify: `sidecars/api/src/server.test.ts`

- [ ] Change the session-cookie test to require a supplied QQ adapter and assert that the adapter receives the runtime cookie state.
- [ ] Run the focused test before implementation and confirm the current global route path is exercised.
- [ ] Replace global `routeHandler` use in this test with `createRouteHandler({ providerAdapters })`.
- [ ] Run the focused test repeatedly and confirm no `qq-music-api` call occurs.

### Task 3: Fix Rust lint baseline and pin the toolchain

**Files:**
- Create: `rust-toolchain.toml`
- Modify: `apps/desktop/src-tauri/src/db.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `package.json`

- [ ] Run Clippy and record the existing `too_many_arguments` and `let_and_return` failures.
- [ ] Add narrow Chinese-commented lint allowances where the argument lists model stable boundaries; simplify the unnecessary test helper binding.
- [ ] Pin Rust 1.95.0 with Clippy and rustfmt components and Bun 1.3.14 via `packageManager`.
- [ ] Run format, Clippy, and Rust tests.

### Task 4: Harden CI and release workflows

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Create: `.github/dependabot.yml`

- [ ] Update Actions to Node 24-compatible releases pinned by full SHA.
- [ ] Split CI into Bun/Linux and Rust/Windows jobs with explicit timeouts and read-only permissions.
- [ ] Restrict release to semantic-version tags, validate versions before build, disable persisted checkout credentials, and use a protected release environment name.
- [ ] Publish as draft, verify required assets and `latest.json`, then publish via GitHub CLI.
- [ ] Add weekly npm, Cargo, and GitHub Actions dependency update checks.
- [ ] Run actionlint against both workflow files.

### Task 5: Full verification and direct main integration

**Files:**
- Verify all modified files.

- [ ] Run `bun install --frozen-lockfile`.
- [ ] Run `bun run typecheck`, `bun run test`, and `bun run web:build`.
- [ ] Run Cargo format, Clippy, and test commands with `--locked`.
- [ ] Run release guard success and intentional failure cases.
- [ ] Run `git diff --check` and inspect the complete staged diff.
- [ ] Commit one cohesive change, fast-forward local `main`, rerun critical checks, and push `main` to `origin`.

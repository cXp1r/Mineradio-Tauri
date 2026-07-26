# Mineradio M0/M1 App Decomposition Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在完全保持现有 Tauri、Bun sidecar、HTTP 路由、DTO、错误字段和用户可见行为不变的前提下，建立 M0 行为冻结线与 M1 Ports/Adapters 基础，并让搜索入口率先脱离 `SidecarClient` 具体类型。

**Architecture:** 采用渐进式 Strangler 迁移。`SidecarClient` 继续作为唯一生产 API 实现，新增窄 Port 描述业务所需能力，legacy adapter 只做无损委托；React 通过 `AppServices` 获取 Port，不感知 base URL 或路由。第一批只迁移搜索与 sidecar runtime 装配，不改变播放、账户、歌词、媒体 URL 和桌面命令的现有时序。

**Tech Stack:** React 19、TypeScript 5.9、Zustand、Bun test、Tauri 2、Rust 1.95、现有 `@mineradio/shared` Zod 契约。

---

## Scope and invariants

本计划只覆盖 M0 和 M1 的前置基础：

- 建立 capability、上游来源和 `App.tsx` 提取映射；
- 建立可机器校验的 API 冻结清单；
- 增加 music、runtime、media 和 desktop Port；
- 增加 legacy sidecar/Tauri adapter；
- 增加 `AppServices` 依赖容器；
- 将 `SearchShell` 改为依赖窄接口；
- 提取 sidecar bootstrap/recovery 的所有权边界；
- 保持 `AppProps.createSidecarClient` 测试注入兼容。

本计划明确不做：

- 不引入 `MineRadio-api` Cargo dependency；
- 不切换 Tauri command transport；
- 不改 `ProviderId`；
- 不删除 `sidecar.rs`、Bun workspace、构建脚本或 `externalBin`；
- 不改 sidecar endpoint、HTTP method、请求体、响应 schema、错误字段和代理 URL；
- 不重写播放、登录或歌词流程。

## Target file map

| 文件 | 单一职责 |
| --- | --- |
| `docs/parity/capability-matrix.md` | 记录 2.0.2 能力、当前状态、目标 owner、API 依赖和验收方式 |
| `docs/parity/upstream-source-map.md` | 记录 Electron 2.0.2 行为证据到 Tauri 目标模块的映射 |
| `docs/parity/app-extraction-map.md` | 记录 `App.tsx` 顶层符号、纯度、副作用、目标模块和测试证据 |
| `docs/parity/api-freeze.md` | 固定 M0/M1 不可变化的 transport、路由、DTO、错误和 supervisor 边界 |
| `scripts/architecture/verify-convergence-baseline.mjs` | 校验 parity 文档结构和 API 冻结标记 |
| `scripts/architecture/verify-convergence-baseline.test.ts` | 验证校验器在缺字段和完整文档上的行为 |
| `apps/web/src/ports/music/*.ts` | 描述搜索、播放、歌词、账户、资料库、发现和 mutation 能力 |
| `apps/web/src/ports/api-runtime-port.ts` | 描述 runtime config、health、capabilities 与 sidecar status |
| `apps/web/src/ports/media-url-port.ts` | 返回 opaque playable/image URI，不泄漏路由拼接 |
| `apps/web/src/ports/desktop-runtime-port.ts` | 描述窗口、桌面歌词和全局快捷键能力 |
| `apps/web/src/adapters/sidecar/legacy-sidecar-services.ts` | 无损委托当前 `SidecarClient` |
| `apps/web/src/adapters/sidecar/legacy-api-runtime.ts` | 组合现有 Tauri runtime 与 `SidecarClient.health/capabilities` |
| `apps/web/src/adapters/sidecar/legacy-media-url.ts` | 无损委托现有代理 URL 生成规则 |
| `apps/web/src/adapters/tauri/tauri-desktop-runtime.ts` | 无损委托现有 Tauri command wrappers |
| `apps/web/src/app/app-services.ts` | 组装并导出稳定的应用依赖集合 |
| `apps/web/src/app/AppRuntimeProvider.tsx` | 通过 React context 提供 `AppServices` |
| `apps/web/src/app/runtime/SidecarRecoveryRuntime.tsx` | 拥有 sidecar config/status 轮询、恢复提示和 client 生命周期 |
| `apps/web/src/components/shell/SearchShell.tsx` | 只依赖 `SearchExperiencePort`，不导入 `SidecarClient` |

### Task 1: Establish the M0 parity and API-freeze baseline

**Files:**
- Create: `docs/parity/capability-matrix.md`
- Create: `docs/parity/upstream-source-map.md`
- Create: `docs/parity/app-extraction-map.md`
- Create: `docs/parity/api-freeze.md`
- Create: `scripts/architecture/verify-convergence-baseline.mjs`
- Create: `scripts/architecture/verify-convergence-baseline.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write the failing validator tests**

Create `scripts/architecture/verify-convergence-baseline.test.ts`:

```ts
import { expect, test } from "bun:test";
import { validateConvergenceBaseline } from "./verify-convergence-baseline.mjs";

const validDocuments = {
  capabilityMatrix: "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  upstreamSourceMap: "Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`",
  appExtractionMap: "| symbol | kind | purity | current_side_effects | target_module | evidence | migration_order |\n| --- | --- | --- | --- | --- | --- | --- | --- |",
  apiFreeze: [
    "SidecarClient",
    "Bun sidecar",
    "RuntimeConfig.sidecarBaseUrl",
    "get_sidecar_status",
    "SidecarRecoveryNotice",
    "apps/desktop/scripts/build-sidecar-binary.mjs",
    "externalBin",
    "ApiError",
  ].join("\n"),
};

test("M0 baseline accepts the complete frozen contract", () => {
  expect(validateConvergenceBaseline(validDocuments)).toEqual([]);
});

test("M0 baseline reports missing API freeze markers", () => {
  expect(validateConvergenceBaseline({ ...validDocuments, apiFreeze: "SidecarClient" }))
    .toContain("api-freeze: missing Bun sidecar");
});
```

- [x] **Step 2: Run the tests and verify the missing module failure**

Run:

```powershell
bun test scripts/architecture/verify-convergence-baseline.test.ts
```

Expected: FAIL because `verify-convergence-baseline.mjs` does not exist.

- [x] **Step 3: Implement the validator and repository documents**

Implement `validateConvergenceBaseline()` as a pure function. It must verify the complete capability header, complete extraction header, the pinned Electron SHA, and every API-freeze marker from the test. Its CLI mode must read the four UTF-8 files and exit non-zero with one diagnostic per missing marker.

Populate the four documents from the approved umbrella design and the audited repositories. `app-extraction-map.md` must include every top-level `App.tsx` symbol from constants through `createDefaultSidecarClient`, classifying each as `pure`, `browser-storage`, `DOM`, `Tauri`, `sidecar`, or `React-runtime`.

Modify the root test script so architecture tests are always included:

```json
"test": "bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture"
```

- [x] **Step 4: Run the M0 validator and focused tests**

Run:

```powershell
bun test scripts/architecture/verify-convergence-baseline.test.ts
node scripts/architecture/verify-convergence-baseline.mjs
git diff --check
```

Expected: both commands exit 0 and the validator prints the four verified document paths.

- [x] **Step 5: Commit the M0 baseline**

```powershell
git add docs/parity scripts/architecture package.json
git commit -m "docs: establish Mineradio parity baseline"
```

### Task 2: Define transport-neutral application Ports

**Files:**
- Create: `apps/web/src/ports/music/search-port.ts`
- Create: `apps/web/src/ports/music/playback-port.ts`
- Create: `apps/web/src/ports/music/lyrics-port.ts`
- Create: `apps/web/src/ports/music/account-port.ts`
- Create: `apps/web/src/ports/music/library-port.ts`
- Create: `apps/web/src/ports/music/discover-port.ts`
- Create: `apps/web/src/ports/music/likes-port.ts`
- Create: `apps/web/src/ports/music/music-services.ts`
- Create: `apps/web/src/ports/api-runtime-port.ts`
- Create: `apps/web/src/ports/media-url-port.ts`
- Create: `apps/web/src/ports/desktop-runtime-port.ts`
- Create: `apps/web/src/ports/ports.test.ts`

- [ ] **Step 1: Write a compile-time and runtime Port fixture test**

The test creates a `MusicServices` object with fake methods, invokes search, lyrics and playlist methods, and asserts recorded arguments. Use `satisfies MusicServices` so TypeScript validates the complete interface without type casts.

- [ ] **Step 2: Run the focused test and verify imports fail**

Run:

```powershell
bun test apps/web/src/ports/ports.test.ts
```

Expected: FAIL because the Port modules do not exist.

- [ ] **Step 3: Add the narrow Port interfaces**

Use existing `@mineradio/shared` request and response types. The key signatures are:

```ts
export interface SearchPort {
  search(provider: ProviderId, keyword: string, limit?: number): Promise<Track[]>;
  searchAll(keyword: string, limit?: number, provider?: ProviderId): Promise<Track[]>;
}

export interface PlaybackPort {
  songUrl(track: Track, quality?: PlaybackQualityRequest): Promise<SongUrlResult>;
  resolveSongUrl(track: Track, quality?: PlaybackQualityRequest): Promise<SongUrlResult>;
  trackQualities(track: Track): Promise<TrackQualityAvailability>;
}

export interface LyricsPort {
  lyric(track: Track): Promise<LyricPayload>;
}

export interface SearchExperiencePort extends SearchPort {
  podcastSearch(keywords: string, limit?: number): Promise<PodcastSearchResponse>;
  podcastHot(limit?: number, offset?: number): Promise<PodcastHotResponse>;
  podcastPrograms(id: string, limit?: number, offset?: number): Promise<PodcastProgramsResponse>;
}
```

`MediaUrlPort` must expose only:

```ts
export interface MediaUrlPort {
  audioProxyUrl(url: string): string;
  playableUrl(url: string): string;
  imageUrl(url: string, options?: { cacheBust?: boolean; now?: number }): string;
}
```

No Port may expose `baseUrl`, endpoint paths, `fetch`, Tauri command names, `SidecarClient`, or Axum concepts.

- [ ] **Step 4: Run Port tests and web typecheck**

Run:

```powershell
bun test apps/web/src/ports/ports.test.ts
bun run --filter ./apps/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the Port contracts**

```powershell
git add apps/web/src/ports
git commit -m "refactor(web): define application ports"
```

### Task 3: Add the legacy Sidecar adapters without changing transport behavior

**Files:**
- Create: `apps/web/src/adapters/sidecar/legacy-sidecar-services.ts`
- Create: `apps/web/src/adapters/sidecar/legacy-sidecar-services.test.ts`
- Create: `apps/web/src/adapters/sidecar/legacy-media-url.ts`
- Create: `apps/web/src/adapters/sidecar/legacy-media-url.test.ts`

- [ ] **Step 1: Write delegation tests using a recording fake client**

Tests must prove:

- `search()` retains provider, keyword and default/current limit;
- `resolveSongUrl()` retains the `Track` object and quality string;
- account and playlist calls retain all current parameters;
- returned `SidecarClientError` remains the same instance with `restriction`, `reason`, `qqCode`, `rawMessage` and `tried` intact;
- media URL output is byte-for-byte identical to `audioProxyUrl`, `proxiedUrl` and `imageProxyUrl`.

- [ ] **Step 2: Run the focused tests and verify missing adapter failures**

```powershell
bun test apps/web/src/adapters/sidecar
```

Expected: FAIL because adapter modules do not exist.

- [ ] **Step 3: Implement pure delegation adapters**

The production factory must retain the concrete client only inside the adapter closure:

```ts
export function createLegacySidecarServices(client: SidecarClient): MusicServices {
  return {
    search: {
      search: (provider, keyword, limit = 30) => client.search(provider, keyword, limit),
      searchAll: (keyword, limit = 30, provider) => client.searchAll(keyword, limit, provider),
      podcastSearch: (keywords, limit = 18) => client.podcastSearch(keywords, limit),
      podcastHot: (limit = 18, offset = 0) => client.podcastHot(limit, offset),
      podcastPrograms: (id, limit = 30, offset = 0) => client.podcastPrograms(id, limit, offset),
    },
    playback: {
      songUrl: (track, quality) => client.songUrl(track, quality),
      resolveSongUrl: (track, quality) => client.resolveSongUrl(track, quality),
      trackQualities: (track) => client.trackQualities(track),
    },
    lyrics: { lyric: (track) => client.lyric(track) },
    accounts: {
      loginStatus: (provider) => client.loginStatus(provider),
      createLoginQrKey: (provider) => client.createProviderLoginQrKey(provider),
      createLoginQrImage: (provider, key) => client.createProviderLoginQrImage(provider, key),
      checkLoginQr: (provider, key) => client.checkProviderLoginQr(provider, key),
      setSessionCookie: (provider, cookie) => client.setProviderSessionCookie(provider, cookie),
      clearSessionCookie: (provider) => client.clearProviderSessionCookie(provider),
      logout: (provider) => client.logout(provider),
    },
    library: {
      playlistList: (provider) => client.playlistList(provider),
      playlistDetail: (provider, id) => client.playlistDetail(provider, id),
      importSharedPlaylist: (input) => client.importSharedPlaylist(input),
      addSongToPlaylist: (provider, playlistId, trackId) => client.addSongToPlaylist(provider, playlistId, trackId),
    },
    likes: {
      likeSong: (provider, id, liked) => client.likeSong(provider, id, liked),
      checkSongLikes: (provider, ids) => client.checkSongLikes(provider, ids),
    },
    discover: {
      weatherRadio: (params) => client.weatherRadio(params),
      discoverHome: () => client.discoverHome(),
      podcastDetail: (id) => client.podcastDetail(id),
      podcastMy: () => client.podcastMy(),
      podcastMyItems: (key, limit, offset) => client.podcastMyItems(key, limit, offset),
      podcastDjBeatmap: (url, durationSec, introSec) => client.podcastDjBeatmap(url, durationSec, introSec),
    },
  };
}
```

Do not catch and recreate errors in these adapters.

- [ ] **Step 4: Run adapter conformance tests and existing client tests**

```powershell
bun test apps/web/src/adapters/sidecar apps/web/src/api/sidecar-client.test.ts
bun run --filter ./apps/web typecheck
```

Expected: PASS with unchanged sidecar-client assertions.

- [ ] **Step 5: Commit the legacy adapter**

```powershell
git add apps/web/src/adapters/sidecar
git commit -m "refactor(web): adapt legacy sidecar services"
```

### Task 4: Add API runtime, media URL and desktop runtime adapters

**Files:**
- Create: `apps/web/src/adapters/sidecar/legacy-api-runtime.ts`
- Create: `apps/web/src/adapters/sidecar/legacy-api-runtime.test.ts`
- Create: `apps/web/src/adapters/tauri/tauri-desktop-runtime.ts`
- Create: `apps/web/src/adapters/tauri/tauri-desktop-runtime.test.ts`

- [ ] **Step 1: Write adapter tests with injected function tables**

Avoid module mocking. Each adapter factory accepts a dependency object whose defaults are the current functions. Tests inject recorders and assert exact arguments and return objects.

- [ ] **Step 2: Run focused tests and verify missing modules**

```powershell
bun test apps/web/src/adapters/sidecar/legacy-api-runtime.test.ts apps/web/src/adapters/tauri/tauri-desktop-runtime.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement lossless wrappers**

`createLegacyApiRuntime()` delegates `getRuntimeConfig`, `getSidecarStatus`, `health` and `capabilities`. `createTauriDesktopRuntime()` delegates existing window, desktop lyrics and hotkey functions without changing command names or payloads.

- [ ] **Step 4: Run adapter, runtime and desktop lyrics tests**

```powershell
bun test apps/web/src/adapters apps/web/src/tauri/runtime.test.ts apps/web/src/desktop-lyrics
bun run --filter ./apps/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit runtime adapters**

```powershell
git add apps/web/src/adapters apps/web/src/ports
git commit -m "refactor(web): add runtime adapters"
```

### Task 5: Introduce AppServices dependency assembly

**Files:**
- Create: `apps/web/src/app/app-services.ts`
- Create: `apps/web/src/app/AppRuntimeProvider.tsx`
- Create: `apps/web/src/app/AppRuntimeProvider.test.tsx`
- Modify: `apps/web/src/app/App.tsx`

- [ ] **Step 1: Write provider tests**

Render a probe inside `AppRuntimeProvider`, assert it receives the exact injected service object, and assert `useAppServices()` throws a Chinese diagnostic outside the provider.

- [ ] **Step 2: Run the focused provider test and verify failure**

```powershell
bun test apps/web/src/app/AppRuntimeProvider.test.tsx
```

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Implement service assembly and provider**

```ts
export interface AppServices {
  music: MusicServices;
  apiRuntime: ApiRuntimePort;
  mediaUrl: MediaUrlPort;
  desktop: DesktopRuntimePort;
}

export function createLegacyAppServices(config: RuntimeConfig, client: SidecarClient): AppServices {
  return {
    music: createLegacySidecarServices(client),
    apiRuntime: createLegacyApiRuntime(client),
    mediaUrl: createLegacyMediaUrl(client),
    desktop: createTauriDesktopRuntime(),
  };
}
```

Keep the existing `AppProps.createSidecarClient` hook. Add optional `servicesFactory` for tests, but default it to `createLegacyAppServices`; this preserves all existing fake-client tests.

- [ ] **Step 4: Run provider and full App characterization tests**

```powershell
bun test apps/web/src/app/AppRuntimeProvider.test.tsx apps/web/src/app/App.test.tsx
bun run --filter ./apps/web typecheck
```

Expected: PASS with no DOM ID, class or copy changes.

- [ ] **Step 5: Commit dependency assembly**

```powershell
git add apps/web/src/app
git commit -m "refactor(web): assemble app services"
```

### Task 6: Move SearchShell from SidecarClient to SearchExperiencePort

**Files:**
- Modify: `apps/web/src/components/shell/SearchShell.tsx`
- Modify: `apps/web/src/components/shell/SearchShell.test.ts`
- Modify: `apps/web/src/components/shell/SearchShell.actions.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Test: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Add a source-boundary characterization test**

Read `SearchShell.tsx` as UTF-8 and assert it imports `SearchExperiencePort` and does not contain `api/sidecar-client` or `SidecarClient`.

- [ ] **Step 2: Run the focused test and verify it fails against the current import**

```powershell
bun test apps/web/src/components/shell/SearchShell.test.ts
```

Expected: FAIL on the source-boundary assertion.

- [ ] **Step 3: Replace the concrete client type**

Change `SearchShellProps.client` to `SearchExperiencePort | null`, change `searchTracksForMode` to `SearchPort`, and remove all casts to `Pick<SidecarClient, ...>`. In `App.tsx`, pass `appServices?.music.search ?? null` after legacy services are created.

- [ ] **Step 4: Run search and App characterization tests**

```powershell
bun test apps/web/src/components/shell/SearchShell.test.ts apps/web/src/components/shell/SearchShell.actions.test.tsx apps/web/src/app/App.test.tsx
bun run --filter ./apps/web typecheck
```

Expected: PASS; URL, error and UI assertions remain unchanged.

- [ ] **Step 5: Commit the first UI boundary migration**

```powershell
git add apps/web/src/components/shell/SearchShell.tsx apps/web/src/components/shell/SearchShell*.test.ts* apps/web/src/app/App.tsx
git commit -m "refactor(web): route search through application port"
```

### Task 7: Extract the sidecar bootstrap and recovery runtime

**Files:**
- Create: `apps/web/src/app/runtime/sidecar-recovery-policy.ts`
- Create: `apps/web/src/app/runtime/sidecar-recovery-policy.test.ts`
- Create: `apps/web/src/app/runtime/SidecarRecoveryRuntime.tsx`
- Create: `apps/web/src/app/runtime/SidecarRecoveryRuntime.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Test: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Move existing pure recovery functions behind policy tests**

Copy the existing truth table for `deriveSidecarRecoveryNoticeState()` and `nextSidecarStatusPollDelayMs()` into the focused policy test before moving code.

- [ ] **Step 2: Run the focused test against the not-yet-created module**

```powershell
bun test apps/web/src/app/runtime/sidecar-recovery-policy.test.ts
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Move pure policy without changing constants or text**

Preserve:

- `1500` ms regular poll;
- `12000` ms ready max poll;
- `60000` ms hidden max poll;
- `2600` ms recovered notice;
- all current `SidecarRecoveryNoticeState` values and Chinese copy.

- [ ] **Step 4: Extract runtime ownership with injected ApiRuntimePort and client factory**

`SidecarRecoveryRuntime` owns runtime config loading, client creation, status polling, health/capabilities verification, recovery state, cancellation and cleanup. It reports a snapshot to `App` through a render prop or narrow context. It must keep the current `initialRuntimeConfig` and `createSidecarClient` test hooks.

- [ ] **Step 5: Run recovery, App and full web tests**

```powershell
bun test apps/web/src/app/runtime apps/web/src/components/shell/SidecarRecoveryNotice.test.tsx apps/web/src/app/App.test.tsx
bun run --filter ./apps/web typecheck
bun run web:build
```

Expected: PASS with unchanged recovery timing assertions.

- [ ] **Step 6: Commit runtime extraction**

```powershell
git add apps/web/src/app/runtime apps/web/src/app/App.tsx
git commit -m "refactor(web): extract sidecar recovery runtime"
```

### Task 8: Verify the first M0/M1 implementation batch

**Files:**
- Modify: `docs/parity/app-extraction-map.md`
- Modify: `docs/parity/capability-matrix.md`

- [ ] **Step 1: Mark only verified migrations as completed**

Update the search and sidecar bootstrap rows with exact test commands and commit SHAs. Do not mark playback, accounts, home, library, desktop or updater complete.

- [ ] **Step 2: Run the full repository verification**

```powershell
bun run typecheck
bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture
bun run web:build
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
node scripts/architecture/verify-convergence-baseline.mjs
git diff --check
```

Expected: every command exits 0; Bun reports zero failed tests and Cargo reports zero failed tests.

- [ ] **Step 3: Audit the API freeze**

Run:

```powershell
git diff --name-only HEAD~7..HEAD
git diff HEAD~7..HEAD -- sidecars/api apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json packages/shared
```

Expected: the second diff is empty. If the actual commit count differs, use the M0 baseline commit as the left revision.

- [ ] **Step 4: Commit parity evidence**

```powershell
git add docs/parity
git commit -m "docs: record M0 M1 foundation evidence"
```

## Completion checkpoint

This plan is complete only when:

- all eight tasks are checked and committed;
- `SearchShell.tsx` has no concrete sidecar import;
- current `SidecarClient`, Bun sidecar and Tauri command behavior are unchanged;
- all existing App and sidecar tests still pass;
- parity documents name the remaining owners rather than implying full M1 completion;
- no `MineRadio-api` code or dependency has entered the production build.

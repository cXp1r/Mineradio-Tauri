# Mineradio M1 Playback Port Session Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保持播放和 API 行为不变，把当前歌曲的地址解析、媒体 URL、音质查询、歌词与 podcast beatmap 从具体 `SidecarClient` 迁移到既有 application Ports。

**Architecture:** 新增纯 `resolvePlayableAudio` 用例组合 `PlaybackPort` 和 `MediaUrlPort`，由 App 的首次加载与恢复路径共同调用。App 暂时继续持有播放时序和 refs，但播放领域不再读取 concrete sidecar 方法，为后续提取 `usePlaybackRuntime` 做准备。

**Tech Stack:** TypeScript 5.9、React 19、Bun test、现有 `PlaybackPort`、`LyricsPort`、`DiscoverPort` 与 `MediaUrlPort`。

---

## Invariants

- `result.proxied === true` 必须继续调用 legacy `proxiedUrl` 对应的 `MediaUrlPort.playableUrl()`；
- 其他远程 URL 必须继续调用 `audioProxyUrl()`；
- 缺少 URL 时继续使用 `result.message || "播放地址不可用"`；
- stale request、恢复次数、试听提示、position seek 和错误文案不变；
- local blob URL 不经过 Port；
- 当前 Bun sidecar 与 API DTO 不变。

### Task 1: Add the tested playable-audio use case

**Files:**
- Create: `apps/web/src/features/playback/resolve-playable-audio.ts`
- Create: `apps/web/src/features/playback/resolve-playable-audio.test.ts`

- [x] **Step 1: Write failing core tests**

覆盖普通远程 URL、`proxied=true` 相对 URL、请求参数透传和空 URL 错误文案。测试使用 recording fake Ports，必须断言未选择的 URL 方法没有调用。

- [x] **Step 2: Verify RED**

```powershell
bun test apps/web/src/features/playback/resolve-playable-audio.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the minimal use case**

```ts
export interface ResolvedPlayableAudio {
  result: SongUrlResult;
  audioUrl: string;
}

export async function resolvePlayableAudio(input: {
  playback: PlaybackPort;
  mediaUrl: MediaUrlPort;
  track: Track;
  quality?: PlaybackQualityRequest;
}): Promise<ResolvedPlayableAudio>;
```

不得捕获或重建 adapter error。

- [x] **Step 4: Verify GREEN and typecheck**

```powershell
bun test apps/web/src/features/playback/resolve-playable-audio.test.ts
bun run --filter ./apps/web typecheck
```

- [x] **Step 5: Commit**

```powershell
git add apps/web/src/features/playback docs/superpowers/plans/2026-07-26-m1-playback-port-session-boundary.md
git commit -m "refactor(web): add playable audio use case"
```

### Task 2: Route playback and lyrics through AppServices

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Test: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Replace reload path dependencies**

`reloadCurrentTrackAndPlay` 使用：

```ts
appServices.music.playback
appServices.mediaUrl
appServices.music.discover
```

并调用 `resolvePlayableAudio()`。`handlePlaybackError` 只检查 playback Port 是否存在，不读取 `sidecarClient.resolveSongUrl`。

- [ ] **Step 2: Replace current-track effect dependencies**

- 音质查询：`appServices.music.playback.trackQualities()`；
- 首次 URL：`resolvePlayableAudio()`；
- 歌词：`appServices.music.lyrics.lyric()`；
- podcast beatmap：`appServices.music.discover.podcastDjBeatmap()`。

保留所有 request sequence 和取消判断。

- [ ] **Step 3: Run core playback characterization**

```powershell
bun test apps/web/src/features/playback apps/web/src/adapters/sidecar/legacy-media-url.test.ts apps/web/src/app/App.test.tsx
bun run --filter ./apps/web typecheck
bun run web:build
```

- [ ] **Step 4: Commit**

```powershell
git add apps/web/src/app/App.tsx docs/superpowers/plans/2026-07-26-m1-playback-port-session-boundary.md
git commit -m "refactor(web): route playback through application ports"
```

### Task 3: Guard the playback transport boundary

**Files:**
- Create: `scripts/architecture/playback-port-boundary.test.ts`

- [ ] **Step 1: Add source assertions**

断言 `App.tsx` 不再包含：

```text
client.resolveSongUrl(
client.audioProxyUrl(
client.lyric(currentTrack)
sidecarClient?.resolveSongUrl
```

同时断言 App 导入并调用 `resolvePlayableAudio`。

- [ ] **Step 2: Run and commit the guard**

```powershell
bun test scripts/architecture/playback-port-boundary.test.ts
git add scripts/architecture/playback-port-boundary.test.ts docs/superpowers/plans/2026-07-26-m1-playback-port-session-boundary.md
git commit -m "test: guard playback port boundary"
```

### Task 4: Verify and record evidence

**Files:**
- Modify: `docs/parity/app-extraction-map.md`
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/superpowers/plans/2026-07-26-m1-playback-port-session-boundary.md`

- [ ] **Step 1: Record verified Port migration only**

不得把 `playback.resolve` 或 `playback.switch` 标为完成；只记录 concrete client dependency 已移除。

- [ ] **Step 2: Run full verification and frozen API audit**

```powershell
bun run typecheck
bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture
bun run web:build
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
node scripts/architecture/verify-convergence-baseline.mjs
git diff --check
git diff d33dc6e..HEAD -- sidecars/api apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json packages/shared
```

- [ ] **Step 3: Commit evidence**

```powershell
git add docs/parity docs/superpowers/plans/2026-07-26-m1-playback-port-session-boundary.md
git commit -m "docs: record playback port migration"
```

## Completion checkpoint

- App 的播放 URL、音质、歌词和 beatmap 路径只依赖 Ports；
- concrete `SidecarClient` 仍供未迁移领域使用；
- local audio、stale request、media error recovery 和用户文案不变；
- 全仓验证及 frozen API audit 通过。

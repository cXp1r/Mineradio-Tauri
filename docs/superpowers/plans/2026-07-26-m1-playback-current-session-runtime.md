# Mineradio M1 Playback Current Session Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有 Tauri/Bun API、播放时序和用户可见行为的前提下，把当前歌曲装载、歌词协调、媒体错误恢复与 URL 刷新从 `App.tsx` 提取为独立 playback session runtime。

**Architecture:** 使用一个无 React 依赖的 `PlaybackSessionCoordinator` 保存现有 sequence、已装载媒体、暂停时间和单次恢复预算；使用 `usePlaybackSessionRuntime` 组合 Ports、`PlayerController`、播放状态读写器、歌词动作和视图回调。`App.tsx` 只传入依赖并消费 runtime 返回的播放质量、试听提示、beatmap 与事件处理器。

**Tech Stack:** TypeScript 5.9、React 19、Zustand 5、Bun test、现有 `AppServices` Ports 与 `PlayerController`。

---

## Invariants

- Sidecar HTTP routes、DTO、错误结构、代理 URL、`ProviderId`、supervisor 和 packaging 保持不变；
- local audio 继续直接装载 blob URL，不经过 Ports；
- 远程 URL 继续通过 `resolvePlayableAudio()` 与既有 `MediaUrlPort`；
- 切歌或清空当前歌曲必须使旧播放、歌词和 beatmap 结果失效；
- 每首非 local、非 trial 媒体最多自动恢复一次；
- 长暂停 10 分钟或 URL 年龄 20 分钟时保留当前位置刷新，长暂停原因优先；
- 当前歌曲切换后先提交 fallback 歌词，再异步提交 provider 歌词；
- 音质切换、试听文案、错误文案、首页展开状态和 position seek 时机不变；
- 本批只做 M1 所有权迁移，不引入 M2 `playbackSessionId`、状态机、gapless 或 crossfade。

### Task 1: Add the tested playback session coordinator

**Files:**
- Create: `apps/web/src/features/playback/playback-session-coordinator.ts`
- Create: `apps/web/src/features/playback/playback-session-coordinator.test.ts`

- [ ] **Step 1: Write the first failing stale-request test**

测试通过 public methods 创建首个 track session，再切换 track，并断言首个 playback/lyric token 均已失效，第二个 token 有效。

```ts
const coordinator = new PlaybackSessionCoordinator();
const first = coordinator.beginTrack("netease:first");
const second = coordinator.beginTrack("netease:second");
expect(coordinator.isPlaybackCurrent(first!.playbackToken)).toBe(false);
expect(coordinator.isLyricCurrent(first!.lyricToken)).toBe(false);
expect(coordinator.isPlaybackCurrent(second!.playbackToken)).toBe(true);
```

- [ ] **Step 2: Verify RED**

```powershell
bun test apps/web/src/features/playback/playback-session-coordinator.test.ts
```

Expected: FAIL because `playback-session-coordinator.ts` does not exist.

- [ ] **Step 3: Implement token ownership minimally and verify GREEN**

实现：

```ts
export class PlaybackSessionCoordinator {
  beginTrack(trackKey: string): PlaybackTrackSession | null;
  clear(): void;
  beginReload(): number;
  invalidatePlayback(): void;
  isPlaybackCurrent(token: number): boolean;
  isLyricCurrent(token: number): boolean;
}
```

相同 `trackKey` 返回 `null`，保持原 `lastLoadedKeyRef` 去重行为。

- [ ] **Step 4: Add recovery and refresh policy tests one behavior at a time**

依次用 RED→GREEN 覆盖：

1. 同一 track 的非 local、非 trial 媒体只允许一次 `claimMediaErrorRecovery()`；
2. local 或 trial 媒体禁止自动恢复；
3. `markPaused()` 后 10 分钟返回 `long-pause`；
4. URL 达 20 分钟返回 `url-age`；
5. 两者同时满足时返回 `long-pause`；
6. `markPlaying()` 清除暂停时间；
7. 非媒体错误原因的成功 reload 重置 recovery claim。

- [ ] **Step 5: Run coordinator tests and commit**

```powershell
bun test apps/web/src/features/playback/playback-session-coordinator.test.ts
git add apps/web/src/features/playback/playback-session-coordinator.ts apps/web/src/features/playback/playback-session-coordinator.test.ts docs/superpowers/plans/2026-07-26-m1-playback-current-session-runtime.md
git commit -m "refactor(web): add playback session coordinator"
```

### Task 2: Extract the React playback session runtime

**Files:**
- Create: `apps/web/src/features/playback/usePlaybackSessionRuntime.ts`
- Create: `apps/web/src/features/playback/usePlaybackSessionRuntime.test.tsx`
- Modify: `apps/web/src/features/playback/playback-session-coordinator.ts`

- [ ] **Step 1: Write a failing runtime characterization test**

使用 fake Ports、fake `PlayerController` 和注入的 state/view callbacks 渲染最小 host。断言设置远程 track 后：

- fallback 歌词先于未完成的 provider lyric 出现；
- resolved media URL 被 `load()`；
- 原位置被 `seek()`；
- `play()` 成功后调用首页隐藏 callbacks。

- [ ] **Step 2: Verify RED**

```powershell
bun test apps/web/src/features/playback/usePlaybackSessionRuntime.test.tsx
```

Expected: FAIL because the runtime hook does not exist.

- [ ] **Step 3: Implement the minimal injected runtime**

公开接口：

```ts
export interface PlaybackSessionRuntimeResult {
  playbackQuality: PlaybackQualityRequest;
  trackQualityOptions: TrackQualityOption[];
  trialBanner: TrialBannerState | null;
  currentBeatMapState: CurrentBeatMapState | null;
  originalLyricsPayloadRef: RefObject<LyricPayload | null>;
  setPlaybackQuality(quality: PlaybackQualityRequest): void;
  togglePlayback(): void;
  handleRuntimePlay(): void;
  handleRuntimePause(): void;
  handleRuntimeError(payload: ErrorPayload): void;
}
```

依赖必须显式注入：`AppServices | null`、`controllerRef`、`localAudioUrlsRef`、当前播放 snapshot/getter、播放与歌词 setters、toast/search/home callbacks、偏好读写函数和 `now()`。hook 不得导入 `SidecarClient`。

- [ ] **Step 4: Add stale lyric and single-recovery runtime tests**

逐个 RED→GREEN：

1. 切歌后旧 provider lyric resolve 不得覆盖新 track fallback；
2. 连续两次 media error 只触发一次重新解析；
3. trial media error 清除 banner 且不重新解析；
4. local track 不访问 playback/media Ports。

- [ ] **Step 5: Run focused tests and commit**

```powershell
bun test apps/web/src/features/playback/usePlaybackSessionRuntime.test.tsx apps/web/src/features/playback/playback-session-coordinator.test.ts apps/web/src/features/playback/resolve-playable-audio.test.ts
bun run --filter ./apps/web typecheck
git add apps/web/src/features/playback docs/superpowers/plans/2026-07-26-m1-playback-current-session-runtime.md
git commit -m "refactor(web): extract playback session runtime"
```

### Task 3: Integrate App and guard the ownership boundary

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.test.tsx`
- Create: `scripts/architecture/playback-session-boundary.test.ts`

- [ ] **Step 1: Replace App-owned session state and refs**

删除 App 内的播放 session types/constants/helpers、播放质量/试听/beatmap state、session refs、reload/error/toggle callbacks、质量查询 effect 和 current-track load effect。调用 `usePlaybackSessionRuntime()` 并保持现有变量名供 UI 与 `PlaybackRuntimeHost` 消费。

- [ ] **Step 2: Preserve custom lyric and runtime callback integration**

App 继续使用 runtime 返回的 `originalLyricsPayloadRef`；`handleRuntimePlay`、`handleRuntimePause`、`handleRuntimeError` 与 `togglePlayback` 直接来自 runtime。`handleRuntimeEnded`、timeupdate 和 durationchange 暂留 App，避免扩大本批范围。

- [ ] **Step 3: Add the source ownership guard**

断言 `App.tsx`：

- 导入并调用 `usePlaybackSessionRuntime`；
- 不再包含 `playbackRequestSeqRef`、`lyricRequestSeqRef`、`mediaErrorRecoveryTrackKeyRef`、`loadedPlaybackUrlRef`、`pausedAtMsRef`；
- 不再直接调用 `resolvePlayableAudio`、`trackQualities()`、`music.lyrics.lyric()` 或 `podcastDjBeatmap()`。

- [ ] **Step 4: Run App characterization and architecture tests**

```powershell
bun test apps/web/src/features/playback apps/web/src/app/App.test.tsx scripts/architecture/playback-port-boundary.test.ts scripts/architecture/playback-session-boundary.test.ts
bun run --filter ./apps/web typecheck
bun run web:build
```

- [ ] **Step 5: Commit integration**

```powershell
git add apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx scripts/architecture/playback-session-boundary.test.ts docs/superpowers/plans/2026-07-26-m1-playback-current-session-runtime.md
git commit -m "refactor(web): move current track session out of App"
```

### Task 4: Record evidence and run the frozen API audit

**Files:**
- Modify: `docs/parity/app-extraction-map.md`
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/superpowers/plans/2026-07-26-m1-playback-current-session-runtime.md`

- [ ] **Step 1: Record only M1 ownership progress**

记录 current-track session 已迁出 `App.tsx`，但不得把 M2 playback 状态机、gapless/crossfade 或完整 playback parity 标为完成。

- [ ] **Step 2: Run full verification**

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
git add docs/parity docs/superpowers/plans/2026-07-26-m1-playback-current-session-runtime.md
git commit -m "docs: record playback session extraction"
```

## Completion checkpoint

- `App.tsx` 不再拥有当前歌曲请求 token、loaded URL、暂停刷新和媒体恢复状态；
- 现有播放、歌词、试听、local audio、音质和 podcast beatmap 行为由 characterization tests 守护；
- TDD 覆盖 stale request、单次恢复与 URL refresh policy；
- API frozen diff 为空；
- M1 继续推进，但 M2 仍保持未完成。

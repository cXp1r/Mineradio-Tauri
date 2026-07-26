# Mineradio M1 Playback Runtime Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有播放、歌词、队列、媒体恢复和 API 行为的前提下，把 Audio 与 `PlayerController` 的创建、事件订阅、音量同步和卸载清理从 `App.tsx` 提取到独立 Runtime Host。

**Architecture:** `App.tsx` 暂时继续持有现有 `audioElementRef` 与 `controllerRef`，业务事件处理仍由 App 回调完成；新 `PlaybackRuntimeHost` 只拥有控制器生命周期和事件桥接。该批不迁移播放事务，也不改变 `SidecarClient`、代理 URL、store 结构或视觉引擎输入。

**Tech Stack:** React 19、TypeScript 5.9、Bun test、现有 `PlayerController`、Zustand playback/lyrics stores。

---

## Scope and invariants

- 保留同步创建的 `HTMLAudioElement`，确保视觉引擎仍能在初始化时绑定同一元素；
- 保留 `preload = "metadata"`、初始音量、`timeupdate`、`durationchange`、`play`、`pause`、`ended` 和 `error` 时序；
- 保留 single 模式重播、Home 收听会话、歌词索引和现有 error recovery；
- Runtime Host 不读取 Store、Sidecar、Tauri 或媒体 URL；
- 不移动 `reloadCurrentTrackAndPlay`、`handlePlaybackError`、`togglePlayback` 或 `setPlaybackQuality`；
- TDD 只用于 Runtime 生命周期与清理；source boundary、类型和装配使用结构验证。

## Target file map

| 文件 | 单一职责 |
| --- | --- |
| `apps/web/src/features/playback/PlaybackRuntimeHost.tsx` | 创建 `PlayerController`、绑定事件、同步音量、释放订阅和 refs |
| `apps/web/src/features/playback/PlaybackRuntimeHost.test.tsx` | 冻结生命周期、事件委托、音量和卸载清理 |
| `scripts/architecture/playback-runtime-boundary.test.ts` | 保证 `App.tsx` 不再构造控制器或注册控制器事件 |
| `apps/web/src/app/App.tsx` | 只保留业务回调和 Runtime Host 装配 |
| `docs/parity/app-extraction-map.md` | 记录 PlayerController lifecycle 的已验证 owner |

### Task 1: Add the tested PlaybackRuntimeHost

**Files:**
- Create: `apps/web/src/features/playback/PlaybackRuntimeHost.test.tsx`
- Create: `apps/web/src/features/playback/PlaybackRuntimeHost.tsx`

- [x] **Step 1: Write failing lifecycle tests**

使用 fake controller factory 和现有 happy-dom preload。测试必须验证：

```ts
expect(factoryAudio).toBe(audioElementRef.current);
expect(fakeController.volume).toBe(0.35);
expect(receivedEvents).toEqual([
  "time:1200:9000",
  "duration:1200:9000",
  "play",
  "pause",
  "ended",
  "error:4:network",
]);
```

重新渲染 `muted=true` 后断言音量变成 `0`；unmount 后断言所有 `on()` 返回的取消函数执行、`controllerRef.current` 和 `audioElementRef.current` 均为 `null`。

- [x] **Step 2: Run the test and verify the missing module failure**

```powershell
bun test apps/web/src/features/playback/PlaybackRuntimeHost.test.tsx
```

Expected: FAIL because `PlaybackRuntimeHost.tsx` does not exist.

- [x] **Step 3: Implement the transport-free runtime host**

导出：

```ts
export interface PlaybackRuntimeCallbacks {
  onTimeUpdate(payload: TimeUpdatePayload): void;
  onDurationChange(payload: TimeUpdatePayload): void;
  onPlay(): void;
  onPause(): void;
  onEnded(): void;
  onError(payload: ErrorPayload): void;
}

export interface PlaybackRuntimeHostProps extends PlaybackRuntimeCallbacks {
  audioElementRef: MutableRefObject<HTMLAudioElement | null>;
  controllerRef: MutableRefObject<PlayerController | null>;
  volume: number;
  muted: boolean;
  createController?: (audio: HTMLAudioElement) => PlayerControllerLike;
  createAudioElement?: () => HTMLAudioElement | null;
}
```

`PlayerControllerLike` 只描述 `setVolume()` 与六个 `on()` overload。默认 factory 仍执行 `new PlayerController(audio)`。Host 返回 `null`，不得读取任何 Store。

- [x] **Step 4: Run lifecycle tests and web typecheck**

```powershell
bun test apps/web/src/features/playback/PlaybackRuntimeHost.test.tsx
bun run --filter ./apps/web typecheck
```

Expected: PASS.

- [x] **Step 5: Commit the runtime host**

```powershell
git add apps/web/src/features/playback
git commit -m "refactor(web): add playback runtime host"
```

### Task 2: Route App playback lifecycle through the host

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Test: `apps/web/src/app/App.test.tsx`

- [x] **Step 1: Extract stable event bridge callbacks in App**

保留原事件体，分别建立：

```ts
handleRuntimeTimeUpdate
handleRuntimeDurationChange
handleRuntimePlay
handleRuntimePause
handleRuntimeEnded
handleRuntimeError
```

`handleRuntimeError` 必须继续调用 `handlePlaybackErrorRef.current(payload)`；`handleRuntimeEnded` 必须继续完成收听会话、清零位置、调用 store `ended()`，并在 single 模式 seek 到 0 后重新播放。

- [x] **Step 2: Render PlaybackRuntimeHost after the visual shell**

Host 放在 `AppRuntimeProvider` 内、主 `div` 之后，使视觉子树 effect 仍先获得同步创建的 Audio 元素。传入现有 refs、`volume`、`muted` 和六个稳定回调。

- [x] **Step 3: Remove the old lifecycle and volume effects**

删除 App 中直接执行 `new PlayerController(audio)`、`controller.on(...)` 和 `controllerRef.current?.setVolume(...)` 的两个 effect。不得修改加载、播放、暂停、seek 或 recovery callbacks。

- [x] **Step 4: Run focused App playback characterization**

```powershell
bun test apps/web/src/features/playback/PlaybackRuntimeHost.test.tsx apps/web/src/audio/player-controller.test.ts apps/web/src/app/App.test.tsx
bun run --filter ./apps/web typecheck
bun run web:build
```

Expected: PASS; existing media proxy、Soda recovery、quality fallback、trial banner、lyrics fallback and queue tests remain unchanged.

- [x] **Step 5: Commit App integration**

```powershell
git add apps/web/src/app/App.tsx
git commit -m "refactor(web): move player lifecycle out of App"
```

### Task 3: Add the source boundary guard

**Files:**
- Create: `scripts/architecture/playback-runtime-boundary.test.ts`
- Modify: `package.json` only if architecture tests are no longer included by the root test script

- [x] **Step 1: Add the source assertion**

读取 UTF-8 源码并断言：

```ts
expect(appSource).not.toContain("new PlayerController(");
expect(appSource).not.toContain('controller.on("timeupdate"');
expect(appSource).not.toContain('controller.on("error"');
expect(runtimeSource).toContain("export function PlaybackRuntimeHost");
```

- [x] **Step 2: Run the architecture test**

```powershell
bun test scripts/architecture/playback-runtime-boundary.test.ts
```

Expected: PASS after Task 2; this is a structural boundary check, not a new behavior TDD cycle.

- [x] **Step 3: Commit the guard**

```powershell
git add scripts/architecture/playback-runtime-boundary.test.ts
git commit -m "test: guard playback runtime ownership"
```

### Task 4: Verify and record the M1 playback lifecycle extraction

**Files:**
- Modify: `docs/parity/app-extraction-map.md`
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/superpowers/plans/2026-07-26-m1-playback-runtime-lifecycle.md`

- [x] **Step 1: Record only the verified lifecycle boundary**

记录 `PlaybackRuntimeHost` 的提交 SHA 和测试命令。`playback.resolve`、`playback.switch`、`playback.audio-start` 仍保持现有状态，不得标记为 M2 完成。

- [x] **Step 2: Run full repository verification**

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

- [x] **Step 3: Re-audit the frozen API surface**

```powershell
git diff d33dc6e..HEAD -- sidecars/api apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json packages/shared
```

Expected: empty diff.

- [x] **Step 4: Commit parity evidence**

```powershell
git add docs/parity docs/superpowers/plans/2026-07-26-m1-playback-runtime-lifecycle.md
git commit -m "docs: record playback runtime extraction"
```

## Completion checkpoint

- `App.tsx` 不再构造 `PlayerController` 或注册其媒体事件；
- Audio、PlayerController、事件订阅和音量同步由 `PlaybackRuntimeHost` 持有；
- 播放事务、API、代理 URL、错误文案和用户可见行为未改变；
- 生命周期 TDD、App characterization、全仓 Bun/Rust 验证全部通过；
- frozen API audit 仍为空。

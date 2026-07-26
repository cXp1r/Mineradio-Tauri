# Mineradio M1 App Decomposition Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 M1 App Decomposition，使 `App.tsx` 只保留依赖装配、跨 Surface 导航和顶层布局顺序，同时保持现有 Tauri/Bun sidecar API、DOM、中文文案和视觉行为不变。

**Architecture:** 按 Desktop、Updater、Likes、Library、Home、Playback UI、Global Shell 与 Surfaces 八个边界逐批迁移。Controller/Runtime 依赖现有 Ports 或窄 callback，Surface 只消费 view model/actions；禁止创建全能 `useAppController`，禁止把 App 原样搬入另一巨型文件。

**Tech Stack:** React 19、TypeScript 5.9、Zustand、Bun test、Tauri 2、现有 `AppServices` Ports。

---

## M1 completion invariants

- `sidecars/api/**`、shared DTO、HTTP routes、错误字段、代理 URL、supervisor、packaging 全部冻结；
- TDD 仅用于桌面歌词生命周期、Library mutation、Home request cancellation 等核心流程；其余结构迁移使用 characterization、boundary tests、typecheck 与 build；
- `App.tsx` 不直接导入 `SidecarClient`、`PlayerController`、`../tauri/runtime` 或访问 `localStorage`；
- `App.tsx` 不包含 Provider 请求、二维码轮询、播放恢复、桌面监听、更新请求、Home 请求、歌单请求和 like mutation；
- 每个 Runtime 的 timer/listener/object URL 都有 cleanup；
- 保持现有 DOM id、class、Surface 顺序、中文文案与已有测试选择器；
- 最终 App 行数以 150–400 行为目标，若因装配 props 超出则必须仍满足依赖方向和领域 effect 为零。

### Task 1: Desktop runtime ownership

**Files:**
- Create: `apps/web/src/features/desktop/useDesktopRuntime.ts`
- Create: `apps/web/src/features/desktop/useDesktopRuntime.test.tsx`
- Create: `apps/web/src/features/desktop/desktop-lyrics-payload.ts`
- Modify: `apps/web/src/app/App.tsx`
- Create: `scripts/architecture/desktop-runtime-boundary.test.ts`

- [x] **Step 1: Characterize desktop lyric enable/disable and hotkey cleanup**

通过 fake `DesktopRuntimePort` 渲染 Hook，断言：启用时先推送 force payload 再 show；禁用时 close；注册默认 hotkeys；unmount 时 unlisten 并清空 hotkeys。

- [x] **Step 2: Implement the public runtime**

```ts
export interface DesktopRuntimeResult {
	desktopLyricsEnabled: boolean;
	desktopWindowState: DesktopWindowState | null;
	toggleDesktopLyrics(): Promise<void>;
	setDesktopLyricsEnabled(enabled: boolean): Promise<void>;
}

export function useDesktopRuntime(options: {
	desktop: DesktopRuntimePort;
	buildLyricsPayload(force: boolean): DesktopJsonValue;
	lyricsPayloadVersion: unknown;
	hotkeyActions: Record<string, () => void>;
}): DesktopRuntimeResult;
```

Hook 持有 window state listener、global hotkey listener、desktop lyrics push gate 和 cleanup。纯 payload helpers 移入 `desktop-lyrics-payload.ts`，App 临时 re-export 兼容现有测试。

- [x] **Step 3: Integrate and guard**

App 删除 desktop lyrics/window/hotkey effects 与直接 Tauri imports。边界测试断言 App 不包含 `listenWindowState(`、`listenGlobalHotkey(`、`configureGlobalHotkeys(`、`desktopLyricsPushStateRef`。

- [x] **Step 4: Verify and commit**

```powershell
bun test apps/web/src/features/desktop apps/web/src/app/App.test.tsx scripts/architecture/desktop-runtime-boundary.test.ts
bun run --filter ./apps/web typecheck
bun run web:build
git commit -m "refactor(web): extract desktop runtime"
```

### Task 2: Updater controller

**Files:**
- Create: `apps/web/src/features/updater/useUpdaterController.ts`
- Create: `apps/web/src/features/updater/useUpdaterController.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Create: `scripts/architecture/updater-controller-boundary.test.ts`

- [x] **Step 1: Extract update state/actions**

```ts
export interface UpdaterControllerResult {
	modalOpen: boolean;
	setModalOpen(open: boolean): void;
	refresh(interactive?: boolean): Promise<void>;
	install(): Promise<void>;
}
```

Controller owns startup check, dev preview, error/toast mapping and install state through the existing update store. Dependencies are injected wrappers for `checkForUpdate`、`getUpdaterStatus`、`installUpdate`、`shouldOpenDevUpdatePreview`。

- [x] **Step 2: Integrate, verify and commit**

App 删除 updater imports、effect 和 callbacks；运行 UpdateHost/App tests、typecheck/build，提交 `refactor(web): extract updater controller`。

### Task 3: Likes controller

**Files:**
- Create: `apps/web/src/features/likes/useLikesController.ts`
- Create: `apps/web/src/features/likes/useLikesController.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Create: `scripts/architecture/likes-controller-boundary.test.ts`

- [x] **Step 1: Test mutation rollback**

fake mutation port 下先 optimistic update；reject 时恢复旧值并保留当前中文失败提示；LOGIN_REQUIRED 调用 `openProviderLogin()`。

- [x] **Step 2: Implement controller**

```ts
export interface LikesControllerResult {
	likedByTrack: Record<string, boolean>;
	busyByTrack: Record<string, boolean>;
	isLiked(track: Track | null): boolean;
	isBusy(track: Track | null): boolean;
	refresh(track: Track | null): void;
	toggle(track: Track | null): Promise<void>;
}
```

先建立窄 `LikesPort` 并由 legacy adapter 委托现有 SidecarClient；App 不再调用 `checkSongLikes` 或 `likeSong`。

- [x] **Step 3: Integrate, verify and commit**

运行 likes/App tests、boundary、typecheck/build，提交 `refactor(web): extract likes controller`。

### Task 4: Library controller

**Files:**
- Create: `apps/web/src/features/library/useLibraryController.ts`
- Create: `apps/web/src/features/library/useLibraryController.test.tsx`
- Modify: `apps/web/src/ports/music/library-port.ts`
- Modify: `apps/web/src/adapters/sidecar/legacy-sidecar-services.ts`
- Modify: `apps/web/src/app/App.tsx`
- Create: `scripts/architecture/library-controller-boundary.test.ts`

- [x] **Step 1: Freeze playlist merge and collect mutation**

核心测试覆盖 Provider 局部刷新不清空其他 Provider、collect 成功后关闭 picker、失败时 busy 清理。

- [x] **Step 2: Implement controller**

Controller 持有平台/导入歌单、播客集合、panel/detail、collect target/busy 和 shared-playlist import/delete；通过 `LibraryPort` 请求，通过注入的 `PlaybackActions` 播放。

- [x] **Step 3: Integrate, verify and commit**

App 删除 `refreshShelfPlaylists`、`refreshProviderPlaylists`、collect、playlist panel 和 imported playlist 业务 callbacks。运行 Library/PlaylistPanel/App tests、boundary、typecheck/build，提交 `refactor(web): extract library controller`。

### Task 5: Home controller

**Files:**
- Create: `apps/web/src/features/home/useHomeController.ts`
- Create: `apps/web/src/features/home/useHomeController.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Create: `scripts/architecture/home-controller-boundary.test.ts`

- [ ] **Step 1: Test stale Home requests and listen-session finalization**

使用 deferred discover/weather responses 断言旧结果不覆盖新请求；ended/pause 只提交有效 listen session。

- [ ] **Step 2: Implement controller**

Controller 持有 discover/weather/loading、forced/suppressed、playlist detail、listen history/session 和 Home actions。依赖 `DiscoverPort`、Library read model、`PlaybackActions`、Preferences adapter。

- [ ] **Step 3: Integrate, verify and commit**

App 删除 Home network effects、listen refs、Home action callbacks 和 direct storage usage。运行 Home/App tests、boundary、typecheck/build，提交 `refactor(web): extract home controller`。

### Task 6: Playback UI and customization controllers

**Files:**
- Create: `apps/web/src/features/playback/usePlaybackUiController.ts`
- Create: `apps/web/src/features/customization/useTrackCustomizationController.ts`
- Modify: `apps/web/src/app/App.tsx`
- Create: `scripts/architecture/playback-ui-boundary.test.ts`

- [ ] **Step 1: Move runtime event ownership**

`usePlaybackUiController` 持有 timeupdate/duration/ended、queue actions、seek、local file import 与 object URL cleanup，并连接现有 `PlaybackRuntimeHost`/store。

- [ ] **Step 2: Move lyric/cover customization**

Customization controller 持有 modal、custom lyric、custom cover 和 current-track patch；保持现有 localStorage compatibility adapters，不在 App 直接访问存储。

- [ ] **Step 3: Integrate, verify and commit**

运行 playback/custom lyric/custom cover/App tests、boundary、typecheck/build，提交 `refactor(web): extract playback UI controllers`。

### Task 7: Global shell runtime and preferences

**Files:**
- Create: `apps/web/src/app/runtime/GlobalShellRuntime.tsx`
- Create: `apps/web/src/app/runtime/useShellPreferences.ts`
- Modify: `apps/web/src/app/App.tsx`
- Create: `scripts/architecture/global-shell-boundary.test.ts`

- [ ] **Step 1: Extract DOM/listener effects**

Runtime owns body/root class synchronization、toast timeout、account dropdown outside click、mini queue outside click、capsule peek、stage-mode classes、empty-home blank dismiss 和 AI depth event cleanup。

- [ ] **Step 2: Extract browser preferences**

`useShellPreferences` owns DIY、panel pin、capsule auto-hide and shelf/visual persistence through adapters；App 不再调用 `localStorage` helpers。

- [ ] **Step 3: Integrate, verify and commit**

运行 App/shell tests、boundary、typecheck/build，提交 `refactor(web): extract global shell runtime`。

### Task 8: Feature surfaces and App shell

**Files:**
- Create: `apps/web/src/features/accounts/AccountSurface.tsx`
- Create: `apps/web/src/features/home/HomeSurface.tsx`
- Create: `apps/web/src/features/library/LibrarySurface.tsx`
- Create: `apps/web/src/features/playback/PlaybackSurface.tsx`
- Create: `apps/web/src/features/visual/VisualSurface.tsx`
- Create: `apps/web/src/app/AppShell.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Create: `scripts/architecture/app-composition-boundary.test.ts`

- [ ] **Step 1: Move JSX without behavior changes**

每个 Surface 接收该领域 controller result 和窄跨领域 actions，保留全部 DOM id/class/文案。`AppShell` 只定义 DesktopChrome、Visual、Home、Search、Account、Library、Playback、Overlays 顺序。

- [ ] **Step 2: Enforce composition boundary**

边界测试断言 App 不导入 `SidecarClient`、`PlayerController`、`../tauri/runtime`，不包含 `useEffect(`，不调用 music/desktop methods，并包含 `AppShell` 与各 controller/runtime 组合。

- [ ] **Step 3: Verify and commit**

运行全部 App/Surface tests、architecture tests、typecheck/build，提交 `refactor(web): converge App composition`。

### Task 9: M1 completion audit

**Files:**
- Modify: `docs/parity/app-extraction-map.md`
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md`
- Modify: `docs/superpowers/plans/2026-07-26-m1-app-decomposition-completion.md`

- [ ] **Step 1: Record exact ownership and remaining M2+ work**

只标记 M1 App Decomposition 完成；gapless、Audio Graph、Visual 2.0、Desktop parity 和 Rust API 嵌入仍保持后续里程碑。

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
git diff --exit-code d33dc6e..HEAD -- sidecars/api apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json packages/shared
```

- [ ] **Step 3: Commit evidence**

```powershell
git commit -m "docs: complete M1 app decomposition"
```

## Completion checkpoint

- 所有 Task checkbox 完成；
- `App.tsx` 是装配层且无领域 `useEffect`；
- concrete Sidecar/Tauri/browser storage dependencies 位于 adapters/runtime；
- 所有现有 API 和用户可见行为保持；
- frozen API diff 为空；
- M1 后续开发入口转入 M2 Playback 2.0。

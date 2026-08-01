# M5 Desktop Runtime 基础实施计划

> 本计划只执行 M5。M6 WorkerW/Explorer、M7 Wallpaper Engine、M9 Port 全量收口和未来 `MineRadio-api` 嵌入不得混入。

**Goal：** 在保持 Sidecar/API/shared DTO/现有 Tauri command 行为不变的前提下，把 Rust Desktop shell 深化为可维护的 runtime Modules，补齐 tray/close、普通窗口生命周期、桌面歌词、cache 和 diagnostics/resource governance。

**Architecture：** Tauri command 是稳定 transport Adapter；`WindowRuntimeState` 组合纯 `ShutdownCoordinator`、tray phase、topology 与 coalescing，`HotkeyRuntime`、`DesktopLyricsRuntime`、`CacheRuntime` 和 `DiagnosticsRuntime` 是其他 deep Modules。Web 继续通过 `DesktopRuntimePort` 调用，`App.tsx` 只组合 controllers 与 view props。

**Tech Stack：** Rust 2021、Tauri 2、serde、Tauri plugins、Windows API target dependency、TypeScript、React 19、Bun test、Vite。

**TDD 约束：** 只对 close/shutdown、window topology、desktop lyrics lock/DPI/native input、Overlay clock、cache fallback/stale scan 和 working-set ownership 等核心流程使用 red-green-refactor。文件搬迁、command wiring、普通 UI 和文档不强制先写 RED。

**当前状态：** Code Complete / Windows Field Validation Pending (non-blocking)。代码门禁完成后即可进入 M6；strict evidence runner 已落地，但当前机器不具备 100%+150% 左侧双屏环境，托盘/正常退出 soak 也未取得可接受的实机证据，因此尚不能宣称 `Field Validated / Release Verified`。

**当前施工起点：** 已开始落地 `app/lifecycle.rs`、`app/tray.rs`、`commands/window.rs`、`commands/window_runtime.rs`、`runtime/window.rs`、`runtime/cache.rs` 与 Overlay clock tracer bullets；后续任务深化这些 Module，不另起一套平行结构。

---

## M5 冻结线

实施期间持续验证下列内容没有变化：

- `sidecars/api/**`；
- `packages/shared/**`；
- `apps/web/src/api/sidecar-client.ts` 的请求/响应行为；
- `apps/desktop/scripts/build-sidecar-binary.mjs`；
- `apps/desktop/src-tauri/build.rs`；
- `apps/desktop/src-tauri/tauri.conf.json` 的 `externalBin`；
- `RuntimeConfig.sidecarBaseUrl`、`get_sidecar_status`、Sidecar supervisor/recovery；
- ProviderId、ApiError、media URL；
- 28 个 frozen Tauri command 的名称、参数、返回 shape 与错误语义。

允许的 additive command：

```text
get_window_runtime_state
set_close_behavior
window_show
application_exit
get_cache_snapshot
choose_cache_directory
set_cache_root
clear_cache_category
get_desktop_diagnostics
get_resource_governance
trim_application_working_set
purge_system_memory
```

---

## File map

### Rust app 与 command Adapter

- `apps/desktop/src-tauri/src/app/mod.rs`
- `apps/desktop/src-tauri/src/app/lifecycle.rs`
- `apps/desktop/src-tauri/src/app/tray.rs`
- `apps/desktop/src-tauri/src/app/state.rs`
- `apps/desktop/src-tauri/src/app/desktop_runtime.rs`
- `apps/desktop/src-tauri/src/app/desktop_diagnostics.rs`
- `apps/desktop/src-tauri/src/app/window_labels.rs`
- `apps/desktop/src-tauri/src/commands/mod.rs`
- `apps/desktop/src-tauri/src/commands/runtime.rs`
- `apps/desktop/src-tauri/src/commands/window.rs`
- `apps/desktop/src-tauri/src/commands/window_runtime.rs`
- `apps/desktop/src-tauri/src/commands/updater.rs`
- `apps/desktop/src-tauri/src/commands/dialogs.rs`
- `apps/desktop/src-tauri/src/commands/hotkeys.rs`
- `apps/desktop/src-tauri/src/commands/login.rs`
- `apps/desktop/src-tauri/src/commands/desktop_lyrics.rs`
- `apps/desktop/src-tauri/src/commands/cache.rs`
- `apps/desktop/src-tauri/src/commands/diagnostics.rs`

### Rust deep runtime Modules

- `apps/desktop/src-tauri/src/runtime/window.rs`
- `apps/desktop/src-tauri/src/runtime/window_adapter.rs`
- `apps/desktop/src-tauri/src/runtime/window_contract.rs`
- `apps/desktop/src-tauri/src/runtime/settings.rs`
- `apps/desktop/src-tauri/src/runtime/hotkeys.rs`
- `apps/desktop/src-tauri/src/runtime/desktop_lyrics.rs`
- `apps/desktop/src-tauri/src/runtime/cache.rs`
- `apps/desktop/src-tauri/src/runtime/diagnostics.rs`
- `apps/desktop/src-tauri/src/runtime/resources.rs`

### Web Adapter、controller 与 Overlay

- `apps/web/src/ports/desktop-runtime-port.ts`
- `apps/web/src/adapters/tauri/tauri-desktop-runtime.ts`
- `apps/web/src/tauri/runtime.ts`
- `apps/web/src/features/desktop/useDesktopRuntime.ts`
- `apps/web/src/features/desktop/useDesktopManagementRuntime.ts`
- `apps/web/src/features/desktop/DesktopRuntimeControls.tsx`
- `apps/web/src/desktop-lyrics/custom-lyric-font.ts`
- `apps/web/src/desktop-lyrics/desktop-lyrics-clock.ts`
- `apps/web/src/desktop-lyrics/desktop-lyrics-bridge.ts`
- `apps/web/src/desktop-lyrics/DesktopLyricsRoot.tsx`
- `apps/web/src/desktop-lyrics/DesktopLyricsOverlay.tsx`
- `apps/web/src/desktop-lyrics/DesktopLyricsOverlay.css`

### Guards 与 evidence

- `scripts/architecture/desktop-command-manifest.mjs`
- `scripts/architecture/desktop-command-manifest.test.ts`
- `scripts/architecture/desktop-runtime-boundary.test.ts`
- `scripts/parity/m5/*`
- `docs/parity/capability-matrix.md`
- `docs/parity/upstream-source-map.md`
- umbrella spec 与 M5 progress docs

---

## Task 0：冻结 command 与 API 基线

**类型：** Characterization；不使用 TDD。

**Files：**

- Add: `scripts/architecture/desktop-command-manifest.mjs`
- Add: `scripts/architecture/desktop-command-manifest.test.ts`
- Modify: `scripts/architecture/desktop-runtime-boundary.test.ts`

- [x] **Step 1：记录 28 个 frozen command manifest**

Manifest 至少记录 command 名称、Rust 函数参数名/类型摘要、返回类型摘要和注册顺序。不要把 additive M5 command 混入 frozen 集合。

- [x] **Step 2：建立 registration/invoke 一致性检查**

解析：

```text
tauri::generate_handler![...]
apps/web/src/tauri/runtime.ts invokeTauriCommand("...")
```

断言 frozen command 全部注册，frontend invoke 不引用不存在的 command，additive command 只来自 allowlist。

- [x] **Step 3：记录当前 focused baseline**

```powershell
bun test scripts/architecture/desktop-command-manifest.test.ts scripts/architecture/desktop-runtime-boundary.test.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
bun test apps/web/src/tauri/runtime.test.ts apps/web/src/adapters/tauri/tauri-desktop-runtime.test.ts
```

- [x] **Step 4：验证冻结目录 clean**

```powershell
git diff --exit-code a2e845b -- sidecars/api packages/shared apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/build.rs apps/desktop/src-tauri/tauri.conf.json
```

**候选 commit：** `test(desktop): freeze m5 command manifest`

---

## Task 1：机械拆分 command 与 AppState

**类型：** Mechanical refactor；不使用 TDD。

**Files：**

- Add: `apps/desktop/src-tauri/src/app/{mod,state}.rs`
- Add: `apps/desktop/src-tauri/src/commands/*.rs`
- Add: `apps/desktop/src-tauri/src/runtime/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Remove after migration: `apps/desktop/src-tauri/src/commands.rs`

- [x] **Step 1：建立 module tree 与 re-export**

先保持函数实现原样移动。`commands/mod.rs` re-export frozen command，使 `generate_handler!` 的 command 名称不变。

- [x] **Step 2：按领域移动 command**

```text
runtime.rs        get_runtime_config/get_sidecar_status/get_database_status
window.rs         window/get_window_state/open_external
window_runtime.rs close behavior/tray/show/explicit exit
updater.rs        updater commands
dialogs.rs        import/export JSON
hotkeys.rs        configure_global_hotkeys
login.rs          Netease/QQ login window
desktop_lyrics.rs desktop lyrics commands
cache.rs          M5 additive cache commands（先留空或后续加入）
diagnostics.rs    M5 additive diagnostics commands（先留空或后续加入）
```

- [x] **Step 3：把 AppState 类型移入 `app/state.rs`**

保留 Sidecar、DB 和 config 字段及构造行为。暂时不要顺手修改 Sidecar supervisor。

- [x] **Step 4：保持 helper locality**

登录 Cookie、dialog JSON 等只在对应 command Adapter 内使用的 helper 随领域移动；真正的 lifecycle/geometry/input helper 留给后续 runtime Task，不制造公共 util 文件。

- [x] **Step 5：编译与 manifest 验证**

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
bun test scripts/architecture/desktop-command-manifest.test.ts
```

Expected：所有 frozen command 与 baseline tests 保持绿色。

**候选 commit：** `refactor(desktop): split tauri command adapters`

---

## Task 2：完成 ShutdownCoordinator、WindowRuntime tray phase 与 exactly-once shutdown

**类型：** 核心 TDD。

**Files：**

- Modify: `apps/desktop/src-tauri/src/app/lifecycle.rs`
- Modify: `apps/desktop/src-tauri/src/app/tray.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/window.rs`
- Modify: `apps/desktop/src-tauri/src/commands/window_runtime.rs`
- Modify: `apps/web/src/features/desktop/useDesktopManagementRuntime.ts`
- Add: matching Rust tests
- Modify: `apps/desktop/src-tauri/src/app/state.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/commands/window.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml` if tray feature is required

- [x] **Step 1：RED — close decision table**

用纯状态 fixture 覆盖：

| behavior | close source | expected |
| --- | --- | --- |
| exit | titlebar/OS | request exit |
| tray | titlebar/OS close | prevent + hide |
| tray | tray Exit | cleanup + exit |
| any | repeated exit | cleanup exactly once |
| tray unavailable | set tray | fail closed to exit |

- [x] **Step 2：GREEN — 完成现有 `ShutdownCoordinator`**

沿用已落地的 `CloseBehavior`、`CloseDecision`、`LifecyclePhase`、`request_exit()` 和 `claim_cleanup()`，不另建第二状态机。测试使用 fake cleanup actions，断言只有首次 claim 能执行以下顺序：

```text
stop timers
unregister hotkeys
stop desktop lyrics
stop sidecar supervisor
terminate sidecar child
destroy tray
```

- [x] **Step 3：RED→GREEN — hide 不 cleanup**

测试 close=tray 后：

- cleanup count=0；
- Sidecar supervisor flag 仍 true；
- desktop lyrics watcher desired 不变；
- hotkeys 仍 registered。

- [x] **Step 4：实现 versioned runtime settings**

默认 `exit`。atomic temp + rename；损坏文件保留，使用安全默认并写 diagnostics。

- [x] **Step 5：实现 tray Adapter**

菜单仅“显示 MineRadio / 退出”。click/double-click 与 single-instance callback 共同调用 `reactivate_main_window()`。

- [x] **Step 6：把 cleanup 从 main CloseRequested 移到 lifecycle**

CloseRequested 只请求 decision。显式退出路径调用 `cleanup_once`。不得在 tray hide 时终止 Sidecar 或歌词 watcher。

- [x] **Step 7：加入 additive close behavior commands**

```text
get_window_runtime_state
set_close_behavior
window_show
application_exit
```

保留 `window_close()` 原有签名；它仍触发正常 close event，由 lifecycle 决定 exit/tray。

- [x] **Step 8：验证**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml lifecycle
bun test scripts/architecture/desktop-command-manifest.test.ts
```

**候选 commit：** `feat(desktop): add tray close lifecycle`

---

## Task 3：实现 WindowRuntime 与 HotkeyRuntime

**类型：** Window topology/coalesce 使用核心 TDD；hotkey 搬迁使用 characterization。

**Files：**

- Modify: `apps/desktop/src-tauri/src/runtime/window.rs`
- Add: `apps/desktop/src-tauri/src/runtime/hotkeys.rs`
- Add: matching tests
- Modify: `apps/desktop/src-tauri/src/commands/window.rs`
- Modify: `apps/desktop/src-tauri/src/commands/hotkeys.rs`
- Modify: `apps/desktop/src-tauri/src/app/state.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [x] **Step 1：RED — topology fixtures**

覆盖：

- 单屏 primary；
- 右侧副屏；
- 左侧负 X 副屏；
- 上下排列；
- 窗口跨屏时 display matching；
- display removal fallback；
- 无 monitor query 时 compatibility fallback。

- [x] **Step 2：GREEN — `WindowTopologySnapshot`**

保留 `WindowStateSnapshot` shape，填充真实 `displayBounds/isPrimaryDisplay/hasDisplayOnLeft/hasDisplayOnRight`。

- [x] **Step 3：RED — coalescing publisher**

fake clock 下连续 100 次 move/resize 只产生一次最新 snapshot；focus/scale/show/hide 立即发布；dispose 后不发布。

- [x] **Step 4：GREEN — 单 worker/revision publisher**

删除 event-per-thread debounce。任何窗口同时最多一个 pending worker/timer。

- [x] **Step 5：迁移 HotkeyRuntime**

保持 conflict 字段、Released event 和 `mineradio-global-hotkey` 不变；registration 替换、空列表清理、shutdown 清理集中在 runtime。

- [x] **Step 6：接入 main window events**

`lib.rs` 只将 Tauri event 交给 `WindowRuntimeState`；纯 close decision 来自其内部 `ShutdownCoordinator`，不再内联 snapshot/debounce/cleanup。

- [x] **Step 7：验证**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml window
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml hotkey
bun test apps/web/src/features/desktop/useDesktopRuntime.test.tsx
```

**候选 commit：** `refactor(desktop): deepen window and hotkey runtimes`

---

## Task 4：深化 DesktopLyricsRuntime 并移除 PowerShell helper

**类型：** 核心 TDD。

**Files：**

- Add: `apps/desktop/src-tauri/src/runtime/desktop_lyrics/{mod,state,geometry,input}.rs`
- Add: `apps/desktop/src-tauri/src/platform/windows/{mod,mouse}.rs`
- Add: matching tests
- Modify: `apps/desktop/src-tauri/src/commands/desktop_lyrics.rs`
- Modify: `apps/desktop/src-tauri/src/app/state.rs`
- Modify: `apps/desktop/src-tauri/src/app/lifecycle.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`

- [x] **Step 1：RED — lock single-source lifecycle**

覆盖：

```text
show preserves saved lock
middle click unlocks
main receives lock event
next full payload remains unlocked
second middle click locks
close/reopen preserves effective lock
overlay ready replays payload + lock
```

- [x] **Step 2：GREEN — runtime owns clickThrough**

`desktop_lyrics_update_payload` 在缓存/emit 前应用 runtime 有效锁状态。事件向 main 与 overlay 广播，但 event name/payload 保持兼容。

- [x] **Step 3：RED — logical hot bounds 与 DPI**

覆盖 scale 1/1.25/1.5、负坐标、边缘命中、跨屏后重新缩放。Rust state 保存 logical bounds，不保存永久 physical bounds。

- [x] **Step 4：RED — monitor clamp**

固定上游公式，覆盖：

- 72vw / 38vh；
- min 320×180；
- max monitor - 96；
- `y=0.76`；
- user drag；
- 程序化移动 120ms guard；
- display removal。

- [x] **Step 5：GREEN — shared geometry helper**

show、move_by、scale change、topology change 全部复用同一 clamp implementation。

- [x] **Step 6：RED — native watcher ownership**

fake input Adapter 覆盖 start idempotent、24ms edge、260ms debounce、stop/join、shutdown exactly once、close while starting。

- [x] **Step 7：GREEN — Windows native mouse Adapter**

使用 Rust Windows API `GetAsyncKeyState(VK_MBUTTON)` 与 `GetCursorPos`。删除 PowerShell command、stdout parser 和 `std::process::Child` poller ownership。

- [x] **Step 8：窗口行为**

歌词窗口 transparent/decorations=false/always-on-top/skip-taskbar；show/reconcile 不抢 main focus。只在 enabled 时运行 watcher。

- [x] **Step 9：Overlay hot bounds 外扩**

Web viewport rect 使用 `padX=26..72`、`padY=24..56`；resize/font/text/scale 变化重报。

- [x] **Step 10：验证**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml desktop_lyrics
bun test apps/web/src/desktop-lyrics/desktop-lyrics-push.test.ts apps/web/src/desktop-lyrics/DesktopLyricsOverlay.test.tsx apps/web/src/desktop-lyrics/DesktopLyricsRoot.test.tsx
```

并确认代码中不再出现桌面歌词 PowerShell helper：

```powershell
rg -n "powershell|GetAsyncKeyState|DesktopLyricsPollerChild" apps/desktop/src-tauri/src
```

Expected：`GetAsyncKeyState` 只在 Windows Rust Adapter；无 PowerShell 与 poller child。

**候选 commit：** `feat(desktop-lyrics): add native lifecycle and monitor safety`

---

## Task 5：实现 Overlay 自主时钟和电影运动

**类型：** 核心 TDD。

**Files：**

- Add: `apps/web/src/desktop-lyrics/desktop-lyrics-clock.ts`
- Add: `apps/web/src/desktop-lyrics/desktop-lyrics-clock.test.ts`
- Add: `apps/web/src/desktop-lyrics/desktop-lyrics-motion.ts`
- Add: `apps/web/src/desktop-lyrics/desktop-lyrics-motion.test.ts`
- Modify: `apps/web/src/desktop-lyrics/DesktopLyricsRoot.tsx`
- Modify: `apps/web/src/desktop-lyrics/DesktopLyricsOverlay.tsx`
- Modify: `apps/web/src/desktop-lyrics/DesktopLyricsOverlay.css`

- [x] **Step 1：RED — monotonic clock**

使用 injected fake clock 覆盖：

- playing 外推；
- paused hold；
- playbackRate；
- duration clamp；
- seek/new payload replacement；
- line progress `0..1`；
- dispose 后无 tick。

- [x] **Step 2：GREEN — one Overlay scheduler**

按 24/30/60/120fps gate，仅在歌词 WebView 内运行。主窗口只发送语义 payload，不逐帧 invoke。

- [x] **Step 3：RED — beat/cinema policy**

覆盖 cameraBeats/pulseBeats/kicks、相同 beat 不重复触发、seek-back reset、`cinema=false`、`reduceMotion=true`。

- [x] **Step 4：GREEN — bounded CSS variables**

Overlay motion 只输出 progress/scroll/pulse/glow/bass/translate/scale。不得创建 AudioContext、Three.js renderer 或第二视觉 scheduler。

- [x] **Step 5：Root 生命周期**

payload event 只更新 anchor；scheduler mount once、unmount dispose。字体/layout 更新触发重测，不重建 scheduler。

- [x] **Step 6：验证**

```powershell
bun test apps/web/src/desktop-lyrics/desktop-lyrics-clock.test.ts apps/web/src/desktop-lyrics/desktop-lyrics-motion.test.ts apps/web/src/desktop-lyrics/DesktopLyricsOverlay.test.tsx apps/web/src/desktop-lyrics/DesktopLyricsRoot.test.tsx
bun run --filter ./apps/web typecheck
```

**候选 commit：** `feat(desktop-lyrics): keep overlay clock alive in background`

---

## Task 6：加入 Web-local 自定义歌词字体

**类型：** 普通单元/集成测试；不要求 RED-first。

**Files：**

- Add: `apps/web/src/features/desktop/custom-lyric-fonts.ts`
- Add: matching tests
- Modify: `apps/web/src/visual/VisualControlPanelHost.tsx` or feature slot host
- Modify: `apps/web/src/stores/visual-store.ts`
- Modify: `apps/web/src/features/desktop/desktop-lyrics-payload.ts`
- Modify: `apps/web/src/desktop-lyrics/DesktopLyricsRoot.tsx`

- [x] **Step 1：实现 versioned bounded store**

支持 ttf/otf/woff/woff2；单文件 ≤3.6MiB；id/family/name/dataUrl/size/savedAt；数量与总 bytes 有界；损坏记录忽略并保留诊断。

- [x] **Step 2：实现 FontFace registration**

主 WebView 和歌词 WebView 各自按 `custom:<id>` 注册；同 id/family 幂等；失败回退现有字体。

- [x] **Step 3：加入上传/选择/删除 UI**

UI 可以嵌入现有歌词字体区，但读写逻辑必须留在 feature Module。visual host 只转发 callbacks。

- [x] **Step 4：保持 shared DTO 不变**

Desktop payload 仅使用现有 `fontFamily`。不得修改 `packages/shared/src/desktop.ts`，不得通过 invoke 发送 font bytes。

- [x] **Step 5：字体完成后 remeasure**

Overlay load 成功后重新计算 line layout、scroll 和 hot bounds。

- [x] **Step 6：验证**

```powershell
bun test apps/web/src/features/desktop/custom-lyric-fonts.test.ts apps/web/src/desktop-lyrics
bun test packages/shared
git diff --exit-code a2e845b -- packages/shared
```

**候选 commit：** `feat(lyrics): add shared-origin custom font storage`

---

## Task 7：实现 CacheRuntime settings、fallback 与 usage

**类型：** settings/fallback/stale scan 使用核心 TDD；command/UI wiring 不使用 TDD。

**Files：**

- Modify: `apps/desktop/src-tauri/src/runtime/cache.rs`
- Add: matching tests
- Modify: `apps/desktop/src-tauri/src/app/state.rs`
- Modify: `apps/desktop/src-tauri/src/commands/cache.rs`
- Modify: `apps/web/src/features/desktop/useDesktopManagementRuntime.ts`

- [x] **Step 1：RED — path normalization**

覆盖 empty、relative、unavailable drive、read-only root、Unicode path、configured!=active 和 fallback。

- [x] **Step 2：GREEN — CacheRuntime initialization**

默认 `<app-data>/cache`。准备 audio/images/lyrics/beatmaps/temp。自定义 root 不可用时 active 使用 `<app-data>/cache-fallback`，configured 保持。

- [x] **Step 3：RED — atomic setting**

覆盖 temp write/rename、损坏 settings、失败不覆盖旧值、restartRequired。

- [x] **Step 4：RED — usage generation**

新 scan 使旧 generation stale；symlink/junction 不跟随；单目录失败返回 partial；total 只包含 managed categories。

- [x] **Step 5：GREEN — on-demand `spawn_blocking` scan**

禁止在 app setup 同步递归 scan。

- [x] **Step 6：实现 additive commands**

```text
get_cache_snapshot
choose_cache_directory
set_cache_root
clear_cache_category
```

`choose_cache_directory` 使用现有 dialog plugin，command 返回取消/选择结果，不直接改变设置。

- [x] **Step 7：RED→GREEN — 受管分类清理 containment**

只接受 `CacheCategory::{Audio,Images,Lyrics,Beatmaps,Temp}`。测试覆盖：

- category root 必须是 canonical cache root 的真子目录；
- root 本身、app-data、credentials、SQLite、logs、Sidecar session 全部拒绝；
- symlink/junction/reparse point 不被跟随；
- category 不存在时只重建空目录；
- 清理返回 removed bytes/files/directories/links；
- 任一 containment 校验失败时零删除。

- [x] **Step 8：验证**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cache
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

**候选 commit：** `feat(desktop): add safe cache runtime`

---

## Task 8：实现 DiagnosticsRuntime 与 working-set policy

**类型：** ownership/foreground/cooldown 使用核心 TDD；snapshot mapping 不要求 RED-first。

**Files：**

- Add: `apps/desktop/src-tauri/src/runtime/resources/{mod,diagnostics,working_set}.rs`
- Add: `apps/desktop/src-tauri/src/platform/windows/memory.rs`
- Add: matching tests
- Modify: `apps/desktop/src-tauri/src/app/state.rs`
- Modify: `apps/desktop/src-tauri/src/app/lifecycle.rs`
- Modify: `apps/desktop/src-tauri/src/commands/diagnostics.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`

- [x] **Step 1：定义 immutable native snapshot**

组合 runtime/window/tray/hotkey/lyrics/cache/Sidecar/DB/process memory 和 bounded recent errors。读取不得触发 scan、trim 或 recovery。

- [x] **Step 2：RED — process ownership**

fixture 覆盖 current PID、verified descendants、PID reuse、unrelated process、已退出 process。无法证明 ownership 一律跳过。

- [x] **Step 3：RED — trim policy**

覆盖 foreground-visible skip、hidden/minimized allow、120s cooldown、in-flight skip、manual-force、unsupported platform。

- [x] **Step 4：GREEN — Windows ProcessMemoryAdapter**

读取 before/after working set；只对 verified process tree 调用 working-set trim。错误按 PID 记录，不中断其余 PID。

- [x] **Step 5：background schedule**

main hide/minimize/tray hide 后至少 4s 请求 trim；重新 show/focus 使 activity guard 跳过；shutdown 关闭 runtime ownership，使 pending worker 不再执行 trim。

- [x] **Step 6：实现 additive commands**

```text
get_desktop_diagnostics
get_resource_governance
trim_application_working_set
purge_system_memory
```

系统级 purge 只报告 capability unavailable；不加入提权 helper。

- [x] **Step 7：验证**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml resources
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml lifecycle
```

**候选 commit：** `feat(desktop): add diagnostics and working set governance`

---

## Task 9：扩展 DesktopRuntimePort 与 Web controllers

**类型：** Adapter/controller tests；不要求所有步骤 RED-first。

**Files：**

- Modify: `apps/web/src/ports/desktop-runtime-port.ts`
- Modify: `apps/web/src/tauri/runtime.ts`
- Modify: `apps/web/src/tauri/runtime.test.ts`
- Modify: `apps/web/src/adapters/tauri/tauri-desktop-runtime.ts`
- Modify: adapter tests
- Modify: `apps/web/src/features/desktop/useDesktopRuntime.ts`
- Modify: `apps/web/src/features/desktop/useDesktopRuntime.test.tsx`
- Add: `apps/web/src/features/desktop/useDesktopResourceController.ts`
- Add: matching tests
- Add: `apps/web/src/features/desktop/DesktopRuntimeControls.tsx`
- Add: matching tests
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/AppShell.tsx` or existing control-panel slot

- [x] **Step 1：additive Port types**

加入 close/cache/diagnostics/trim typed methods。browser fallback 返回 exit/default cache/unsupported diagnostics，不抛异常。

- [x] **Step 2：Tauri Adapter mapping**

所有 snake_case → camelCase mapping 集中在 `tauri/runtime.ts`。View/controller 不接触 raw Rust shape。

- [x] **Step 3：锁状态闭环**

`useDesktopRuntime` 监听 native `desktop-lyrics-lock-changed`，更新 visual store 的 `desktopLyricsClickThrough`，随后强推 payload。测试中键解锁后下一次 payload 不回滚。

- [x] **Step 4：实现 resource controller**

controller 拥有 load/set/refresh/in-flight/error。cache scan 与 diagnostics refresh 有 generation guard；unmount 后不 commit。

- [x] **Step 5：实现 DesktopRuntimeControls**

显示 close selector、configured/active cache root、restartRequired、usage、refresh、trim 和 diagnostics summary。不得把原始 invoke 放入 view。

- [x] **Step 6：Visual diagnostics Adapter**

通过现有 Visual Engine facade 的只读 performance snapshot 组合 native diagnostics；不要让 Rust 伪造 GPU 数据，也不要让 desktop feature import Three.js。

- [x] **Step 7：保持 App.tsx 薄**

`App.tsx` 只调用 controllers 并传 props。architecture guard 禁止：

```text
invokeTauriCommand(
listenTauriEvent(
recursive cache scan
direct tray state
```

- [x] **Step 8：验证**

```powershell
bun test apps/web/src/tauri/runtime.test.ts apps/web/src/adapters/tauri/tauri-desktop-runtime.test.ts apps/web/src/features/desktop scripts/architecture/desktop-runtime-boundary.test.ts
bun run --filter ./apps/web typecheck
```

**候选 commit：** `feat(web): expose desktop runtime controls`

---

## Task 10：完成跨窗口/退出集成与 architecture guards

**类型：** Integration/characterization；不使用 TDD。

**Files：**

- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `scripts/architecture/desktop-command-manifest.*`
- Modify: `scripts/architecture/desktop-runtime-boundary.test.ts`
- Add/Modify: Rust integration tests

- [x] **Step 1：收口 lib.rs**

`lib.rs` 只保留：

```text
resolve startup paths/settings
construct AppState runtimes
register plugins
register command manifest
delegate setup/window/run events
run application
```

禁止保留内联 poller、debounce、tray menu 或 shutdown sequence。

- [x] **Step 2：Sidecar ownership integration**

验证：

- tray hide 不修改 `sidecar_supervisor_running`；
- explicit exit 置 false 并只 take/terminate child 一次；
- Sidecar recovery status 和 log path 不变；
- login Cookie 注入仍可调用当前 base URL。

- [x] **Step 3：桌面歌词 ownership integration**

验证 show/close/tray/exit/overlay reload/monitor reconcile 的 watcher 与 window ownership。

- [x] **Step 4：command Module guard**

断言：

- 不再存在 monolithic `commands.rs`；
- command 文件不包含 PowerShell、recursive directory walk、shutdown sequence；
- runtime Module 不依赖 Web、Sidecar route 或 shared TypeScript。

- [x] **Step 5：冻结 diff**

```powershell
git diff --exit-code a2e845b -- sidecars/api packages/shared apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/build.rs apps/desktop/src-tauri/tauri.conf.json
bun test scripts/architecture/verify-convergence-baseline.test.ts scripts/architecture/desktop-command-manifest.test.ts
```

**候选 commit：** `refactor(desktop): complete m5 runtime ownership`

---

## Task 11：Windows 实机 soak 与 M5 evidence

**类型：** Manual/automated evidence；不使用 TDD。

**Files：**

- Add: `scripts/parity/m5/*`
- Add: `output/parity/m5/...`（只保留 manifest/必要文本，按仓库 artifact 规则处理）
- Modify later: parity docs

- [x] **Step 1：建立 evidence runner**

Runner/manifest 记录：

- git commit 与 clean status；
- Windows build/version；
- monitor bounds/scale；
- close behavior；
- PID/process tree；
- tray actions；
- desktop lyrics payload generation/clock；
- cache paths/usage；
- working-set before/after；
- console/runtime errors。

- [ ] **Step 2：close=exit**

关闭主窗口后主进程与 Sidecar child 均退出，无 PowerShell/helper 残留。

- [ ] **Step 3：close=tray**

隐藏 30 秒：

- playback 继续；
- Sidecar ready/recovery 继续；
- hotkeys 可用；
- desktop lyrics progress/scroll/cinema 继续；
- main process 未 cleanup。

- [ ] **Step 4：reactivation**

tray click、double click 和 second-instance 均执行 show → unminimize → focus。

- [ ] **Step 5：DPI/monitor soak**

100% + 150% 双屏，副屏位于主屏左侧：

- 拖动歌词跨屏；
- 热区内/外中键；
- display disable/remove；
- 重新连接；
- bounds/scale/hot area 正确。

- [ ] **Step 6：font/background soak**

中文自定义字体首载、切歌、main hide、overlay close/reopen、删除字体；无布局卡死或锁状态回滚。

- [ ] **Step 7：cache/resource soak**

不可用 cache drive fallback；大目录 usage scan 不阻塞首屏；foreground trim skipped；tray/background trim 有 before/after。

- [ ] **Step 8：strict field/release evidence gate**

以下任一发生则不得宣称 `Field Validated / Release Verified`；这些人工证据不阻塞 M5 Code Complete 或进入 M6：

- orphan Sidecar/helper；
- tray hide 触发 cleanup；
- lock state 回滚；
- monitor removal 后窗口不可见；
- main hidden 时歌词停止；
- cache scan 阻塞 UI 或越过 root；
- working-set 处理未验证 PID；
- frozen API/shared diff 非零。

**候选 commit：** `test(parity): capture m5 desktop runtime evidence`

---

## Task 12：全仓验证与文档收口

**类型：** Verification/docs；不使用 TDD。

**Files：**

- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/parity/upstream-source-map.md`
- Modify: `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md`
- Modify: 本 M5 design/plan 的状态和 checklist

- [x] **Step 1：Rust 格式、lint、tests**

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-features
```

- [x] **Step 2：Focused Web/architecture**

```powershell
bun test apps/web/src/features/desktop apps/web/src/desktop-lyrics apps/web/src/tauri/runtime.test.ts apps/web/src/adapters/tauri/tauri-desktop-runtime.test.ts scripts/architecture --parallel=1
bun run --filter ./apps/web typecheck
```

- [x] **Step 3：全仓**

```powershell
bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture
bun run typecheck
bun run web:build
```

- [x] **Step 4：冻结与 hygiene**

```powershell
git diff --check
git diff --exit-code a2e845b -- sidecars/api packages/shared apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/build.rs apps/desktop/src-tauri/tauri.conf.json
git status --short
```

- [x] **Step 5：依据代码审计与 evidence 分级更新状态**

代码门禁与独立审计通过后：

- 把 `desktop.window`、`desktop.lyrics` 和 M5 resource/cache 项标记为 `implemented`；
- verification 标记为 `field-validation-pending`，`blocked_by` 保持 `none`；
- 将 umbrella 中 M4 的陈旧 Open 状态修正为 Complete；
- 把 M5 标记为 `Code Complete / Windows Field Validation Pending (non-blocking)`。

只有 strict evidence 通过后才：

- 晋升为 `Field Validated / Release Verified`；
- 记录 Windows evidence manifest。

- [x] **Step 6：独立 review**

审查必须覆盖：

- command freeze；
- tray/exit cleanup races；
- Sidecar ownership；
- native input thread lifecycle；
- DPI/negative coordinates；
- cache path traversal/reparse point；
- working-set PID ownership；
- App.tsx/command Module locality；
- M6/M7/M9 scope leakage。

Critical/Important 必须清零。

**候选 final commit：** `feat(desktop): complete m5 runtime foundation`

---

## Completion checklist

- [x] 28 frozen commands + additive allowlist guard 通过
- [x] Sidecar/API/shared DTO/Provider/media URL/package freeze 通过
- [x] command Adapter 拆分且 `commands.rs` monolith 删除
- [x] `ShutdownCoordinator` / `WindowRuntimeState` 与 cleanup_once 完成
- [x] close default exit / optional tray 完成
- [x] tray hide 保持 Sidecar/playback/hotkeys/lyrics（核心状态机/集成测试通过；实机 soak 待补）
- [x] `WindowRuntime` topology/coalesce 完成
- [x] `HotkeyRuntime` 生命周期完成
- [x] 桌面歌词 Rust runtime/lock replay/DPI/monitor clamp 完成
- [x] PowerShell/helper process 删除
- [x] Overlay autonomous clock 与 cinema/beat policy 完成
- [x] custom font 完成且 shared DTO 零修改
- [x] CacheRuntime settings/fallback/usage 与受管分类安全清理完成
- [x] DiagnosticsRuntime + visual composition 完成
- [x] working-set ownership/foreground/cooldown guard 完成
- [x] 核心 TDD suites 通过
- [x] Rust/Bun focused 与全仓验证通过
- [ ] Windows tray/DPI/background/cache/memory evidence 通过
- [x] 独立 review 无 Critical/Important（自动架构门通过，仍需 Windows evidence review）
- [x] capability matrix 与 umbrella 已按“Code Complete / field-validation-pending”分级更新；实机状态未提前晋升为 Field Validated / Release Verified

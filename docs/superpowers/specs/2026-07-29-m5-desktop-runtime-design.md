# M5 Desktop Runtime 基础设计

**日期：** 2026-07-29

**状态：** Code Complete / Windows Field Validation Pending (non-blocking)

**基线：** `a2e845b`（M4 Lyrics 与 Visual Parity complete）

**上位设计：** `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md`

**上游行为基线：** Mineradio Electron 2.0.2，`4abaa190de42c632365ae4244e041bad16443224`

**当前施工起点：** `app/lifecycle.rs`、`app/tray.rs`、`commands/window.rs`、`commands/window_runtime.rs`、`runtime/window.rs`、`runtime/cache.rs` 与 Overlay clock 已开始以 tracer bullet 方式落地；本设计深化这些 Module，不建立平行实现。

## 1. 背景

M1 至 M4 已经把 Web 应用编排、播放会话和视觉运行时从 `App.tsx` 与旧视觉实现中逐步抽离。Desktop Runtime 仍停留在早期迁移形态：

- `apps/desktop/src-tauri/src/commands.rs` 约 2573 行，command、窗口实现、登录、桌面歌词、原生输入与纯函数测试混在同一文件；
- `apps/desktop/src-tauri/src/lib.rs` 同时装配 `AppState`、Sidecar supervisor、窗口事件与退出清理；
- 主窗口 `CloseRequested` 当前直接停止 Sidecar supervisor 和桌面歌词输入轮询，没有“隐藏到托盘”语义；
- 主窗口窗口状态仍使用占位 topology，`isPrimaryDisplay`、左右显示器和 display bounds 不是真实值；
- move/resize debounce 每次事件都创建新线程，没有 coalesce；
- 桌面歌词已有窗口、payload replay、click-through、中键轮询和长歌词布局骨架，但锁定状态、DPI、显示器变化、后台刷新和电影运动尚未闭环；
- Windows 中键检测仍依赖额外 PowerShell 子进程；
- Tauri Desktop interface 尚未提供缓存根目录、使用量、工作集和统一诊断能力。

M5 的目标不是继续堆 command，而是把 Desktop Runtime 深化为少量高 **Depth** 的 **Module**。Tauri command 只保留 transport **Adapter** 角色，生命周期、状态转换和资源所有权集中在 runtime **Seam** 后面，从而提高 caller 的 **Leverage** 和维护者的 **Locality**。

## 2. 目标

M5 完成后必须满足：

1. `commands.rs` 拆为按领域组织的 command Adapter，现有 command 名称、参数和返回值保持不变；
2. `AppState`、启动装配、窗口事件和 shutdown ownership 分离；
3. 默认关闭行为仍为 `exit`，用户可选择 `tray`；托盘隐藏不停止播放、Sidecar、热键或桌面歌词；
4. 显式退出、系统退出和 fatal startup cleanup 汇合到 exactly-once shutdown；
5. 主窗口 snapshot 使用真实 monitor topology，move/resize 事件由一个 coalescing publisher 处理；
6. 全局快捷键注册、替换、清空和退出释放由独立 runtime 持有；
7. 桌面歌词补齐自定义字体、节拍/电影运动、主窗口后台刷新、中键临时解锁闭环、DPI/负坐标/显示器变化修正；
8. Windows 中键输入不再创建 PowerShell 或其他 helper 进程；
9. 新增 Tauri-owned cache settings、按分类使用量、安全 fallback 与受管分类清理，不自动搬迁或越权删除用户数据；
10. 新增 native/visual/cache/window/Sidecar 组合诊断与应用工作集整理；
11. Sidecar、API、shared DTO、Provider、media URL 和现有 Tauri command 行为保持冻结；
12. 核心生命周期与资源治理使用 TDD，机械拆分和普通 wiring 不强制先写测试。

## 3. 非目标与禁区

### 3.1 M6 禁区

M5 不得实现或预埋可执行的完整桌面能力：

- WorkerW/Progman/Explorer 宿主发现或 attach；
- Explorer 桌面图标显示、隐藏、交互锁和透明 shielding；
- 完整桌面状态机、恢复 journal、Explorer restart reconcile；
- 把主窗口转换为桌面子窗口；
- full-desktop 托盘菜单项及其 rollback。

M5 的 monitor topology 只服务普通顶层主窗口和桌面歌词窗口。

### 3.2 M7 禁区

M5 不包含：

- Wallpaper Engine library/project discovery；
- Scene 进程启动、捕获、静音、pointer relay；
- DWM/WGC surface；
- Wallpaper 与完整桌面的协同。

Cache snapshot 不扫描或管理 Wallpaper Engine 项目。

### 3.3 M9 与未来 Rust API 禁区

M5 不包含：

- `MineRadio-api` crate、git dependency、path dependency 或嵌入；
- Rust Provider、Tauri invoke 业务 API 或 custom media protocol；
- 删除/替换 Bun Sidecar；
- 修改 Sidecar route、响应 envelope、错误字段、登录 Cookie 注入或媒体 URL；
- 删除 Sidecar supervisor、build script、`externalBin` 或 recovery UI；
- Port/legacy adapter 的 M9 全量收口。

### 3.4 其他非目标

- 不改播放时钟、Audio Graph、gapless、crossfade 或 output routing；
- 不建设 M8 的完整设置工作台和用户数据迁移体系；
- 不重写 Stage Lyrics、Sonic Topography 或 Shelf；
- 不把桌面歌词改造成第二套视觉引擎；
- 不默认提权，不在前台播放时自动执行系统级内存释放；
- 不实现 app-data 根清理、任意路径删除、目录搬迁或自动删除；M5 只允许用户显式清理 `CacheRuntime` 创建并验证过的受管分类。

## 4. 冻结契约

### 4.1 Sidecar 与业务 API 冻结

以下内容在 M5 中必须保持：

- `src-tauri/src/sidecar.rs`、Sidecar child ownership、3 秒 supervisor 和 health recovery；
- `RuntimeConfig.sidecarBaseUrl` 与 `get_sidecar_status`；
- `apps/desktop/scripts/build-sidecar-binary.mjs`；
- `build.rs` Sidecar 构建；
- `tauri.conf.json` 的 `externalBin`；
- `sidecars/api/**` 与 Bun workspace；
- 登录窗口完成后的 Cookie 注入链；
- `SidecarClient`、legacy adapter、`SidecarRecoveryNotice`；
- ProviderId、ApiError、媒体代理 URL 和 Sidecar JSON 行为。

### 4.2 shared DTO 冻结

M5 不修改 `packages/shared` 的业务或 desktop schema，包括 `DesktopLyricsPayloadSchema`。桌面歌词新增行为使用：

- 现有 payload 字段；
- Web-local typed state；
- 现有/新增的 Tauri-only event；
- 同源 WebView 的本地字体存储。

自定义字体不会把 `dataUrl` 塞进 shared DTO，也不会扩大 Sidecar DTO。

### 4.3 现有 command 冻结

当前 `tauri::generate_handler!` 中的 28 个 command 是冻结 manifest。拆文件后仍以相同名称、参数名、serde casing、返回 shape 和错误字符串暴露：

```text
get_runtime_config
get_sidecar_status
get_database_status
configure_global_hotkeys
get_updater_status
check_for_update
install_update
window_minimize
window_toggle_maximize
window_toggle_fullscreen
window_close
get_window_state
open_external
export_json_file
import_json_file
desktop_lyrics_show_window
desktop_lyrics_close_window
desktop_lyrics_set_click_through
desktop_lyrics_move_by
desktop_lyrics_set_hot_bounds
desktop_lyrics_update_payload
desktop_lyrics_overlay_ready
login_netease_show_window
login_qq_show_window
login_netease_complete
login_qq_complete
login_netease_close_window
login_qq_close_window
```

M5 可以增加 additive command，但不得重命名或复用旧 command 表达新语义。command manifest guard 同时检查：

- 28 个 frozen command 全部存在；
- frozen command 参数/返回 fixture 不变；
- M5 additive command 只来自批准的 allowlist；
- frontend invoke 名称与 Rust registration 一致。

建议的 additive command：

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

## 5. 设计原则

### 5.1 Command 是 Adapter，不是业务 Module

Command 的 **Interface** 由前端已知的名称、参数、返回值、错误和调用顺序组成。command implementation 只负责：

1. 从 `tauri::State` 取 runtime；
2. 做 transport-level deserialize/serialize；
3. 调用 deep runtime Module；
4. 把 runtime error 无损映射成现有字符串或新 typed result。

Command 不再持有窗口状态机、原生输入线程、cache walk 或 shutdown 顺序。

### 5.2 Deep runtime Module

M5 选择以下 Module：

| Module | 小 Interface 后隐藏的 implementation | Leverage / Locality |
| --- | --- | --- |
| `WindowRuntimeState` + `ShutdownCoordinator` | close policy、tray phase、reactivation、lifecycle phase、cleanup claim、snapshot、monitor topology、clamp、event coalesce | 所有普通窗口与退出路径共享一致状态和一次正确清理 |
| `HotkeyRuntime` | 注册替换、冲突、事件、清空、shutdown | command 和 app cleanup 不再各自管理插件状态 |
| `DesktopLyricsRuntime` | 窗口、payload replay、锁、热区、DPI、native input、topology | 桌面歌词 bug 与资源所有权集中 |
| `CacheRuntime` | settings、active/configured root、fallback、usage scan | UI 不理解路径、原子文件和扫描细节 |
| `DiagnosticsRuntime` | native snapshot、bounded errors、process tree、working-set policy | 诊断与资源动作使用同一事实来源 |

对这些 Module 应用 deletion test：删除任一个都会让状态转换、清理或几何规则重新散落到多个 command/事件 caller，因此它们提供真实 Depth。相反，`commands/*` 是有意保持很薄的 transport Adapter，不以文件数量伪装 Depth。

### 5.3 Seam 只放在会变化的位置

真实 external seam：

- `NativeInputAdapter`：Windows 实现与 unsupported/noop 实现；
- `ProcessMemoryAdapter`：Windows 实现与 unsupported snapshot；
- `RuntimeSettingsStore`：文件实现与 memory test Adapter；
- `MonitorTopologyAdapter`：Tauri implementation 与 deterministic fake。

普通纯函数不再为“可测试”额外包一层 trait。内部 helper 保持 package-private。

## 6. 目标结构

```text
apps/desktop/src-tauri/src/
├─ lib.rs                         # 只装配 Builder、plugins、state、handlers
├─ app/
│  ├─ mod.rs
│  ├─ lifecycle.rs               # 纯 ShutdownCoordinator 状态机
│  ├─ tray.rs                    # Tauri tray Adapter
│  ├─ state.rs                   # AppState 与 runtime ownership
│  ├─ desktop_runtime.rs         # 窗口事件与 exactly-once cleanup 编排
│  ├─ desktop_diagnostics.rs     # 只读 probe 与显式资源动作编排
│  └─ window_labels.rs           # Tauri 窗口身份的单一事实来源
├─ commands/
│  ├─ mod.rs                     # re-export 与 frozen manifest
│  ├─ window.rs                  # 既有 window command Adapter
│  ├─ window_runtime.rs          # M5 close/tray/show/exit Adapter
│  ├─ runtime.rs
│  ├─ updater.rs
│  ├─ dialogs.rs
│  ├─ hotkeys.rs
│  ├─ login.rs
│  ├─ desktop_lyrics.rs
│  ├─ cache.rs
│  └─ diagnostics.rs
├─ runtime/
│  ├─ mod.rs
│  ├─ window.rs                  # pure WindowRuntimeState/topology/geometry
│  ├─ window_adapter.rs          # Tauri window/topology/state publisher Adapter
│  ├─ window_contract.rs         # command re-export 的稳定窗口 DTO
│  ├─ settings.rs                # versioned native runtime settings
│  ├─ cache.rs                   # deep CacheRuntime/scan/clear containment
│  ├─ hotkeys.rs
│  ├─ desktop_lyrics.rs          # geometry、state 与 Windows input ownership
│  ├─ diagnostics.rs             # immutable typed snapshot aggregator
│  └─ resources.rs               # working-set policy 与 Windows process identity
```

`runtime/window.rs` 保持纯策略与几何，Tauri-specific 实现集中在 `window_adapter.rs`；其余 runtime 只有在 ownership 或测试 cadence 真正不同的情况下才继续拆分，避免为了目录整齐制造浅 pass-through。

Web 侧：

```text
apps/web/src/
├─ ports/desktop-runtime-port.ts
├─ adapters/tauri/tauri-desktop-runtime.ts
├─ tauri/runtime.ts
├─ features/desktop/
│  ├─ useDesktopRuntime.ts
│  ├─ useDesktopResourceController.ts
│  ├─ DesktopRuntimeControls.tsx
│  ├─ desktop-lyrics-payload.ts
│  └─ custom-lyric-fonts.ts
└─ desktop-lyrics/
   ├─ desktop-lyrics-clock.ts
   ├─ desktop-lyrics-motion.ts
   ├─ desktop-lyrics-bridge.ts
   ├─ DesktopLyricsRoot.tsx
   └─ DesktopLyricsOverlay.tsx
```

## 7. AppState 与 shutdown ownership

### 7.1 AppState

`AppState` 持有 runtime，而不是公开所有内部 mutex：

```rust
pub struct AppState {
    pub config: RuntimeConfig,
    pub window_runtime: Mutex<WindowRuntimeState>,
    pub desktop_lyrics: Mutex<DesktopLyricsRuntimeState>,
    pub cache: Option<Arc<Mutex<CacheRuntime>>>,
    pub diagnostics: DiagnosticsRuntime,
    pub resources: ResourceGovernor,

    // M0-M9 冻结 ownership
    pub sidecar: Mutex<sidecar::SidecarRuntimeState>,
    pub sidecar_supervisor_running: AtomicBool,
    pub db: Option<Mutex<db::DbRuntimeState>>,
    pub db_init_error: Option<String>,
}
```

`HotkeyRuntime` 直接封装 Tauri global-shortcut plugin，不在 `AppState` 复制 registration 状态；
close preference 由 Web `useDesktopManagementRuntime` 使用稳定 localStorage key 持久化，Rust 只持有当前生命周期决策。

Sidecar 字段暂时保留原位，避免 M5 偷做 API runtime 重构。

### 7.2 ShutdownCoordinator 与 WindowRuntime

`app/lifecycle.rs` 提供纯 `ShutdownCoordinator`；`runtime/window.rs` 的 `WindowRuntimeState` 持有它并组合 tray phase、topology 与 debounce generation：

```rust
enum CloseBehavior { Exit, Tray }
enum CloseDecision { Exit, HideToTray, Ignore }
enum LifecyclePhase { Running, HiddenToTray, Exiting, Cleaned }
```

核心 **Interface**：

```rust
set_close_behavior(...)
request_close(...)
request_show(...)
request_exit(...)
claim_cleanup(...)
schedule_state_emit(...)
```

不变量：

- 默认 `CloseBehavior::Exit`；
- `Tray` + 普通 close：`prevent_close()` → hide，不调用 cleanup；
- 托盘“退出”、OS exit 或显式 exit：进入 `LifecyclePhase::Exiting`，只允许一个 caller 通过 `claim_cleanup()` 取得 cleanup ownership；
- cleanup 顺序固定：停止 topology/trim timer → unregister hotkeys → 停止桌面歌词 watcher 并关闭歌词窗口 → 停止 Sidecar supervisor → terminate verified Sidecar child → destroy tray → exit；
- cleanup 幂等，任何资源最多释放一次；
- 不在持有 runtime mutex 时调用窗口、plugin 或 child wait；
- tray hide 后 Sidecar、Audio、全局热键和桌面歌词继续运行；
- tray 创建失败时 fail closed，close 行为回退为 exit，并返回可诊断错误；
- single-instance reactivation 和 tray click 使用同一个 `reactivate_main_window()`。

## 8. 托盘与关闭行为

托盘菜单在 M5 只包含：

```text
显示 MineRadio
──────────────
退出
```

M6 的“退出完整桌面模式”不得提前加入。

关闭行为保存在 versioned native settings 中，使 Rust 在 Web 首次同步之前也有确定语义：

```json
{
  "version": 1,
  "closeBehavior": "exit",
  "cacheRoot": "..."
}
```

写入使用同目录临时文件、flush、atomic rename。文件损坏时：

- 记录诊断；
- 使用 `exit` 和默认 cache root；
- 不覆盖原损坏文件，保留给诊断导出。

前端仍通过 `DesktopRuntimePort` 读写偏好，不直接访问文件。

## 9. WindowRuntime

### 9.1 真实 topology snapshot

`get_window_state` 返回 shape 不变，但值来自真实 monitor topology：

- `displayBounds` 为当前窗口匹配显示器的物理 bounds；
- `isPrimaryDisplay` 按 monitor position/primary identity 推导；
- `hasDisplayOnLeft` / `hasDisplayOnRight` 按其他 monitor 与当前 display bounds 的相对关系推导；
- 负坐标必须保留；
- monitor 查询失败时才使用当前兼容 fallback。

### 9.2 单 publisher coalesce

当前每个 move/resize 都 spawn 80ms thread。M5 改为一个 `WindowStatePublisher`：

- move/resize 只更新 revision 与 deadline；
- 同一窗口同时最多一个 worker/timer；
- deadline 到期只发布最新 snapshot；
- focus、scale、show/hide、maximize/fullscreen 立即发布；
- dispose 后 pending revision 不再 emit。

该 Module 的 Interface 只暴露 `publish_now()`、`publish_debounced()` 和 `dispose()`。

### 9.3 普通窗口 clamp

M5 只修正普通主窗口和桌面歌词窗口：

- 窗口必须与至少一个 monitor 有可见交集；
- display 移除后回落到最近/primary monitor；
- 尺寸不超过目标 monitor bounds；
- 不执行 WorkerW attach 或 Explorer 相关恢复。

## 10. HotkeyRuntime

现有 `configure_global_hotkeys` command shape 不变。runtime 负责：

- 新 bindings 替换旧 registration；
- 每个 action/accelerator 的冲突结果保持现有文案和字段；
- Released 事件继续 emit `mineradio-global-hotkey`；
- 重复配置不残留旧 registration；
- `[]` 清空全部快捷键；
- tray hide 不清空；
- shutdown exactly once 清空；
- registration callback 不持有 runtime lock。

默认 bindings 和 Web action semantics 不变。

## 11. DesktopLyricsRuntime

### 11.1 单一事实来源

Rust runtime 持有有效状态：

```rust
struct DesktopLyricsState {
    latest_payload: Option<serde_json::Value>,
    enabled: bool,
    click_through: bool,
    logical_hot_bounds: Option<LogicalBounds>,
    user_bounds: Option<PhysicalBounds>,
    last_middle_at_ms: u64,
    overlay_ready: bool,
    input_watcher: NativeInputHandle,
}
```

规则：

- `show_window` 使用当前 `click_through`，不再无条件重置为 true；
- `desktop_lyrics_update_payload` 缓存 payload，但 emit 前以 runtime 的 `clickThrough` 覆盖 payload 内可能过期的值；
- overlay ready 后 replay 最新 payload 和锁状态；
- 中键切换后向 overlay 与 main window 广播同一 `desktop-lyrics-lock-changed` 事件；
- main window 收到事件后更新现有 `fx.desktopLyricsClickThrough` 并强推完整 payload；
- 下一次 payload、切歌、show/reopen 都不得回滚锁状态；
- close 只停止歌词 watcher；tray hide 主窗口时保持已启用歌词运行。

### 11.2 原生中键输入

移除 PowerShell poller，改为 Rust Windows Adapter：

- `GetAsyncKeyState(VK_MBUTTON)` 检测按下沿；
- `GetCursorPos` 获取物理屏幕坐标；
- 24ms cadence；
- 260ms runtime debounce；
- watcher 只在桌面歌词 enabled 时存在；
- start 是幂等的，同时最多一个 watcher；
- stop 发 cancellation，并把 join 交给后台 reaper；UI/窗口事件线程不等待，24ms 轮询 worker 在观察到 cancellation 后退出；
- 非 Windows 使用 noop Adapter，现有 command 仍安全返回；
- 不安装全局低级 hook，不创建外部 helper，不请求管理员权限。

### 11.3 热区与 DPI

Overlay 上报逻辑坐标热区。Rust 保存逻辑值，每次命中时按当前歌词窗口 scale factor 转成物理值，禁止在接收时永久固化旧 DPI。

热区来自实际歌词 viewport，并按上游语义外扩：

- `padX` clamp `26..72`；
- `padY` clamp `24..56`；
- 不再默认使用整个透明窗口；
- resize、字体加载、文本变化、scale 变化后重新上报。

测试必须覆盖 100%、125%、150% DPI、负 X/负 Y 和边缘命中。

### 11.4 窗口 bounds

默认 bounds 对齐 2.0.2 的能力语义：

```text
width  = clamp(72vw, 880, monitor.width - 96)
height = clamp(38vh, 340, 560, monitor.height - 96)
y      = monitor.y + monitor.height * lyricY - height / 2
min    = 320 × 180
```

所有 move、show、scale change、monitor topology change 复用同一个 clamp helper。程序化 set-bounds 后 120ms 内不记录为用户拖动。显示器移除后回到可用 monitor。

歌词窗口保持透明、无边框、always-on-top、skip-taskbar，并且 show/reconcile 不抢主窗口焦点。

### 11.5 Overlay 自主时钟

主窗口不再承担逐帧推送。Overlay 接收 payload 时记录本地 monotonic anchor：

```ts
interface DesktopLyricsClockAnchor {
  payloadTimeSeconds: number;
  payloadProgress: number;
  progressSpanSeconds: number;
  playbackRate: number;
  playing: boolean;
  receivedAtMs: number;
}
```

`DesktopLyricsClock` 在歌词 WebView 内按 payload `frameRate` 采样：

- playing 时以 monotonic elapsed × rate 外推 playback time 与当前行 progress；
- paused 时 hold；
- 新 payload、seek、track/line identity 变化时替换 anchor；
- progress clamp `0..1`，duration 有值时 playback clamp 到 duration；
- 不创建 AudioContext，不读取主窗口 DOM，不通过 invoke 逐帧通信；
- Overlay dispose 后 RAF/timer exactly once 清理；
- 主窗口最小化或隐藏 30 秒时，Overlay 仍能推进高亮和长歌词滚动。

### 11.6 节拍与电影运动

Overlay 使用现有 `beatMap`、`motion`、`playback` 和 `cinema` 字段，不扩大 shared DTO：

- 从 beat map 的 camera/pulse/kick 数组构建只读索引；
- 依据本地 extrapolated playback time 查找当前 beat；
- 输出有限 CSS variables：pulse、glow、bass、translate、scale；
- `cinema=false` 时 beat camera/scale/shake 全部归零，但保留基础漂浮和歌词滚动；
- `reduceMotion=true` 时只保留进度与必要淡入；
- 不复制 Stage/Sonic 的 Three.js 或 analyser runtime。

### 11.7 自定义字体

shared payload 保持不变。自定义字体使用 Web-local Module：

```ts
interface CustomLyricFontRecord {
  id: string;
  name: string;
  family: string;
  dataUrl: string;
  size: number;
  savedAt: number;
}
```

规则：

- 支持 `.ttf/.otf/.woff/.woff2`；
- 单文件上限 3.6 MiB，记录数量与总量有界；
- localStorage key versioned；
- `fx.lyricFont` 保存 `custom:<id>`；
- 主 WebView 与歌词 WebView 从同源 storage 读取同一 record，并各自用 `FontFace` 注册；
- payload 继续只发送现有 `fontFamily`；
- FontFace load 完成后 Overlay 重新测量 layout 和热区；
- 同一 id/family 不重复注册；
- 加载失败回退系统字体并记录诊断，不影响歌词窗口；
- 不通过 Sidecar、shared DTO 或 Tauri command 传输字体二进制。

## 12. CacheRuntime

### 12.1 管理范围

M5 管理 Tauri-owned cache root 和使用量，不迁移 credentials、SQLite 或 Sidecar 协议数据：

```text
<cache-root>/
├─ audio/
├─ images/
├─ lyrics/
├─ beatmaps/
└─ temp/
```

`logs/`、SQLite、Cookie/token 和当前 Sidecar data 继续留在 app data。WebView2 profile 不在运行时切换。

### 12.2 configured 与 active

Snapshot 同时报告：

- configured root；
- 本次运行 active root；
- 各 category path；
- fallback 是否生效；
- restartRequired；
- 各 category bytes 与 total managed bytes；
- unmanaged app-data bytes 只作诊断，不计入 managed total。

设置新 root 时：

1. canonicalize；
2. 创建目录；
3. 写权限探测；
4. 原子保存 setting；
5. 不移动、不删除旧目录；
6. 需要启动前生效的路径标记 `restartRequired`。

自定义/移动磁盘不可用时，本次运行回退 `<app-data>/cache-fallback`，但保留 configured root，避免下一次恢复后丢失用户选择。

### 12.3 使用量扫描

- 只在用户打开/刷新资源面板时扫描，不阻塞 shell-ready；
- 使用 `spawn_blocking`；
- 同 category 同时最多一个 scan generation；
- 新 scan 取消/废弃旧 generation；
- 不跟随 symlink/junction/reparse point；
- 单文件/stat 错误记录到 category diagnostics，其他目录继续；
- 完成后原子发布 immutable snapshot；
- 受管分类清理只接受 `CacheCategory`，不接受任意路径；执行前 canonicalize root/category 并验证 category 是 root 的真子目录；
- 不跟随 symlink、junction 或其他 reparse point，链接本身只按安全平台语义处理；
- 绝不清理 app-data 根、credentials、SQLite、logs、Sidecar session 或 WebView2 profile；
- 清理后重建空分类目录，并返回 removed bytes/files/directories/links；
- 不提供“全部根目录清空”或 raw path delete command。

## 13. DiagnosticsRuntime 与资源治理

### 13.1 Native snapshot

`get_desktop_diagnostics` 返回 typed snapshot：

- app version、PID、uptime、platform；
- main/desktop-lyrics window state 与 topology；
- tray/close behavior/shutdown phase；
- hotkey registration 数与最近冲突；
- Sidecar 现有 snapshot 的只读副本；
- database status/error；
- cache settings/usage/scan state；
- current/peak process-tree working set；
- desktop lyrics watcher、overlay ready、payload generation、monitor/scale；
- bounded recent runtime errors。

诊断读取不得改变 runtime 状态。

### 13.2 Visual diagnostics composition

GPU/visual diagnostics 已位于 `VisualEngineFacade.getPerformanceSnapshot()`。Web `DesktopDiagnosticsController` 组合：

```text
native diagnostics command
          +
visual performance snapshot
          =
Desktop diagnostics view model
```

Rust 不伪造 GPU 数据，Web 不解析 Rust 内部 mutex。

### 13.3 应用工作集整理

Windows `ProcessMemoryAdapter` 只处理能证明属于当前 app process tree 的 PID：

- current PID 与 parent-chain 验证的子进程；
- PID、parent PID 和创建时间用于避免 PID reuse；
- 无法证明 ownership 的进程不处理；
- 默认仅 main hidden/minimized 后允许；
- 自动 background trim 延迟约 2.2 秒，cooldown 120 秒；
- foreground visible 时跳过，除非用户显式 `manual-force`；
- 结果包含 before/after、成功/失败 PID 和 skip reason；
- 非 Windows 返回 `available=false`，不是 command failure。

系统级 memory purge 在 M5 只暴露 capability 状态。没有无需提权、可验证且可回滚的 Adapter 时保持安全的 `disabled`；不得为了 parity 引入管理员 helper 或默认提权。

## 14. Web Interface 与控制面

`DesktopRuntimePort` additive 扩展 close/cache/diagnostics/trim 方法，现有方法不变。`createTauriDesktopRuntime()` 是 Tauri Adapter；browser fallback 返回安全默认值。

`useDesktopRuntime` 继续拥有：

- 主窗口 state subscription；
- hotkey subscription；
- desktop lyrics show/close/payload lifecycle；
- native lock event 回写。

新增 `useDesktopResourceController` 拥有：

- close behavior load/set；
- cache settings/choose/set/refresh；
- diagnostics refresh；
- working-set trim action。

`DesktopRuntimeControls` 只渲染：

- 关闭窗口：直接退出 / 后台托盘；
- cache root、active root、restartRequired 与分类使用量；
- 刷新使用量；
- 整理应用工作集；
- native/visual 诊断摘要。

它可以通过现有视觉控制台的 slot 展示，但 visual feature 不得直接 import Tauri runtime。`App.tsx` 只做 controller 与 view props 连接，不新增原始 invoke、事件监听或 cache walk。

## 15. 错误与降级

- Tray 初始化失败：回退 exit，显示诊断/Toast；
- Cache configured root 不可用：使用 per-run fallback，不覆盖用户选择；
- Cache scan 局部失败：返回 partial snapshot；
- Cache clear containment 校验失败：拒绝操作且不删除任何内容；
- Native input 不可用：桌面歌词仍显示，用户可通过现有 UI 解锁；
- Desktop lyrics FontFace/beat motion 失败：回退静态歌词，不拖垮主窗口；
- Monitor 查询失败：保留当前 bounds，并在下一次 topology reconcile 重试；
- Working-set trim 不可用或前台：返回 typed skipped result；
- Shutdown 某一步失败：记录错误，继续释放后续资源，最终 bounded exit；
- Sidecar recovery 行为不因 M5 诊断或 tray 改变。

## 16. 测试策略

### 16.1 核心 TDD 范围

仅以下高风险流程使用 red-green-refactor：

1. close/tray/shutdown 状态机与 cleanup exactly once；
2. tray hide 后 Sidecar/lyrics/hotkeys ownership 保持；
3. window event coalesce 与 monitor topology/clamp；
4. desktop lyrics 260ms debounce、锁回写/replay、DPI/负坐标/monitor removal；
5. native input start/stop/exactly-once ownership；
6. Overlay monotonic clock、pause/seek、beat/cinema policy；
7. cache settings atomic/fallback、stale usage scan 与 clear containment；
8. working-set foreground guard、cooldown 与 PID ownership。

### 16.2 非 TDD 工作

以下工作以 characterization、compile 和集成测试为主，不强制先写 RED：

- `commands.rs` 机械拆文件；
- command re-export 与 `generate_handler!` wiring；
- updater/dialog/login implementation 搬迁；
- controls markup/CSS；
- 文档与 capability matrix 更新；
- browser fallback 与 ordinary DTO mapping。

### 16.3 自动化验证

- Rust unit tests：lifecycle、geometry、topology、settings、cache scan policy、working set policy；
- Rust integration/manifest tests：28 frozen commands + additive allowlist；
- Bun tests：DesktopRuntimePort Adapter、controller、custom fonts、Overlay clock/motion/layout/hot bounds；
- architecture tests：`App.tsx` 无 raw invoke/listen，commands 不反向依赖 Web/Sidecar route；
- API freeze：Sidecar/shared/Provider/media URL/build packaging diff 为零；
- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`；
- 全仓 Bun tests/typecheck/build。

### 16.4 Windows 实机证据

至少记录：

1. close=exit：进程树退出，Sidecar child 无残留；
2. close=tray：主窗口隐藏但播放、Sidecar、热键和桌面歌词继续；
3. tray show/double click/single-instance reactivation：show → unminimize → focus；
4. tray exit：cleanup exactly once，无 helper/Sidecar 残留；
5. 100% + 150% 双屏，其中一块负 X；歌词拖屏后中键热区准确；
6. 主窗口最小化/隐藏 30 秒，歌词 progress、长词滚动和 cinema motion 持续；
7. 显示器断开后歌词回到剩余屏幕；
8. 自定义中文字体首载、切歌、关闭重开、删除/回退；
9. cache root 不可用时 fallback，usage scan 不阻塞首屏；
10. foreground trim 被跳过，tray/background trim 有 before/after 证据。

## 17. 完成标准

- [x] `commands.rs` monolith 删除，command Adapter 按领域组织；
- [x] 28 frozen commands 的名称、参数、返回和行为全部通过 manifest/fixture；
- [x] Sidecar/API/shared DTO/Provider/media URL/package freeze 通过；
- [x] `lib.rs` 不再直接实现 close cleanup、desktop lyrics poller 或 window debounce；
- [x] close default=exit，tray preference 可持久化；
- [x] tray hide 不执行 cleanup，explicit exit cleanup_once；
- [x] single-instance 和 tray reactivation 共用 WindowRuntime；
- [x] 主窗口 topology snapshot 与 coalescing publisher 完成；
- [x] hotkey lifecycle 在 tray/exit 路径正确；
- [x] PowerShell desktop lyrics helper 删除；
- [x] 桌面歌词锁状态、DPI、负坐标、monitor removal、background clock 完成；
- [x] 自定义字体不修改 shared DTO；
- [x] CacheRuntime settings/fallback/usage 与受管分类安全清理完成；
- [x] native + visual diagnostics 可读；
- [x] app working-set trim 有 foreground/cooldown/ownership guard；
- [x] 核心 TDD suites、Rust/Bun focused tests、全仓验证通过；
- [ ] Windows 实机证据完成；
- [x] capability matrix 将代码完成项标记为 `implemented`，并以 `field-validation-pending` 单独记录非阻塞 Windows 实机验证。

自动验证记录：Rust `165 passed`；Bun `2069 passed`；`cargo clippy --all-targets --all-features --locked -- -D warnings`、全 workspace typecheck、Web production build、`git diff --check` 与基于 `a2e845b` 的 Sidecar/API/shared freeze 均通过。独立 Rust、Web 与范围复审无 Critical/Important。`scripts/parity/m5/capture-evidence.mjs` 当前在单屏环境按预期 fail closed，不能替代双屏/托盘实机证据；它只阻止 `Field Validated / Release Verified`，不阻止 M5 Code Complete 或进入 M6。

## 18. 方案结论

M5 采用：

> **稳定 command Adapter + deep Desktop Runtime Modules + exactly-once lifecycle + Overlay 自主时钟。**

这不是把 2573 行拆成更多浅文件，而是把 caller 必须理解的 interface 压缩到少数 runtime 操作后面。生命周期、窗口几何、原生输入、缓存和资源诊断分别获得明确 ownership；Sidecar 与 shared 契约继续冻结；M6、M7 和 M9 保持可独立审查的后续里程碑。

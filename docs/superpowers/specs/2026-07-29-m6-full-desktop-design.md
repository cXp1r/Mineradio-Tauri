# M6 Full Desktop 设计

**日期：** 2026-07-29

**状态：** Code Complete / Windows Field Validation Pending (non-blocking)

**基线：** `a2e845b`（M4 complete；M5 Code Complete / Windows Field Validation Pending）

**上位设计：** `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md` §9.2

**上游行为基线：** Mineradio Electron 2.0.2，`4abaa190de42c632365ae4244e041bad16443224` 的 `desktop/full-desktop-mode-runtime.js`、`desktop/desktop-native-icon-layer-runtime.js` 与 `desktop/desktop-icon-shape-runtime.js`

## 1. 背景

M5 已将普通顶层窗口、托盘、关闭生命周期、桌面歌词、缓存和诊断收敛到 Rust Desktop Runtime。完整桌面仍是能力矩阵中唯一会修改 Explorer/窗口层级的 P0 desktop capability：它不能只是把 Tauri 窗口 `SetParent` 到某个 WorkerW。该做法若没有对称恢复、Explorer 重启 reconcile 和硬崩溃 journal，会留下被隐藏的图标、错误父窗口、残留透明遮罩或无法恢复普通窗口的系统状态。

M6 的目标是建立一个高 **Depth** 的 `FullDesktopRuntime` **Module**。它隐藏 WorkerW、Progman、DefView、ListView、DPI、Explorer 生命周期和 journal 的 Windows 细节；command 与 Web 只通过小而稳定的 **Interface** 请求模式和读取状态。该 Module 的核心 **Seam** 是：所有第一次系统修改前，先原子落盘可恢复快照；所有可观察的模式转换都由同一 runtime 决定；所有 native handle 都由 platform **Adapter** 所有并在 rollback 中释放。

M6 追求行为兼容与安全恢复，而非照搬 Electron 的实现组织。上游的全局 main-process runtime、补丁式定时器和隐式窗口状态不迁移。

## 2. 目标

M6 完成后必须满足：

1. 主窗口可以在普通顶层窗口与完整桌面模式间显式切换；
2. Full Desktop 有唯一状态机：`disabled`、`attaching`、`passive`、`interactive`、`recovering`、`detaching`、`recoveryRequired`；
3. `passive` 将内容附着至经验证的 WorkerW/Explorer 宿主，仍让原生桌面图标保持可见且可交互；
4. `interactive` 使用真实 DefView/ListView 的透明原生层处理图标命中，而不是仿制图标或截图；
5. 图标显示/隐藏和软件交互锁均可显式控制，并在 exit、Escape、tray recovery、attach failure、Explorer restart 与下次启动恢复中对称 rollback；
6. 首次系统修改前写入原子恢复 journal；上一会话异常退出后，在**动态创建主窗口之前**恢复遗留系统状态；
7. Explorer watcher 以有界轮询/reconcile 处理 shell 重启、宿主消失、句柄失效和 monitor/DPI 重建；
8. settings v2 保存用户选择的 `fullDesktopMode`，但硬崩溃恢复成功后本次启动禁止 auto-resume；
9. 现有 Sidecar、API、shared DTO、Provider、media URL、28 个 frozen Tauri command 和 M5 additive command 行为不变；
10. 核心状态机、journal、runtime 恢复路径采用 TDD；Win32 机械调用、文件移动和 UI 布线不强制先写 RED；
11. M6 Code Complete 只依赖自动代码门禁。双屏混合 DPI、Explorer 重启、托盘与长时间 Windows soak 是 `Field Validated / Release Verified` 门槛，不阻止进入 M7。

## 3. 非目标与禁区

### 3.1 M7 禁区

M6 不得包含：

- Wallpaper Engine library/project discovery、Steam 扫描或项目导入；
- Wallpaper Scene 进程启动、静音、DWM/WGC capture、texture bridge 或 pointer relay；
- 任何 Wallpaper 与 WorkerW 的协同策略；
- DWM thumbnail、Windows Graphics Capture 或桌面视频/Scene 混合。

M6 完成时，只保证为 M7 留出明确 runtime **Seam**；不得预先创建可执行的 Wallpaper adapter。

### 3.2 M9 与未来 Rust API 禁区

M6 不得：

- 引入、嵌入或依赖开发中的 `MineRadio-api`；
- 删除 Bun Sidecar、`externalBin`、supervisor、health/recovery 或修改 HTTP 行为；
- 修改 `sidecars/api/**`、`packages/shared/**` 业务 DTO、Provider、登录 Cookie 注入或媒体 URL；
- 将搜索、播放、歌词或音乐业务改为 Tauri invoke。

### 3.3 其他非目标

- 不仿制 Explorer 图标、快捷方式文本、选中框或 context menu；
- 不承诺杀死已退出进程后立即清理；硬崩溃只承诺下一次启动的最终恢复；
- 不实现提权、Explorer 注入、shell replacement 或全局 hook；
- 不把普通 Tauri command 变成 Win32 细节泄漏点；
- 不将 M5 field evidence 的缺失重新定义为 M6 代码阻塞项。

## 4. 冻结契约与新增 Interface

### 4.1 保持冻结的契约

M6 持续冻结：

- `src-tauri/src/sidecar.rs`、Sidecar child ownership、supervisor、`get_sidecar_status`；
- `apps/desktop/scripts/build-sidecar-binary.mjs`、`build.rs` 与 `tauri.conf.json` 的 `externalBin`；
- `sidecars/api/**`、Bun workspace、shared Provider/DTO/error schema；
- 现有 media URL、登录窗口 Cookie 注入链及 `SidecarRecoveryNotice`；
- M5 的 28 个 frozen 和 12 个 additive command 的 name、argument、serde casing、return shape 与错误语义。

M6 不改变 `DesktopRuntimePort` 的现有方法；完整桌面使用新的窄 Port/Adapter，避免让普通 window runtime 获得 Explorer ownership。

### 4.2 新增 additive commands

只允许新增下列 Tauri command；它们均是 transport **Adapter**，不包含 Win32 逻辑：

```text
get_full_desktop_runtime_state()
set_full_desktop_mode(mode)
set_desktop_icons_visible(visible)
set_full_desktop_interaction_locked(locked)
recover_full_desktop_runtime()
```

建议 DTO（Tauri-only，不加入 `packages/shared`）：

```ts
type FullDesktopMode = "disabled" | "passive" | "interactive";

type FullDesktopRuntimePhase =
  | "disabled"
  | "attaching"
  | "passive"
  | "interactive"
  | "recovering"
  | "detaching"
  | "recoveryRequired";

interface FullDesktopRuntimeState {
  phase: FullDesktopRuntimePhase;
  requestedMode: FullDesktopMode;
  effectiveMode: FullDesktopMode;
  iconsVisible: boolean;
  interactionLocked: boolean;
  recoveryRequired: boolean;
  autoResumeSuppressed: boolean;
  explorerGeneration: number;
  lastError?: string;
}
```

`set_full_desktop_mode(mode)` 返回完成 rollback 后的 state，不接受任意 HWND、路径、PID 或坐标。`recover_full_desktop_runtime()` 是幂等安全操作：无 journal 时返回 disabled snapshot；不能证明 owner/handle 时 fail closed 并进入 `recoveryRequired`。

## 5. 状态机和 ownership

### 5.1 状态模型

```text
disabled
  └─ enable(passive|interactive) → attaching
attaching
  ├─ attach succeeds → passive | interactive
  └─ attach fails → recovering → disabled | recoveryRequired
passive
  ├─ set(interactive) → attaching → interactive
  ├─ disable/Escape/tray recovery → detaching → disabled
  └─ Explorer loss → recovering → attaching | disabled | recoveryRequired
interactive
  ├─ set(passive) → attaching → passive
  ├─ lock/unlock → interactive
  ├─ disable/Escape/tray recovery → detaching → disabled
  └─ Explorer loss → recovering → attaching | disabled | recoveryRequired
recovering
  ├─ rollback/reconcile succeeds → disabled
  └─ ownership cannot be proven → recoveryRequired
recoveryRequired
  └─ explicit recover succeeds → disabled
```

`attaching` 和 `detaching` 是 serialization boundary：同一时刻只有一个 runtime operation 能修改系统状态。其他请求由 runtime 合并为最后一个明确 intent 或以 `busy`/稳定错误返回，绝不并行 `SetParent`、显示/隐藏 ListView 或写同一个 journal。

`passive` 和 `interactive` 不是“UI 标签”，而是 system ownership 的不同事实：

- `passive`：主窗口附着到经过验证的 desktop host；DefView/ListView 保持其原始交互行为；
- `interactive`：主窗口成为 DefView child 并位于真实 ListView 之下；经身份验证的 ListView 临时使用可逆的 layered color-key，保留真实图标像素与原生命中。它不复制 icon model，也不创建 helper 进程；
- software lock：只改变 Mineradio 自身窗口的 input routing；Escape 与 tray 始终提供原生恢复路径，不改变 Explorer 的安全设置、ACL 或全局输入策略；
- `iconsVisible=false`：只保存并改变本次会话已验证的原生 icon layer 可见性；从不对未知窗口、第三方 desktop shell 或 Explorer replacement 猜测写入。

### 5.2 深 Module 划分

```text
commands/full_desktop.rs              Transport Adapter
        │
app/full_desktop_runtime.rs           lifecycle composition / diagnostics / watcher
        │
runtime/full_desktop/mod.rs           FullDesktopRuntime (state + journal + rollback)
        ├─ runtime/full_desktop/reconcile.rs   bounded Explorer watcher policy
        └─ platform/windows/full_desktop.rs    TauriFullDesktopPlatform
                 ├─ WorkerW / Progman discovery
                 ├─ DefView + ListView validation
                 ├─ parent/style/visibility snapshots
                 └─ reversible ListView layered/background state
```

`FullDesktopRuntime` 是深 Module：caller 只知道 `request_mode`、`set_icons_visible`、`set_interaction_locked`、`recover` 和 `snapshot`；它负责 journal 事务、rollback、状态和 failure classification。`FullDesktopPlatform` trait 隔离机制，`TauriFullDesktopPlatform` 只做 Windows 操作而不拥有应用 policy；handle、window-style、visibility 与 parent 通过 typed snapshot 进入 runtime。`commands/full_desktop.rs` 不得 import `windows-sys` 或枚举 HWND。

### 5.3 Locality 与错误边界

- Explorer 发现、window identity、DPI/monitor 坐标与 native handle 生命周期局部于 Windows Adapter；
- journal schema、原子写、owner PID/creation-time 验证局部于 journal Module；
- 何时 attach、rollback、auto-resume suppress、通知 UI 局部于 runtime 与 app composition；
- Tauri window show/hide 和 application exit 仍由 M5 `DesktopRuntime` ownership 管理；full desktop 只向其提供 shutdown/recovery hook；
- 上游系统修改失败不传播 raw HWND/Win32 error 给 Web；command 返回稳定 desktop error 和 snapshot。

## 6. Journal、设置与启动恢复

### 6.1 恢复 journal

journal 必须位于受 Tauri app data 管理的路径，例如 `full-desktop-recovery-v1.json`。格式版本化，且至少记录：

- schema version、application version、创建时间；
- owner PID、owner process creation time、随机 launch nonce；
- requested/effective mode、icons visible、interaction lock；
- 主窗口原始 parent、style、extended style、placement、visibility、monitor/DPI；
- 已验证的 WorkerW/DefView/ListView identity 和其原始可见性/可交互状态；
- ListView layered attributes/background/visibility 原值与所有已应用 mutation 的 checkpoint；
- `rollback_started`、`rollback_completed` checkpoint。最后错误使用 live runtime 的稳定错误码与有界 diagnostics event，不进入持久恢复材料。

它不是调试日志，不能包含 Cookie、用户音乐数据、媒体 URL 或任意外部窗口 payload。PID 必须配合 creation time 和 nonce 使用；仅 PID 相同不足以证明 owner。

### 6.2 原子与幂等原则

1. runtime 确定将执行第一次系统 mutation；
2. 完整 snapshot 写入临时文件、flush、原子 rename 后才允许调用 Adapter；
3. 每次 mutation 成功后持久化 checkpoint；
4. rollback 按逆序尝试所有已记录 mutation，即使其中一项失败；
5. rollback 完整成功才删除 journal；
6. journal 解析失败时保留固定路径 primary 和 forensic 副本；版本未知、snapshot 不可验证或 Explorer identity 不安全时保留 primary。所有这些情况都不猜测恢复并进入 `recoveryRequired`。

恢复必须幂等：重复启动、重复 `recover_full_desktop_runtime()`、Explorer 在恢复中重启都不能使系统状态更差。无法确认某句柄仍属于本应用/Explorer 时，按“不可拥有”处理，停止写入并给出可见诊断。

### 6.3 settings v2

`RuntimeSettingsStore` 从 v1 升级到 v2，新增：

```json
{ "fullDesktopMode": "disabled" }
```

它保存用户偏好而非 live state。成功关闭完整桌面后保留该偏好，以便下一次正常启动可尝试 attach；但若启动恢复到遗留 journal，设置 `autoResumeSuppressed=true`，本次运行不得自动重进 passive/interactive，必须由用户重新显式选择。恢复成功不会静默修改用户偏好；恢复失败同样不得自动 attach。

### 6.4 启动顺序

```text
启动进程
  → 构造 Settings / Journal / TauriFullDesktopPlatform / FullDesktopRuntime
  → 检查并恢复遗留 journal（动态创建 main window 前）
  → 记录 auto-resume suppress 结果
  → 创建主窗口、M5 Runtime、tray、Sidecar supervisor
  → 若无 recovery journal 且 settings 请求模式非 disabled，则在窗口 ready 后受控 attach
```

早于主窗口创建的恢复可避免 Tauri 新窗口被错误地附着、覆盖或当作旧 session snapshot。正常 auto-resume 也必须在 main window 创建完成后执行，不能阻塞首屏；失败退回普通顶层窗口并发布可诊断 state。

## 7. Windows Adapter 行为

### 7.1 WorkerW/Explorer 发现与验证

Adapter 必须通过明确的 shell window class/parent relationship 发现候选宿主，并验证它们属于当前 Explorer shell process。发现不是一次性字符串匹配：每次 attach/reconcile 都重新验证 HWND 有效性、进程 PID、进程 creation time、class、可见性和 DefView/ListView 链。候选不唯一、PID/creation time 改变、class 链不完整或 Explorer replacement 不符合预期时 fail closed。

不得依赖固定 HWND、桌面坐标或“第一个 WorkerW”。不得把任何任意窗口设置为 parent。多显示器和负坐标使用 M5 monitor topology 的 logical/physical conversion contract；platform Adapter 只接收已经明确单位的 `PhysicalRect`，并把实际 DPI/monitor 回报给 runtime diagnostics。

### 7.2 passive attach

passive attach 的顺序：

1. 获取并验证 host/DefView/ListView；
2. capture 主窗口完整 native snapshot；
3. journal 已落盘后，将主窗口转换/附着为已验证 host 的 child，并设置受控 bounds；
4. 确认 window visible、host valid、icons visibility 与目标一致；
5. publish `passive` snapshot 并启动 bounded watcher。

任一失败立即按 journal rollback：先恢复仍可验证的 ListView layered/background/visibility，再恢复主窗口为普通顶层 window 及其 placement/style/visibility；无法验证恢复时进入 `recoveryRequired`，绝不继续半附着运行。

### 7.3 interactive、icons 和软件锁

interactive 仅在真实 DefView/ListView 已验证时启用可逆的原生 icon layer：

- 保存 ListView 原始 ex-style、layered attributes、background color 与 visibility；
- 只在完整 Explorer PID/creation-time/class/parent identity 仍匹配时写入；
- 使用 `WS_EX_LAYERED + LWA_COLORKEY` 与对应背景色保留真实 icon pixel/native hit-test；
- 在关闭、detach、Explorer restart、Escape 和 tray recovery 中按快照恢复；
- 不仿制或缓存 Explorer icon model，不创建 PowerShell/C# helper，不安装 global hook。

`set_desktop_icons_visible` 只作用于当前 validated ListView，先记录原始 visible state，随后调用 Adapter；状态未知即拒绝。`set_full_desktop_interaction_locked` 只改变本应用窗口的 input routing；locked 不等于永久隐藏 icons，也不等于禁止 Explorer 自己的输入。模式切换或 rollback 后，先恢复 native icon state，再恢复普通主窗口输入。

### 7.4 Explorer watcher reconcile

watcher 只在 passive/interactive 运行，有固定最小 interval、单一 in-flight reconcile 和指数退避；它不扫描文件系统，不创建 PowerShell/helper process。检测到 Explorer process/host/listview identity 变化时：

1. transition 到 `recovering` 并暂停 Mineradio native interaction；
2. 尝试恢复旧 mutation（若旧句柄已失效则只恢复仍可验证部分）；
3. 重新发现 shell；
4. 仅在 intent、settings 和 journal 均允许时重新 attach；
5. 成功更新 journal identity/generation；失败回普通顶层窗口或 `recoveryRequired`。

这条路径必须限流，且永不在 watcher 中静默重启 Sidecar、修改播放或访问 Provider。

## 8. 用户可恢复路径与 shutdown

以下入口都必须汇合到 runtime 的同一 detach/recover path：

- 用户选择 `disabled`；
- Escape（仅 full desktop active 时）；
- tray 的恢复普通窗口 action；
- 主窗口显式退出、系统退出与 M5 exactly-once cleanup；
- attach/reconcile 失败；
- `recover_full_desktop_runtime()`。

退出顺序固定为：停止 watcher/禁止新 intent → journal checkpoint → 暂停主窗口输入 → 恢复 ListView layered/background/visibility → 恢复 main window parent/style/placement/visibility → flush journal rollback outcome → 成功时删除 journal → 继续 M5 desktop-lyrics/Sidecar/tray cleanup。完整桌面 rollback 必须发生在 Sidecar stop 前，但不得阻塞 shutdown indefinitely；超时后保留 journal、停止进一步未知 mutation，并将失败记入 diagnostics。

Escape 不能只隐藏窗口；它必须请求 `disabled` 并恢复原生状态。tray recovery 不能依赖 Web 已挂载，必须由 Rust runtime 直接执行。`show_main_window` 必须先向 runtime 确认当前 phase 可恢复为顶层 window，避免在 `attaching`/`recovering` 中显示错误父窗口。

## 9. Web、diagnostics 与可观测性

Web 通过独立 `FullDesktopRuntimePort` 和 Tauri Adapter 调用新 command。UI 是 consumer，不拥有 native lifecycle：它不得直接保存 HWND、模拟 Explorer state 或用 localStorage 覆盖 native snapshot。控制面至少展示：requested/effective mode、icons visible、interaction locked、recoveryRequired、auto-resume suppressed、Explorer generation 和稳定错误文案。

`DiagnosticsRuntime` 新增只读 full-desktop facts：phase、watcher active、last reconcile time、explorer generation、主窗口是否处于 desktop child、icons visibility、lock、journal presence/version、auto-resume suppression 与最近结构化 failure code。诊断读取不得触发 attach、scan、reconcile、journal 删除或状态修复。

日志使用结构化事件：`full_desktop_transition`、`full_desktop_journal_written`、`full_desktop_rollback`、`full_desktop_explorer_reconcile`、`full_desktop_recovery_required`。记录 phase、reason、generation、duration、stable error code；不记录 Cookie、媒体 URL、窗口标题、文件路径或任意 third-party payload。

## 10. 测试策略

### 10.1 必须 TDD 的核心

先写 RED 再实现：

- 纯 state reducer 的合法/非法 transition、intent 合并和 exactly-once detach；
- journal 原子写、checkpoint、损坏/未知 schema、owner PID reuse、幂等恢复；
- runtime attach failure rollback、Escape/tray/shutdown 统一恢复、auto-resume suppression；
- Explorer generation change 的 single-flight reconcile、失败 fail-closed 与 journal 保留；
- settings v1→v2 migration 与本次启动 suppression。

测试使用 fake `FullDesktopPlatform`、fake clock、temporary journal store，不能在普通 CI 中修改真实 Explorer。Windows-specific Adapter 有 compile-time contract/handle ownership unit tests；真实 WorkerW 行为由 field evidence 覆盖。

### 10.2 不强制 TDD 的工作

下列可在核心通过后直接实现并 review：

- command registration、Web button/layout、DTO serialization wiring；
- `windows-sys` mechanical wrapper、feature-gate、错误映射；
- 文档、fixture、architecture guard 与手动 evidence script。

### 10.3 自动门禁

- Rust fmt、clippy `-D warnings`、full Rust test；
- Bun workspace test、typecheck、Web production build；
- command manifest additive contract guard；
- full-desktop boundary guard：command 不能 import Win32，core runtime 不依赖 Tauri/Web；
- Sidecar/API/shared/media freeze 相对 M6 baseline 为零；
- `git diff --check`。

### 10.4 Windows field evidence（非 Code Complete 阻塞）

在真实 Windows 环境执行并留存版本、日志与录屏/截图：

- 单屏、双屏 100%+150%、负坐标 monitor 的 passive/interactive attach/detach；
- desktop icons 显示/隐藏/lock、图标点击与 shell context menu；
- Explorer restart、attach 中断、应用 kill 后下次启动 journal recovery；
- Escape、tray restore、normal exit、后台 30 分钟 soak；
- no helper process、no icon state residue、普通窗口可恢复。

这些证据缺失只阻止 `Field Validated / Release Verified`，不阻止 M6 `Code Complete` 或 M7 设计/施工。

`scripts/parity/m6` 只对 Windows host、时间戳、required case、artifact 与 soak duration 等凭证完整性 fail closed；它不自动判断真实 ListView 点击、shell context menu 或 expected/observed state 的行为语义。上述语义必须由人工审阅录屏、日志和实际结果后才能晋升 `Field Validated / Release Verified`。

### 10.5 Code Complete 实施记录

- `runtime/full_desktop/**` 已实现唯一状态机、原子 recovery journal v1、系统熵 128-bit launch nonce、恢复前 mutation checkpoint、hard-crash 后 `autoResumeSuppressed`、reconcile policy 和 settings v2 migration；损坏 primary journal 会保留 forensic 副本并在固定路径跨重启持续 fail closed，图标/交互锁 mutation 失败会进入 `RecoveryRequired`；
- `platform/windows/full_desktop.rs` 已实现 platform snapshot v3、完整 `WINDOWPLACEMENT`、physical monitor bounds、WorkerW/DefView/ListView 完整身份校验、真实 ListView layered color-key、`ShowWindowAsync` 有界确认、5 秒 rollback 总预算和逐步重验身份的 best-effort 恢复；只有能证明 Explorer 进程 creation identity 已变化时 stale recovery 才可 no-op，同代发现失败或身份不完整时保留 journal 并 fail closed；
- `app/full_desktop_runtime.rs` 已将 startup recovery 安排在动态创建主窗口之前，并统一 Explorer watcher、Escape、tray、minimize、close、RunEvent 与退出 rollback；
- 五个 additive command、独立 Web Port/Adapter/hook/controls 和 request generation guard 已落地；既有 Desktop Runtime 与 Sidecar API 行为保持冻结；
- diagnostics 已提供真实 journal version、稳定错误码、最近 reconcile 结果、半附着/稳定附着 actual-child 只读事实和有界结构化事件；只读诊断不扫描 Explorer，也不触发 reconcile 或系统 mutation；
- 最终自动门禁：Rust `223 passed`、Bun `2093 passed`；Rust fmt、全 target/feature 离线 clippy `-D warnings`、workspace typecheck、Web production build 与相对 `a2e845b` 的 API freeze（含 `bundle.externalBin`）均通过。Windows 实机 field evidence 仍按 §10.4 保持 pending。

## 11. 风险与决策

| 风险 | 决策与缓解 |
| --- | --- |
| 错误 WorkerW 导致桌面异常 | 进程 creation time + class chain + DefView/ListView 验证；不唯一即 fail closed |
| 崩溃留下图标隐藏/窗口 child | 首次 mutation 前原子 journal；下次启动、创建主窗口前幂等恢复 |
| PID reuse 被当作旧 owner | PID、creation time、launch nonce 共同验证 |
| Explorer restart 造成半附着 | generation reconcile、single-flight、失败退回顶层/`recoveryRequired` |
| interactive 侵入 Explorer | 只对 validated ListView 做快照化 layered/background 修改；不复制、不注入、不全局 hook |
| 多显示器 DPI 坐标漂移 | 统一 physical/logical conversion seam，Adapter 不接收无单位坐标 |
| 开发时混入 M7 | 禁止 DWM/WGC/WE crate、process/capture/pointer code；M7 单独设计 |
| 业务 API 回归 | Sidecar/API/shared/media freeze + contract guard |

## 12. 完成定义

M6 可标记 `Code Complete / Windows Field Validation Pending (non-blocking)` 的条件：

1. 五个 additive command 与 typed Web Port/Adapter 已落地且不改变冻结命令；
2. core runtime/journal/reconcile/platform Adapter 按本设计分层，核心 TDD 套件通过；
3. passive/interactive、icons、software lock、Escape、tray recovery、shutdown、attach failure 与 Explorer reconcile 具备代码级对称 rollback；
4. settings v2 和启动前 journal recovery 实现，hard-crash recovery suppress auto-resume；
5. diagnostics、日志、architecture/freeze guards 和全量自动门禁通过；
6. 无 M7/M9 scope leakage；
7. Windows field evidence 项被明确记录为 pending，且不被虚假标为已验证。

只有完成 §10.4 的真实 Windows evidence 才可标记 `Field Validated / Release Verified`。

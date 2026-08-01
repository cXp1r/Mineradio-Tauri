# M7 Wallpaper Engine 设计

**日期：** 2026-07-29

**状态：** Code Complete / Windows Field Validation Pending（non-blocking）

**基线：** `a2e845b`（M4 complete；M5/M6 Code Complete，Windows Field Validation Pending）

**上位设计：** `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md` §9.3

**上游行为基线：** Mineradio Electron 2.0.2，`4abaa190de42c632365ae4244e041bad16443224`

## 1. 决策摘要

M7 将 Wallpaper Engine 实现为静态链接在 Tauri 主程序中的 Rust **Module**，不迁移 Electron 的 PowerShell/C# helper，也不增加 sidecar、localhost 服务或额外正式二进制。

```text
Web UI
  └─ WallpaperEngineRuntimePort
       └─ Tauri command Adapter
            └─ WallpaperEngineRuntime
                 ├─ WallpaperLibrary
                 ├─ SceneSession / RecoveryJournal
                 ├─ WallpaperEnginePlatform
                 └─ Windows Adapter
                      ├─ Steam / Authenticode / process observation
                      ├─ exact Scene HWND identity
                      ├─ in-process DWM thumbnail surface
                      └─ optional in-process WGC glass sampler
```

普通结构化操作走 Tauri command。图片、视频和预览走只读 Tauri custom protocol；协议只能解析由 Library 注册的 project ID 和媒体角色，不接受任意绝对路径。原生 Scene 由 Rust 启动/观察，并通过同进程 DWM surface 呈现在透明主窗口下方。

M7 持续冻结现有 Bun Sidecar、音乐 API、shared DTO、Provider、媒体 URL 和 `bundle.externalBin`。开发中的 `mineradio-api` 不在本里程碑接入。

## 2. 行为范围

M7 必须完成：

- Steam 根、所有 `libraryfolders.vdf`、Workshop `431960` 与 `projects/myprojects` 发现；
- 手工目录、`project.json`、`.pkg/.pak` 导入、移除和持久化；
- image、video、Scene 与 preview-only 分类；
- 媒体 realpath containment、文件大小、扩展名、MIME 和 `PKGVdddd` 包头校验；
- 官方 Wallpaper Engine 安装发现、签名/路径验证、核心进程观察和有界 ready probe；
- 唯一 `Mineradio Wallpaper <24hex>` location 的 Scene start/switch/stop/recovery；
- location-scoped 静音，不修改 Wallpaper Engine 全局或 Windows 音频会话；
- 同进程 DWM thumbnail surface、窗口换代重绑定和主窗口 physical rect 跟随；
- 可选 WGC 底栏玻璃采样 owner；WGC 不是主背景 transport；
- Full Desktop passive/interactive 协同；
- minimize、hide、renderer crash/navigation、tray、exit 的资源释放；
- 自动门禁与 Windows Field Validation evidence runner。

M7 不实现：

- synthetic pointer relay、cursor hook、`SendInput` 或伪造 `WM_MOUSEMOVE`；
- `SetParent`/隐藏/park Wallpaper Engine Scene HWND；
- 杀死用户已有的 `wallpaper32.exe`/`wallpaper64.exe`；
- web/application 类型 Wallpaper 的任意代码执行；
- 将音乐业务迁入 Rust 或修改 Sidecar transport；
- M8 数据迁移或 M9 Rust API 嵌入。

## 3. 上游事实与实现替换

2.0.2 生产链路是：

```text
真实 Windows cursor
       ↓
exact Scene HWND（与主窗口 physical rect 对齐）
       ↓ DwmRegisterThumbnail
click-through DWM surface HWND
       ↓ z-order
透明 Tauri 主窗口
```

上游退役代码仍保留 `WM_MOUSEMOVE` relay，但生产 DWM 路径会主动停止 relay，且 quick-check 禁止再次启用。M7 以生产路径为 parity oracle。

上游 DWM helper 和 pointer helper 是 Electron 为跨语言调用产生的子进程。Rust 可直接使用 Win32，因此 M7 将 DWM surface、跟随 worker、WGC owner 和清理全部放入主进程；不生成 helper binary。该实现改变 mechanism，不改变可观察结果。

## 4. 深 Module 与 Seam

```text
runtime/wallpaper_engine/
├─ mod.rs                 public runtime Interface / state machine
├─ library.rs             discovery、import、snapshot persistence
├─ project.rs             project.json、媒体和包安全分类
├─ ownership.rs           generation、session、window/process identity
├─ journal.rs             exact-location recovery record
└─ policy.rs              geometry、mute、Full Desktop transition policy

platform/windows/wallpaper_engine/
├─ mod.rs                 Windows Adapter composition
├─ discovery.rs           Steam registry/VDF/installation discovery
├─ trust.rs               Authenticode 与 executable identity
├─ scene.rs               control command、exact HWND、ready/close probe
├─ dwm_surface.rs         surface thread 与 thumbnail owner
└─ wgc_sampler.rs         optional glass sampler owner

app/wallpaper_engine_runtime.rs       app lifecycle composition
commands/wallpaper_engine.rs          Tauri transport Adapter
```

`WallpaperEngineRuntime` 是高 **Depth** Module。caller 只知道 library、status、start、stop、recover 与 desktop transition；Steam/VDF、Win32、generation supersede、mute retry、DWM/WGC 和 cleanup ordering 留在 implementation 内，形成 locality。`WallpaperEnginePlatform` 是 core tests 的 seam；Windows Adapter 是生产实现。

## 5. Tauri-only Interface

M7 只追加以下 command，不修改 M1–M6 command：

```text
list_wallpaper_engine_projects(request)
get_wallpaper_engine_project_details(id)
choose_wallpaper_engine_directory()
choose_wallpaper_engine_project_file()
remove_wallpaper_engine_directory(root_id)
get_wallpaper_engine_runtime_status(request)
start_wallpaper_engine_scene(request)
stop_wallpaper_engine_scene(request)
recover_wallpaper_engine_runtime()
```

DTO 只存在于 desktop/Web Wallpaper Port，不加入 `packages/shared`：

```ts
type WallpaperSafetyMode = "directMedia" | "nativeEngine" | "previewOnly";
type WallpaperRuntimePhase =
  | "idle" | "starting" | "active" | "stopping" | "cleanupRequired" | "unavailable";

interface WallpaperProjectSummary {
  id: string;                 // canonical project root SHA-256 前 24 hex
  title: string;
  projectType: string;
  mediaType?: "image" | "video";
  playable: boolean;
  enginePlayable: boolean;
  previewOnly: boolean;
  safetyMode: WallpaperSafetyMode;
  source: "workshop" | "local" | "imported";
  sourceLabel: string;
  workshopId?: string;
  hasPreview: boolean;
  previewAnimated: boolean;
  updatedAt: number;
  mediaUrl?: string;
  previewUrl?: string;
}

interface WallpaperRuntimeState {
  available: boolean;
  phase: WallpaperRuntimePhase;
  pending: boolean;
  active: boolean;
  projectId: string;
  sessionId: string;
  sourceId: string;
  captureMode: "none" | "dwmThumbnail";
  sourceWindowAligned: boolean;
  dwmSurfaceReady: boolean;
  glassSamplerReady: boolean;
  audioMuted: boolean;
  cleanupRequired: boolean;
  fullDesktopMode: "disabled" | "passive" | "interactive";
  lastError?: string;
}
```

Dialogs 取消返回 `ok: true, canceled: true`。Library 和 runtime 业务错误使用稳定代码；raw path、HWND、PID、签名 subject 和 Win32 文本不发给 Web。

## 6. Library 与媒体协议

### 6.1 发现和扫描边界

- Steam 根来自注册表、常见安装目录和所有 VDF library；
- 同时扫描 Workshop `431960` 与 `myprojects`；不可访问 library 单独降级，不中止整个 snapshot；
- 手工扫描最多 4,000 个目录项和三层后代；跳过隐藏、cache、temp、tmp、`node_modules`；
- 强制刷新合并同一 in-flight scan，普通 snapshot 可使用 30 秒 TTL；
- 配置最多 32 个手工根、64 个手工包，原子写入 `wallpaper-engine-library-v1.json`；
- 路径按 canonical、Windows 大小写不敏感语义去重。

### 6.2 分类和信任

- `project.json` 最大 1 MiB；
- image 白名单：jpg/jpeg/png/webp/gif；video：mp4/webm/m4v/mov；
- `web`/`application` 永远 preview-only；
- Scene 包必须为 `.pkg/.pak` 且前 8 字节匹配 `PKGVdddd`；
- manifest 引用的媒体须同时通过 lexical 与 realpath containment；symlink escape 失败关闭；
- 每次 Scene start 前重新验证 project ID、manifest、containment 与 package header。

custom protocol URL 只含 project ID、role 和 revision。handler 从当前 immutable Library snapshot 查回 canonical path，并实现单 Range、`206/416`、Content-Type、Content-Length、HEAD 与 bounded chunk；不接受 URL 中的 filesystem path。

## 7. Scene 状态机、ownership 与 recovery

```text
Idle
  → Starting(generation, session)
  → WE ready + exact project revalidation
  → close older exact location
  → open unique location
  → exact title/executable/window identity
  → location mute confirmed
  → DWM surface ready
  → Active
  → Stopping
  → exact location/HWND close confirmed
  → release WGC/DWM/timers/stage
  → Idle

任一步无法证明清理：CleanupRequired（journal 保留）
```

- session ID 为 CSPRNG 12 bytes/24 hex；location 固定为 `Mineradio Wallpaper <session>`；
- generation 防止旧 start/refresh/stop 覆盖新 intent；替换必须先确认旧 location 关闭；
- core Wallpaper Engine 进程一律视为 external/shared，不在 normal stop/dispose 中 kill；
- Scene ownership 由 exact session + exact title + executable identity + HWND identity 证明；
- 若未来产生本应用 child，只能在 PID、creation time、launch nonce、executable 四项仍匹配时终止；
- close 使用 location-scoped `closeWallpaper`，并以 exact HWND `WM_CLOSE` 作为验证后的 fallback；
- close 未确认时保留 active/session/journal 和可重试资源，不伪装为 idle；
- idle stop/dispose 幂等成功；启动后 cleanup 失败也保留 `CleanupRequired`，不丢失 location；
- startup recovery 早于自动 resume；只清理 journal 记录的 exact location，不能证明 identity 时 fail closed。

## 8. Scene 启动、静音与几何

Scene 使用已验证安装下的 `wallpaper64.exe`/`wallpaper32.exe`：

```text
-control openWallpaper
-file <validated scene package>
-playInWindow "Mineradio Wallpaper <session>"
-width <physical width>
-height <physical height>
-x <physical x>
-y <physical y>
-borderless
```

目标进程路径必须位于选定官方安装且 Authenticode 有效。发现同名进程但路径不一致时 fail closed。主程序 elevated 或无法安全降权时不得启动 Scene。

Scene HWND 与主窗口 physical content rect 容差 2 px。首次错位最多重开三次；主窗口后续 move/resize 由 surface 跟随，不重启 Scene。HWND 换代或 title/executable identity 失效时释放旧 capture 并重新绑定。

静音只作用于唯一 location：

- manifest 解析出音频属性并令 `volume=0`；
- Scene stage/package patch 可用时设置 `startsilent=true, volume=0`；
- 运行时 `applyProperties -location <exact location>`，有界重试并周期重申；
- 不修改全局 Wallpaper Engine mute，不持久化 Windows Core Audio session 状态；
- stage patch 失败可退到 property-only，location mute 无法确认则 start 失败。

## 9. DWM、WGC 与真实鼠标

DWM surface 是同进程 Rust owner：

- 创建单一 click-through top-level HWND，`WM_NCHITTEST -> HTTRANSPARENT`；
- `DwmRegisterThumbnail(surface, exact_source)`；
- destination rect 1:1、opacity 255、visible、source-client-only；
- PMv2 DPI、physical rect 与主窗口对齐；
- z-order 为 host/main → DWM surface → exact Scene source；不 `SetParent`、不 `SW_HIDE` Scene；
- surface thread 以有界频率跟随 host；连续 identity/geometry 失败后退休，并让 runtime 进入可诊断恢复；
- stop 先 unregister thumbnail，再 destroy HWND、退出 worker 并确认资源释放。

原生 WGC/D3D glass sampler 在 M7 **未启用**。当前 `WgcSamplerOwner` 是明确的 unsupported Adapter，始终返回 `glassSamplerReady=false`；底栏使用已完成的 DOM/static fallback，这不影响 DWM 主背景 Code Complete。未来若实现 native sampler，才需要补 frame-pool resize、event-token 撤销、session/frame-pool/texture 释放及对应 Field Validation；当前 fallback 证据不得被解释为 WGC capture 已实现。

鼠标视差使用真实 Windows cursor。M7 禁止 synthetic relay、cursor hook 和 input injection；Scene 与主窗口像素对齐就是 interface。

## 10. Full Desktop、window lifecycle 与 shutdown

- 进入 `passive` 前 Web 先保留静态 preview，Rust 随后完整停止 WGC/DWM/exact Scene；停止未确认则拒绝 passive；
- `interactive` 允许 Scene，DWM Adapter 将真实 Explorer icon host 保持在 Mineradio 与 surface/source 之间；
- interactive layering 失效或 Explorer generation 变化时退休并重建 surface，绝不复用未验证 HWND；
- 回到 top-level/interactive 后，根据 Web 持久选择显式创建新 session，不复用旧 HWND；
- minimize/hide/navigation/crash 停止 Scene，但不清除用户选择；restore 由 Web 重新 start；
- tray recovery 与 exit 不依赖 Web 存活。

退出顺序固定：

```text
禁止新 intent
→ M6 Full Desktop detach/rollback
→ exact Scene location close/confirm
→ WGC stop
→ DWM thumbnail/surface stop
→ mute timer/stage/journal cleanup
→ M5 lyrics/tray/Sidecar cleanup
```

exact close 未确认时不能先销毁仍用于诊断/重试的 capture owner；保留 active/session/journal，
让显式 recovery 可以再次验证。close 已确认后再释放 WGC/DWM。总清理有界；无法完成时
保留 recovery journal 和稳定 diagnostics，不盲杀外部进程。

## 11. 测试和完成定义

仅核心路径使用 TDD：

- project classification、containment、PKGV 校验和 bounded import；
- generation supersede、close-old-before-open-new、targeted stop、idle dispose；
- exact location/window ownership mismatch fail closed；
- cleanup failure 保留 active/journal，startup recovery 幂等；
- 2 px geometry/relaunch 三次上限；
- mute retry、DWM ready ordering、resource stop exactly once；
- passive/interactive transition 与 M6 shutdown 顺序。

Win32 机械调用、dialog/UI 布线和 evidence runner 不强制先写 RED，但必须有 architecture guards：commands 不得 import Win32；core 不得依赖 Tauri；禁止 localhost/helper/PowerShell/C#/pointer injection；冻结 Sidecar/API/externalBin。

Code Complete 需要：Rust/Bun tests、fmt、clippy、typecheck、Web build、M7 guards、API freeze 和 `git diff --check` 全绿。真实官方 Scene、DWM 无黑闪、真实光标、双屏混合 DPI、Explorer 重启、静音听感、tray/crash/exit soak 标记为 `Field Validation Pending`，不阻止 M7 Code Complete。

## 12. 实施收口（2026-07-29）

- Library 已完成 Steam/VDF、Workshop/local、手工 root/project/package、bounded scan、原子持久化、realpath containment、PKGV 复验，以及 image/video preview 的 `previewMediaType` 与 registered asset lookup；
- Scene core 已完成 generation/session、close-old-before-open-new、exact ownership、opening/active journal recovery、bounded location absence、cleanup retention，以及 prepare/activation/replacement/journal write/clear 失败后的可重试状态收敛；
- Windows Adapter 已完成官方安装、WinVerifyTrust 与 exact normalized publisher allowlist、进程校验、location-scoped mute 首次确认与周期重申、DWM owner、physical rect 跟随，以及一秒级 native capture watcher 驱动的 HWND generation rebind；
- 主 WebView 使用 fail-closed navigation allowlist；reload/page-load、WebView2 browser/render/frame failure、renderer unresponsive、main destroyed、minimize/hide/tray/exit 均汇入统一 Scene stop/dispose。延迟 failure worker 使用成功 session epoch，不能误停恢复后的新 session；
- Full Desktop 与 Wallpaper Scene start 共享单一 transition owner；窗口 bounds 在 owner 外读取，主线程 M6 路径使用 fail-fast `try_lock`，避免跨 runtime TOCTOU 与 UI 等待。显式恢复、passive settings 失败和 minimize 失败都有对称 Wallpaper policy 同步/rollback；
- direct image/video 已进入应用 Background seam；native Scene 只有在 DWM capture health 完整时才切透明合成，否则保留登记 preview；production/dev CSP 只在 `img-src`/`media-src` 放行精确 mapped origin；
- 原生 WGC/D3D frame pool **未启用**。当前 `WgcSamplerOwner` 明确返回 unsupported，`glassSamplerReady=false`，DOM/static glass fallback 已完成且不阻塞 DWM 主背景。未来若启用 native WGC，必须另开实现与 Field Validation，不得用现有 fallback 证据宣称 WGC capture 已完成；
- Bun Sidecar、音乐 API、shared DTO、Provider、legacy media URL 与 `bundle.externalBin` 保持冻结；开发中的 `mineradio-api` 未接入。

自动门禁记录：Rust `283 passed`，Updater signature `7 passed`，Bun/workspace `2148 passed`；`cargo fmt --all --check`、全 target/feature 离线 Clippy `-D warnings`、workspace typecheck、Web production build、M7 architecture/evidence guards、相对 `a2e845b` 的 API freeze（含 `bundle.externalBin`）与 `git diff --check` 均通过。

剩余项仅为 Windows Field Validation：真实官方 Scene/DWM 合成与无黑闪、视频 preview、真实 cursor、location mute 听感、混合 DPI/Explorer restart，以及 tray/crash/exit soak。它们阻止 `Field Validated / Release Verified`，不阻止 M7 Code Complete。

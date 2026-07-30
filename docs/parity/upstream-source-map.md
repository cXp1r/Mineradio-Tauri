# Electron 2.0.2 上游源码映射

Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`

除 Sonic Topography 外，本文件只把上游当作行为、参数和恢复语义证据，不继承其全局脚本组织方式。Sonic 依据已确认的来源链、维护者审阅的公开合作证据与项目决策采用直接迁移；该证据不等于书面授权或许可放宽，实施仍须适配 visual-engine 的 scheduler、resource scope、typed settings 和生命周期 seam。

| 领域 | 上游证据 | 当前 Tauri 证据 | 目标所有权 | 迁移规则 |
| --- | --- | --- | --- | --- |
| 启动与本地服务 | `desktop/main.js`、`server.js` | `src-tauri/src/sidecar.rs`、`api/sidecar-client.ts`、`adapters/sidecar/legacy-application-runtime.ts` | `ApplicationRuntimePort` + `ApiRuntimePort` + Legacy Sidecar Adapter | M0–M9 保留现有 supervisor 和 HTTP 行为；业务 caller 只消费聚合 Ports |
| 搜索 | `public/js/modules/05-playback/07-search.js` | `components/shell/SearchShell.tsx` | `SearchExperiencePort` + search controller | 先换依赖类型，不改请求与竞态控制 |
| 播放 URL 与音质 | `05-playback/00-api-quality-output.js`、`11-provider-fallback.js` | `features/playback/usePlaybackSessionRuntime.ts`、`playback-session-coordinator.ts`、`audio/player-controller.ts` | playback session runtime + frozen Playback Port | 保留既有 reload/fallback；opaque URL、session/load generation、fresh URL 单次预算和回滚均不改变 Sidecar 调用 |
| 队列与切歌 | `05-playback/09-queue-snapshot-autoplay.js` 至 `13-playback-start-audio.js` | playback store、handoff policy/controller、session runtime | playback store/runtime | exact current intent 与严格相邻 candidate 才能 compare-and-commit；真实媒体时钟不受视觉 Frame Gate 限流 |
| Audio owner / Gapless | `05-playback/12-playback-switch-core.js`、`13-playback-start-audio.js` | `audio/playback-audio-runtime.ts`、`features/playback/playback-handoff-policy.ts`、`gapless-playback-controller.ts` | `PlaybackAudioRuntime` + session coordinator | pending/committed owner 分离；A/B deck 共用 prepared authority；8.5s preload、1.05s muted preroll、360–720ms equal-power；失败保留 outgoing |
| Audio Graph | `05-playback/08-audio-graph-controls.js` | `audio/playback-audio-runtime.ts`、Visual `AudioFrameSource` consumers | playback runtime + read-only visual snapshot | Runtime 独占 Graph/source/gain/recovery；Visual 不创建或断开 MediaElementSource，不让 React 每帧驱动 analyser |
| 输出路由与恢复 | `05-playback/00-api-quality-output.js`、`08-audio-graph-controls.js`、`13-playback-start-audio.js` | `audio/playback-audio-runtime.ts`、`features/playback/PlaybackAudioSettings.tsx` | playback runtime + typed preferences | primary/最多四 mirrors/Virtual Bridge、默认 sink 恢复、play/stall/Graph/audibility 有界预算；实机设备/听感为 Field Validation Pending（non-blocking） |
| 歌词请求 | `06-lyrics/00-lyrics-fetch-parse.js` | lyrics store、custom lyrics、`App.tsx` | lyrics controller | 保留 fallback、自定义歌词与 stale request 语义 |
| 舞台歌词 | `02-visual/10-lyrics-mask-textures.js` 至 `14-stage-lyrics-rendering.js` | `packages/visual-engine/src/stage-lyrics/**` | visual-engine | 保留旧 mesh 直到新正文 ready，双预算上传 |
| Sonic Topography | `public/sonic-topography-preset.js`、`03-beat/06-sonic-audio-monitor.js`；原始来源 `yin-yizhen/sonic-topography@3ff303e` | `packages/visual-engine/src/sonic-topography/**` | visual-engine | 直接迁移视觉算法，保留 Ajin、来源 commit、Non-Commercial Learning License 和修改说明；不继承全局脚本结构 |
| 主循环与调度 | `00-state/10-frame-scheduler.js`、`11-main-loop.js` | visual-engine runtime | visual scheduler | analyser/视觉采样可限流，媒体状态不可限流 |
| 3D 歌单架 | `04-shelf/**` | visual shelf modules、`shelf-detail-data.ts` | visual-engine + library controller | 数据增长时 DOM/GPU 对象保持有界 |
| Home 2.0 | `05-playback/03-home-discover-weather.js`、`03a-home-dashboard.js`、`05-home-actions.js` | `home/EmptyHomeHost.tsx`、`App.tsx` | home controller/surface | 维持当前 API，允许重做 UI 组织 |
| 窗口、托盘与关闭 | `desktop/main.js` | `app/lifecycle.rs`、`app/tray.rs`、`app/desktop_runtime.rs`、`runtime/window.rs` | desktop runtime | 默认 exit、可选 tray；所有真实退出汇合到 exactly-once cleanup |
| 完整桌面 | `desktop/full-desktop-mode-runtime.js` | `apps/desktop/src-tauri/src/runtime/full_desktop/**`、`apps/desktop/src-tauri/src/app/full_desktop_runtime.rs`、`apps/desktop/src-tauri/src/commands/full_desktop.rs`、Web `full-desktop-runtime` Port/Adapter/runtime | Rust full desktop runtime | 动态创建主窗口前恢复 journal；状态机统一 attach、reconcile、Escape/tray/exit rollback，无法证明恢复时 fail closed |
| 原生桌面图标 | `desktop/desktop-native-icon-layer-runtime.js`、`desktop/desktop-icon-shape-runtime.js` | `apps/desktop/src-tauri/src/platform/windows/full_desktop.rs` | Rust Windows platform | 只操作经 parent/thread/PID/creation-time 验证的 WorkerW/DefView/ListView；快照化 mutation 必须在 deadline 内 best-effort 对称 rollback |
| Wallpaper Engine | `desktop/wallpaper-engine-runtime.js`、`desktop/wallpaper-engine-library.js` | Rust core/Windows Adapter/app lifecycle + Web `WallpaperEngineRuntimePort`/Background/controller | Rust runtime/platform + Web controller/background | 只关闭 exact location，不终止共享 Wallpaper Engine 核心进程；图片/视频/preview 仅用登记 project-id/role custom protocol；exact signer、bounded absence/journal recovery、DWM 主背景、HWND rebind、周期 location mute、成功-session epoch cleanup 与 Full Desktop transition owner 已实现。原生 WGC/D3D 未启用，明确使用 `glassSamplerReady=false` 的 DOM/static fallback；真实 Scene/DWM/静音/cursor/mixed-DPI/soak 为 Field Validation Pending（non-blocking） |
| 桌面歌词 | `desktop/main.js`、overlay preload | desktop lyrics Rust/React modules | desktop runtime | 保持锁定、穿透、拖动和显示器修正 |
| 内存与资源 | `desktop/system-memory.js`、`00-state/08-desktop-render-power.js` | visual perf state、Rust diagnostics | resources runtime | 系统级释放默认关闭且不在前台播放运行 |
| 缓存治理 | `desktop/main.js` cache handlers、`server.js` cache paths | `runtime/cache.rs`、`commands/cache.rs` | cache runtime | 只管理已验证分类，不接受任意删除路径，不跟随 reparse point |
| Cuefield | `05-playback/16-cuefield-automix-core.js` 至 `18-cuefield-automix-integration.js` | 尚无完整服务 | future playback service | 等待未来 API capability，不进入本轮 |

## 明确不迁移的上游实现

- 同步 XHR 脚本拼接与编号加载顺序；
- renderer 全局变量和内联事件；
- Electron 主进程内加载完整 HTTP server；
- 运行时 PowerShell/C# helper；
- 登录彩蛋认证门禁；
- 未使用或未实例化的旧 runtime；
- Electron 快速补丁更新路径。

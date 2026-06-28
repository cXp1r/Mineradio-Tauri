# Capability Parity Checklist

更新时间：2026-06-28

Tauri 版对外发布前必须完成本清单。Electron 当前运行效果是视觉和交互基线；二开项目不需要迁移旧用户数据，但必须达到原项目完整能力。

## 2026-06-28 当前审查对齐

- 当前执行入口：`docs/migration/plans/11-final-baseline-parity.md`。旧的 `IMPLEMENTATION_PLAN_TAURI_REWRITE.md` 只作为历史 master sequencing plan 和阶段背景，不作为当前直接实施入口。
- `417cedc` 仅是 post-splash Empty Home mitigation：修复 splash 后黑屏/空壳风险，让 Empty Home mitigation 能出现；它不是 Home parity，不能据此勾选 Home、Search、Bottom controls、Playback 或 Visual parity gate。
- `8b86051` 已移除 web debug shell。后续手动验收必须确认 WebView2 中没有 debug shell 回归。
- `b0186dd` 已在代码侧恢复 splash ready gate。启动动画仍需要 Electron baseline 对照录屏和 WebView2 手动证据后才能勾选 parity。
- 2026-06-28 Phase 1 startup shell code-side slice 已恢复 `#empty-home`、`#search-area`、`#top-right`、`#bottom-handle`、`#bottom-bar` 的 React 挂载，并恢复 baseline 当前施工 Home 文案与 console reveal 入口；用户截图观察到点击进入后不再黑屏。该证据只证明 shell 可见，仍需 Electron baseline 对照截图/录屏和 WebView2 交互验证后才能勾选 Home/Search/Bottom controls parity。
- 2026-06-29 Phase 3 startup intro sound code-side slice 已迁移 baseline `playMineradioIntroSound` / `armSplashSoundFallback` Web Audio 图：master/noise/low/soft-tone 常量、autoplay unlock fallback、reduced-motion 不自动播放、点击/Enter/Space 重试和 dispose 清理均有 Bun 单测覆盖。仍需 Windows/WebView2 与 Electron baseline 启动录屏/听感对照后才能勾选启动动画 parity。
- 2026-06-29 Provider playlistList code-side slice 已恢复 Netease/QQ 用户歌单列表：Netease 登录后走 `userPlaylist(uid, limit:60)` 并映射 `PlaylistSummary[]`；QQ 登录后复用 `qq-music-api` 的 `user/songlist` 与 `user/collect/songlist`，合并创建/收藏歌单、去重、过滤 Qzone/空间背景歌单并把“我喜欢”置顶。无 cookie 时两者均返回空列表且不打网络。仍需 WebView2 登录态下“我的歌单/收藏歌单”和 3D 歌单架真实数据源手动验证后才能勾选 provider/shelf parity。
- 2026-06-29 Web shelf playlist source code-side slice 已把 `SidecarClient.playlistList(provider)` 接到 React 启动/登录状态刷新/手动 cookie 导入/登出路径；`VisualEngineHost` 现在优先把 Netease/QQ `PlaylistSummary[]` 映射成 3D shelf playlist cards，只有没有账号歌单时才回退播放队列。仍需 WebView2 登录态确认用户歌单卡片、详情打开和真实播放。
- 本清单只记录代码侧进展和待验收证据；没有手动截图、录屏、Windows/WebView2 实测或 release artifact 证据的 gate 保持 unchecked。

## Baseline Freeze

- [x] 建立 Electron baseline tag 或 branch。
- [x] 记录 baseline commit、tag/branch 名称、采集日期、操作者和操作系统版本。
- [x] 建立 baseline artifacts 目录，并记录截图、录屏、视觉存档和测试素材路径。
- [x] 建立代码派生动画规格：`docs/migration/baseline/BASELINE_ANIMATION_SPEC.md`。
- [x] 保存默认视觉存档用于对照。
- [x] 保存主界面静态截图。
- [x] 按代码记录启动动画规格。
- [ ] 公开发布前保存启动动画录屏。
- [x] 保存播放控制台显示/隐藏静态截图。
- [x] 按代码记录播放控制台显隐和按钮动效规格。
- [ ] 公开发布前保存真实播放中控制台截图和录屏。
- [x] 保存视觉控制台打开状态截图。
- [x] 保存 3D 歌单架静态截图。
- [x] 按代码记录 3D 歌单架打开、滚动、详情页和点击播放动效规格。
- [ ] 公开发布前保存 3D 歌单架打开、滚动、详情页、点击播放录屏。
- [x] 按代码记录桌面歌词开启、锁定、解锁、拖动动效和窗口行为规格。
- [ ] 公开发布前保存桌面歌词开启、锁定、解锁、拖动录屏。
- [x] 记录窗口尺寸、搜索 fixture 和视觉存档来源。
- [ ] 记录固定测试歌曲、封面和歌词来源。
- [x] 记录 baseline 最小验证命令输出：`git diff --check`、`node --check server.js`。
- [ ] `docs/migration/baseline/BASELINE_CAPTURE.md` 已填写 commit、branch、固定测试歌曲、视觉存档和外部存储路径。
- [x] `docs/migration/baseline/BASELINE_METADATA.template.json` 已复制为实际 metadata 并填充已采集字段。

## Execution Readiness Gate

> 2026-06-28 最终阶段任务切片状态：继续从 `docs/migration/plans/11-final-baseline-parity.md` 执行。Phase 0（计划与证据对齐）已建立当前入口；Phase 1（Startup Shell / Empty Home parity）代码侧 shell 可见性切片已完成，但 WebView2/Electron 对照证据未完成；Phase 2（Search / Queue / Playback / Lyrics / Provider runtime parity）pending；Phase 3（Visual Engine full parity）pending；Phase 4（Tauri runtime / sidecar lifecycle / login / desktop lyrics / Windows parity）pending；Phase 5（Updater / installer / license / notices / release identity）pending；Phase 6（Final parity sign-off）pending。进入任一 phase 前必须重新确认目标文件、验收命令、停止条件和是否需要更新本清单、`DEFERRED_CAPABILITIES.md` 或 `LICENSE_GATE.md`。

- [ ] 当前阶段有明确任务切片，且每个任务包含目标文件、验收命令和停止条件。
- [ ] 当前阶段已确认不违反 `docs/migration/MIGRATION_TAURI_PLAN.md` 的阶段边界。
- [ ] 当前阶段已确认是否需要独立分支或 worktree。
- [ ] 当前阶段已确认是否需要更新 PRD、capability checklist、deferred capabilities 或 license gate。
- [ ] 当前阶段完成后有 review 入口：spec compliance review 和 code quality review。

## Desktop Shell Gate

- [ ] Tauri 主窗口启动、关闭、最小化、最大化、全屏、退出全屏正常。
- [ ] 单实例行为正常。
- [ ] 新 app id、新数据目录、新快捷方式、新 updater 通道生效。
- [ ] 外部链接打开正常。
- [ ] 文件导入导出正常。  — Stage 7d code-side complete: `export_json_file(fileName,data)` / `import_json_file()` 已由 Rust 通过 `tauri-plugin-dialog` 非阻塞 save/open dialog 打开 JSON 文件选择；导出写入 pretty UTF-8 JSON 且只返回 `cancelled/path`，导入读取 UTF-8、解析 JSON 并返回 `cancelled/path/data`；路径只来自 Rust dialog，不接受前端任意路径，且未向 renderer 授权 dialog plugin open/save commands。helper tests 覆盖默认文件名净化、`.json` 扩展处理、pretty serialization、import parse error、cancel result 和 dialog callback receiver；web runtime typed helper 在非 Tauri 环境返回 cancel placeholder。待 WebView2 手动导入/导出真实文件后再勾选。
- [ ] 全局热键注册、冲突提示、触发正常。

## Sidecar Gate

- [ ] Rust 启动 Bun sidecar。
- [ ] sidecar 使用随机端口并由 Rust 注入给前端。
- [ ] `/health` 返回 app version、api version、schema version、provider status。
- [ ] sidecar 崩溃后自动重启。  — 2026-06-29 Phase 4 sidecar lifecycle code-side slice complete: Rust `AppState` now retains the sidecar child handle, records phase/pid/restarts/provider health/log path, starts a supervisor loop that detects exited children and restarts on the same injected random port, and terminates the child on main-window close. Pending Windows/Tauri runtime crash-restart evidence before checking.
- [ ] 前端能显示 sidecar 恢复中/已恢复状态。  — 2026-06-29 code-side complete: `get_sidecar_status` Tauri command returns a typed snapshot and `apps/web/src/tauri/runtime.ts` maps it to camelCase; React now polls sidecar status after runtime config, derives transient recovered state after `recovering`/`stopped`/`error` or restart-count increase, and renders a quiet `SidecarRecoveryNotice` for recovering/recovered/stopped/error without exposing pid/port/log debug details. Pending Windows/WebView2 crash-restart UI evidence before checking.
- [ ] sidecar rolling log 写入 app data。  — 2026-06-29 code-side complete: Rust constructs the runtime log path and passes `MINERADIO_SIDECAR_LOG_FILE`; Bun sidecar now consumes it, writes startup/request JSONL entries, bounds file size, creates parent directories, and redacts cookie/auth/token-like keys and values before disk writes. Pending Windows/Tauri runtime evidence that the file appears under app data and remains cookie-free after real login/provider traffic.
- [ ] 诊断导出不包含 cookie。

## Provider Gate

> P4.5 + P7 完成 Netease 代码侧（search/songUrl/lyric/playlistDetail/loginStatus/logout 匿名可用；B1 真实凭证运行时验证已通过，端到端 WebView2 手动验证仍待用户实测）。QQ provider 已按 `DECISIONS.md` A6 接入 `jsososo/QQMusicApi`（GPL-3.0，npm 包 `qq-music-api`），并为旧 search route 不稳补入 QQ smartbox search fallback。2026-06-29 Provider playlistList code-side slice 已补齐 Netease/QQ 用户歌单列表，仍待 WebView2 登录态真实验证。
>
> Stage 7c code-side login/session vertical slice complete: sidecar 新增 in-memory runtime auth session service，`POST /providers/:provider/session-cookie` 与 `DELETE /providers/:provider/session-cookie` / `POST /providers/:provider/session-cookie/clear` 只返回 `{ provider, stored }` ack，不回显 cookie；Netease/QQ provider client `getConfig()` 已改为 runtime session 优先、再 fallback `MINERADIO_NETEASE_COOKIE` / `MINERADIO_QQ_COOKIE`；web sidecar client 仅新增 set/clear transport methods，不把 cookie 放入 UI store；Tauri Rust 新增 Netease/QQ login webview window lifecycle skeleton（labels `login-netease` / `login-qq`，baseline URLs/titles/sizes）、cookie header parser/域过滤/login detector/header builder helpers 与 login window capability。自动化证据覆盖 shared ack schema strict no-cookie、sidecar runtime-over-env、route response/diagnostics 不泄露 fake cookie、QQ loginStatus runtime cookie logged-in path、web client no-retain ack、Rust helper tests。B1 真实凭证、WebView2 手动登录 cookie extraction/injection seam、Netease/QQ 真实账号态 loginStatus/logout 与高音质 songUrl 验证仍 pending，所以下方账号相关 gate 保持 unchecked。
>
> Stage 7e B1 runtime credential validation complete with user-provided ephemeral Netease/QQ cookies: raw cookies were only injected transiently at runtime and were not written to repo files, diagnostics, or UI state. Netease `loginStatus` returned logged-in with profile, `search` returned 5 tracks, `songUrl` resolved a real `music.126.net` MP3 URL, and diagnostics contained no cookie/auth keys. QQ `loginStatus` returned logged-in by cookie presence, smartbox-backed `search` returned 4 tracks, `songUrl` resolved a real `aqqmusic.tc.qq.com` MP3 URL, `lyric` returned 63 timed lines, and diagnostics contained no cookie/auth keys. Manual WebView2 login-window extraction, UI import/logout clicking, and real playback/visual evidence remain user-test gates, so account rows stay unchecked until interactive verification.

- [x] Provider Adapter 层存在，前端不直接处理 Netease/QQ 分支差异。
- [ ] Netease 支持 search。  — P4.5 已落地（hana cloudsearch）；B1 真实凭证运行时验证返回 5 条；待手动 WebView2 验证
- [ ] Netease 支持 songUrl。  — P4.5 已落地（hana songUrlV1，匿名 standard level）；B1 真实凭证运行时验证返回真实 MP3 URL；待手动 WebView2 验证 + vip 音质专项验证
- [ ] Netease 支持 lyric。  — P4.5 已落地（hana lyricNew 优先，lyric 回退），待手动 WebView2 验证（简繁交错行 P7 select-current-index 已 sort 防御）
- [ ] Netease 支持 playlistList。  — 2026-06-29 code-side complete：无 cookie 返回空列表不打网络；有 cookie 先 `loginStatus` 取 `userId`，再调用 hana `userPlaylist({ uid, limit:60 })` 映射 `PlaylistSummary[]`；待 WebView2 登录态真实账号“我的歌单/收藏歌单”验证。
- [ ] Netease 支持 playlistDetail。  — P4.5 已落地（hana playlistDetail），待手动 WebView2 验证
- [ ] Netease 支持 loginStatus。  — P4.5 已落地（无 cookie 时返回 logged-out，不走网络）；B1 真实凭证运行时验证 returned logged-in/profile；待手动 WebView2 登录/导入 UI 验证
- [ ] Netease 支持 logout。  — P4.5 已落地（无 cookie 时 NOT_IMPLEMENTED(no-session)），待手动 WebView2 UI logout 验证
- [ ] QQ 支持 search。  — P4.5/A6 已落地；生产默认优先 QQ smartbox search fallback，保留 jsososo raw search route 兼容测试；body.list 与 smartbox 字段差异（songmid/songname/singer/albumname/interval、mid/name/singer/pic）已 mapper 对齐；B1 真实凭证运行时验证返回 4 条；待手动 WebView2 实搜验证。
- [ ] QQ 支持 songUrl。  — A6 已落地（jsososo `qq.api("song/url", {id,type:"128"})`）；无 cookie 抛 ProviderError LOGIN_REQUIRED retryable:true action:"login"；B1 真实凭证运行时验证返回真实 QQ 音频 URL；待 WebView2 播放验证。
- [ ] QQ 支持 lyric。  — A6 已落地（jsososo `qq.api("lyric", {songmid})`）；jsososo 内 Base64 decode；hasTranslation 从 trans 字段派生；B1 真实凭证运行时验证返回 63 行；待手动 WebView2 真实歌词同步。
- [ ] QQ 支持 playlistList。  — 2026-06-29 code-side complete：无 cookie 返回空列表不打网络；有 cookie 从 QQ cookie 解析 uin，调用 `user/songlist` + `user/collect/songlist` 合并创建/收藏歌单，去重、过滤 Qzone/空间背景歌单并“我喜欢”置顶；待 WebView2 登录态真实账号验证。
- [ ] QQ 支持 playlistDetail。  — A6 已落地（jsososo `qq.api("songlist", {id})`）；body.cdlist[0] mapper；匿名可用，待手动验证 B1 cookie 后真实歌单打开/滚动/详情。
- [ ] QQ 支持 loginStatus。  — A6 已落地，无 cookie offline logged-out 不走网络；有 cookie trust cookie 存在；B1 真实凭证运行时验证 returned logged-in；待 WebView2 登录/导入 UI 验证。
- [ ] QQ 支持 logout。  — A6 已落地，无 cookie 抛 ProviderNotImplementedError("qq","no-session")；有 cookie 调 jsososo user/logout best-effort；待手动 WebView2 UI logout 验证。
- [x] Provider capability matrix 已更新（registry netease+qq 均 available:true，capabilities list 字段对齐 ProviderAdapter 接口）
- [ ] 跨源换源逻辑在 sidecar service 层完成。  — Stage 3 code-side fallback 已落地：`sidecars/api/src/services/cross-source-resolver.ts` 支持 provider-agnostic `/search` preferred/registry-order fallback、空结果继续尝试、`/song-url` 先直连 track.provider 再按 title/artists 搜索候选换源；Bun DI 单测与 route 注入测试通过。待 WebView2 手动实搜/真实 provider 换源证据后再勾选。
- [x] QQ 开源项目研究结果经过 license 审核。  — A6 已评估决定 `jsososo/QQMusicApi`（GPL-3.0 兼容，1.6k stars）；lint/repo 审核已记入 LICENSE_GATE.md QQ 项目审核表 + Dependency Audit 表（含 transitive deps）。`sansenjian/qq-music-api` 不接入（README 非商业附加条款与 GPL-3.0 冲突）。

## Playback Gate

> P7 code complete; Stage 4 sidecar `/audio-proxy` code complete for HTMLAudioElement URL shape (Range-only incoming header forwarding, safe upstream playback headers, CORS `*`, 200/206 stream passthrough, 400/502 envelopes) with Bun fake-fetch and route DI tests. Stage 11 product-flow code-side closure strengthened Home gating + search/play handoff: `SearchShell` All/Podcast routes use cross-source `/search`, explicit NE/QQ modes stay provider-specific, search-result play now suppresses Home, reveals playback controls, clears floating search results, and the playback effect uses request tokens so stale songUrl/lyric responses cannot overwrite a newer track. `SidecarClient` now preserves structured provider failure envelopes even on non-2xx responses for login/VIP/retry recovery UI. Still pending manual WebView2 verification (`search → enqueue → proxied audio src → play → pause → seek → next → ended next → lyric sync`).

- [ ] 搜索结果能加入播放队列。  — P7 code complete; Stage 11 code-side Home/search handoff now clears search UI, suppresses Home, reveals controls, and uses queue-front dedupe semantics; pending manual WebView2 verification
- [ ] 播放、暂停、恢复正常。  — P7 code complete; Stage 4 sidecar audio proxy code complete; Stage 11 code-side playback state now has explicit play/pause setters instead of toggle inference; pending manual WebView2 verification
- [ ] 下一首、上一首正常。  — P7 code complete; pending manual WebView2 verification
- [ ] 进度条随真实 audio 推进。  — P7 code complete; pending manual WebView2 verification
- [ ] seek 正常。  — P7 code complete; Stage 4 sidecar audio proxy Range forwarding covered by Bun tests; pending manual WebView2 verification
- [ ] ended 后按当前模式切歌。  — P7 code complete; pending manual WebView2 verification
- [ ] 单曲循环、队列循环等现有模式对齐。  — P7 code complete; pending manual WebView2 verification
- [ ] 音质选择行为对齐。  — 2026-06-29 code-side complete: shared `PlaybackQualitySchema`/`SongUrlRequestSchema` now carry baseline `jymaster/hires/lossless/exhigh/standard`; web quality popover restores the five baseline options and local preference key, passes selected quality into cross-source `/song-url`, and triggers current-track reload on quality change; sidecar `/song-url` and provider-specific song-url accept `{ track, quality }` while preserving legacy Track bodies; Netease forwards `level`, QQ maps quality to `flac`/`320`/`128`, and both return resolved quality metadata. Pending WebView2 real playback quality switch/downshift evidence before checking.
- [ ] 音频失败时有统一错误提示和恢复路径。  — P7 code complete; Stage 4 audio proxy maps missing/invalid url to BAD_REQUEST and upstream failures/non-ok statuses to retryable UPSTREAM_AUDIO_PROXY 502; Stage 11 web client preserves provider failure envelopes on non-2xx and surfaces playback load/media errors through search error + toast; pending WebView2 UI recovery verification
- [ ] WebView2 中真实播放链路通过，不只验证 URL。  — P7 code complete; Stage 4 proxy endpoint ready for HTMLAudioElement src; still pending manual WebView2 playback verification before this gate can be checked

## Lyrics Gate

> P7 code complete; 2026-06-29 Netease native karaoke code-side slice complete: shared `LyricPayload` now carries line duration/source/charCount and word timing, sidecar parses baseline YRC `[lineStart,lineDur](wordStart,wordDur,0)` format with absolute-or-relative word timing and preserves words when translation matches, and `VisualEngineHost` maps milliseconds into visual-engine seconds for word-by-word progress. 2026-06-29 custom lyric code-side complete: shared parsing supports timestamped LRC and plain-text duration spreading, web reads baseline `mineradio-custom-lyrics-v1` / `mineradio-custom-lyric-prefs-v1`, applies custom lyrics when original lyrics are fallback unless the user pinned original, preserves existing localStorage compatibility, and restores the baseline 原词/自定义 source segment plus custom lyric editor modal save/delete path. Pending manual WebView2 verification (`play track → lyric loads → current line follows timeupdate`) and visual/editor interaction parity evidence.

- [ ] 普通歌词获取和解析正常。  — P7 code complete; pending manual WebView2 verification
- [ ] 新歌词/逐字歌词能力按原项目行为对齐。  — 2026-06-29 code-side Netease YRC word timing payload + stage feed complete; pending WebView2 real-song visual verification
- [ ] 歌词高亮、进度、位置、缩放、颜色、发光对齐。  — P7 code complete; pending manual WebView2 verification (lyric sync wired via store + selectCurrentIndex)
- [ ] 自定义歌词能力对齐。  — 2026-06-29 code-side parser/storage/preference playback application + custom lyric editor modal/buttons complete; pending WebView2 editor/save/delete/source-switch verification
- [ ] 歌词与播放进度同步。  — P7 code complete; pending manual WebView2 verification (defensive sort handles interleaved NCM lrc)
- [ ] 视觉场景下歌词层级和遮挡关系与 baseline 对齐。

## Visual Parity Gate

- [ ] 启动动画截图/录屏与 baseline 对齐。  — P8.splash code complete; Phase 3 startup intro sound code-side slice complete; pending manual WebView2 parity recording
- [ ] 主视觉粒子场与 baseline 对齐。  — P8.s2c.1 code complete (HomeVisual field + fx defaults + preset state + audio→uniform projection); Stage 11 Home idle slice now drives baseline wallpaper preview semantics from React/visual-engine (`home-wallpaper-preview`, preset 5, `uAlpha` target 0.96, `uFloatAlpha=0`, and preset-5 camera baseline 9.4/0.34/-0.52) without adding fake DOM particles. 2026-06-29 HomeVisual cover texture chain code-side slice complete: visual-engine now owns current/previous cover texture updates, baseline `coverTextureSizeForResolution` 256/384/512 thresholds, square center-crop canvas preparation, `uHasCover` clear/set, `uColorMixT` 1400ms tween advance, stale load token guard, and React host current-track cover URL wiring. Sidecar `/image-proxy` now provides the baseline cover proxy/CORS path for remote HTTP(S) covers without forwarding cookie/auth headers; inline data/blob covers remain direct. 2026-06-29 HomeVisual edge/depth code-side slice complete: visual-engine now builds the baseline 256x256 RGBA depth/edge/foreground/luminance texture from cover canvas, applies `uEdgeTex`, and advances `uHasDepth`/`uAiBoost` with baseline smoothstep tween to heuristic `(1, 0.55)` over the 180ms new-cover path. 2026-06-29 HomeVisual ripple code-side slice complete: visual-engine now owns baseline 12-slot `1xN` RGBA Float DataTexture ripple state, 3x3 region bass rising-edge trigger, 0.30 threshold, 0.32s cooldown, age expiry, and per-frame `uRippleTex`/`uRippleCount` updates. 2026-06-29 cover color code-side slice complete: visual-engine now ports baseline `updateLyricPaletteFromCover` / `lyricTextPaletteFromHsl` / silver-blue fallback, back-cover UV color sampling at `0.85`, float random cover sampling at `0.95`, and exposes HomeVisual `onCoverLyricPalette` from the prepared square cover canvas. 2026-06-29 back-cover layer code-side slice complete: visual-engine now owns baseline 3000-point mirrored cover layer at `z=-1.5..-1.9`, shader breathe/noise constants, `aUv` mirrored sampling, `aColor` refresh from prepared cover canvas, and HomeVisual lazy mount/dispose behind `fx.backCover` without enabling it by default. 2026-06-29 free-camera code-side slice complete: visual-engine now owns baseline default/read/save shape, persisted clamp semantics, toggle active/locked behavior, pointer delta fallback, wheel FOV clamp, WASD/Space/Ctrl/Shift/QE movement constants, velocity easing, 620ms easeOutCubic reset tween, R/K/key/mouse/wheel/blur host wiring, and render-loop camera override with beat shake/FOV punch preservation; WebView2 interaction evidence remains pending. Still pending AI depth, float layer runtime (baseline currently force-disabled), skull/gesture host behaviors, and manual WebView2 parity recording.
- [ ] 控制台 SVG 玻璃质感与 baseline 对齐。  — P8.s3 code complete; pending manual WebView2 parity recording (control-glass-svg.ts byte-equal to baseline filter; attachControlGlassNode wires ResizeObserver)
- [ ] 播放后 Emily/默认视觉入场与 baseline 对齐。
- [ ] Canvas/WebGL 无空白、错位、闪烁。  — P8.s3 code complete; pending manual WebView2 parity recording (bottom-bar SVG glass + control button motion)
- [ ] GSAP timing 与 baseline 对齐。  — P8.s3 code complete; pending manual WebView2 parity recording (back.out(2.1), back.out(1.8/1.9), power2.out, click pulse 0.58/0.42s preserved)
- [ ] 歌词舞台动画与 baseline 对齐。  — P8.s4.b lifecycle + GSAP lyr-in/bob/out + YRC timetable driver + RenderStepSlot.StageLyrics registry landed. Stage 5 host wiring is code-complete: `VisualEngineHost` maps shared lyric payload into visual lyric lines, `useVisualEngine` mounts `createStageLyricsLifecycle`, calls `setLyricLines`, and registers `RenderStepSlot.StageLyrics` in the render loop. Earlier note: P8.s4.a stage-lyrics builder landed (THREE.Group with sun/glow/readability/text-shader/sparks; 16 userData.lyric fields; renderOrders 40/41/42/43/44; full YRC fragment shader verbatim). Pending manual WebView2 visual parity recording before gate can be checked.
- [ ] 视觉控制台 UI 与 baseline 对齐。
- [ ] baseline 视觉存档读入后效果与 Electron baseline 对齐。  — P8.s2c.1 code complete (HomeVisual field + fx defaults + preset state + audio→uniform projection); pending manual WebView2 parity recording
- [ ] 不出现廉价透明、错位、过度渐变、卡顿、跳帧。

## 3D Playlist Shelf Gate

> P8.s6.a core data + layout math + entrance animation constants ported (`packages/visual-engine/src/shelf/`). P8.s6.b code complete for Three.js card meshes, Canvas sprite texture, rendered window limit, and `RenderStepSlot.Shelf` host registration. P8.s6.c.1 code complete for queue-backed shelf items, pane memory restore, and `connectorParticles` mount. P8.s6.c.2 code complete for baseline focus-zone camera targets/timers in `CinemaCamera`. P8.s6.c.3 code complete for focus resolver and host pointer wiring. P8.s6.c.4 code complete for queue focus DOM math and side-card raycast plumbing. P8.s6.c.5 code complete for first-level hover selection and primary card click/action plumbing. P8.s6.c.6 code complete for baseline primary hit `raycastCards || pickCardAtScreen` screen-space fallback/padding behavior. P8.s6.c.7 code complete for baseline-style shelf visibility target/easing driver (`stage` + data and `side` + `always` fade in by 0.22; `off`/empty fade out by 0.18 with near-zero clamp; `side` + `auto` remains hidden unless detail content is open) and per-frame host sync of shelf mode/presence. P8.s6.c.8 partial wheel parity code complete for stage/card-hit scroll, side `always`/card-hit scroll with 18px screen pad, and Shift-forced scroll in stage plus side `always`; side `auto` remains non-scrolling without preview state. P8.s6.c.9 code complete for visual-engine pinned shelf state, right-click side pinned toggle/focus, open-detail right-click close-and-pin behavior, pinned side auto visibility target, and pinned wheel card-hit/Shift-force paths. P8.s6.c.10 code complete for side-auto preview wheel-zone/Shift/card-hit paths, including baseline landscape/portrait hot-zone geometry and no 18px pad for preview card hits. P8.s6.c.11 code complete for pinned normal wheel hot-zone geometry/scroll. P8.s6.c.12 code complete for baseline contextmenu `off`→`side` mutation through runtime shelf mode ref/callback before pinned side open/focus behavior. P8.s6.c.13 code complete for baseline shelfHoverCue state/tick semantics and side-auto preview visibility parity. P8.s6.d.1 code complete for detail-list state/layout skeleton (`ShelfContentList`: open/close token reset, loading/error rows, clamp scroll, centerSmooth 0.18, max-11 render window, baseline row layout/panel opacity math) without provider fetch, row actions, or canvas panel rendering. P8.s6.d.2 partial wheel plumbing code complete for open detail `contentList.scrollBy` when an injected detail-wheel target predicate matches, preserving baseline no-consume behavior for detail misses, UI targets, splash, and shelf `off` mode; real row/panel raycast target detection remains pending. P8.s6.d.3 primitives complete for baseline detail-list row/panel screen-space hit sorting, padding, uv, and constants. P8.s6.d.4 content-list screen target state/hit API complete. P8.s6.d.5 code complete for detail row/panel Three meshes under a dedicated detail group, capped visible row render window, baseline detail-group transform placement, per-frame world-space screen target sync, and cleanup on close/off/dispose. P8.s6.d.6 code complete for web detail wheel target detection using `contentList.hasScreenTargetAt({ x: event.clientX, y: event.clientY })`, while retaining injected predicate overrides and preserving UI/splash/off/detail-miss no-consume behavior. P8.s6.d.7 code complete for detail row click callback plumbing: screen picks now expose row index, manager screen target sync carries actual row index, and web open-detail clicks consume real row hits through `contentList.pickRowAtScreen({ x: event.clientX, y: event.clientY })` while placeholder rows remain inert and misses do not fall through to first-level shelf clicks. P8.s6.d.8 code complete for provider playlistDetail data plumbing on already-open shelf detail: `ShelfManager` notifies host with playlist metadata/requestToken, web host calls `SidecarClient.playlistDetail`, maps shared tracks into detail rows, and writes success/error through token-guarded `ShelfContentList` methods so stale responses cannot overwrite newer detail opens. P8.s6.d.9 code complete for loaded shelf detail row enqueue/play plumbing: web detail rows preserve shared track metadata, reconstruct tracks through shared zod validation, reuse search playback semantics, and deterministically ignore invalid or hard non-playable rows. P8.s6.d.10 code complete for detail canvas sprite drawing: rows now render cover/placeholder cues, title/subtitle metadata, duration, quality hints, normalized playable-state labels, and dedicated loading/error/empty placeholder visuals; panel sprite keeps `update(title)` compatibility while supporting richer header metadata. 2026-06-29 Web shelf playlist source code-side complete: React now loads Netease/QQ playlistList on sidecar ready, login status refresh, manual cookie import, and logout; `VisualEngineHost` maps real `PlaylistSummary[]` to shelf playlist cards before falling back to queue. 2026-06-29 shelf mode control persistence code-side complete: web shelf store now owns baseline `off/side/stage`, `static/dynamic`, and `always/auto` controls with a Tauri-migration localStorage key, control-console segmented buttons, `search-area`/`bottom-bar` stage-mode class sync, VisualEngineHost explicit shelf settings, and runtime right-click `off`→`side` promotion persisted without writing legacy `mineradio-lyric-layout-v1`. Still pending full row actions/playback parity, pinned detail content list, secondary-display seam/dwell, visual parity recording, and full interaction feedback. Boxes remain unchecked until visual parity is recorded.

- [ ] 右键唤起行为对齐。
- [ ] 常驻/静态/动态模式对齐。
- [ ] 滚轮热区对齐。
- [ ] hover 浮起、选中、滚动手感对齐。
- [ ] 详情页打开、滚动、中心行高亮对齐。
- [ ] 选择音和交互反馈对齐。
- [ ] 详情页不被歌词或卡片错误遮挡。
- [ ] 播客/收藏/合并开关能力对齐。

## Desktop Lyrics And Overlay Gate

> Stage 7a code-side vertical slice complete: shared `DesktopLyricsPayloadSchema` covers enabled/text/progress/colors/opacity/position/clickThrough/font/motion with fps 24/30/60/120 and font fitting knobs; React overlay route/search entry renders without `public/` iframe reuse, listens for `desktop-lyrics-payload` / `desktop-lyrics-lock-changed`, announces overlay readiness for cached payload replay, and invokes Tauri lock/move commands through the centralized runtime bridge; Tauri commands create/show/close desktop lyrics window, apply default click-through via `set_ignore_cursor_events(true)`, cache latest payload, validate native move deltas, and emit payload events under `labels::DESKTOP_LYRICS`. Verified by Bun shared/web tests and Rust pure helper tests. Renderer middle-click only covers unlocked -> locked because locked click-through suppresses WebView pointer delivery; locked-state middle-click pass-through/unlock still requires manual Windows WebView2 validation and possibly a native hot-bound follow-up, so parity boxes stay unchecked.
>
> Stage 7b code-side native poller wired: shared `DesktopLyricsHotBoundsSchema` now carries relative `{ left, top, right, bottom }` rectangles; React desktop lyrics overlay reports normalized DOM hot bounds through `desktop_lyrics_set_hot_bounds`; Rust/Tauri converts CSS logical hot bounds to physical pixels with the desktop lyrics window scale factor and stores them in native state. Windows runtime now starts a PowerShell `GetAsyncKeyState(4)` + `GetCursorPos` poller, reads `MMB x y` lines from stdout on a Rust background thread, hit-tests/debounces in native code, updates cached `DesktopLyricsRuntimeState.click_through` / `last_middle_at_ms`, calls `set_ignore_cursor_events(next)`, and emits `desktop-lyrics-lock-changed` without trusting renderer pointer delivery. Covered helpers include poller line parsing, scale 1.25/1.5 bounds conversion, screen bounds conversion, point-in-bounds, 260ms debounce, native event application, and idempotent poller stop/kill state. Windows WebView2 manual parity for real locked click-through unlock and white/black background readability remains pending, so all manual parity boxes below stay unchecked.

- [ ] 桌面歌词窗口开启/关闭正常。
- [ ] 置顶正常。
- [ ] 鼠标穿透正常。
- [ ] 中键锁定/解锁正常。
- [ ] 拖动正常。
- [ ] 白底/黑底可读性与 baseline 对齐。
- [ ] 桌面歌词不阻挡后台操作。
- [ ] 壁纸/覆盖层能力按原项目稳定行为对齐或进入延期文档。  — DECISIONS.md A7 已锁定 Wallpaper Engine 深联动、实验壁纸模式、手势识别/hand-canvas 发布前隐藏；Stage 7d 同步 `DEFERRED_CAPABILITIES.md` 为 `hidden`，不声明已实现 parity。

## Update And Release Gate

- [ ] Tauri updater manifest 可检测新版本。  — P10.a code-side detection wiring complete: Rust 已接入 `tauri-plugin-updater` 2.10.0、`check_for_update` / `get_updater_status` commands、`tauri.conf.json` endpoint 指向 `https://github.com/zzstar101/Mineradio/releases/latest/download/latest.json`；前端只调用 Rust commands，不暴露 JS updater plugin capability；`apps/desktop/src-tauri/src/updater.rs` 返回结构化状态（available/version/current_version/body/message/date/error/requires_signature/signature_gate/install_state），Web helper/store 以类型安全 camelCase 映射消费。B2 当前锁定不签名且 pubkey 为空，2.10.0 `download()` 会强制 `verify_signature(&buffer, &self.signature, &self.config.pubkey)`，所以安装/下载仍被 `signature-key-missing` gate 阻挡；待真实 manifest + release signing/public key 或最终风险决策后再勾选。
- [ ] 低版本构建能升级到新版本。
- [ ] Windows 安装包可安装、启动、卸载。
- [ ] 新 app id 和数据目录不读取旧 Mineradio 用户目录。  — P10.b code-side static evidence: `apps/desktop/src-tauri/tauri.conf.json` 的 Tauri identifier 为 `com.mineradio.fork.tauri`，不是旧 Electron `package.json` 中的 `com.mineradio.desktop`；README/NOTICE 明确新 Tauri 主线使用新的 app id、数据目录、仓库和 updater channel，且不承诺旧 Electron 用户数据迁移。尚未做 Windows 安装后 app data 目录实测，所以不勾选。
- [x] 旧 patch JSON 系统不进入 Tauri 主线。  — P10.b 文档证据补齐：README、NOTICE 与 `docs/migration/DEFERRED_CAPABILITIES.md` 均明确旧 Electron updater/轻量 patch JSON 不迁入 Tauri 主线；P10.a 的 Tauri updater endpoint 指向 `zzstar101/Mineradio`，未修改旧 Electron `package.json` build/publish。
- [ ] Release notes 明确二开身份和 GPL-3.0。  — P10.b code-side notices done: README 改为 Tauri 二开迁移主线说明，NOTICE 更新 fork/Tauri rewrite notice，新增 `THIRD_PARTY_NOTICES.md`。真实 GitHub Release notes 和安装包内 notices 尚未验证，所以不勾选。

## License Gate

- [ ] `docs/migration/LICENSE_GATE.md` 全部通过。
- [ ] 第三方 notices 完成。  — P10.b code-side done: `THIRD_PARTY_NOTICES.md` 已创建，NOTICE 已更新，并按 `LICENSE_GATE.md` 保留 Tauri/Three.js/GSAP 等待审核状态；安装包是否包含 notices 尚未验证。
- [x] QQ 开源项目 license 审核完成。  — DECISIONS.md A6 / LICENSE_GATE.md 已锁 `jsososo/QQMusicApi` / npm `qq-music-api` 为 GPL-3.0 可接入；`sansenjian/qq-music-api` 因 README 非商业附加条款与 GPL-3.0 冲突不接入。QQ 真实账号态/provider parity 仍由 provider gate 跟踪。
- [ ] 新增依赖 license allowlist 检查通过。

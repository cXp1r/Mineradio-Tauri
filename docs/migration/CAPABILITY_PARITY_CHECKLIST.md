# Capability Parity Checklist

更新时间：2026-06-28

Tauri 版对外发布前必须完成本清单。Electron 当前运行效果是视觉和交互基线；二开项目不需要迁移旧用户数据，但必须达到原项目完整能力。

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
- [ ] 文件导入导出正常。
- [ ] 全局热键注册、冲突提示、触发正常。

## Sidecar Gate

- [ ] Rust 启动 Bun sidecar。
- [ ] sidecar 使用随机端口并由 Rust 注入给前端。
- [ ] `/health` 返回 app version、api version、schema version、provider status。
- [ ] sidecar 崩溃后自动重启。
- [ ] 前端能显示 sidecar 恢复中/已恢复状态。
- [ ] sidecar rolling log 写入 app data。
- [ ] 诊断导出不包含 cookie。

## Provider Gate

> P4.5 + P7 完成 Netease 代码侧（search/songUrl/lyric/playlistDetail/loginStatus/logout 匿名可用；playlistList 延期；loginStatus/logout 真实路径需 B1 凭证后再做端到端 WebView2 验证）。QQ provider 全部保持 `license-review` 占位，待按 `DECISIONS.md` A6 接入 `jsososo/QQMusicApi`（GPL-3.0，npm 包 `qq-music-api`）。
>
> Stage 7c code-side login/session vertical slice complete: sidecar 新增 in-memory runtime auth session service，`POST /providers/:provider/session-cookie` 与 `DELETE /providers/:provider/session-cookie` / `POST /providers/:provider/session-cookie/clear` 只返回 `{ provider, stored }` ack，不回显 cookie；Netease/QQ provider client `getConfig()` 已改为 runtime session 优先、再 fallback `MINERADIO_NETEASE_COOKIE` / `MINERADIO_QQ_COOKIE`；web sidecar client 仅新增 set/clear transport methods，不把 cookie 放入 UI store；Tauri Rust 新增 Netease/QQ login webview window lifecycle skeleton（labels `login-netease` / `login-qq`，baseline URLs/titles/sizes）、cookie header parser/域过滤/login detector/header builder helpers 与 login window capability。自动化证据覆盖 shared ack schema strict no-cookie、sidecar runtime-over-env、route response/diagnostics 不泄露 fake cookie、QQ loginStatus runtime cookie logged-in path、web client no-retain ack、Rust helper tests。B1 真实凭证、WebView2 手动登录 cookie extraction/injection seam、Netease/QQ 真实账号态 loginStatus/logout 与高音质 songUrl 验证仍 pending，所以下方账号相关 gate 保持 unchecked。

- [x] Provider Adapter 层存在，前端不直接处理 Netease/QQ 分支差异。
- [ ] Netease 支持 search。  — P4.5 已落地（hana cloudsearch），待手动 WebView2 验证
- [ ] Netease 支持 songUrl。  — P4.5 已落地（hana songUrlV1，匿名 standard level），待手动 WebView2 验证 + B1 凭证验证 vip 音质
- [ ] Netease 支持 lyric。  — P4.5 已落地（hana lyricNew 优先，lyric 回退），待手动 WebView2 验证（简繁交错行 P7 select-current-index 已 sort 防御）
- [ ] Netease 支持 playlistList。  — 延期（P4.5 决议；走 `playlist-list-deferred` 占位）
- [ ] Netease 支持 playlistDetail。  — P4.5 已落地（hana playlistDetail），待手动 WebView2 验证
- [ ] Netease 支持 loginStatus。  — P4.5 已落地（无 cookie 时返回 logged-out，不走网络），待 B1 凭证注入后端到端验证
- [ ] Netease 支持 logout。  — P4.5 已落地（无 cookie 时 NOT_IMPLEMENTED(no-session)），待 B1 凭证注入后端到端验证
- [ ] QQ 支持 search。  — P4.5/A6 已落地（jsososo `qq.api("search", {key,pageNo,pageSize,t:0})`），body.list 字段差异（songmid/songname/singer/albumname/interval）已 mapper 字节对齐；Stage 2 已移除 `apps/web` SearchPanel 前端 QQ search gate，并以 Bun web tests/build 验证；待手动 WebView2 实搜验证与 B1 QQ cookie 账号态验证。
- [ ] QQ 支持 songUrl。  — A6 已落地（jsososo `qq.api("song/url", {id,type:"128"})`）；无 cookie 抛 ProviderError LOGIN_REQUIRED retryable:true action:"login"；待 B1 凭证注入端到端验证。
- [ ] QQ 支持 lyric。  — A6 已落地（jsososo `qq.api("lyric", {songmid})`）；jsososo 内 Base64 decode；hasTranslation 从 trans 字段派生；待手动 WebView2 验证 B1 cookie 后真实歌词同步。
- [ ] QQ 支持 playlistList。  — deferred（playlist-list-deferred 占位），与 Netease 一致。
- [ ] QQ 支持 playlistDetail。  — A6 已落地（jsososo `qq.api("songlist", {id})`）；body.cdlist[0] mapper；匿名可用，待手动验证 B1 cookie 后真实歌单打开/滚动/详情。
- [ ] QQ 支持 loginStatus。  — A6 已落地，无 cookie offline logged-out 不走网络；有 cookie trust cookie 存在；待 B1 凭证注入端到端 hook。
- [ ] QQ 支持 logout。  — A6 已落地，无 cookie 抛 ProviderNotImplementedError("qq","no-session")；有 cookie 调 jsososo user/logout best-effort。
- [x] Provider capability matrix 已更新（registry netease+qq 均 available:true，capabilities list 字段对齐 ProviderAdapter 接口）
- [ ] 跨源换源逻辑在 sidecar service 层完成。  — Stage 3 code-side fallback 已落地：`sidecars/api/src/services/cross-source-resolver.ts` 支持 provider-agnostic `/search` preferred/registry-order fallback、空结果继续尝试、`/song-url` 先直连 track.provider 再按 title/artists 搜索候选换源；Bun DI 单测与 route 注入测试通过。待 WebView2 手动实搜/真实 provider 换源证据后再勾选。
- [x] QQ 开源项目研究结果经过 license 审核。  — A6 已评估决定 `jsososo/QQMusicApi`（GPL-3.0 兼容，1.6k stars）；lint/repo 审核已记入 LICENSE_GATE.md QQ 项目审核表 + Dependency Audit 表（含 transitive deps）。`sansenjian/qq-music-api` 不接入（README 非商业附加条款与 GPL-3.0 冲突）。

## Playback Gate

> P7 code complete; Stage 4 sidecar `/audio-proxy` code complete for HTMLAudioElement URL shape (Range-only incoming header forwarding, safe upstream playback headers, CORS `*`, 200/206 stream passthrough, 400/502 envelopes) with Bun fake-fetch and route DI tests. Still pending manual WebView2 verification (`search → enqueue → proxied audio src → play → pause → seek → next → ended next → lyric sync`).

- [ ] 搜索结果能加入播放队列。  — P7 code complete; pending manual WebView2 verification
- [ ] 播放、暂停、恢复正常。  — P7 code complete; Stage 4 sidecar audio proxy code complete; pending manual WebView2 verification
- [ ] 下一首、上一首正常。  — P7 code complete; pending manual WebView2 verification
- [ ] 进度条随真实 audio 推进。  — P7 code complete; pending manual WebView2 verification
- [ ] seek 正常。  — P7 code complete; Stage 4 sidecar audio proxy Range forwarding covered by Bun tests; pending manual WebView2 verification
- [ ] ended 后按当前模式切歌。  — P7 code complete; pending manual WebView2 verification
- [ ] 单曲循环、队列循环等现有模式对齐。  — P7 code complete; pending manual WebView2 verification
- [ ] 音质选择行为对齐。
- [ ] 音频失败时有统一错误提示和恢复路径。  — P7 code complete; Stage 4 audio proxy maps missing/invalid url to BAD_REQUEST and upstream failures/non-ok statuses to retryable UPSTREAM_AUDIO_PROXY 502; pending WebView2 UI recovery verification
- [ ] WebView2 中真实播放链路通过，不只验证 URL。  — P7 code complete; Stage 4 proxy endpoint ready for HTMLAudioElement src; still pending manual WebView2 playback verification before this gate can be checked

## Lyrics Gate

> P7 code complete; pending manual WebView2 verification (`play track → lyric loads → current line follows timeupdate`).

- [ ] 普通歌词获取和解析正常。  — P7 code complete; pending manual WebView2 verification
- [ ] 新歌词/逐字歌词能力按原项目行为对齐。
- [ ] 歌词高亮、进度、位置、缩放、颜色、发光对齐。  — P7 code complete; pending manual WebView2 verification (lyric sync wired via store + selectCurrentIndex)
- [ ] 自定义歌词能力对齐。
- [ ] 歌词与播放进度同步。  — P7 code complete; pending manual WebView2 verification (defensive sort handles interleaved NCM lrc)
- [ ] 视觉场景下歌词层级和遮挡关系与 baseline 对齐。

## Visual Parity Gate

- [ ] 启动动画截图/录屏与 baseline 对齐。  — P8.splash code complete; pending manual WebView2 parity recording
- [ ] 主视觉粒子场与 baseline 对齐。  — P8.s2c.1 code complete (HomeVisual field + fx defaults + preset state + audio→uniform projection); pending manual WebView2 parity recording
- [ ] 控制台 SVG 玻璃质感与 baseline 对齐。  — P8.s3 code complete; pending manual WebView2 parity recording (control-glass-svg.ts byte-equal to baseline filter; attachControlGlassNode wires ResizeObserver)
- [ ] 播放后 Emily/默认视觉入场与 baseline 对齐。
- [ ] Canvas/WebGL 无空白、错位、闪烁。  — P8.s3 code complete; pending manual WebView2 parity recording (bottom-bar SVG glass + control button motion)
- [ ] GSAP timing 与 baseline 对齐。  — P8.s3 code complete; pending manual WebView2 parity recording (back.out(2.1), back.out(1.8/1.9), power2.out, click pulse 0.58/0.42s preserved)
- [ ] 歌词舞台动画与 baseline 对齐。  — P8.s4.b lifecycle + GSAP lyr-in/bob/out + YRC timetable driver + RenderStepSlot.StageLyrics registry landed. Stage 5 host wiring is code-complete: `VisualEngineHost` maps shared lyric payload into visual lyric lines, `useVisualEngine` mounts `createStageLyricsLifecycle`, calls `setLyricLines`, and registers `RenderStepSlot.StageLyrics` in the render loop. Earlier note: P8.s4.a stage-lyrics builder landed (THREE.Group with sun/glow/readability/text-shader/sparks; 16 userData.lyric fields; renderOrders 40/41/42/43/44; full YRC fragment shader verbatim). Pending manual WebView2 visual parity recording before gate can be checked.
- [ ] 视觉控制台 UI 与 baseline 对齐。
- [ ] baseline 视觉存档读入后效果与 Electron baseline 对齐。  — P8.s2c.1 code complete (HomeVisual field + fx defaults + preset state + audio→uniform projection); pending manual WebView2 parity recording
- [ ] 不出现廉价透明、错位、过度渐变、卡顿、跳帧。

## 3D Playlist Shelf Gate

> P8.s6.a core data + layout math + entrance animation constants ported (`packages/visual-engine/src/shelf/`). P8.s6.b code complete for Three.js card meshes, Canvas sprite texture, rendered window limit, and `RenderStepSlot.Shelf` host registration. P8.s6.c.1 code complete for queue-backed shelf items, pane memory restore, and `connectorParticles` mount. P8.s6.c.2 code complete for baseline focus-zone camera targets/timers in `CinemaCamera`. P8.s6.c.3 code complete for focus resolver and host pointer wiring. P8.s6.c.4 code complete for queue focus DOM math and side-card raycast plumbing. P8.s6.c.5 code complete for first-level hover selection and primary card click/action plumbing. P8.s6.c.6 code complete for baseline primary hit `raycastCards || pickCardAtScreen` screen-space fallback/padding behavior. P8.s6.c.7 code complete for baseline-style shelf visibility target/easing driver (`stage` + data and `side` + `always` fade in by 0.22; `off`/empty fade out by 0.18 with near-zero clamp; `side` + `auto` remains hidden unless detail content is open) and per-frame host sync of shelf mode/presence. P8.s6.c.8 partial wheel parity code complete for stage/card-hit scroll, side `always`/card-hit scroll with 18px screen pad, and Shift-forced scroll in stage plus side `always`; side `auto` remains non-scrolling without preview state. P8.s6.c.9 code complete for visual-engine pinned shelf state, right-click side pinned toggle/focus, open-detail right-click close-and-pin behavior, pinned side auto visibility target, and pinned wheel card-hit/Shift-force paths. P8.s6.c.10 code complete for side-auto preview wheel-zone/Shift/card-hit paths, including baseline landscape/portrait hot-zone geometry and no 18px pad for preview card hits. P8.s6.c.11 code complete for pinned normal wheel hot-zone geometry/scroll. P8.s6.c.12 code complete for baseline contextmenu `off`→`side` mutation through runtime shelf mode ref/callback before pinned side open/focus behavior. P8.s6.c.13 code complete for baseline shelfHoverCue state/tick semantics and side-auto preview visibility parity. P8.s6.d.1 code complete for detail-list state/layout skeleton (`ShelfContentList`: open/close token reset, loading/error rows, clamp scroll, centerSmooth 0.18, max-11 render window, baseline row layout/panel opacity math) without provider fetch, row actions, or canvas panel rendering. P8.s6.d.2 partial wheel plumbing code complete for open detail `contentList.scrollBy` when an injected detail-wheel target predicate matches, preserving baseline no-consume behavior for detail misses, UI targets, splash, and shelf `off` mode; real row/panel raycast target detection remains pending. P8.s6.d.3 primitives complete for baseline detail-list row/panel screen-space hit sorting, padding, uv, and constants. P8.s6.d.4 content-list screen target state/hit API complete. P8.s6.d.5 code complete for detail row/panel Three meshes under a dedicated detail group, capped visible row render window, baseline detail-group transform placement, per-frame world-space screen target sync, and cleanup on close/off/dispose. P8.s6.d.6 code complete for web detail wheel target detection using `contentList.hasScreenTargetAt({ x: event.clientX, y: event.clientY })`, while retaining injected predicate overrides and preserving UI/splash/off/detail-miss no-consume behavior. P8.s6.d.7 code complete for detail row click callback plumbing: screen picks now expose row index, manager screen target sync carries actual row index, and web open-detail clicks consume real row hits through `contentList.pickRowAtScreen({ x: event.clientX, y: event.clientY })` while placeholder rows remain inert and misses do not fall through to first-level shelf clicks. P8.s6.d.8 code complete for provider playlistDetail data plumbing on already-open shelf detail: `ShelfManager` notifies host with playlist metadata/requestToken, web host calls `SidecarClient.playlistDetail`, maps shared tracks into detail rows, and writes success/error through token-guarded `ShelfContentList` methods so stale responses cannot overwrite newer detail opens. P8.s6.d.9 code complete for loaded shelf detail row enqueue/play plumbing: web detail rows preserve shared track metadata, reconstruct tracks through shared zod validation, reuse search playback semantics, and deterministically ignore invalid or hard non-playable rows. P8.s6.d.10 code complete for detail canvas sprite drawing: rows now render cover/placeholder cues, title/subtitle metadata, duration, quality hints, normalized playable-state labels, and dedicated loading/error/empty placeholder visuals; panel sprite keeps `update(title)` compatibility while supporting richer header metadata. Still pending full row actions/playback parity, visual DIY shelf mode control persistence, pinned detail content list, secondary-display seam/dwell, broader provider/user playlist abilities, visual parity recording, and full interaction feedback. Boxes remain unchecked until visual parity is recorded.

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
- [ ] 壁纸/覆盖层能力按原项目稳定行为对齐或进入延期文档。

## Update And Release Gate

- [ ] Tauri updater manifest 可检测新版本。
- [ ] 低版本构建能升级到新版本。
- [ ] Windows 安装包可安装、启动、卸载。
- [ ] 新 app id 和数据目录不读取旧 Mineradio 用户目录。
- [ ] 旧 patch JSON 系统不进入 Tauri 主线。
- [ ] Release notes 明确二开身份和 GPL-3.0。

## License Gate

- [ ] `docs/migration/LICENSE_GATE.md` 全部通过。
- [ ] 第三方 notices 完成。
- [ ] QQ 开源项目 license 审核完成。
- [ ] 新增依赖 license allowlist 检查通过。

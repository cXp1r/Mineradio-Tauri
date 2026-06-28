# Capability Parity Checklist

更新时间：2026-06-27

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

- [x] Provider Adapter 层存在，前端不直接处理 Netease/QQ 分支差异。
- [ ] Netease 支持 search。  — P4.5 已落地（hana cloudsearch），待手动 WebView2 验证
- [ ] Netease 支持 songUrl。  — P4.5 已落地（hana songUrlV1，匿名 standard level），待手动 WebView2 验证 + B1 凭证验证 vip 音质
- [ ] Netease 支持 lyric。  — P4.5 已落地（hana lyricNew 优先，lyric 回退），待手动 WebView2 验证（简繁交错行 P7 select-current-index 已 sort 防御）
- [ ] Netease 支持 playlistList。  — 延期（P4.5 决议；走 `playlist-list-deferred` 占位）
- [ ] Netease 支持 playlistDetail。  — P4.5 已落地（hana playlistDetail），待手动 WebView2 验证
- [ ] Netease 支持 loginStatus。  — P4.5 已落地（无 cookie 时返回 logged-out，不走网络），待 B1 凭证注入后端到端验证
- [ ] Netease 支持 logout。  — P4.5 已落地（无 cookie 时 NOT_IMPLEMENTED(no-session)），待 B1 凭证注入后端到端验证
- [ ] QQ 支持 search。  — 待 A6 接入 `jsososo/QQMusicApi`（npm `qq-music-api`，GPL-3.0）后实现
- [ ] QQ 支持 songUrl。
- [ ] QQ 支持 lyric。
- [ ] QQ 支持 playlistList。
- [ ] QQ 支持 playlistDetail。
- [ ] QQ 支持 loginStatus。
- [ ] QQ 支持 logout。
- [x] Provider capability matrix 已更新（registry netease available:true；qq available:false action:license-review）
- [ ] 跨源换源逻辑在 sidecar service 层完成。
- [ ] QQ 开源项目研究结果经过 license 审核。  — A6 已评估决定 `jsososo/QQMusicApi`（GPL-3.0 兼容，1.6k stars）；lint/repo 审核已记入 LICENSE_GATE.md。`sansenjian/qq-music-api` 不接入（README 非商业附加条款与 GPL-3.0 冲突）。

## Playback Gate

> P7 code complete; pending manual WebView2 verification (`search → enqueue → play → pause → seek → next → ended next → lyric sync`).

- [ ] 搜索结果能加入播放队列。  — P7 code complete; pending manual WebView2 verification
- [ ] 播放、暂停、恢复正常。  — P7 code complete; pending manual WebView2 verification
- [ ] 下一首、上一首正常。  — P7 code complete; pending manual WebView2 verification
- [ ] 进度条随真实 audio 推进。  — P7 code complete; pending manual WebView2 verification
- [ ] seek 正常。  — P7 code complete; pending manual WebView2 verification
- [ ] ended 后按当前模式切歌。  — P7 code complete; pending manual WebView2 verification
- [ ] 单曲循环、队列循环等现有模式对齐。  — P7 code complete; pending manual WebView2 verification
- [ ] 音质选择行为对齐。
- [ ] 音频失败时有统一错误提示和恢复路径。  — P7 code complete; pending manual WebView2 verification
- [ ] WebView2 中真实播放链路通过，不只验证 URL。  — P7 code complete; pending manual WebView2 verification

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
- [ ] 歌词舞台动画与 baseline 对齐。  — P8.s4.b lifecycle + GSAP lyr-in/bob/out + YRC timetable driver + RenderStepSlot.StageLyrics registry landed (DI seam; pending RenderLoop registration mount from host and App.tsx).  Earlier note: P8.s4.a stage-lyrics builder landed (THREE.Group with sun/glow/readability/text-shader/sparks; 16 userData.lyric fields; renderOrders 40/41/42/43/44; full YRC fragment shader verbatim); awaiting host mounting.
- [ ] 视觉控制台 UI 与 baseline 对齐。
- [ ] baseline 视觉存档读入后效果与 Electron baseline 对齐。  — P8.s2c.1 code complete (HomeVisual field + fx defaults + preset state + audio→uniform projection); pending manual WebView2 parity recording
- [ ] 不出现廉价透明、错位、过度渐变、卡顿、跳帧。

## 3D Playlist Shelf Gate

> P8.s6.a core data + layout math + entrance animation constants ported (`packages/visual-engine/src/shelf/`). P8.s6.b code complete for Three.js card meshes, Canvas sprite texture, rendered window limit, and `RenderStepSlot.Shelf` host registration. P8.s6.c.1 code complete for queue-backed shelf items, pane memory restore, and `connectorParticles` mount. P8.s6.c.2 code complete for baseline focus-zone camera targets/timers in `CinemaCamera`. P8.s6.c.3 code complete for focus resolver and host pointer wiring. P8.s6.c.4 code complete for queue focus DOM math and side-card raycast plumbing. P8.s6.c.5 code complete for first-level hover selection and primary card click/action plumbing. P8.s6.c.6 code complete for baseline primary hit `raycastCards || pickCardAtScreen` screen-space fallback/padding behavior. P8.s6.c.7 code complete for baseline-style shelf visibility target/easing driver (`stage` + data and `side` + `always` fade in by 0.22; `off`/empty fade out by 0.18 with near-zero clamp; `side` + `auto` remains hidden unless detail content is open) and per-frame host sync of shelf mode/presence. P8.s6.c.8 partial wheel parity code complete for stage/card-hit scroll, side `always`/card-hit scroll with 18px screen pad, and Shift-forced scroll in stage plus side `always`; side `auto` remains non-scrolling without preview state. P8.s6.c.9 code complete for visual-engine pinned shelf state, right-click side pinned toggle/focus, open-detail right-click close-and-pin behavior, pinned side auto visibility target, and pinned wheel card-hit/Shift-force paths. P8.s6.c.10 code complete for side-auto preview wheel-zone/Shift/card-hit paths, including baseline landscape/portrait hot-zone geometry and no 18px pad for preview card hits. P8.s6.c.11 code complete for pinned normal wheel hot-zone geometry/scroll. P8.s6.c.12 code complete for baseline contextmenu `off`→`side` mutation through runtime shelf mode ref/callback before pinned side open/focus behavior. P8.s6.c.13 code complete for baseline shelfHoverCue state/tick semantics and side-auto preview visibility parity. P8.s6.d.1 code complete for detail-list state/layout skeleton (`ShelfContentList`: open/close token reset, loading/error rows, clamp scroll, centerSmooth 0.18, max-11 render window, baseline row layout/panel opacity math) without provider fetch, row actions, or canvas panel rendering. P8.s6.d.2 partial wheel plumbing code complete for open detail `contentList.scrollBy` when an injected detail-wheel target predicate matches, preserving baseline no-consume behavior for detail misses, UI targets, splash, and shelf `off` mode; real row/panel raycast target detection remains pending. Still pending visual DIY shelf mode control persistence, detail-list row/panel hit plumbing, pinned detail content list, provider playlist data, secondary-display seam/dwell, visual parity recording, and full interaction feedback. Boxes remain unchecked until visual parity is recorded.

- [ ] 右键唤起行为对齐。
- [ ] 常驻/静态/动态模式对齐。
- [ ] 滚轮热区对齐。
- [ ] hover 浮起、选中、滚动手感对齐。
- [ ] 详情页打开、滚动、中心行高亮对齐。
- [ ] 选择音和交互反馈对齐。
- [ ] 详情页不被歌词或卡片错误遮挡。
- [ ] 播客/收藏/合并开关能力对齐。

## Desktop Lyrics And Overlay Gate

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

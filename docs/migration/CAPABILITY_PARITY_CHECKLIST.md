# Capability Parity Checklist

更新时间：2026-06-27

Tauri 版对外发布前必须完成本清单。Electron 当前运行效果是视觉和交互基线；二开项目不需要迁移旧用户数据，但必须达到原项目完整能力。

## Baseline Freeze

- [x] 建立 Electron baseline tag 或 branch。
- [x] 记录 baseline commit、tag/branch 名称、采集日期、操作者和操作系统版本。
- [x] 建立 baseline artifacts 目录，并记录截图、录屏、视觉存档和测试素材路径。
- [x] 保存默认视觉存档用于对照。
- [x] 保存主界面静态截图。
- [ ] 保存启动动画录屏。
- [ ] 保存播放中控制台截图和录屏。
- [x] 保存视觉控制台打开状态截图。
- [ ] 保存 3D 歌单架打开、滚动、详情页、点击播放录屏。
- [ ] 保存桌面歌词开启、锁定、解锁、拖动录屏。
- [ ] 记录测试歌曲、封面、歌词和窗口尺寸。
- [x] 记录 baseline 最小验证命令输出：`git diff --check`、`node --check server.js`。
- [ ] `docs/migration/baseline/BASELINE_CAPTURE.md` 已填写 commit、branch、测试歌曲、视觉存档和外部存储路径。
- [ ] `docs/migration/baseline/BASELINE_METADATA.template.json` 已复制为实际 metadata 并填充。

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

- [ ] Provider Adapter 层存在，前端不直接处理 Netease/QQ 分支差异。
- [ ] Netease 支持 search。
- [ ] Netease 支持 songUrl。
- [ ] Netease 支持 lyric。
- [ ] Netease 支持 playlistList。
- [ ] Netease 支持 playlistDetail。
- [ ] Netease 支持 loginStatus。
- [ ] Netease 支持 logout。
- [ ] QQ 支持 search。
- [ ] QQ 支持 songUrl。
- [ ] QQ 支持 lyric。
- [ ] QQ 支持 playlistList。
- [ ] QQ 支持 playlistDetail。
- [ ] QQ 支持 loginStatus。
- [ ] QQ 支持 logout。
- [ ] Provider capability matrix 已更新。
- [ ] 跨源换源逻辑在 sidecar service 层完成。
- [ ] QQ 开源项目研究结果经过 license 审核。

## Playback Gate

- [ ] 搜索结果能加入播放队列。
- [ ] 播放、暂停、恢复正常。
- [ ] 下一首、上一首正常。
- [ ] 进度条随真实 audio 推进。
- [ ] seek 正常。
- [ ] ended 后按当前模式切歌。
- [ ] 单曲循环、队列循环等现有模式对齐。
- [ ] 音质选择行为对齐。
- [ ] 音频失败时有统一错误提示和恢复路径。
- [ ] WebView2 中真实播放链路通过，不只验证 URL。

## Lyrics Gate

- [ ] 普通歌词获取和解析正常。
- [ ] 新歌词/逐字歌词能力按原项目行为对齐。
- [ ] 歌词高亮、进度、位置、缩放、颜色、发光对齐。
- [ ] 自定义歌词能力对齐。
- [ ] 歌词与播放进度同步。
- [ ] 视觉场景下歌词层级和遮挡关系与 baseline 对齐。

## Visual Parity Gate

- [ ] 启动动画截图/录屏与 baseline 对齐。
- [ ] 主视觉粒子场与 baseline 对齐。
- [ ] 控制台 SVG 玻璃质感与 baseline 对齐。
- [ ] 播放后 Emily/默认视觉入场与 baseline 对齐。
- [ ] Canvas/WebGL 无空白、错位、闪烁。
- [ ] GSAP timing 与 baseline 对齐。
- [ ] 歌词舞台动画与 baseline 对齐。
- [ ] 视觉控制台 UI 与 baseline 对齐。
- [ ] baseline 视觉存档读入后效果与 Electron baseline 对齐。
- [ ] 不出现廉价透明、错位、过度渐变、卡顿、跳帧。

## 3D Playlist Shelf Gate

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

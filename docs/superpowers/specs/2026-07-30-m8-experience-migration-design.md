# M8 P1 体验与数据迁移设计

**日期：** 2026-07-30

**状态：** Code Complete / Automated Verification Complete / Field Validation Pending（non-blocking）

**基线：** `21c9c6c`（M1–M7 Code Complete；M5–M7 Windows Field Validation Pending，non-blocking）

**上位设计：** `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md`

**上游行为基线：** Mineradio Electron 2.0.2，`4abaa190de42c632365ae4244e041bad16443224`

## 1. 目标

M8 已收口五类 P1 能力：

1. Home 2.0 Dashboard；
2. 搜索历史与有界渐进分页；
3. 设置工作台与可逆设置 undo；
4. 非破坏性用户偏好和收听数据迁移；
5. 低配模式与确定性性能门禁。

M8 迁移用户可观察结果，不复制 Electron 的全局 DOM、脚本顺序、同步存储和快照式回滚。新能力进入当前 Tauri 的 feature、Port/Adapter、Rust runtime 与 visual-engine 架构。

## 2. 硬约束

M8 全程冻结：

- Bun Sidecar 路由和响应行为；
- 音乐 API、`@mineradio/shared` DTO 和 Provider 集合；
- media URL 语义；
- `bundle.externalBin`；
- M7 Wallpaper Engine / Full Desktop ownership；
- 开发中的 Rust `mineradio-api`。

允许追加只用于本地持久化的 Tauri command，但不得修改现有 command 语义。M8 不进入 M9，不以新 Rust API 替换 `SidecarClient`。

TDD 只覆盖核心流程：request generation、pagination、history migration、setting transaction/undo、listen ledger migration、资源释放和资源上限。普通布局、文案和简单点击使用聚焦的行为测试。

## 3. 决策摘要

### 3.1 Home 使用现有 Discover seam

`DiscoverPort`、`LibraryPort` 和 `SearchExperiencePort` 保持不变。Dashboard 只消费当前 `DiscoverHomeResponse`、天气、队列和本地收听 ledger。

M8 不新增平台推荐 route，也不把 fallback 数据标成“平台官方推荐”。当前 Sidecar 最多提供 12 首 `dailySongs`，因此 UI 使用“当前已载入 N 首”，不声明完整每日推荐。

### 3.2 搜索由一个 Session owner 统一

当前 compact 与 detail 各自持有 request sequence，却共同写 Store；Enter 会触发两次请求，跨 Surface 的旧响应仍可能覆盖新结果。

M8 建立一个高 Depth 的 `SearchSessionController`。它独占：

- committed intent 与 generation；
- request phase、stale 判定和显式 retry；
- compact/detail 共享结果；
- Podcast drill-in；
- 分页 ownership；
- 成功后的历史提交；
- detail visibility。

React Surface 只消费 snapshot 和发送 intent。`SearchDetailPage` 改为依赖 `SearchExperiencePort`/controller，不再直接依赖 `SidecarClient`。

### 3.3 分页是 frozen Port 上的有界渐进分页

现有 `SearchPort` 没有 offset/cursor/total/hasMore，All resolver 又固定最多返回 18 首。M8 不伪造远端分页能力：

- All：在当前最多 18 首内渐进展示；
- 显式 Provider：以 cumulative limit 重新请求，按 Track identity 合并；无新增、响应少于请求量或达到本地上限即 exhausted；
- Podcast hot/programs：使用现有 offset 做真实分页；
- Podcast search：保持单页。

同时只允许一个 `loadNext`。append 必须匹配 exact generation；query/mode 切换立即使旧 append 失效。

完成状态名称固定为：`Bounded progressive pagination over the frozen SearchExperiencePort`。不得宣称 Electron 2.0.2 的 180 首、多 Provider offset parity。

### 3.4 搜索历史采用 typed preference

搜索历史在成功获得结果后才提交；空结果、失败请求和空关键词不写入。历史规则：

- 大小写不敏感去重；
- 最近优先；
- 最多 10 条；
- 支持单项删除和清空；
- 迁移旧 array、`items` envelope 和旧 mode map；
- 损坏数据隔离，不阻止搜索。

历史使用 `PreferencesRepository` 的 typed key，不另建只有一个实现的浅 repository。

### 3.5 设置使用事务历史，不使用整页快照回滚

`SettingsTransactionController` 是设置 mutation 的单一 owner。每条历史记录包含：

```ts
interface SettingsHistoryEntry {
  id: string;
  label: string;
  changedPaths: SettingPath[];
  before: SettingsSnapshot;
  after: SettingsSnapshot;
  mergeKey?: string;
  committedAt: number;
}
```

固定不变量：

- apply + persist 成功后才 push；
- undo 成功后才 pop，失败保留；
- 只恢复 `changedPaths`，不能覆盖 unrelated 新值；
- multi-key patch 只有一条记录；
- no-op 不记录；
- slider/color 在 650ms gesture 窗口按 `mergeKey` 合并；
- 当前会话最多 40 条，不跨启动持久化；
- mutation 与 undo 串行；
- rollback-to 对区间 changed paths 求并集并恢复最早 before。

缓存清理、内存 trim、缓存根删除、Full Desktop、Wallpaper Engine、更新、登录、文件导入和其他 native ownership 操作不进入通用 undo。

### 3.6 PreferencesRepository 静态链接进 Tauri 持久化层

Web interface 保持上位设计的 typed key + schema + transaction：

```ts
interface PreferencesRepository {
  get<T>(key: PreferenceKey<T>): Promise<T>;
  set<T>(key: PreferenceKey<T>, value: T): Promise<void>;
  remove<T>(key: PreferenceKey<T>): Promise<void>;
  transaction<T>(work: (tx: PreferencesTransaction) => Promise<T>): Promise<T>;
}
```

生产 Adapter 使用同一 Tauri 主进程中的 SQLite；浏览器测试/预览使用 memory/browser Adapter。Rust 只追加 allowlist command，不暴露任意 KV：

```text
get_preferences_snapshot
commit_preferences_transaction
migrate_legacy_preferences
```

Rust 对 schema version、key allowlist、单值大小、总 payload、操作数和启动 IPC 次数设置硬上限。`RuntimeSettingsStore` 继续只管理 native runtime 设置，不扩张为通用 KV。

### 3.7 非破坏性迁移

M8 首批迁移普通偏好、搜索历史和 Home 收听 ledger。大对象保留既有数据并进入各自 repository seam；M8 不把 Base64 封面或字体塞进通用 preference JSON。

首批 legacy key 与代码接线状态：

| Legacy key | 新 key/归属 | M8 状态 |
| --- | --- | --- |
| `mineradio-playback-quality-v1` | `playback.quality` | 已由 composition root hydration，并由播放质量写路径 canonical-first 提交 |
| `mineradio-user-capsule-auto-hide-v1` | `shell.capsuleAutoHide` | 已由 `useShellPreferences` hydration/写路径接入 |
| `mineradio-playlist-panel-pinned-v1` | `shell.playlistPanelPinned` | 已由 `useShellPreferences` hydration/写路径接入 |
| `mineradio-diy-player-mode-v1` | `shell.diyMode` | 已由 `useShellPreferences` hydration/写路径接入 |
| `mineradio-visual-guide-seen-v2` | `shell.visualGuideSeen` | 已由 shell 写路径接入 |
| `mineradio-tauri-shelf-settings-v1` | `visual.shelf` | 已与 visual 重叠字段组成同一 repository transaction；canonical commit 后才发布 Zustand 快照 |
| `mineradio-tauri-visual-settings-v1` | `visual.fx` | 已由 visual 设置 mutation/undo 的实际 commit 路径接入 |
| `mineradio-fx-fab-auto-hide-v1` | `settings.fabAutoHide` | 已 hydration，并在 canonical commit 成功后更新 FAB UI |
| `mineradio.wallpaper-engine.selection.v1` | `desktop.wallpaperSelection` | 已 hydration；选择只有 canonical commit 成功后才成为当前选择 |
| `mineradio-listen-stats-v1` | `home.listenLedger.v2` | 已由 Home domain mapping 迁移；v1 不伪造 daily rollup |
| `mineradio-search-history` | `search.history` | 已支持 array、`items` envelope 和 nested mode map；成功搜索后才提交，最多 10 条 |

`mineradio-tauri-close-behavior-v1` 已由 Rust `RuntimeSettings` 迁移并清理，不重复迁回 Web repository。`mineradio.visualAudioDebug` 保持 dev-only。导入歌单、自定义歌词、封面和字体在 M8 只建立 domain repository seam 并保持 legacy 数据可读；文件化迁移必须在不丢数据且有磁盘配额策略后单独启用。

迁移 journal 状态：

```text
legacy-authoritative -> copied -> verified -> committed
```

语义：

1. Web 读取 legacy raw，schema 校验并计算 digest；
2. SQLite transaction 写新值和 `copied` journal；
3. 从新存储读回验证后标记 `committed`；
4. committed 前 legacy 为权威，内容变化则以新 digest 重跑；
5. committed 后新存储为权威；
6. 写入先提交新存储，再 best-effort 镜像可无损映射的 legacy key；
7. legacy mirror 失败记录诊断，不回滚新值；
8. legacy 至少保留两个正式版本，M8 不删除；
9. hydration 完成前禁止把默认值写回。

### 3.8 Home listen ledger v2

v1 只有每首歌的累计 plays/listenMs/lastPlayedAt，不能准确还原历史每日统计。v2 保存：

```text
version
recent sessions
song lifetime aggregate
artist lifetime aggregate
daily rollup by local YYYY-MM-DD
```

v1 迁移只保留 lifetime aggregate、recent 和 top artist；不把累计时长伪造到最后播放日。今日时长、歌曲数和连续天数从升级后的真实 session 开始准确累计。

### 3.9 Home Hero MP4 使用 IndexedDB

自定义 Hero 视频是 Blob，不进入 SQLite preference JSON。`HomeHeroVideoRepository` 使用 IndexedDB，限制 MP4 且最大 300MB。controller 持有 generation；替换、关闭 Home、页面隐藏和卸载时暂停 video，并且只 revoke 自己创建的 Object URL。

### 3.10 低配模式与门禁

低配模式是可逆设置事务，复用 visual runtime 已有的 `performanceQuality`、`performanceBackground` 和资源预算，不创建第二套 frame loop。它不降低媒体时钟精度，也不修改 Bun API。

确定性 PR gate `bun run perf:budget` 覆盖：

- Home/Search/Settings 可见 DOM 上限；
- 大列表虚拟窗口；
- Depth 热路径大数组分配保持 0；
- Web bundle 相对 checked-in baseline 不恶化超过 10%；
- migration key/payload/transaction/startup IPC 上限；
- mount/unmount 后 timer、listener 和 Object URL 归零；
- 除 legacy Adapter 外禁止生产代码直接访问 `localStorage`。

真实 release 性能仍使用 Windows runner：5 次冷启动中位数；10 秒预热 + 60 秒采样 × 3；记录 CPU、Working Set、Private Bytes、GPU memory、p50/p95 frame time 和包体积。

## 4. Home 2.0 用户结果

Dashboard 包含：

- 日期、时间、每日热评与换一条；
- 自定义 MP4 Hero 的选择、替换和删除；
- Continue：当前队列/暂停恢复 → 最近播放 → 当前已载入每日推荐；
- Library：已登录打开音乐库，未登录打开本地导入；
- Daily 与 Recent 快捷入口；
- 今日聆听时长、唯一歌曲数、常听歌手和连续天数；
- Next Up；
- For You：跨来源去重、按日期稳定、最多三首；
- 现有公开推荐、Provider 歌单、播客、天气 rail；
- 现有歌单详情；
- discover/weather 局部失败与重试。

Dashboard policy、listen ledger、Hero Blob lifecycle 分别是独立 deep Module。`useHomeController` 保留 discover/播放/导航编排，不接管 Blob implementation。

## 5. 设置工作台信息架构

工作台使用六个 task-oriented tab：

```text
常用 / 界面 / 歌词 / 动效 / 歌单架 / 系统
```

提供：

- 全局设置搜索；
- 最近更改（最多 40 条）；
- 单步 undo 和 rollback-to；
- 低配模式；
- 完整 reset 的可逆 preference 部分；
- 现有 Desktop Runtime 控件，但 native 动作明确标记不可 undo。

`VisualControlPanelHost` 的现有控件 definition 被 catalog 引用，不通过 DOM 查询、节点搬移或冒泡推断 mutation。空的 `user-archive-grid` 被真实历史替换。

## 6. 手动音源切换

P1 搜索体验还包含现有 Provider 间手动音源切换。M8 只对网易云、QQ、汽水和当前 capability 可用项展示入口。

`SourceSwitchController` 必须：

- 使用 `SearchPort` 搜索目标 Provider；
- 严格匹配标题和主歌手，拒绝翻唱、Remix 和额外歌手误匹配；
- 绑定 expected playback intent；
- 成功只替换 exact 当前 queue index，并保留 position；
- load/resolve 失败保持原 Track、队列和位置；
- 显示实际 resolved Provider，不显示请求值冒充结果。

本地文件、Podcast、当前 Provider 和缺少 capability 的 Provider禁用。Kugou/Spotify 不在 M8。

## 7. Code Complete 与不可宣称项

M8 Code Complete 记录：

- Home Dashboard 已包含 Continue、按 queue/single/loop/stable-shuffle 计算的 Next Up、跨 Provider identity 的 For You、listen ledger v2、MP4 Hero、天气/歌单/播客 rail、600 首歌单详情虚拟化与 discover/weather 局部重试；
- compact/detail 已收敛到单一 `SearchSessionController`，完成 stale/retry/single-flight、真实历史 UI，以及 frozen `SearchExperiencePort` 上的有界渐进分页；
- 设置工作台已完成六 tab、控件标签搜索、最多 40 条最近更改、串行 mutation/undo、rollback-to、650ms gesture merge、低配模式和可逆 preference reset；native/destructive slot 明确标记不可撤销；
- 手动音源切换已完成严格标题/主歌手匹配、stale intent、exact index/position preserve、resolve/load failure rollback 和实际 Provider 校验；
- typed `PreferencesRepository`、memory/browser/Tauri conformance、SQLite v3、allowlist/quota/quarantine、`copied → verified → committed` journal 和 canonical-first/legacy-mirror 写语义已完成并接入首批生产写路径；
- `perf:budget`、CI 接线与 Windows release evidence schema/runner 已落地；最终门禁为 Bun/workspace `2222 passed`、Rust 主 crate `292 passed`、Updater example `7 passed`，workspace typecheck、Web production build、deterministic performance budget、Rust fmt、全 target/feature Clippy `-D warnings`、API/architecture freeze 与 `git diff --check` 全绿。

以下可以标记 `Field Validation Pending (non-blocking)`，不阻止 Code Complete：

- 正式 WebView2 冷启动和完整进程树内存；
- iGPU/低配实体机、电池和温控；
- Home/Shelf/Sonic/后台 30–60 分钟 soak；
- 真实旧版本用户目录升级和旧版本回滚；
- 大型 MP4、字体、封面的磁盘配额与权限；
- 安装器升级和断电恢复。

M8 不得宣称：

- Electron 2.0.2 完整远端搜索分页；
- All 模式 180 首或 Provider partial-error UI；
- Kugou/Spotify/平台推荐 Feed；
- 所有 Base64 用户资产已经文件化；
- 所有 native 操作可 undo；
- 已在正式 WebView2 release 构建验证冷启动、完整进程树内存、GPU/frame time 或包体积收益；
- 已在真实低配/iGPU/电池/温控环境验证；
- 已完成真实旧版本用户目录升级、旧版本回滚、安装器升级、断电恢复或大型 MP4/字体/封面权限验证；
- 已完成 Home/Shelf/Sonic/后台 30–60 分钟 Windows soak；
- 已接入开发中的 Rust `mineradio-api`，或已经开始 M9。

M8 完成后继续保持 Bun Sidecar 路由和响应、现有音乐 API、`@mineradio/shared` DTO、Provider 集合、media URL 与 `bundle.externalBin` 冻结。M9 未开始；任何未来 API 嵌入都必须另行设计、实现和验证。

# 发现与决策

## 需求
- 用户要求完成 M4。
- M4 上位范围：Stage Lyrics 2.0、歌词纹理/GPU 上传预算、Sonic Topography、3D Shelf behavior parity。
- 保持现有 Tauri Sidecar/API 行为，不接入仍在开发的 Rust API 项目。
- TDD 仅用于核心重要流程。

## 研究发现
- M3 已完成 runtime facade、Scheduler、ResourceScope/Ledger、CancellationScope、BudgetTaskQueue、performance collector、thin React adapter 与 legacy composition。
- 当前仓库没有独立 M4 设计或实施计划，M4 只在 convergence design 与 capability matrix 中定义边界。
- 研究开始时的 capability matrix 状态：`lyrics.stage-v2=partial`、`visual.sonic-topography=missing`、`shelf.3d=partial`。
- Stage Lyrics 当前已有较多 shader、mask、palette、lifecycle 模块；Shelf 也已有多个交互/布局模块，因此 M4 需要先做行为差距审计，不能按“从零实现”处理。
- 2026-07-28 会话恢复确认：M4 worktree 仍位于 `codex/m4-visual-parity`，HEAD 为 `ab04493`；除三份规划文件外无未提交代码变更。
- `planning-with-files-zh` 会话追赶脚本未报告额外未同步上下文，当前可直接延续阶段 1。
- Umbrella spec 将 Stage Lyrics 2.0 的目标明确为：单/多行/电影模式、原文/翻译、发光/羽化/背景适配、float/glitch、自定义字体与清晰度、轻量首屏/相邻预热、旧 mesh 保留、Canvas 与 GPU 上传双预算、取消旧构建和分批释放。
- Sonic Topography 必须作为独立 preset plugin 接入；研究开始时 capability matrix 标记为 `missing`，不能把已有 Home Visual shader 误判为该 preset 已实现。
- 3D Shelf 的验收边界明确包含右键召唤、常驻/动态模式、hover/滚轮/视差/中心行、切歌保护窗、GPU 对象池、详情虚拟化，以及数据增长时 GPU/DOM 对象数保持有界。
- 研究开始时的 Tauri 已有较丰富的 Stage Lyrics 与 Shelf 单元测试和模块化实现，但尚无 Sonic Topography module，与当时的能力矩阵一致；M4 应以补齐缺失行为和资源治理为主，而非整体重写已有模块。
- M3 已提供 M4 所需的统一基础设施：`VisualEngineCompositionContext` 暴露 `resources`、`cancellation`、`tasks`、`scheduler`、`performance` 与 immutable frame snapshot；Stage Lyrics/Sonic/Shelf 不应另建 RAF、queue 或资源账本。
- 当前 public facade 只提供 number 型 `VisualPresetId` 与 `applyPreset()`，尚无 plugin registry/runtime 契约。Sonic 应在 visual-engine 内新增 preset plugin 抽象，同时保持前端既有 preset number 与持久化格式兼容。
- `VisualSettingsSnapshot.fx` 已携带歌词、Shelf 和 preset 设置，`ShelfVisualSnapshot` 已携带 pane/mode/camera/presence/merge/count 等字段；M4 应优先在 composition 内消费 snapshot，不新增 React 高频控制通道。
- Shelf store 默认值与上游行为仍需审计确认；现有 `open` 与 `selectedPlaylistId` 属 UI/store 状态，而真正 3D 生命周期仍由 visual-engine manager 管理，设计要避免出现第二份权威状态。
- 当前 `StageLyricsLifecycle` 已有 build token、异步 mount、防迟到完成、outgoing mesh 与 `whenIdle()`，但其 public options 尚未注入 `BudgetTaskQueue`、`CancellationScope` 或资源预算；歌词构建仍直接调用 `buildLyricGroup()`，尚未形成 Canvas build / GPU upload 双阶段治理。
- Legacy composition 已把 Stage Lyrics 安装到 M3 的 45 FPS lane，并用父 `VisualResourceScope` 托管整个 lifecycle；M4 应在 lifecycle 内细化任务与每行资源登记，而不是改变主循环 lane 或 React host。
- Electron 2.0.2 将歌词实现拆为显示模式、payload、mask/texture、shader、row layers、mesh build、rendering 等连续模块；当前 Tauri 主要对应 mask/shader/builder/lifecycle，显示模式与 row/translation 语义很可能是主要 parity 缺口。
- 上游 Sonic 相关至少包含独立的 `03-beat/06-sonic-audio-monitor.js`；preset 主体的位置和参数仍由 Sonic 审计代理确认，不能仅凭文件名推断实现边界。
- M4 设计/计划可沿用已完成 M3 的文档格式：独立 spec 放在 `docs/superpowers/specs`，可执行纵向切片计划放在 `docs/superpowers/plans`。
- 仓库现有验证入口已足够覆盖 M4：visual-engine 包测试/typecheck、Web 测试/typecheck、根级串行全量测试，以及 `web:build`；无需新增测试运行器或改变 CI/API 行为。
- M3 design 已明确 `TDD` 仅覆盖核心生命周期/调度/资源/取消路径；M4 应保持同样策略，并用 characterization/parity tests 覆盖大量视觉参数与交互。
- Shelf 当前测试量很大，已覆盖多数指针、滚轮、pane、detail row 和 reveal 行为；M4 Shelf 重点应落在审计确认的少数缺口、对象池/对象数量硬阈值和 600 行虚拟化，而不是重写已被基线测试保护的交互层。
- 现有 runtime 测试已经能观测 texture/geometry/mesh/cache/queued task usage，因此 M4 的资源预算验收应通过 public performance snapshot 断言，不直接窥探内部数组或 Three 私有字段。
- Electron 2.0.2 的 Sonic Topography 不是单一 shader：存在独立 `public/sonic-topography-preset.js`、音频监视模块、完整设置 UI、颜色/频段/浮空方块参数和默认配置；迁移必须拆成 preset runtime、配置 schema/defaults、audio analysis 与 UI 适配，不能塞入 legacy composition 一个大文件。
- 当前 Tauri 视觉设置把 preset 限制在 `0..6`，控制面板也只渲染 7 个 preset；Sonic 的精确 preset id、旧持久化兼容和 preset count 需要在设计中显式冻结。
- Sonic 上游包含大量调节项，但 M4 不应机械复制所有 DOM 结构；参数应进入既有 `FxState`/visual store，通过 snapshot 下发，preset runtime 只消费 typed settings。
- Electron 2.0.2 精确冻结：Sonic preset id 为 `7`，最大 preset index 为 `7`，且历史上被移除的 preset `8` 需要迁移到 `7`。当前 Tauri `PRESET_COUNT=7`（仅 0..6）且 store clamp 到 6，M4 必须扩展为 0..7 并加入 `8 -> 7` 持久化迁移。
- 当前 `FxState` 不含任何 Sonic 参数；需要新增 typed defaults/normalization，但不得改变已有字段默认值或旧存储键行为。
- Sonic 与主系统存在有意集成点：相机默认姿态、歌词布局下移、背景粒子/星河可见性、Shelf/背景 dim。设计中应把这些声明为 plugin policies/hooks，避免在主循环散布 `preset === 7` 特例。
- 安装 workspace dependencies 后，M4 目标测试基线为 953/953 通过；后续红灯可归因于 M4 增量，而非起点不稳定。
- Stage Lyrics 2.0 上游 payload 支持 `current/prev/next/context/translation` 角色、独立 alpha/scale/weight/lineOffset、translation row 与 parent/virtual index；当前 Tauri `VisualLyricLine`/`LyricsVisualSnapshot` 不表达这些层级语义。
- `@mineradio/shared` 的 `LyricLine` 已包含 optional `translation`，但 `VisualEngineHost.mapLyricPayload()` 当前没有把它传入 visual snapshot；因此无需改 Sidecar/API DTO，只需扩展内部视觉契约与 mapping。
- 上游显示模式至少包含 single、dual、cinema 与自定义行数，并以虚拟行索引控制上下文/翻译布局；当前 lifecycle 一次只维护 current/outgoing 单正文 mesh，属于明确的 Stage Lyrics 2.0 行为缺口。
- 依赖安装未修改 lockfile 或 tracked source；当前 worktree 仍仅有三份规划文件未跟踪，visual-engine 与 Web typecheck 均通过。
- Shelf 的数量上限已经存在：一级卡片 `SHELF_MAX_RENDER=11`，详情行 `CONTENT_MAX_RENDER=11`；600 行详情虚拟化的窗口计算已实现。
- 但当前一级卡片在 render window signature 变化时会 `disposeRenderedCards()` 后全部重建；上游会复用仍在窗口内的 card 并 rebind slot。详情行当前也仅按 index 保留，离窗即 dispose，没有显式可复用对象池。M4 Shelf 的核心是降低滚动时 GPU/Canvas 创建与释放抖动，而不是再实现一套窗口算法。
- 上游一级卡片和详情行均有 rebind/reuse 逻辑；M4 应用固定容量 pool（活动 ≤11，闲置有硬上限）并通过公共统计/测试验证创建次数随 600 项滚动保持有界。
- M3 spec 明确把“歌词纹理上传”和“3D Shelf 对象池”留到 M4；M4 应直接复用现有 ResourceScope/CancellationScope/BudgetTaskQueue，而不是再设计并行基础设施。
- M3 的资源优先级可直接映射：当前/首屏歌词为 critical/essential，相邻歌词为 visible/normal，远端预热为 background/optional；当前可见歌词在 hard pressure 下不得被自动释放。
- M4 核心 TDD 范围应限定为：歌词 generation 取消与 stale 结果拒绝、Canvas/GPU 双队列每 slice 预算、旧 mesh 交接、分批释放、Sonic dispose/资源有界、Shelf pool 复用与 600 行对象数量上限。
- Electron Stage Lyrics 2.0 的基线包含 cooperative phase build（phase count + millisecond budget）和独立 GPU upload frame budget；上传预算明确为每帧 1 次。M4 可把每个 Canvas/row phase 建模为 cost=1 task，再把 GPU commit 放到单独 cost=1 upload lane。
- 现有 `BudgetTaskQueue.runSlice()` 只限制“启动任务”的 cost，不会暂停一个已经启动的重型同步 task；因此歌词构建必须拆成可恢复的小 phase/state machine，不能把完整 `buildLyricGroup()` 包进一个 task 就声称满足预算。
- 上游高质量纹理替换会在新纹理上传前保留旧 committed texture，并在一次 upload turn 后原子替换；这正是“新正文完成前保留旧 mesh”的可测试交接语义。
- Stage Lyrics 2.0 精确显示模式：`single`、`dual`、`triple`、`cinema`（5 行）、`custom`（1..10）；翻译模式：`off`、`current`、`dual`、`multi`；motion styles：`glass`、`smooth`、`float`、`quick`、`shine`、`glitch`。
- 关键参数范围已从基线确认：context opacity 0.25..1、context spread 0.60..2.40、translation gap 0.28..2.20、translation scale 0.46..1.12、translation opacity 0.20..1、edge fade 0..1、motion softness 0.15..1.2、glitch intensity 0..1.5、glitch slice 0..1.4。
- GPU upload 基线为每 frame reset `remaining=1` 并最多 consume 1；这一硬阈值应进入自动化测试与 performance snapshot diagnostics。

## Stage Lyrics 审计收敛
- 当前 lifecycle 已实现真实媒体时钟、45 FPS lane、current/outgoing 交接、旧 mesh 保留、native karaoke、palette、Shelf/skull 避让和大量 characterization；`partial` 而非 `missing`。
- 五个首要阻断项：translation 在 visual contract 丢失；pause 时错误地把 current 推为 outgoing；stale build 未主动取消；shared sun/dot texture ownership 不安全；叶子纹理/geometry 绕过 M3 admission 与 performance snapshot。
- 上游 cooperative build 目标每次 1 phase、约 4.2ms，>8ms 作为 release perf failure；GPU upload ≤1/frame，pending replacement ≤1。
- clarity pool 初始 parity 阈值：tier1=0；tier2/3/4 在 low 为 32/64/96MiB、balanced 为 48/96/144MiB、high 为 64/128/192MiB；resident rows ≤4/6/8；单项 ≤min(64MiB, pool×0.55)。
- 单行模式 current 1 + outgoing 1 + prewarm cache ≤10；dispose 后 pending build/upload、resident row、ephemeral texture/cache 必须归零。
- 推荐拆为 model/layout/textures/resource-budget/scheduler/rows/transitions/runtime，而不是继续扩大 `lifecycle.ts`。

## Sonic Topography 审计收敛
- Sonic 是 preset `7` 的复合插件：terrain + floating blocks + meteors + trails 四个 InstancedMesh，并复用共享 star-river；不是单个 shader。
- 资源硬上限：terrain grid 96..224，质量 cap eco/balanced/high/ultra=112/160/192/224；floating 100、meteor 20、trail 200、ripple 10；总 mesh/draw call=4，总实例上限 50,496。
- 音频必须复用现有 analyser，但新增 Electron 同款 8 个固定 Hz 段和 Kick/trigger profile；不能只用现有 bass/mid/treble 或 32 log bands 近似。
- plugin 激活时创建独立 child resource scope，离开 preset 7 立即释放；density/count 重建应先成功创建新层再原子替换旧层。
- Sonic 需要声明式集成 policies：相机基线 `(theta=0, phi=.18, radius=8.4)`、歌词 unlocked 偏移 `Y-0.34/Z+0.16`、歌词 lookAt、Home preserve、Shelf precedence、pointer release ripple。
- 建议性能门：high 1080p Sonic CPU p95 ≤1.5ms、GPU p95 增量 ≤5ms；ultra ≤2.5ms/8ms；整体 frame p95 ≤当前基线+10%；退出后两个 frame 内 ledger 回到进入前基线。
- 来源链已确认为 `XxHuberrr/Mineradio@4abaa190` 的 `public/sonic-topography-preset.js` → `yin-yizhen/sonic-topography@3ff303e`；原始作者署名为音域回响作者 Ajin，许可证为 `Non-Commercial Learning License`。
- 用户提供的公开社交媒体截图显示 Mineradio 作者宣称“与音域回响作者 Ajin 联动”，与 Mineradio 文件头的移植声明相互印证。维护者据此作出直接迁移的项目决策；该公开合作证据不等于书面授权、再许可或许可放宽。
- 直接迁移必须更新 `THIRD_PARTY_NOTICES.md`，保留来源 commit、Ajin、许可证、个人非商业限制和修改说明；不能把 Tauri 适配表示为原作者发布的未修改版本。
- 旧 clean-room 路线和 source-isolation 结果作为历史审计保留，但不再是 M4 blocker；最终晋升依据改为 origin-attribution 守卫、直接迁移代码复核和新 release evidence。

## 3D Shelf 审计收敛
- 当前 Shelf 不是骨架：side/stage/off、always/auto、static/dynamic、右键召唤/pin、hover、wheel、pane memory、中心行、详情 actions 和 11/11 虚拟窗口均已实现。
- Critical 缺口 1：一级卡窗口变化时整批 dispose/rebuild，详情行离窗即 dispose；需固定容量 11/11 的 rebind pool，600 项从头滚到尾后创建量不再增长。
- Critical 缺口 2：Electron 约 1120ms 的切歌保护窗完全缺失；未 pin、未开详情时切歌必须清 hover/visibility/selection/focus 并阻断 hover/click/wheel/contextmenu，pin/detail 例外。
- Critical 缺口 3：现有测试只覆盖 25/30 行，没有 600 行、创建计数或 renderer memory plateau 证据。
- Important：static camera 的全局 resolver 会拒绝 focus，但 click/open/contextmenu 直接调用可绕过；应把 static gate 下沉为统一 focus policy，切到 static 时立即清旧 Shelf focus。
- Important：`closeDetail({ immediate })` 当前忽略参数并立即 dispose；普通关闭需约 180ms 的缩放/位移/淡出，禁用 hit 后再释放，immediate 同 tick 释放，重开不得被旧 closing generation 清理。
- Important：当前 async card build 每帧固定 3 张，无 ≤2 张/≤7ms budget 和 stale cancellation；M4 应复用 M3 task/cancellation。
- 新安装默认 camera mode 应对齐 Electron 的 `dynamic`，但已持久化的显式 `static` 必须保留。

## 技术决策
| 决策 | 理由 |
|------|------|
| 先并行审计四个独立领域，再写 M4 设计 | 现有代码覆盖度不明，直接实现容易重复或误改已迁移行为 |
| 使用 Electron 2.0.2 worktree 作为只读行为基线 | 上位目标是 2.0.2 parity，不能只依据旧 Tauri 测试命名推断 |
| 视觉引擎继续保持命令式，React 只提交 snapshots/events | 延续 M3 已建立的架构边界 |
| preset 7 public 开放延迟到 composition route 完成 | PRESET_COUNT、8→7 migration、UI selector 和 plugin route 必须原子落地，避免被旧 Home shader 错误处理 |

## M4 收尾审计
- preset 7 的逐帧与 `setPreset()` 路径已隐藏 Home 粒子，但 `createHomeVisual()` 初始挂载仍只排除 skull，存在首帧闪现；已用公开行为测试锁定并修复初始化 gate。
- `home-visual.test.ts` 仍保留旧 `[0,6]` clamp 断言，而 preset 公共契约已扩展至 `[0,7]`；该遗留断言已同步到 Sonic preset 7 契约。
- parity/performance 证据必须继续复用正式 `createVisualEngine` 与 production composition；`?m4-parity=1` 仅作为 Web 入口分流，不能引入第二个 renderer、RAF、AudioContext、task queue 或 resource ledger。
| Stage upload 使用 renderer-backed single-texture executor | `needsUpdate`/scene commit 不是 GPU upload；row 所有 required texture ready 后才 atomic takeover |
| 新增统一 Maintenance lane | 当前 task pump 属 Home governor，会使 Stage/Sonic 收口依赖 Home；全局 queue 只能在独立 lane pump 一次 |
| Sonic audio 使用 immutable 512-bin typed snapshot | 32 个聚合频段无法实现固定 Hz、手动 bin 区间与 onset/flux；同一次 analyser read 内复制一次固定 512-byte frame |
| Shelf guard 的 pin/detail 例外仅指可见性 | guard 内 card 交互仍阻断；有效 detail 内部交互可继续；跨 track generation release 必须丢弃 |

## 独立设计/计划复审结论
- 两份独立复审共识：原稿不能直接全面实施，必须先补 plugin factory/context、typed FFT seam、统一 maintenance pump、renderer-backed upload executor。
- Stage `whenIdle()` 必须覆盖 raster、upload、takeover 与 cancellation settlement，不能只等待旧 lifecycle promise。
- clarity pool 和全局 ledger 的职责必须分离：pool 管 cache/LRU，reservation/admission 只由 child resource scope/ledger 负责。
- Sonic 大规模 instance rebuild 同样需要 cooperative generation cancellation，不能只做 transactional swap。
- Shelf 必须使用显式 `closed/open/closing` 状态机，并逐资源登记 texture/geometry/material/mesh。
- 每个切片需要相对 `ab04493` 的 Sidecar/shared/Rust sidecar packaging 零差异检查，普通测试通过不足以证明 API freeze。

## 分片实现发现
- `VisualEngineHost.mapLyricPayload()` 原本在第一段 mapping 读取字段后，又在最终排序 projection 中丢弃 translation；修复必须覆盖完整 public mapping path，不能只扩展 contract type。
- M3 的 diagnostics 只有 root resource/task snapshots；新增 supplier registry 后，composition module 可以注册深模块的只读诊断，同时 caller 仍看不到 ledger ownership interface。
- 全仓生产代码中 `BudgetTaskQueue.runSlice()` 过去由 Home governor 调用；迁移到 Maintenance lane 后，实际 pump 唯一且可由 architecture guard静态证明。
- M4 fixture 不依赖网络、真实时间或随机输入；Sonic byte fixture 每次返回独立 512-bin copy，适合后续 onset/reset TDD。

## M4 候选收口发现
- Stage Lyrics 全目录当前为 198 pass；全仓为 1996 pass / 0 fail，根级 typecheck、Web build 与 API freeze 均通过。
- `buildLyricForText()` 已把 admission 放在 Canvas/Three 分配前：current=`persistent`，resident prewarm=`rebuildable`；post-build registration 复用同一 allocation，不重复记账。
- 预热 B 行激活时必须在 atomic takeover 前把 retention 晋升为 `persistent`。真实 B upload/takeover 测试证明，随后释放 `rebuildable` 不会释放 B 的 group、required textures 或 5 个 geometry。
- retention 晋升若任一 handle 失败，bundle 采用 fail-closed 语义整体释放；release observer 抛错会被聚合，但不会中断后续 handle 与物理资源清理。
- `VisualResourceHandle.setRetention()` 当前只改变 scope retention；budget ledger allocation priority 仍保留 admission 时的值。ledger 不会按存量 priority 主动驱逐，因此本切片安全，但 reprioritize interface 应作为独立后续设计。
- `scheduleResidentRowPrewarm()` 先跳过 `!row.resident`，因此 planner 的 `background + ephemeral` 远端预热分支目前不可达。不得把 clarity pool 的 background admission 单元测试误写成生产远端预热已完成。
- 真实 GPU timer query 已接入 production presentation seam。只有 resolved、non-disjoint 且 `sampleCount > 0` 才能标记 measured；扩展可用但 release 无样本时 strict gate 必须失败。
- 历史 Sonic source-isolation guard 曾证明旧候选目录无外部资产和来源标记；切换为直接迁移后，该结论不再是完成条件，守卫已替换为强制来源和署名存在的 origin-attribution 检查。
- M4 当前统一状态为 Complete：Stage/Shelf 与直接迁移版 Sonic 已由 clean immutable evidence 晋升 `implemented`。
- 首版 evidence strict 存在三类假通过：console error 只记录不判定、manifest HEAD 未绑定实际 preview build、扩展不可用时 GPU 硬门被跳过；此外 dirty 只记录不阻断。现已统一进入 fail-closed run/scene checks。
- Vite build 将当前 Git commit 注入 M4 parity contract；runner 对每个场景验证 build commit 与 repository commit 相等，因此旧 4173 preview 无法再冒充当前 clean HEAD。README 同时使用 `--strictPort` 阻止端口自动漂移。
- clean evidence commit `51ec050` 通过 60/60：dirty=false、preview build SHA=HEAD、三场景 console errors=0、GPU 均 measured 且各 240 samples。
- Stage release evidence：resident rows=3、pending builds/uploads=0、GPU p95=0.138016ms；Shelf：11 cards、11 detail rows、1 panel、GPU p95=0.167904ms。因此 `lyrics.stage-v2` 与 `shelf.3d` 可晋升 `implemented`。
- 直接迁移实现提交 `0230feb` 的 final release strict evidence 通过 65/65：dirty=false、preview build SHA=HEAD、三场景 console errors=0、GPU 均 measured 且各 240 samples；manifest SHA-256 为 `B96A032DCAC332DBE8D01CFD1964BF39080716B6875ABCDF0E14630C9B35C80B`。
- Sonic high 最终为 4 meshes、24,636 instances、grid=156、CPU p95 `0.100000ms`、GPU p95 `0.179488ms`；相对 clean high baseline `094316a` 的 GPU 增量 `0.046080ms`，frame p95 `0.400000ms` 与 baseline 持平并低于 `0.440000ms` 上限。因此 `visual.sonic-topography` 晋升 `implemented`，M4 完成。

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| `rg` 无匹配会返回非零并中断并行脚本 | 探索性搜索统一追加成功退出，真实验证仍保留原始 exit code |

## 资源
- `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md`
- `docs/superpowers/specs/2026-07-27-m3-visual-runtime-foundation-design.md`
- `docs/parity/capability-matrix.md`
- Electron 2.0.2 worktree：`D:/项目/Mineradio-upstream-latest`

## 视觉/浏览器发现
- 已目视检查 final release 的 Stage、Sonic high 与 Shelf 截图/录屏；Sonic 地形、涟漪高光、浮空元素与空间布局可见，无空白画布、Shader 编译错误或明显错层，三场景 console errors=0。

---
*每执行2次查看/浏览器/搜索操作后更新此文件*

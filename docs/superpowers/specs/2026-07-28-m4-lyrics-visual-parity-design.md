# M4 Lyrics 与 Visual Parity 设计

**日期：** 2026-07-28  
**状态：** Open / Blocked；Stage Lyrics 与 3D Shelf 已通过 clean release evidence，Sonic provenance 未通过
**基线：** `ab04493`（M3 Visual Runtime Foundation complete）  
**上游行为基线：** Mineradio Electron 2.0.2，`4abaa19`

## 1. 背景

M3 已经把视觉运行时从 React 中抽离，并建立了统一的：

- `VisualEngineFacade`；
- immutable frame snapshots；
- `VisualScheduler` 与独立 Frame Gate；
- `VisualResourceScope` / ledger；
- `CancellationScope`；
- `BudgetTaskQueue`；
- 性能快照与严格生命周期。

M4 不再重做这些基础设施，而是在它们之上完成三项仍未收敛的 2.0.2 parity：

1. Stage Lyrics 2.0 与歌词纹理/GPU 上传预算；
2. Sonic Topography preset 7；
3. 3D Shelf behavior parity、对象池与 600 行详情虚拟化。

设计起点的 capability matrix 判断为：

- `lyrics.stage-v2=partial`；
- `visual.sonic-topography=missing`；
- `shelf.3d=partial`。

## 2. 目标

M4 完成后必须满足：

- Stage Lyrics 支持 Electron 2.0.2 的显示模式、翻译层、motion style、清晰度和上下文行；
- 歌词 Canvas 构建、GPU upload、纹理缓存和释放全部受统一预算、取消域和资源所有权约束；
- 切歌、seek、设置变化和 dispose 不允许旧 generation 继续提交或泄漏；
- 当前歌词在新资源完成前保持可见，暂停默认 hold，不闪回空白或低清纹理；
- Sonic Topography 以 preset `7` 的独立 plugin 实现，并保持 `8 -> 7` 旧存档迁移；
- Sonic 使用共享 audio analyser、Stage palette、scene 与 runtime，不创建第二 AudioContext、RAF、renderer 或资源账本；
- Shelf 已有行为保持不回退，并把一级卡片与详情行改为有界可复用对象池；
- 600 项 Shelf 与 600 行详情在滚动期间 GPU/Canvas/DOM 对象数量保持有界；
- React 仍只提交 snapshots/events，不拥有 Three.js、逐帧更新或纹理任务；
- Sidecar/API/ProviderId/DTO/media URL 行为保持冻结。

## 3. 非目标

M4 不包含：

- Rust `mineradio-api` 接入或嵌入；
- Sidecar route、响应 envelope、Provider 行为或 media URL 改造；
- gapless、crossfade、dual deck、output routing、Audio Graph recovery；
- Desktop Lyrics Rust runtime、托盘、完整桌面、Wallpaper Engine；
- Home 2.0 全量重构；
- 把 0..6 全部旧 preset 重写成新 plugin；
- WebGPU、compute shader 或新的后处理管线；
- Sonic Workshop；
- 高频频谱 Canvas 面板。Sonic 的 8-band/Kick 语义属于 P0，但调试 UI 可后置。

## 4. 兼容边界

### 4.1 保持不变

- `VisualEngineFacade` 的调用形状保持不变；
- `VisualEngineHostProps` 保持兼容；
- `VisualSettingsSnapshot` 继续通过 `fx` 下发视觉设置；
- 现有 preset `0..6` 的编号和默认行为不变；
- 现有 localStorage key 不变；
- 现有 Shelf callback payload 保持对象身份；
- CSS 封面继续使用直接 URL，WebGL 继续使用 Sidecar proxy URL；
- 真实媒体时钟不受 Frame Gate 限制。

### 4.2 允许的内部扩展

- `VisualLyricLine` 增加 optional `translation`；
- `FxState` 增加 Stage Lyrics 2.0 与 Sonic typed settings；
- `VisualPerformanceSnapshot` 可增加只读 subsystem diagnostics；
- `RenderStepSlot` 增加 Sonic lane；
- Shelf manager 可增加只读 pool diagnostics；
- visual-engine 内增加 package-private preset plugin factory、registry 与 runtime contract；
- composition context 增加统一 maintenance pump、renderer-backed texture upload executor 与 subsystem diagnostics registry。

这些扩展不改变 Sidecar/API DTO。`@mineradio/shared` 已经提供 `LyricLine.translation`，M4 只修复 Web 到 visual-engine 的信息丢失。

## 5. 总体架构

```text
React / Zustand
  ├─ playback snapshot
  ├─ lyrics snapshot（含 translation）
  ├─ shelf snapshot
  └─ visual settings snapshot
             │
             ▼
VisualEngineFacade（M3，保持稳定）
             │
             ▼
Legacy Visual Composition
  ├─ HomeVisual 0..6
  ├─ StageLyricsRuntime 2.0
  │   ├─ model/layout
  │   ├─ cooperative raster build
  │   ├─ upload gate
  │   ├─ quality pool
  │   └─ transitions/resident rows
  ├─ SonicTopographyPlugin（preset 7）
  └─ ShelfManager
      ├─ card pool ≤ 11
      └─ detail-row pool ≤ 11
             │
             ▼
M3 Scheduler / ResourceScope / Cancellation / TaskQueue / Performance
```

所有增量后台工作由独立于 Home 状态的统一 maintenance lane 推进：

```text
RenderStepSlot.Maintenance
  ├─ BudgetTaskQueue.runSlice(...)
  ├─ Stage texture upload executor（每帧 ≤1 texture）
  ├─ pending atomic takeover
  └─ diagnostics refresh
```

`LegacyHomeVisualRuntimeGovernor` 只治理 Home retention/active 状态，不再拥有全局任务队列 pump。Stage、Sonic 与 Shelf 不得依赖 Home 是否活跃才能推进或收口。

不允许出现：

```text
React → 每帧更新 Three.js
Stage Lyrics → 自建 RAF/idle queue/全局 ledger
Sonic → 第二 AudioContext/renderer
Shelf → 数据量线性增长的 mesh/canvas 数量
```

## 6. Stage Lyrics 2.0 数据模型

### 6.1 内部视觉行契约

```ts
interface VisualLyricLine {
  readonly t: number;
  readonly text: string;
  readonly translation?: string;
  readonly duration?: number;
  readonly charCount?: number;
  readonly fallback?: boolean;
  readonly words?: readonly VisualLyricWord[];
}
```

`VisualEngineHost.mapLyricPayload()` 必须保留 `translation`，snapshot builder 必须冻结并保真复制该字段。

### 6.2 Stage 设置

```ts
type StageLyricDisplayMode =
  | "single"
  | "dual"
  | "triple"
  | "cinema"
  | "custom";

type StageLyricTranslationMode = "off" | "current" | "dual" | "multi";

type StageLyricMotionStyle =
  | "glass"
  | "smooth"
  | "float"
  | "quick"
  | "shine"
  | "glitch";

interface StageLyricsSettings {
  readonly displayMode: StageLyricDisplayMode;
  readonly customLineCount: number;
  readonly translationMode: StageLyricTranslationMode;
  readonly motionStyle: StageLyricMotionStyle;
  readonly contextOpacity: number;
  readonly contextSpread: number;
  readonly translationGap: number;
  readonly translationScale: number;
  readonly translationOpacity: number;
  readonly edgeFade: number;
  readonly motionSoftness: number;
  readonly glitchIntensity: number;
  readonly glitchSlice: number;
  readonly glitchCameraBind: number;
  readonly glitchChroma: number;
  readonly glitchRate: number;
  readonly glitchJitter: number;
  readonly verticalFloat: number;
  readonly backgroundStarRiver: boolean;
  readonly textureClarity: 1 | 2 | 3 | 4;
  readonly pauseHold: boolean;
}
```

基线模式：

| display mode | 正文行数 |
| --- | ---: |
| single | 1 |
| dual | 2 |
| triple | 3 |
| cinema | 5 |
| custom | 1..10 |

参数 clamp 必须与 Electron 2.0.2 一致：

- context opacity `0.25..1`；
- context spread `0.60..2.40`；
- translation gap `0.28..2.20`；
- translation scale `0.46..1.12`；
- translation opacity `0.20..1`；
- edge fade `0..1`；
- motion softness `0.15..1.2`；
- glitch intensity `0..1.5`；
- glitch slice `0..1.4`；
- glitch camera bind、chroma、rate、jitter 与 vertical float 按 Electron 2.0.2 effective range 表归一化；
- custom line count `1..10`；
- texture clarity `1..4`。

### 6.3 Track entry 与虚拟索引

Stage runtime 不直接把整首歌词一次性变为完整 GPU 树，而是先生成纯数据 entry：

```ts
interface StageLyricEntry {
  readonly key: string;
  readonly text: string;
  readonly role: "current" | "prev" | "next" | "context" | "translation";
  readonly lineIndex: number;
  readonly parentIndex?: number;
  readonly virtualIndex: number;
  readonly alpha: number;
  readonly scale: number;
  readonly weight?: number;
  readonly lineOffset?: number;
  readonly translationLine: boolean;
}
```

layout 模块负责：

- display mode 的行选择；
- translation mode 的行插入；
- primary/translation virtual index；
- 当前行与上下文行的 y anchor；
- edge fade、opacity、scale；
- cinema/custom 的可见窗口。

这些函数必须是纯函数，先以固定 fixture 完成 characterization，再接 Three.js。

## 7. Stage Lyrics 资源与任务流水线

### 7.1 两阶段预算

歌词资源拆为两条独立路径：

```text
Canvas / layout / raster phases
  → cooperative build queue
  → pending texture leases
  → GPU upload gate（每 render frame ≤ 1）
  → atomic commit
```

Canvas build 与 GPU upload 不得合并成一个不可暂停的大任务。

### 7.2 Cooperative build

```ts
type StageLyricBuildStepResult =
  | { readonly state: "yield"; readonly nextPhase: number }
  | { readonly state: "complete"; readonly result: StageLyricBuildResult }
  | { readonly state: "cancelled" };

interface StageLyricBuildJob {
  readonly owner: string;
  readonly generation: number;
  readonly priority: "critical" | "visible" | "normal" | "background";
  step(signal: AbortSignal): StageLyricBuildStepResult;
  cancel(): void;
}
```

规则：

- 每个 step 最多执行一个 phase；
- 目标单 phase `≤4.2ms`；
- 任一 phase `>8ms` 记入 release perf failure；
- 每个 owner/key 最多一个 current generation；
- 每个 phase 开始前检查 `AbortSignal`；
- coordinator 而非 job 自己负责 continuation；一个 phase settle 后使用新的 continuation key 重新入队，禁止用相同 active key 替换正在运行的自己；
- 同优先级按 FIFO 推进，每轮最多推进一个 phase，低优先级必须保留可证明的公平性；
- phase failure/cancel 通过 job-owned rollback stack 逆序释放 partial resources；
- elapsed time 由 injected monotonic clock 记录；
- 取消后 Canvas backing store 缩到 `1×1`；
- task commit 前必须同时满足 signal、scope、generation 三重校验；
- 不使用 `requestIdleCallback`、独立 timer queue 或第二个 RAF。

M3 `BudgetTaskQueue` 只负责 cost admission 和 slice 启动。Stage Lyrics 必须把长任务拆成 phase，不能把完整同步 `buildLyricGroup()` 包进单一 task。统一 maintenance lane 每个 render frame 只调用一次 queue pump，不能由 Home、Stage 或 Sonic 分别重复调用。

### 7.3 GPU upload gate

```ts
interface StageLyricUploadGate {
  beginFrame(frameId: number): void;
  enqueue(ticket: StageLyricUploadTicket): boolean;
  uploadOne(executor: StageTextureUploadExecutor): StageLyricUploadResult | null;
  cancelOwner(owner: string): void;
  dispose(): void;
}

interface StageTextureUploadExecutor {
  upload(texture: THREE.Texture): void;
}
```

硬规则：

- ticket 单位是一个 texture lease，不是 row/group；
- executor 由真实 renderer adapter 提供，生产路径受控调用 `renderer.initTexture(texture)` 或等价的 renderer-backed 预上传能力；
- 每 render frame 最多预上传 1 个 texture；仅设置 `needsUpdate` 或把 group 挂进 scene 不视为上传成功；
- 一个 row/group 的全部 required texture ticket 成功后，才允许进入 atomic takeover；
- pending replacement texture 全局最多 1；
- 新 texture 上传成功前保留旧 committed texture/mesh；
- 原子替换后再释放旧资源；
- renderer upload 抛错时回滚新 leases、保留旧 mesh；stale upload 不得写入 scene；
- dispose 后 queue 必须为空。

除 fake executor 单元测试外，必须通过真实 WebGL renderer instrumentation 记录每 frame 的 `initTexture` 调用数，证明真实上传 `≤1/frame`。

### 7.4 Ownership

资源必须区分 owned 与 borrowed：

```ts
type TextureOwnership = "owned" | "borrowed";

interface LyricTextureLease {
  readonly texture: THREE.Texture;
  readonly ownership: TextureOwnership;
  readonly estimatedBytes: number;
  readonly canvas?: HTMLCanvasElement;
  release(): void;
}
```

规则：

- mask/readability/glow/quality texture 默认 owned；
- shared sun bloom 和外部 dot texture 为 borrowed 或 ref-counted persistent lease；
- row/group dispose 只释放 owned lease；
- 每个 lease 最多 release 一次；
- owned Canvas texture release 同时执行 `texture.dispose()` 与 Canvas `1×1` 回收；
- admission 必须发生在分配前，Three scanner 只能做诊断对账，不能代替 admission。

创建资源前必须先从 child `VisualResourceScope` 申请 reservation。reservation 保存 estimated usage、priority 与 retention；创建成功后转为正式 allocation，创建失败/取消则原子回滚。clarity pool 只决定 cache/LRU 资格，ledger reservation 才是唯一的全局资源 admission，二者不得重复计数。

映射固定为：current/首屏 `essential + persistent`，相邻行 `normal + rebuildable`，远端预热 `background + ephemeral`。

### 7.5 Clarity pool

初始 parity 预算：

| quality | tier 2 | tier 3 | tier 4 | resident rows |
| --- | ---: | ---: | ---: | ---: |
| low/eco | 32 MiB | 64 MiB | 96 MiB | 4 |
| balanced | 48 MiB | 96 MiB | 144 MiB | 6 |
| high/ultra | 64 MiB | 128 MiB | 192 MiB | 8 |

附加规则：

- tier 1 不建立 clarity pool；
- 单 item `≤ min(64 MiB, pool × 0.55)`；
- 估算使用 `width × height × 8.8`；
- base raster width clamp `768..3072`，并受 `maxTextureSize` 限制；
- low base width `≤1024`，balanced `≤1536`；
- glow width：low `1536..2048`、balanced `1792..2560`、high `2048..3072`；
- LRU 不得驱逐当前 essential 行；
- soft pressure 暂停 background warmup；
- hard pressure 拒绝新的 optional/background quality build。

## 8. Stage Lyrics 生命周期与行为

### 8.1 首屏与预热

- single mode：current 1 + outgoing 1 + prewarm cache `≤10`；
- current 行为 critical；
- 相邻正文与当前翻译为 visible；
- 更远预热为 background；
- 轻量首屏完成后再异步升级高质量/多行；
- lightweight → full track takeover 必须原子交换；
- 切歌、歌词 payload、font、clarity、display/translation mode 变化都会提升 generation 并取消旧任务。

### 8.2 Pause / Seek / Resume

- `pauseHold=true` 时暂停保持 current mesh 和 progress；
- 暂停不得把 current 自动推入 outgoing；
- seek 使用二分查找定位行，不在 45 FPS lane 做 O(n) 扫描；
- seek preview 可请求目标行和相邻行预热；
- resume 重置必要 Frame Gate credit，但不改变媒体状态；
- 快速 scrub 期间同 owner 只保留最新 generation。

### 8.3 Transition

- current/new mesh 完成前旧 current 保持；
- commit 后旧 current 进入 outgoing；
- outgoing 数量保持有界；
- reveal hold、防闪烁、single static swap 与 multi-line track swap 分开实现；
- motion style 只影响 transition/runtime，不改变数据选择。

### 8.4 Runtime services 与 idle 语义

`StageLyricsRuntime` 必须显式注入 child resource scope、child cancellation scope、共享 task queue、renderer-backed upload executor、diagnostics publisher 与 monotonic clock。`whenIdle()` 只有在以下条件全部满足时才 resolve：

- queued/running raster phase 为 0；
- pending texture upload 为 0；
- pending atomic takeover 为 0；
- 被取消 generation 的 settlement/rollback 已完成。

composition dispose 必须先取消 generation，再推进或强制收口 rollback，最后释放 child scope。

## 9. Sonic Topography plugin

### 9.0 Clean-room 与许可证硬门

参考项目 `yin-yizhen/sonic-topography` 在审计 commit `3ff303e` 使用 `Non-Commercial Learning License`。该许可证禁止商业使用和打包销售，与本项目 GPL-3.0 的开源发行目标不兼容。因此 M4 Sonic 实现必须满足：

- 不复制参考项目的源码、shader、表达性结构、注释或其他受版权保护实现；
- 不以参考实现源码为逐行翻译或派生实现基础；
- 只使用 Electron 2.0.2 已公开的可观察行为、参数、资源上限、交互结果和本设计冻结的 interface 规格；
- 实现者依据独立测试 fixture 与行为规格编写新实现，并在 review 中检查来源隔离；
- 若未来需要直接复用任何实现，必须先取得版权方明确书面许可；
- 可以在研究说明中保留 attribution，但 attribution 不构成许可证兼容或复制授权。

任何无法证明为独立行为重建的 Sonic 变更都不得合并。

### 9.1 Preset identity

```ts
export const SONIC_TOPOGRAPHY_PRESET_ID = 7;
export const PRESET_COUNT = 8;
```

归一化规则：

- `0..7` 原样保留；
- legacy `8` 迁移到 `7`；
- 其他无效值 clamp 到合法范围；
- 现有 0..6 编号绝不改变。

### 9.2 Plugin factory、registry 与 runtime contract

```ts
interface VisualPresetPluginContext {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly resources: VisualResourceScope;
  readonly cancellation: CancellationScope;
  readonly tasks: BudgetTaskQueue;
  readonly diagnostics: VisualSubsystemDiagnosticsPublisher;
  readonly audio: SonicAudioSnapshotSupplier;
  readonly palette: VisualPaletteSupplier;
  readonly input: VisualPresetInputAdapter;
}

interface VisualPresetPlugin {
  readonly id: VisualPresetId;
  create(context: VisualPresetPluginContext): VisualPresetPluginRuntime;
}

interface VisualPresetPluginRuntime {
  readonly id: VisualPresetId;
  activate(settings: Readonly<FxState>): void;
  update(frame: FrameContext): void;
  deactivate(): void;
  dispose(): void;
}

interface SonicTopographyRuntime extends VisualPresetPluginRuntime {
  pointerRipple(x: number, z: number, strength: number): void;
  getDiagnostics(): SonicTopographyDiagnostics;
}
```

registry 负责 plugin factory 注册、active runtime 切换、child scopes、失败回滚和 exactly-once dispose。M4 只注册 Sonic plugin，不迁移旧 preset 0..6。Sonic 特例不得进入 React 或复制到多个 preset 实现。

preset `7` 的 public 开放、legacy `8 -> 7` 存储迁移、控制面板可见性和 composition plugin route 必须在同一纵向切片原子完成。在该切片之前 `PRESET_COUNT`、store clamp 和 UI 仍只允许 `0..6`，内部 Sonic modules 保持 dormant，避免 preset 7 被旧 Home shader 渲染。

### 9.3 模块结构

```text
packages/visual-engine/src/sonic-topography/
├─ sonic-topography.ts
├─ sonic-settings.ts
├─ sonic-audio-profile.ts
├─ sonic-palette.ts
├─ sonic-shaders.ts
├─ sonic-terrain.ts
├─ sonic-floating-blocks.ts
├─ sonic-impulses.ts
└─ *.test.ts
```

### 9.4 Settings

Electron 2.0.2 的 effective defaults 必须逐字段 characterization。核心默认值：

- terrain：amplitude 50、motionSpeed 50、density 46、range 82、lower 68、depth 62、autoRotate 50；
- EQ：subBass 90、bass 92、lowMid 50、mid 50、highMid 50、presence 25、brilliance 50、air 48；
- colors：cover mode、base `#05070c`、cool `#0066ff`、warm `#ff3c19`、accent `#33e6ff`、glow 20；
- floating：enabled、count 80、intensity 36、minSize 9、maxSize 12、speed 59；
- trigger：monitor enabled、autoTrack enabled、sensitivity 100、bandStart 1、bandEnd 4、threshold 32、pulseStrength 62。

ground 数字控件统一为整数 `0..100`；band start 为 `0..510`，band end 为 `2..512`。

### 9.5 Typed audio seam 与 profile

Sonic 复用现有 analyser frequency frame，不创建第二 AudioContext，也不得第二次读取 analyser。`audio-reactivity` 在读取原始 FFT 的同一 update 中生成 immutable typed snapshot：

```ts
interface SonicSpectrumFrame {
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly binCount: 512;
  readonly currentTimeSeconds: number;
  readonly playing: boolean;
  bin(index: number): number;
  mean(startInclusive: number, endExclusive: number): number;
}

interface SonicAudioSnapshot {
  readonly spectrum: SonicSpectrumFrame | null;
  readonly bands: Readonly<Record<SonicBand, number>>;
  readonly kickSub: number;
  readonly kickCore: number;
  readonly kickPunch: number;
  readonly body: number;
  readonly vocal: number;
  readonly snap: number;
  readonly onset: number;
  readonly flux: number;
  readonly confidence: number;
  readonly triggerPulse: number;
}
```

`SonicSpectrumFrame` 内部复制/重采样到固定 512-byte buffer，并只暴露只读查询方法；outer snapshot 与 bands 对象冻结。每 analyser update 最多产生一份 512-byte frame，不复制为普通 number array，也不把可写 typed array 暴露给 caller。

固定八段：

| band | Hz |
| --- | --- |
| subBass | 32..58 |
| bass | 58..118 |
| lowMid | 118..260 |
| mid | 260..720 |
| highMid | 720..1800 |
| presence | 1800..4200 |
| brilliance | 4200..9000 |
| air | 9000..16000 |

同时计算 kickSub、kickCore、kickPunch、body、vocal、snap，并输出 onset/flux/confidence/triggerPulse 与 warmth/brightness/sharpness/smoothness/density。

禁用 detailed monitor 时才使用现有通用 audio snapshot fallback。

timeline identity 由 composition 把 playback `trackKey` 传给 audio-reactivity；track key 变化、时间向后跳、sampleRate/fftSize 改变、source detach 都重置 onset/flux/hysteresis。暂停时按 dt 衰减但不制造 onset；reduced-motion 保留数据分析，仅抑制强视觉 pulse。

### 9.6 Render resources

Sonic 新增四个 InstancedMesh：

- terrain；
- floating blocks；
- meteors；
- trails。

硬上限：

- grid `96..224`；
- quality cap eco/balanced/high/ultra = `112/160/192/224`；
- floating `≤100`；
- meteors `≤20`；
- trails `≤200`；
- ripples `≤10`；
- mesh/draw call = 4；
- 总实例 `≤50,496`。

Sonic 自身不复制 cover texture。建议增量预算：

- geometry/instance buffer soft `4 MiB`，hard `6 MiB`；
- texture `0`；
- mesh `4`；
- material `4`；
- cache/async `0`。

### 9.7 Lifecycle

- preset 7 激活时创建独立 child `VisualResourceScope`；
- density/floatingCount 变化时先构建新层，再原子替换旧层；
- 离开 preset 7 立即 deactivate 并 dispose child scope；
- 两个 frame 内 ledger 回到进入前基线；
- scene 中不得残留 `sonic-topography-root`；
- plugin 可重入 7→0→7；
- dispose exactly once。
- terrain/floating 的大规模 rebuild 必须拆为 cooperative phases，使用共享 task queue 与 child cancellation scope；settings drag 只保留最新 generation，离开 preset 7 立即取消 pending rebuild，stale build 不得替换 active layer；
- 每 phase 必须有实例数量或时间预算，不能一次同步写入约 5 万个 instance matrix。

### 9.8 系统集成 policies

Sonic 通过显式 policy/supplier 与其他子系统协作：

- camera baseline：theta `0`、phi `0.18`、radius `8.4`；
- unlocked Stage Lyrics 偏移：`Y-0.34`、`Z+0.16`；
- composition 提供统一 `VisualCameraPolicy`，输入 active preset、Stage Lyrics world target、Shelf focus、free-camera 与 wallpaper lock；Sonic 只声明 camera baseline/是否启用 Stage target，不反向查询 Stage runtime；
- Shelf focus 优先于 lyric lookAt；
- Home 保留 preset 7，不强制切换到 5；
- pointer release 仅在非 drag、非 UI hit、非 free-camera consume 时触发 ripple；
- long press strength 最大 3；
- 共享 star-river 保留，除非用户关闭。

完整 render order 固定为：Home Visual → Camera Cinematic → Gesture Rotation → Skull Layer → Sonic Topography → Stage Lyrics。Shelf 仍在前置 Shelf lane 更新，但其 focus 通过 camera policy 取得优先级。preset 6 与 7 互斥激活，Sonic 不与 Skull layer 同时可见。

## 10. 3D Shelf parity 与对象池

### 10.1 已完成且保持不变

当前实现已经具备：

- side/stage/off；
- always/auto；
- static/dynamic camera；
- 右键召唤与 pin；
- hover、wheel、pane switch、中心行；
- detail open/close 与 row actions；
- 一级窗口 `SHELF_MAX_RENDER=11`；
- 详情窗口 `CONTENT_MAX_RENDER=11`；
- 600 行详情的窗口计算。

M4 不重写这些行为，只补齐审计确认的差距和资源复用。

### 10.2 Card pool

```ts
interface ReusableShelfCard {
  readonly mesh: THREE.Mesh;
  rebind(binding: ShelfCardBinding): number;
  setVisible(visible: boolean): void;
  dispose(): void;
}
```

`ShelfCardBinding` 必须包含 item identity、index、draw key、render order、action payload 与 binding generation。`rebind()` 重置全部 metadata/visual state，并返回新 generation；异步 cover/load callback 必须同时校验 object identity 与 generation。

算法：

1. 保留仍在新窗口内且 identity 未变的 card；
2. 把离窗 card release 到 idle pool；
3. 为新 index 从 pool acquire 并 `rebind()`；
4. 只有 pool 为空时才创建；
5. active + idle 总数不得超过 11；
6. manager dispose 时统一释放。

滚动窗口变化不得再先 `disposeRenderedCards()` 再整体重建。

### 10.3 Detail row pool

详情行采用同样模型：

- active `≤11`；
- active + idle `≤11`；
- row canvas/texture/material/geometry 复用；
- `rebind(row, index)` 重绘内容并更新 metadata；
- loading/error/empty row 也走同一有界 pool；
- panel 单实例；
- open identity 变化、关闭和 dispose 不得泄漏。

### 10.4 切歌保护窗与数据 identity

```ts
interface ShelfTrackChangeGuard {
  begin(nowMs: number, durationMs?: number): void;
  isBlocking(nowMs: number): boolean;
  clear(): void;
}
```

基线 duration 为 `1120ms`，边界测试覆盖 `1119/1120ms`。

规则：

- playback `trackKey` 变化时触发；
- 未 pin、未开详情时立即清 hover cue、visibility target、selected index 和 Shelf focus；
- guard 内所有 Shelf card hover/focus/click/wheel/contextmenu 都不触发 action；
- pin 或 detail open 只是不强制隐藏，不代表 card 交互例外；
- 已打开且 identity 仍有效的 detail pane 内部滚动与 row action 可继续，underlay card 始终被 gate；
- pointer-down 记录 track generation，任何跨 track-change 的迟到 release 一律丢弃；
- guard 使用 injected clock，不读取 `Date.now()` 隐藏依赖；
- setData 同 index 但 identity 变化时关闭无效 detail；
- async cover/load 结果提交前校验 card binding generation；
- 被 recycle 的旧 card 不得接收迟到图片结果；
- pane/mode/presence 仍以 snapshot 为权威。

交互矩阵：

| 场景 | 保持可见 | card 交互 | detail 内交互 | 跨 generation release |
| --- | --- | --- | --- | --- |
| 未 pin、无 detail | 否 | 阻断 | 不适用 | 丢弃 |
| pinned | 是 | 阻断 | 不适用 | 丢弃 |
| detail open | 是 | 阻断 | identity 有效时允许 | 丢弃 |

### 10.5 Camera focus policy

static/dynamic gate 必须位于统一 policy，而不是只存在于全局 pointer resolver：

```ts
interface ShelfCameraFocusPolicy {
  canFocus(mode: ShelfCameraMode): boolean;
  clearIfStatic(mode: ShelfCameraMode): void;
}
```

- static 下 hover、右键 pin、open detail 都不能建立 Shelf focus；
- dynamic 保持现有行为；
- dynamic → static 立即清除已有 Shelf focus；
- 直接 click/contextmenu 路径不得绕过 policy。

### 10.6 Detail close transition

`closeDetail({ immediate })` 必须真正区分两条路径：

- `immediate=true`：同 tick 禁用 hit 并释放；
- 普通关闭：约 `180ms` 缩放/位移/淡出，动画期间禁用 hit，完成后 exactly-once dispose；
- 关闭状态由 render lane 推进，不新增裸 timer；
- 每次 close/reopen 提升 closing generation；
- 关闭后立刻重开时，旧 generation 不得释放新 detail；
- composition dispose 时强制 immediate 收口。

detail 使用显式 `closed | open | closing` 状态机。`closing` 期间：`hasOpenContent()` 为 true、raycast/hit 为 false、旧 focus 清除、callback 不重复发送；新的 open 提升 request/closing generation 并复用或替换 panel，旧 closing completion 不得释放新 detail。

### 10.7 Card build budget

对象池冷启动和 pool 缺位时仍需创建资源：

- 单 slice 最多创建 2 张 card；
- 单 slice 目标 `≤7ms`；
- 每张 build 绑定 window/binding generation；
- 窗口变化时取消未开始任务，迟到结果不得提交；
- 可选 warm upload 必须进入统一 upload/资源统计；
- warm pool 后滚动不再进入 build path。

### 10.8 Shelf diagnostics

```ts
interface ShelfResourceDiagnostics {
  readonly activeCards: number;
  readonly pooledCards: number;
  readonly createdCards: number;
  readonly activeRows: number;
  readonly pooledRows: number;
  readonly createdRows: number;
  readonly panelCount: number;
}
```

600 项/行滚动 soak 后：

- activeCards `≤11`；
- activeRows `≤11`；
- createdCards `≤11`；
- createdRows `≤11`；
- panelCount `≤1`；
- dispose 后 active/pooled 全部为 0。

card/row/panel 的 texture、geometry、material 与 mesh 必须逐项登记到 Shelf child `VisualResourceScope`；不能只用“整个 manager 一个 mesh”作为资源记账。pool idle 对象使用 rebuildable retention，dispose 释放 child scope 并注销 diagnostics supplier。

### 10.9 其他 parity 收口

- stage mode 普通 wheel 在无 card hit 时不消费；Shift 才允许强制滚动；
- portrait 判定统一使用 `height > width * 1.08`；
- 新安装默认 camera mode 为 Electron 同款 `dynamic`；
- 已持久化的显式 `static` 保持，不做破坏性迁移。

## 11. Store、持久化与控制面板

### 11.1 Store

`FxState` 使用嵌套、typed 的 additive 字段：

```ts
interface FxState {
  // 既有扁平字段保持兼容
  readonly stageLyrics: StageLyricsSettings;
  readonly sonic: SonicTopographySettings;
}
```

Stage/Sonic 控件通过 `setFxPatch({ stageLyrics: ... })` / `setFxPatch({ sonic: ... })` 更新，不把嵌套对象交给现有 scalar setters。`normalizeVisualFxState()` 是持久化 normalization 的唯一 owner，并分别委托两个 module normalizer；缺失字段补默认值，显式字段保留，旧 key 不改。

`normalizeVisualFxState()` 必须：

- 保持旧存储 key；
- 对所有新 enum/numeric/color 字段 clamp；
- 只有 Sonic factory 已注册并与 composition route 同版本可用时，才把 preset 8 迁移到 7；该开放与 runtime route 原子提交；
- 对缺失新字段使用默认值；
- 不改变现有 0..6 的值；
- round-trip 后保持稳定。

Shelf settings 单独遵循：基于原始对象是否拥有 `cameraMode`/`shelfCameraMode` 字段判断。字段缺失时默认 `dynamic`；读取到已存在的 `static` 时原样保留；非法显式值回落到 `dynamic`。`fx-defaults.ts`、`shelf-store.ts`、`VisualEngineHost.tsx`、`PlayerConsoleHost.tsx` 与 composition 初始 snapshot 必须使用同一 normalizer，不能各自保留 static fallback。

### 11.2 控制面板

不要继续把所有 JSX 塞进 `VisualControlPanelHost.tsx`。新增：

```text
apps/web/src/visual/controls/
├─ StageLyricsControls.tsx
└─ SonicTopographyControls.tsx
```

Sonic 控件仅在 preset 7 显示。Stage Lyrics 控件覆盖 display、translation、motion、clarity、context、edge、glitch；既有 glow/font/layout 控件保持兼容。

## 12. 性能与资源 diagnostics

建议扩展只读 subsystem diagnostics：

```ts
interface VisualSubsystemDiagnostics {
  readonly stageLyrics?: StageLyricsResourceDiagnostics;
  readonly sonicTopography?: SonicTopographyDiagnostics;
  readonly shelf?: ShelfResourceDiagnostics;
}
```

composition context 提供 diagnostics registry：module mount 时注册 supplier，dispose 时注销；collector 每次 snapshot 对 supplier 结果做 immutable copy，并把 reconciliation 差异放入 diagnostics，不取代 ledger admission。Stage、Sonic、Shelf 不得分别硬编码 performance collector 字段。

### 12.1 Stage Lyrics 门槛

- cooperative phase target `≤4.2ms`；
- release 中任何 phase `>8ms` 失败；
- upload `≤1/frame`；
- pending replacement `≤1`；
- 每 owner pending build `≤1`；
- dispose 后 pending build/upload、resident row、ephemeral texture/cache 为 0。

### 12.2 Sonic 门槛

- high 1080p CPU p95 `≤1.5ms`；
- high GPU p95 增量 `≤5ms`；
- ultra CPU p95 `≤2.5ms`；
- ultra GPU p95 增量 `≤8ms`；
- 整体 frame p95 `≤当前 Tauri 基线 +10%`；
- 预热后 >33ms frame `<1%`，>50ms frame `=0`；
- cold activate eco/balanced `≤80ms`，ultra `≤140ms`；
- warm re-enter `≤25ms`。

### 12.3 Shelf 门槛

- 600 项/行对象数量保持在 11/11；
- warm window scroll 不再创建新 card/row；
- 迟到 cover 不污染 recycled object；
- 连续两批同 fixture 的 Shelf gate CPU p50/p95 与 `renderer.info.memory` 不得回退超过 10%；
- card build 单 slice `≤2` 张且目标 `≤7ms`；
- track change guard 为 `1120ms`，1119ms 仍阻断、1120ms 解除；
- dispose 后对象、listener、pending load 全部归零。

### 12.4 自动检查与 release benchmark

自动测试负责 deterministic CPU cost、phase duration、上传调用计数、资源/current-peak、对象上限与 long-frame proxy。浏览器 benchmark 使用固定 web fixture、clock、audio、RNG、viewport、DPR、测试字体并等待 `document.fonts.ready`；截图比较与录屏由 Playwright/Chromium harness 生成 manifest。

GPU p95 仅在支持 `EXT_disjoint_timer_query_webgl2` 的 runner 上作为硬门；扩展存在本身不等于完成测量，只有 production presentation seam 发起的 query 已 resolved、未发生 disjoint 且 `sampleCount > 0` 时，证据才允许标记 `measured=true`。扩展可用但 release run 没有有效样本时，strict gate 必须失败。不支持扩展时记录 renderer CPU、draw calls、实例数和 frame p95 代理指标并明确标记为降级证据，不能把 CPU collector 数据误称为 GPU 时间。最终 release 需至少有一台支持 timer query 的 Windows/WebView2 或 Chromium 机器完成 GPU benchmark。

Release strict 还必须 fail closed：worktree 必须 clean；parity contract 内嵌的 build commit 必须与 manifest repository commit 完全一致；三场景 console error 必须为 0；preview 使用固定端口并拒绝静默 fallback。manifest 只记录 Git SHA 而不验证实际构建、或仅把 console 输出写入 artifact，都不能构成 immutable evidence。

## 13. 测试策略

TDD 只用于核心重要流程。

### 13.1 必须 TDD

- translation contract preservation；
- Stage settings normalization；
- display/translation virtual layout；
- pause hold、seek binary selection、resume；
- cooperative generation cancellation；
- stale build/upload 拒绝提交；
- owned/borrowed texture exactly-once；
- Canvas `1×1` 回收；
- GPU upload `≤1/frame`；
- clarity LRU 与 soft/hard pressure；
- Sonic preset 7 与 8→7 迁移；
- Sonic 8-band/Kick audio fixtures；
- Sonic lifecycle、资源上限和 deterministic impulse ring；
- Shelf card/row pool 复用、binding generation 与 600 行上限。
- Shelf 1120ms guard、static focus policy、detail closing generation 和 build slice budget。

### 13.2 Characterization / parity tests

- Electron 默认值和 clamp 表；
- Stage motion/glitch 参数；
- shader uniform/GLSL contract；
- camera、Shelf、Home、pointer policies；
- 现有 DOM ID/class 和 callback payload；
- 旧 preset 0..6；
- Stage current/outgoing visual formulas；
- Shelf 已有交互矩阵。

### 13.3 固定 fixtures

新增：

```text
packages/visual-engine/src/fixtures/m4/
├─ lyrics-short.ts
├─ lyrics-translated.ts
├─ lyrics-dense.ts
├─ lyrics-long.ts
├─ lyrics-seek-boundary.ts
├─ sonic-audio-frames.ts
└─ shelf-600.ts
```

覆盖短/长/CJK/英文/超长行/缺翻译/密集时间戳/seek 边界和 600 项数据。

### 13.4 视觉验收

- 固定 viewport、DPR、字体、封面、歌词、preset、RNG 和 audio frame；
- Stage 在指定时间点比较 current/context/translation 行、anchor、opacity、scale、glow；
- Sonic 1080p eco golden 建议 SSIM `≥0.98`，ROI MAE `≤3/255`；
- 5..10 秒录屏人工检查 transition、glitch、seek、无闪烁；
- 视觉证据必须可重复生成并记录命令。

## 14. Architecture guards

新增或扩展守卫：

- visual-engine 不导入 React、Zustand、Tauri、Sidecar；
- Stage/Sonic/Shelf 不直接调用 RAF、requestIdleCallback 或创建 AudioContext；
- Sonic 不导入 Web store 或 React；
- Stage build 必须通过 injected task/cancellation/resource services；
- React controls 不导入 Three.js；
- Sidecar/API freeze 仍通过；
- `VisualEngineHost` 不直接创建 Sonic/Stage/Shelf runtime；
- preset 7 特例不散落到 React 主循环。
- 全局 `BudgetTaskQueue.runSlice()` 只能由 maintenance lane 调用；
- Sonic 目录不得包含参考项目源码、shader 文本或逐行派生标记；
- 每个切片相对 `ab04493` 对 `sidecars/api`、`packages/shared`、Rust sidecar 启动/打包文件执行零差异检查。

## 15. 文件边界

### 15.1 主要新增

```text
packages/visual-engine/src/stage-lyrics/
├─ model/
├─ layout/
├─ textures/
├─ resource-budget/
├─ scheduler/
├─ rows/
└─ transitions/

packages/visual-engine/src/sonic-topography/
└─ ...

packages/visual-engine/src/shelf/
├─ object-pool.ts
└─ shelf-resource-diagnostics.ts

apps/web/src/visual/controls/
├─ StageLyricsControls.tsx
└─ SonicTopographyControls.tsx
```

### 15.2 主要修改

- `packages/visual-engine/src/runtime/visual-engine-contract.ts`；
- `packages/visual-engine/src/runtime/render-step-slot.ts`；
- `packages/visual-engine/src/home-visual/fx-defaults.ts`；
- `packages/visual-engine/src/audio/audio-snapshot.ts`；
- `packages/visual-engine/src/audio/audio-reactivity.ts`；
- `packages/visual-engine/src/runtime/cinema-camera.ts`；
- `packages/visual-engine/src/stage-lyrics/lifecycle.ts`；
- `packages/visual-engine/src/shelf/shelf-animate.ts`；
- `packages/visual-engine/src/index.ts`；
- `apps/web/src/visual/VisualEngineHost.tsx`；
- `apps/web/src/visual/runtime/create-legacy-visual-composition.ts`；
- `apps/web/src/stores/visual-store.ts`；
- `apps/web/src/visual/VisualControlPanelHost.tsx`；
- capability matrix、parity 文档和第三方声明。

## 16. 实施切片

1. 冻结 translation contract、fixtures、plugin/diagnostics/maintenance seams 与 architecture guards；preset 仍只开放 0..6；
2. Stage translation/display/translation layout；
3. Stage owned texture leases 与 cooperative raster pipeline；
4. Stage upload gate、clarity pool、prewarm 与 atomic takeover；
5. Stage pause/seek/resume、motion/glitch、UI 与 diagnostics；
6. clean-room Sonic settings 与 dormant controls；
7. immutable 512-bin typed audio seam 与 8-band profile；
8. Sonic plugin factory、cooperative render build、lifecycle 和 resource scope；
9. 原子开放 preset 7、8→7 migration、composition/camera/lyrics/Home/Shelf/pointer integration；
10. Shelf card/row pools、binding generation 与 diagnostics；
11. visual parity/performance harness、architecture guards、docs；
12. 全量验证、独立终审和 capability matrix 收口。

每个切片必须：

- 先执行适用的 RED→GREEN；
- 保持 Sidecar/API freeze；
- 独立规格复审；
- 独立代码质量复审；
- 主代理 fresh verification；
- Critical/Important 清零后再进入下一片。

## 17. 风险与应对

### 17.1 M4 体量过大

应对：按纵向切片提交；每片都可单独运行并保持旧行为，不采用一次性大爆炸替换。

### 17.2 Tauri 默认 high 与 Electron 默认 eco 不一致

不借 M4 全局改变现有用户的性能档位。Sonic grid cap 按当前 performance quality 执行，并在 parity 测试中显式使用 eco 与 high 两组基线，避免默认实例数无意翻倍。

### 17.3 Shader 与透明排序

必须真实运行 WebGL 截图检查 terrain、star-river、Shelf 与 Stage Lyrics 的 depthWrite/renderOrder，不只做源码字符串测试。

### 17.4 共享纹理误释放

所有共享纹理必须显式 borrowed/ref-counted；不允许继续从 material map 反推所有权。

### 17.5 随机效果破坏测试稳定性

Sonic impulse 接收注入 RNG；golden fixture 固定 seed。

### 17.6 第三方算法来源

已确认 `yin-yizhen/sonic-topography` 的 Non-Commercial Learning License 与本项目 GPL-3.0 发行目标不兼容。Sonic 必须按 9.0 节执行 clean-room 行为重建；不得复制第三方源码、shader 或派生实现。研究来源说明可保留，但不能替代版权方授权。

## 18. 完成标准

截至当前候选实现，施工判定如下：

| 领域 | 当前判定 | 尚未满足的完成门 |
| --- | --- | --- |
| Stage Lyrics 2.0 | `implemented` | clean commit `51ec050` 的 release strict evidence 通过；远端 `background + ephemeral` prewarm 仍未进入 scheduler，作为后续增强而非本次完成声明 |
| 3D Shelf | `implemented` | clean commit `51ec050` 的 600×600 release strict evidence 通过 |
| Sonic Topography | `partial` / blocked | clean-room provenance 与既有 exposure remediation；自动 source-isolation guard 只能证明 non-inclusion，不能证明实施者隔离 |
| M4 | Open / Blocked | Sonic provenance gate |

旧的 dirty manifest、早于最新生命周期/GPU 接线的 artifact 或仅含 proxy GPU 数据的 run 都不能作为 release evidence。`51ec050` 的 manifest 已记录 dirty=false、preview build commit 精确匹配、三场景 console errors=0、真实 GPU samples 与 60/60 hard checks，因此 Stage 与 Shelf 已晋升；Sonic 在 provenance 未通过前仍必须保持 `partial`。

M4 只有同时满足以下条件才算完成：

- `lyrics.stage-v2` 达到 implemented；
- `visual.sonic-topography` 达到 implemented；
- `shelf.3d` 达到 implemented；
- Stage translation/display/translation/motion/clarity 均有可观察行为；
- pause hold、seek、scrub、切歌和设置变化无 stale commit；
- GPU upload 永远 `≤1/frame`；
- Stage/Sonic/Shelf resource diagnostics 与 ledger 对账；
- Sonic preset 7 和 legacy 8→7 持久化可用；
- Sonic 8-band/Kick、camera、lyrics、Home、Shelf、pointer parity 完成；
- 600 项 Shelf 与 600 行详情对象数量保持有界；
- dispose/release 后无 texture、mesh、canvas、listener、timer、task 残留；
- 目标测试、全仓测试、typecheck、Web production build、API freeze 和 `git diff --check` 全部通过；
- 视觉/性能证据已生成并记录；
- 第三方声明已审计；
- Sonic clean-room 来源隔离复审通过；
- 相对 `ab04493` 的 Sidecar/shared/Rust sidecar 打包文件保持零差异；
- 独立最终代码审查无 Critical/Important。

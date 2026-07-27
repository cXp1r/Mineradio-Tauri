# M3 Visual Runtime 基础设计

日期：2026-07-27

状态：已确认，待实施计划

上位设计：docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md

## 1. 背景

当前 Tauri 主线已经完成 M1 App Decomposition，并建立了 M2 播放会话状态基础。视觉层仍存在以下结构性问题：

- packages/visual-engine/src/index.ts 中的 createVisualEngine() 仍是空壳；
- apps/web/src/visual/useVisualEngine.ts 约 1760 行，同时承担异步初始化、子系统装配、事件 wiring、RenderLoop 和释放；
- RenderLoop 只有全局 VSync 或固定 FPS 跳帧，没有各子系统独立 Frame Gate；
- analyser、歌词、粒子、Shelf、Home Visual 和维护任务共享同一 cadence；
- 前后台策略通过 document 状态和 FX 设置零散推导，没有显式 runtime mode；
- texture、mesh、listener、timer、subscription 和异步任务缺少统一 owner；
- 昂贵任务缺少统一取消、stale result 防护和预算调度；
- 性能指标只有 FPS、skip 和 long frame 基础计数，没有 gate、task、resource 和执行成本统计。

M3 的目标是建立可供后续 M4 Visual Parity 复用的运行时内核，不在本阶段重写具体视觉行为。

## 2. 目标

M3 必须交付：

1. 生产路径实际使用的 Visual Engine facade；
2. 前台 VSync、显式固定 FPS 和分级后台调度；
3. 各视觉子系统独立 Frame Gate；
4. 统一 ResourceScope、ResourceLedger 和资源预算；
5. CancellationScope、generation guard 和预算任务队列；
6. mount、取消、失败回滚和 dispose 的确定性生命周期；
7. frame、gate、task 和 resource 性能仪表；
8. 薄 React adapter，并保持当前视觉与 API 行为。

## 3. 非目标

以下能力属于 M4，不得混入 M3：

- Stage Lyrics 2.0 行为和视觉重写；
- 歌词纹理与 GPU 上传的完整迁移；
- Sonic Topography；
- 3D Shelf parity、对象池和详情虚拟化；
- 新视觉预设或视觉参数调整；
- 录屏、关键帧和观感 parity 验证体系。

以下跨层行为也不在 M3 修改：

- Bun Sidecar HTTP 路由；
- shared DTO；
- ProviderId；
- 媒体 URL 结构；
- Tauri 与 Sidecar 的现有 API 行为；
- 播放媒体时钟、play、pause、seek、ended 和 recovery。

## 4. 选择的方案

采用“渐进式 Runtime Kernel”。

packages/visual-engine 负责真实 facade、调度、资源、任务、取消和性能治理。Web 层暂时保留 Legacy Visual Composition，负责当前 Home、Shelf、Lyrics、Particles 的具体装配，以及 DOM、输入和业务 callback 适配。

不采用以下方案：

- 一次性把整个 useVisualEngine 和所有 Web 特有模块迁入 package：风险过高，并会把 M4 行为提前带入；
- 只在 apps/web 内拆文件：不能完成 M3 对真实 facade 和可复用 runtime kernel 的要求。

## 5. 总体架构

~~~text
VisualSurface / React props
        │
        ▼
VisualEngineHost
- 构造不可变 snapshots
- 创建与销毁 facade
- 不直接操作 Three.js
        │
        ▼
薄 useVisualEngine
- mount
- 提交 snapshots
- 同步 visibility
- unmount dispose
        │
        ▼
@mineradio/visual-engine Runtime Kernel
- Facade 生命周期
- Scheduler / Frame Gate
- Resource / Task / Perf 治理
        │
        ▼
Web Legacy Visual Composition
- 当前视觉子系统装配
- DOM 输入和业务事件适配
~~~

依赖方向必须保持：

~~~text
React/Web adapter ──> visual-engine runtime kernel
                           │
                           └──> Three.js / GSAP
~~~

visual-engine 不得依赖 React、Zustand、Tauri、Sidecar、Provider 或 Web 应用模块。

## 6. Facade 契约

~~~ts
interface VisualEngineFacade {
  mount(container: HTMLElement): Promise<void>;

  setPlaybackSnapshot(snapshot: PlaybackVisualSnapshot): void;
  setLyricsSnapshot(snapshot: LyricsVisualSnapshot): void;
  setShelfSnapshot(snapshot: ShelfVisualSnapshot): void;
  setVisualSettings(snapshot: VisualSettingsSnapshot): void;

  applyPreset(preset: VisualPresetId): void;
  setVisibility(state: VisualVisibilityState): void;

  getPerformanceSnapshot(): VisualPerformanceSnapshot;
  dispose(): void;
}
~~~

setVisualSettings() 是必需接口。当前视觉设置不仅包含 preset，还包含字体、歌词布局、粒子、bloom、AI depth、back cover、画质、后台策略、Shelf 模式和 wallpaper-safe 行为。

## 7. Snapshot 与媒体时钟

### 7.1 Snapshot 领域

~~~text
PlaybackVisualSnapshot
├─ trackKey
├─ playing
├─ duration
├─ coverUrl
└─ beatmap

LyricsVisualSnapshot
├─ lines
├─ fallbackText
└─ karaoke metadata

ShelfVisualSnapshot
├─ items
├─ pane
├─ mode
├─ presence
└─ counts

VisualSettingsSnapshot
├─ fx
├─ quality
├─ background policy
├─ reduced motion
└─ wallpaper-safe state
~~~

所有 snapshot 使用只读类型和结构共享。领域输入不变化时复用引用，禁止每帧 deep clone 大型歌词或 Shelf 数组。

Scheduler 在每帧开始时捕获一次完整 bundle：

~~~ts
interface VisualFrameSnapshot {
  revision: number;
  playback: PlaybackVisualSnapshot;
  lyrics: LyricsVisualSnapshot;
  shelf: ShelfVisualSnapshot;
  settings: VisualSettingsSnapshot;
}
~~~

本帧任务全部读取同一个 bundle；帧执行期间的新提交在下一帧生效。

### 7.2 实时媒体时钟

React positionMs 不能成为逐帧视觉时钟的唯一来源。Facade 创建时注入：

~~~ts
interface VisualMediaClock {
  currentTimeSeconds(): number;
  durationSeconds(): number | null;
  isPlaying(): boolean;
}
~~~

Web adapter 继续从真实 audio element 读取 currentTime。Visual Scheduler 不拥有、限制或修改媒体播放状态。

## 8. 反向事件

Facade 通过 event sink 返回视觉交互：

~~~ts
interface VisualEngineEventSink {
  onShelfPlayQueueIndex(index: number): void;
  onShelfPlayPlaylist(payload: ShelfPlayPlaylistEvent): void;
  onShelfDetailRowClick(payload: ShelfDetailRowEvent): void;
  onShelfModeChange(mode: ShelfMode): void;
  onShelfContentOpenChange(open: boolean): void;
  onDesktopLyricsMotion(snapshot: DesktopLyricsMotionSnapshot): void;
  onRuntimeError?(error: VisualRuntimeError): void;
  onPerformanceSample?(snapshot: VisualPerformanceSnapshot): void;
}
~~~

Web adapter 将事件连接到现有 callback，事件 payload 和业务行为保持不变。Callback 异常必须隔离并计入诊断，不能破坏渲染循环。

## 9. Lifecycle

Facade 状态机：

~~~text
idle → mounting → mounted → disposing → disposed
~~~

不变量：

- 同一实例最多成功 mount 一次；
- mount 中的 snapshot 更新只保留最新版本；
- mount 失败事务式回滚；
- mount 中 dispose 会取消初始化并释放已创建资源；
- dispose 幂等；
- disposed 后异步结果不能注册资源、任务或提交状态；
- React StrictMode 重新挂载创建新 facade，不复活旧实例；
- mount 相同实例到不同容器必须拒绝；
- stale callback 使用 generation 检查。

## 10. Visibility 与 Runtime Mode

~~~ts
interface VisualVisibilityState {
  documentVisible: boolean;
  windowVisible: boolean;
  windowFocused: boolean;
  windowMinimized: boolean;
}

type VisualRuntimeMode =
  | "foreground"
  | "background"
  | "deep-sleep"
  | "released";
~~~

状态行为：

| Runtime mode | 条件 | 行为 |
| --- | --- | --- |
| foreground | 可见、未最小化、有焦点 | 默认 VSync |
| background | 可见但失焦 | 降低非关键任务频率 |
| deep-sleep | hidden、不可见或最小化，background=auto | 停止完整渲染，以低频 timer 维护 |
| released | 非前台且 background=release | 取消任务并释放可重建资源 |
| keep | 用户明确保持后台运行 | 保留循环，但不可见任务仍停止 |

Tauri 原生窗口状态与 document visibility 共同输入。

唤醒顺序：

~~~text
取消后台 timer
→ 增加 scheduler generation
→ 重置 Frame Gate
→ 恢复 viewport 和 DPR
→ 捕获最新 snapshots
→ 启动唯一 RAF
~~~

## 11. Frame Policy 与 Frame Gate

### 11.1 前台策略

前台默认始终 VSync。画质档位只控制 DPR、分辨率、昂贵效果和资源预算，不得隐式将全局帧率改为 30 或 45 FPS。

固定 FPS 只由显式用户设置启用：

~~~ts
type ForegroundFramePolicy =
  | { mode: "vsync" }
  | { mode: "fixed"; fps: 24 | 30 | 45 | 60 };
~~~

### 11.2 默认 task cadence

~~~text
AudioAnalysis       60 FPS
Beatmap             60 FPS
HomeVisual          presentation cadence
Camera              presentation cadence
Shelf               30 FPS
LyricParticles      45 FPS
StageLyrics         45 FPS
DesktopOverlay      12 FPS
Maintenance         低频 timer
~~~

执行顺序必须是：

~~~text
AudioAnalysis
→ 构造同帧 immutable AudioSnapshot
→ Beatmap
→ Home / Camera / Shelf / Particles / Lyrics
→ renderer.render()
~~~

这会修复当前 analyser 更新晚于 frame snapshot 构造造成的一帧滞后。

### 11.3 Phase-credit 算法

禁止继续使用 now - lastRun >= 1000 / fps 的简单判断。该算法会使 45 FPS 在 60Hz 时间线上退化为约 30 FPS。

每个 Frame Gate：

- 累积 scheduler tick 的实际时间；
- 达到目标周期时执行一次；
- 扣除一个周期并保留余量；
- 单个 tick 最多执行一次，不执行多帧 catch-up；
- 返回累积后的有效 dt；
- dt 设上限；
- 时钟倒退、长时间 stall 和 visibility 变化时重置 phase；
- inactive task 恢复时不补跑积压帧。

## 12. Scheduler 不变量

- 任意时刻最多一个 RAF 或后台 timer；
- 任意时刻最多一个 active runtime callback registration；legacy `onAnimation` 是初始 registration，动态注册不得与之并存；
- 无 runtime callback registration 时，start 和可动画模式下的 stepOnce 必须同步拒绝，且不得申请 RAF/timer；
- composition 的 RenderLoop 只通过 Scheduler 注册 animation/maintenance callbacks，不得创建第二个 Scheduler、RAF 或 timer；
- Facade 独占 Scheduler 的 start、stop 和 dispose；runtime callback registration 不拥有启动权；
- start、stop 和 dispose 幂等；
- stale RAF/timer callback 不能复活循环；
- stepOnce 只执行一次，不安排下一帧；
- inactive task 不执行；
- task 异常不阻断后续 task 或 renderer；
- 错误必须记录，禁止静默吞掉；
- deep-sleep 不执行完整视觉管线；
- Scheduler 停止时媒体 play、pause、seek、ended 和 recovery 继续工作。

唯一调用链固定为：`Facade 创建唯一 Scheduler -> composition mount(context.scheduler) -> RenderLoop registerRuntimeCallbacks -> mount 成功 -> Facade start`。unregister 在运行中必须取消唯一 RAF/timer 并失效 generation，旧 callback 不得执行或复活；之后的注册必须由 Facade 显式重新 start。

## 13. ResourceScope 与 Ownership

ResourceScope 层级：

~~~text
engine
├─ renderer
├─ audio-analysis
├─ home-visual
│  ├─ cover
│  └─ ai-depth
├─ shelf
├─ particles
├─ stage-lyrics
└─ input-wiring
~~~

~~~ts
interface VisualResourceRegistration {
  owner: string;
  kind:
    | "texture"
    | "geometry"
    | "material"
    | "mesh"
    | "listener"
    | "timer"
    | "subscription"
    | "async-task"
    | "cache";
  retention: "persistent" | "rebuildable" | "ephemeral";
  estimatedBytes?: number;
  dispose(): void;
}
~~~

规则：

- scope 关闭后禁止注册；
- dispose 逆序执行；
- 每个资源最多 dispose 一次；
- 父 scope 自动关闭子 scope；
- disposer 抛错时继续释放剩余资源；
- borrowed 资源不由 engine 释放。

Borrowed 资源包括 audio element、App store、业务 callback 和 Tauri window handle。Owned 资源包括 renderer、Visual Engine 创建的 Three.js 资源、监听器、计时器、订阅和异步任务。

现有视觉叶子模块继续负责内部资源 dispose。ResourceScope 拥有这些模块句柄并保证恰好释放一次。M3 增加只读 Three.js 资源扫描器用于统计，不重复释放叶子模块已拥有的资源。

## 14. 资源预算

~~~ts
interface VisualResourceBudget {
  textureBytes: number;
  geometryBytes: number;
  meshCount: number;
  queuedTaskCost: number;
  cacheBytes: number;
}
~~~

资源优先级：

- essential：renderer 和当前场景关键资源；
- normal：当前可见视觉资源；
- optional：AI depth、额外 bloom 和预加载；
- background：缓存和预测任务。

压力行为：

| 压力 | 行为 |
| --- | --- |
| normal | 正常创建 |
| soft | trim 缓存并暂停 background 任务 |
| hard | 拒绝新的 optional/background 分配 |
| release | 取消任务并释放 rebuildable/ephemeral 资源 |
| wake | 按需懒恢复 |

预算不得自动释放当前正在显示的 essential 资源。

## 15. CancellationScope 与任务队列

~~~ts
interface VisualTaskSpec {
  owner: string;
  priority: "critical" | "visible" | "normal" | "background";
  estimatedCost: number;
  run(signal: AbortSignal): Promise<void>;
}
~~~

取消触发：

- engine dispose；
- subsystem scope dispose；
- track、cover 或 snapshot generation 变化；
- 进入 released；
- 资源压力取消 background 任务。

结果提交前必须同时满足：

~~~text
AbortSignal 未取消
+ owner scope 仍存活
+ generation 仍为当前版本
~~~

任务队列每帧只消耗限定时间。可分批任务主动 yield，同一 owner 的新任务可以取代旧任务。

M3 至少接入：

- facade 异步 mount；
- 封面加载；
- AI depth 请求；
- runtime release/dispose。

歌词纹理上传和 3D Shelf 对象池留到 M4。

## 16. 性能仪表

~~~ts
interface VisualPerformanceSnapshot {
  runtime: {
    mode: VisualRuntimeMode;
    running: boolean;
    mounted: boolean;
    generation: number;
  };
  frames: {
    rafTicks: number;
    timerTicks: number;
    renders: number;
    skippedRenders: number;
    frameCostP50Ms: number;
    frameCostP95Ms: number;
    longFrames: number;
  };
  gates: Record<string, {
    runs: number;
    skips: number;
    effectiveFps: number;
    pendingDtSec: number;
    costP50Ms: number;
    costP95Ms: number;
    errors: number;
  }>;
  resources: {
    current: VisualResourceUsage;
    peak: VisualResourceUsage;
    budget: VisualResourceBudget;
    pressure: "normal" | "soft" | "hard";
    allocations: number;
    releases: number;
  };
  tasks: {
    queued: number;
    running: number;
    completed: number;
    cancelled: number;
    staleResultsDropped: number;
    failed: number;
    peakQueueDepth: number;
  };
}
~~~

性能采样要求：

- frame cost 使用实际执行耗时，不使用帧间 dt；
- p50/p95 使用固定容量环形缓冲区；
- 不保存无限历史；
- 每个 gate 独立统计；
- resource 同时记录 current 和 peak；
- visibility 变化记录原因；
- M3 不新增面向普通用户的性能 UI；
- 不新增 localhost 或 Sidecar 诊断 API。

## 17. 错误处理

错误类型：

~~~text
MountError
TaskError
ResourceError
BudgetPressure
~~~

MountError 必须回滚并 reject。TaskError 隔离到单个 task，连续失败达到阈值后暂停该 task。ResourceError 聚合但不阻断其他释放。BudgetPressure 不是 fatal error，优先取消低优先级任务并 trim。

## 18. 文件边界

预计新增：

~~~text
packages/visual-engine/src/runtime/
├─ visual-engine-contract.ts
├─ visual-engine.ts
├─ visual-scheduler.ts
├─ visual-visibility.ts
├─ frame-gate.ts
├─ cancellation-scope.ts
├─ resource-scope.ts
├─ resource-ledger.ts
├─ resource-budget.ts
├─ budget-task-queue.ts
└─ performance-collector.ts

apps/web/src/visual/runtime/
├─ create-legacy-visual-composition.ts
├─ legacy-visual-events.ts
├─ visual-environment-adapter.ts
└─ visual-snapshot-builders.ts
~~~

useVisualEngine.ts 最终只负责 facade 创建、mount、snapshot/settings/visibility 提交和 dispose。

## 19. 测试策略

TDD 只用于核心重要流程。

必须使用 TDD：

- Frame Gate phase-credit；
- 24/30/45/60 FPS 时间线；
- Scheduler start/stop/dispose race；
- Scheduler runtime callback 单注册、unregister 竞态和无注册拒绝；
- stale RAF/timer 不可复活；
- visibility 状态转换和 wake；
- ResourceScope 逆序且恰好释放一次；
- mount 失败回滚；
- cancellation generation；
- stale task result 拒绝提交；
- soft/hard budget；
- p50/p95 和 peak resource 统计。

使用 characterization 或集成测试：

- 现有 render step 顺序；
- 现有 DOM ID/class；
- CSS 封面直链与 WebGL proxy URL；
- Home preview 和 preset 恢复；
- Shelf callback payload；
- Stage Lyrics 真实媒体时钟；
- StrictMode mount/unmount；
- snapshot 更新不重建 renderer；
- dispose 后无 listener、timer 或 RAF 残留。

Architecture tests：

- visual-engine 不导入 React、Zustand、Tauri 或 Sidecar；
- VisualEngineHost 不直接创建 renderer 或 render-loop；
- React hook 不直接注册 Three.js step；
- runtime package 不包含 ProviderId、HTTP route 或 Sidecar base URL；
- 生产路径使用真实 createVisualEngine()。

## 20. 实施切片

1. Facade contract 与生命周期状态机；
2. Frame Gate、Scheduler 与 visibility（含 runtime callback attachment）；
3. ResourceScope、取消域和预算任务队列；
4. Legacy composition 接入与薄 React adapter；
5. 性能仪表、架构守卫、文档和全量验证。

每个切片独立提交并保持可测试。

## 21. 完成标准

M3 完成必须同时满足：

- createVisualEngine() 成为生产使用的真实 facade；
- 前台默认 VSync；
- 只有显式用户选择才能固定 FPS；
- 子系统使用独立 Frame Gate；
- analyser 在同帧 audio snapshot 前更新；
- hidden/minimized 使用低频 timer 深睡；
- keep、auto 和 release 行为明确；
- 不可见任务停止，恢复不执行巨型 catch-up；
- Scheduler 不控制媒体播放状态；
- texture、mesh、模块句柄、listener、timer 和 task 均有 owner；
- mount 失败、中途取消和 dispose 不泄漏资源；
- stale async task 不能提交；
- soft/hard budget 可测试；
- 提供 frame、gate、task 和 resource 的 current、peak、p50、p95；
- useVisualEngine 成为薄 React adapter；
- 当前视觉与 API 行为保持不变；
- M4 行为没有提前实现；
- parity 文档准确标记 M3 foundation 和 M4 pending。

最终验证：

~~~powershell
bun run typecheck
bun test
bun run web:build
git diff --check
~~~

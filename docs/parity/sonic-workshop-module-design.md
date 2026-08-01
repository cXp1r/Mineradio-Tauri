# Sonic Workshop 独立 Module 设计

## 定位

本设计固定独立重实现的边界、预算与验收事实。`visual.sonic-workshop` 的代码状态是 `implemented / P0 / parity / blocked_by=none`；Windows/WebView2 观感与 GPU timer-query evidence 是 `Field Validation Pending (non-blocking)`，只限制更高的实机证据等级，不阻塞代码完成状态。

实现只能依据公开可观察行为和本项目自己的 Interface 编写，不导入、反编译或再分发 Electron 2.0.3 的 `public/vendor/sonic-workshop/**`。来源与处置依据见 `sonic-workshop-provenance.md`。

## Module 边界

| design_id | module_path | activation_id | input_boundary | vendor_dependency | preference_key | legacy_preset_8 | disabled_cost | authority_status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonic-workshop-v1 | packages/visual-engine/src/sonic-workshop | sonic-workshop-v1 | shared-frame-audio-media-theme-only | none | visual.workshop.v1 | migrates-to-sonic-topography-7 | zero | active |

当前 Module 满足：

- 只依赖 visual-engine 的 `FrameContext`、归一化 `AudioSnapshot`、只读媒体快照、主题 palette、共享 task queue、resource scope、ledger 和 diagnostics；
- 不依赖 React、`App.tsx`、DOM 查询、Sidecar/API、localhost、Tauri command 或外部 iframe；
- 由 visual composition 动态加载，并通过稳定字符串 activation id `sonic-workshop-v1` 装配，不复用 legacy numeric preset `8` 作为持久化身份；
- 使用独立 preference key `visual.workshop.v1`。旧 `visual.fx` 中的 numeric `8` 始终迁到 Sonic Topography `7`，不得被新 Module 重新解释；
- disabled 路径不加载 Module、不创建网络请求、timer、listener、task、GPU 对象或缓存。

## 生命周期

`activate` 创建独立 child `VisualResourceScope`，所有 task、geometry、texture、material、mesh 和 cache entry 都登记到同一 scope/ledger。初次构建采用可取消 generation；迟到或失败 generation 只能释放，不能 attach。当前所有公开设置都是非结构设置，经过值相等检查后直接更新 resident/pending bundle，不因滑块、主题或颜色变化重建 160×160 instance buffer。

`deactivate` 和 `dispose` 必须幂等，取消 owner task 并释放 child scope；两个 frame 内 diagnostics、ledger 和 scene root 回到激活前基线。禁止 Module 自建 RAF、AudioContext、worker、全局 listener 或第二套任务泵。

## 资源与性能预算

以下资源 hard cap 由实现中的资源账本与 deterministic tests 固定；CPU/GPU/frame 是实机验证阈值。两类预算只能收紧，不能在没有新设计审查和 evidence 的情况下放宽。

| profile | mesh_hard | draw_call_hard | geometry_hard_mib | texture_hard_mib | cache_hard_mib | queued_task_cost_hard | cpu_p95_ms | gpu_delta_p95_ms | frame_regression |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| high | 8 | 8 | 8 | 16 | 16 | 32 | 1.5 | 5 | <=10% |

额外不变量：

- 每帧最多一次纹理上传；单次上传不超过 4 MiB；
- cooperative build 单 phase 目标不超过 7 ms，队列压力下 optional warmup 必须可丢弃；
- runtime resident 与 pending replacement 同时存在时也不得超过表中 hard cap；
- 未来实机 evidence 使用固定 Windows/WebView2、1080p、DPR、音频 fixture、RNG、CPU/frame 采样和 240 个有效 GPU timer-query samples；
- 没有有效 CPU/GPU/frame samples 时保持 `Field Validation Pending (non-blocking)`，不得提升为 `Field Validated` 或 `Release Verified`；代码状态仍可依据 deterministic implementation gates 保持 `implemented`。

## 实现门禁

`visual.sonic-workshop` 的代码完成门禁如下：

1. preference schema 的旧 `8 → 7`、新 `visual.workshop.v1`、直接选择和跨重启 round-trip 测试；
2. activate/deactivate、非结构设置原位更新、partial/failed generation、dispose 的资源归零测试；
3. disabled cost=0、mesh/draw/geometry/texture/cache/task hard cap 和 geometry/material exactly-once dispose 的 deterministic tests；
4. 与 Stage Lyrics、Shelf、camera policy 的联合 render-list characterization；
5. capability matrix、source map、reviewed-delta 与独立性 guard 同步变更。

前五项已经完成。Windows/WebView2 观感、真实 CPU/GPU/frame timing 与长时 soak 继续列为非阻塞待实测；它们不得被本地 fixture 伪造，也不再作为 `implemented` 的阻塞条件。

160×160 是本项目为固定资源上界作出的独立实现选择，只对齐公开可观察的高密度音域地形，不声称复刻上游 vendor bundle 的内部几何实现。

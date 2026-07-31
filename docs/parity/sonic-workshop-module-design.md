# Sonic Workshop 独立 Module 设计

## 定位

本设计只固定未来独立重实现的边界和预算，不表示 `visual.sonic-workshop` 已经实现。活动状态继续是 `migration-pending`，能力矩阵继续是 `missing / P0 / parity / blocked_by=none`。

实现只能依据公开可观察行为和本项目自己的 Interface 编写，不导入、反编译或再分发 Electron 2.0.3 的 `public/vendor/sonic-workshop/**`。来源与处置依据见 `sonic-workshop-provenance.md`。

## Module 边界

| design_id | module_path | activation_id | input_boundary | vendor_dependency | preference_key | legacy_preset_8 | disabled_cost | authority_status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonic-workshop-v1 | packages/visual-engine/src/sonic-workshop | sonic-workshop-v1 | shared-frame-audio-pointer-only | none | visual.workshop.v1 | migrates-to-sonic-topography-7 | zero | active |

未来 Module 必须满足：

- 只依赖 visual-engine 的 `FrameContext`、归一化 `AudioSnapshot`、pointer intent、共享 task queue、resource scope、ledger 和 diagnostics；
- 不依赖 React、`App.tsx`、DOM 查询、Sidecar/API、localhost、Tauri command 或外部 iframe；
- 由 visual composition 通过稳定字符串 activation id `sonic-workshop-v1` 装配，不复用 legacy numeric preset `8` 作为运行时身份；
- 使用独立 preference key `visual.workshop.v1`。旧 `visual.fx` 中的 numeric `8` 始终迁到 Sonic Topography `7`，不得被新 Module 重新解释；
- disabled 路径不加载 Module、不创建网络请求、timer、listener、task、GPU 对象或缓存。

## 生命周期

`activate` 创建独立 child `VisualResourceScope`，所有 task、geometry、texture、material、mesh 和 cache entry 都登记到同一 scope/ledger。设置变化采用 generation + latest-wins；新资源 ready 后原子替换，stale generation 只能释放，不能 attach。

`deactivate` 和 `dispose` 必须幂等，取消 owner task 并释放 child scope；两个 frame 内 diagnostics、ledger 和 scene root 回到激活前基线。禁止 Module 自建 RAF、AudioContext、worker、全局 listener 或第二套任务泵。

## 资源与性能预算

以下是进入实现前的 hard cap；实现只能收紧，不能在没有新设计审查和 evidence 的情况下放宽。

| profile | mesh_hard | draw_call_hard | geometry_hard_mib | texture_hard_mib | cache_hard_mib | queued_task_cost_hard | cpu_p95_ms | gpu_delta_p95_ms | frame_regression |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| high | 8 | 8 | 8 | 16 | 16 | 32 | 1.5 | 5 | <=10% |

额外不变量：

- 每帧最多一次纹理上传；单次上传不超过 4 MiB；
- cooperative build 单 phase 目标不超过 7 ms，队列压力下 optional warmup 必须可丢弃；
- runtime resident 与 pending replacement 同时存在时也不得超过表中 hard cap；
- release evidence 使用固定 Windows/WebView2、1080p、DPR、音频 fixture、RNG 和 240 个有效 GPU timer-query samples；
- 没有有效 GPU samples 时只能记录降级证据，不能把能力提升为 `implemented` 或 `Release Verified`。

## 实现门禁

未来将 `visual.sonic-workshop` 提升为 `implemented` 前，必须同时具备：

1. preference schema 的旧 `8 → 7`、新 `visual.workshop.v1`、直接选择和跨重启 round-trip 测试；
2. activate/deactivate/reconfigure/stale generation/dispose 的资源归零测试；
3. disabled cost=0 和表中 hard cap 的 deterministic tests；
4. 与 Stage Lyrics、Shelf、camera policy 的联合 render-list characterization；
5. Windows/WebView2 release evidence，以及 capability matrix、source map 和 reviewed-delta guard 的同步变更。

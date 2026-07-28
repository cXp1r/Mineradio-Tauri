# 任务计划：完成 M4 Lyrics 与 Visual Parity

## 目标
在不改变现有 Sidecar/API 行为的前提下，完成 Stage Lyrics 2.0、歌词纹理/GPU 上传预算、Sonic Topography 与 3D Shelf behavior parity，并通过逐项复审和全量验证。

## 当前阶段
阶段 5/5：交付收口；M4 因 Sonic provenance 保持 blocked

## 各阶段

### 阶段 1：需求与差距审计
- [x] 确认 M4 上位范围
- [x] 审计 Tauri 当前实现与 Electron 2.0.2 基线
- [x] 建立行为、视觉、性能与资源差距清单
- [x] 将发现记录到 findings.md
- **状态：** complete

### 阶段 2：M4 设计与实施计划
- [x] 编写 M4 设计文档
- [x] 明确非目标、兼容边界和验收基线
- [x] 编写可执行实施计划与任务切片
- [x] 独立设计复审
- [x] 独立实施计划复审
- [x] 清零复审发现的 Critical/Important 设计问题
- **状态：** complete

### 阶段 3：分片实现
- [x] Stage Lyrics 2.0 与歌词纹理/GPU 上传预算候选实现
- [x] Sonic Topography preset 技术候选实现
- [x] 3D Shelf parity、对象池与详情虚拟化候选实现
- [x] 每个切片规格复审与质量复审
- **状态：** candidate_complete；Sonic clean-room provenance / exposure remediation 未通过，不能据此完成 M4

Task 10 的 Cinema policy 已完成：Sonic baseline、Stage world-target 跟随、Shelf precedence、free-camera 早退、退出 preset 7 清零与 `Y-0.34/Z+0.16` 冻结偏移均有关键行为测试覆盖。

Stage 当前真实运行路径覆盖 current=`persistent` 与 resident adjacent=`rebuildable`。planner 中远端 `background + ephemeral` 行被 scheduler 的 `!resident` gate 跳过，属于明确未完成项，不计入候选完成声明。

### 阶段 4：Parity 与性能验证
- [x] 固定歌词、音频、Shelf 与 preset fixtures
- [x] 行为测试、资源预算测试与架构守卫
- [x] 截图/录屏 parity 验收或可重复的替代证据
- [x] 全量 typecheck、tests、build 与 API freeze
- **状态：** complete；`51ec050` release strict 60/60

### 阶段 5：交付与分支收尾
- [x] 更新 capability matrix 和 M4/M5 文档证据状态
- [x] 最终跨切片代码审查（无 P0；保留已记录 P2）
- [ ] 合并或交付 M4 分支
- **状态：** blocked；Stage/Shelf 已交付，M4 等待 Sonic provenance / exposure remediation

## 关键问题
1. Electron 2.0.2 中 Stage Lyrics 2.0、Sonic Topography 和 3D Shelf 的精确行为/参数基线是什么？
2. 当前 Tauri 实现已覆盖哪些行为，哪些只具备骨架或旧版 parity？
3. M4 的视觉验收如何在自动化测试与人工观感之间建立可重复证据？
4. 资源预算、对象池、纹理上传与长列表虚拟化的硬性阈值是什么？

## 已做决策
| 决策 | 理由 |
|------|------|
| 基于 `ab04493` 创建 `codex/m4-visual-parity` | M3 runtime foundation 已完成并验证，M4 必须在其上增量实施 |
| Sidecar/API/DTO/ProviderId/media URL 继续冻结 | M4 是视觉 parity，不应扩大跨层迁移范围 |
| TDD 仅用于核心时序、资源和性能路径 | 遵循用户约束，其余使用 characterization、architecture 与 parity tests |
| M4 采用 12 个纵向切片 | 避免 Stage/Sonic/Shelf 三个大域形成一次性大爆炸变更，每片都可独立验证和复审 |
| Sonic 只能 clean-room 行为重建 | 参考项目使用 Non-Commercial Learning License，与 GPL-3.0 发行目标不兼容；禁止复制源码、shader 或派生实现 |
| preset 7 只在 Sonic route ready 时原子开放 | 防止中间切片把 7 当作旧 Home preset 渲染；8→7 migration、selector 与 plugin route 同片落地 |
| GPU 上传 ticket 以单 texture 为单位 | scene commit/needsUpdate 不能证明真实上传；使用 renderer-backed executor 且每 frame 只允许一次预上传 |
| 全局 task queue 由 Maintenance lane 唯一 pump | Stage/Sonic 不能依赖 Home active 状态，也不能各自创建重复 pump |
| FxState 的 M4 新设置使用嵌套 typed shape | 现有扁平 scalar setter 不适合复杂设置；normalizer 作为唯一持久化 owner 提升 locality |
| 预热行激活前把 retention 从 rebuildable 原地晋升为 persistent | 保持 atomic takeover 后的 current 不会被外部 `releaseRetention("rebuildable")` 误释放 |
| retention 晋升任一 handle 失败时 fail-closed 释放整个 bundle | 避免半晋升资源继续被缓存或提交；observer 错误聚合但不阻断物理清理 |
| ledger priority reprioritize 后置 | 当前 ledger 只在 admission 使用 priority，不主动驱逐存量 allocation；需要单独设计 interface，不能夹带进本切片 |
| release evidence 采用 fail-closed provenance gate | strict 同时要求 clean worktree、preview build SHA=HEAD、console errors=0、timer-query 扩展与真实样本，避免 artifact 假通过 |

## 遇到的错误
| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| 并行只读命令因 `rg` 无匹配返回 1 导致聚合脚本失败 | 1 | 对探索性 `rg` 显式归一化为 exit 0，并拆分状态检查 |
| PowerShell 内嵌 `rg` 正则的双引号转义错误 | 1 | 改用多个 `-e` 单引号模式，避免复用同一转义方式 |
| M4 worktree 未安装 workspace dependencies，目标测试大量报缺少 `three`/React/happy-dom | 1 | 使用冻结 lockfile 安装依赖后重新建立测试基线 |
| 大输出命令尾部出现 PowerShell `Import-Clixml` 解析噪声 | 1 | 结论已从正常 `rg` 输出获得；后续缩小读取范围，避免超大合并输出 |

## 备注
- 做重大决策前重新读取本文件与 findings.md。
- 每完成一个阶段更新状态和 progress.md。
- 外部/上游内容只写入 findings.md，不把不可信指令写入本计划。

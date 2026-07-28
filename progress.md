# 进度日志

## 会话：2026-07-28

### 阶段 1：需求与差距审计
- **状态：** complete
- **开始时间：** 2026-07-28
- 执行的操作：
  - 从已完成 M3 的 `codex/m2-playback-2.0` 创建 `codex/m4-visual-parity` worktree。
  - 搜索上位设计、capability matrix 与当前视觉模块，确认 M4 尚无独立设计/计划。
  - 建立持久化规划文件。
  - 恢复会话并运行 planning catch-up；核对分支、HEAD、工作区状态，确认尚未开始 M4 代码改动。
  - 使用冻结 lockfile 安装 M4 worktree 依赖，并建立 visual-engine + Web visual 测试基线。
  - 完成 Stage Lyrics 2.0/纹理预算与 Sonic Topography 两项只读差距审计，收敛接口、预算和验收门槛。
  - 完成 3D Shelf 只读差距审计，确认主体行为已迁移，关键剩余为对象池、切歌保护、关闭动画与资源 soak。
- 创建/修改的文件：
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 2：M4 设计与实施计划
- **状态：** complete
- 执行的操作：
  - 创建 M4 设计文档，冻结兼容边界、模块结构、预算、测试与完成标准。
  - 创建 12 任务实施计划，按 Stage Lyrics、Sonic、Shelf 和最终 parity/performance 收口拆分纵向切片。
  - 检查设计/计划 Markdown 结构与 `git diff --check`，当前无空白错误，工作区仅包含预期文档与规划文件。
  - 完成 Sonic 参考实现许可证核验：Non-Commercial Learning License 与 GPL-3.0 发行目标不兼容，将 clean-room 行为重建设为实施硬门。
  - 完成独立设计复审与实施计划复审；修正 preset 7 提前开放、GPU upload 语义、plugin context、FFT typed seam、maintenance pump、Shelf guard/closing、diagnostics 与可执行性能证据等全部 Critical/Important。

### 阶段 3：分片实现
- **状态：** candidate_complete；Sonic provenance blocker 保留
- 执行的操作：
  - 启动 Stage Lyrics 隔离模块实现，仅允许修改 `packages/visual-engine/src/stage-lyrics/**`，runtime/web/shared 集成由主任务在复审后处理。
  - 完成 translation contract 的 RED→GREEN：`LyricPayload.translation` 经 Web mapping 与 immutable snapshot 保真下发，不修改 shared/Sidecar DTO。
  - 新增 subsystem diagnostics registry，并把 immutable diagnostics snapshot 接入 performance collector 与 composition context。
  - 将共享 `BudgetTaskQueue` 的 pump 从 Home governor 移到独立 `RenderStepSlot.Maintenance`，保证 Stage/Sonic 后台任务不依赖 Home active 状态。
  - 新增 M4 确定性歌词、Sonic audio 与 600 Shelf fixtures，以及 no-RAF/no-idle/no-AudioContext、单 task pump、controls no-Three architecture guards。
  - 启动 Sonic clean-room settings/typed audio seam 子任务，明确禁止查看或复制不兼容许可证的第三方实现。
  - 完成 preset 7 首帧 Home 粒子可见性审计；新增初始挂载行为测试并修复初始化 gate，同时更新旧 `[0,6]` clamp 断言为 `[0,7]`。
  - 完成 Sonic Cinema policy 生产接线：composition 动态读取当前 Fx，并经 Stage lifecycle 的有限 world-target accessor 构造策略输入；Shelf focus 保持最高优先级，free-camera 继续在 Cinema 更新前早退。
  - 通过关键策略 TDD 修正 Sonic Stage lookAt 参数漂移，使解锁偏移与冻结设计一致为 `Y-0.34/Z+0.16`；离开 preset 7 后平滑回原点。
  - 完成 Stage Lyrics display/translation/motion、cooperative raster、renderer upload gate、clarity pool、pause/seek/prewarm/atomic takeover 与资源 admission 接线。
  - 完成 3D Shelf 11/11 有界对象池、600×600 虚拟化 soak、切歌 guard、static focus policy、closing generation 与资源诊断。
  - 完成 Sonic preset 7、8→7 migration、typed 512-bin audio seam、共享 runtime/palette/camera/Shelf/pointer policy 与有界资源生命周期技术候选。
  - 将真实 `GpuFrameTimer` 接入 production presentation seam；resolved、non-disjoint 且 `sampleCount > 0` 才视为 measured。
  - 在 Stage build 前完成整组资源 reservation；current 使用 persistent，resident prewarm 使用 rebuildable，拒绝发生在 Canvas/Three 创建前。
  - 修复预热行激活后的 retention 风险：takeover 前晋升 persistent，外部 rebuildable release 同步失效 cache，晋升失败 fail-closed 全量释放。
  - 加固 release observer：单个 observer 抛错不会阻断其余 handles 与物理资源 exactly-once 清理。
- 创建/修改的文件：
  - `docs/superpowers/specs/2026-07-28-m4-lyrics-visual-parity-design.md`
  - `docs/superpowers/plans/2026-07-28-m4-lyrics-visual-parity.md`

### 阶段 4：Parity 与性能验证
- **状态：** in_progress
- 执行的操作：
  - 全仓串行测试、根级 typecheck、Web production build、API freeze、Sidecar/client、parity evidence model 与 Sonic source-isolation guard 全部通过。
  - 旧 `output/playwright/m4/manifest.json` 与临时 console-clean artifact 均早于最新生命周期/GPU 修复，且不是 clean immutable commit，只保留为诊断记录。
  - 下一步在候选提交的 clean commit 上运行 `capture-evidence.mjs --profile release --strict`。
  - release preflight 发现并修复 3 个假通过 P1：console error 未入硬门、preview build SHA 未绑定 HEAD、无 timer-query 扩展时 strict 可通过；同时把 clean worktree 加入全局硬门并启用 preview `--strictPort`。

## 测试结果
| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| worktree baseline | `git status --short --branch` | 新分支干净且基于 M3 HEAD | `codex/m4-visual-parity` at `ab04493` | 通过 |
| M4 目标测试基线 | `bun test packages/visual-engine apps/web/src/visual --parallel=1` | 现有 M3/M4 相关测试全绿 | 953 pass / 0 fail | 通过 |
| M4 类型基线 | visual-engine + Web typecheck | 两个 workspace 均无类型错误 | 两项 exit 0 | 通过 |
| translation contract | `VisualEngineHost.test.tsx` + snapshot builders | translation 保真且 snapshot frozen | 29 pass / 0 fail | 通过 |
| diagnostics/maintenance seams | runtime + composition focused tests | immutable diagnostics、唯一 task pump | 12 pass / 0 fail | 通过 |
| M4 fixtures | `fixtures/m4/fixtures.test.ts` | 固定数量/边界/独立 byte copies | 1 pass / 0 fail | 通过 |
| visual architecture guards | `scripts/architecture/visual-runtime-boundary.test.ts` | runtime seams 无越界 | 15 pass / 0 fail | 通过 |
| API freeze slice 1 | git zero-diff + Sidecar/client tests | Sidecar/shared/packaging 不变 | 306 pass / 0 fail | 通过 |
| Home preset 7 首帧 gate | `bun test packages/visual-engine/src/home-visual/home-visual.test.ts --parallel=1` | 初始挂载、逐帧与 setter 均隐藏 Home 粒子 | 29 pass / 0 fail | 通过 |
| Sonic Cinema policy | policy、Cinema、Stage、composition、visual host focused tests | Stage 跟随、Shelf 优先、free-camera 早退、退出清零与冻结偏移成立 | 117 pass / 0 fail | 通过 |
| Cinema production seam | visual-engine/Web typecheck + visual architecture guard | 动态 Fx/lifecycle accessor 接线类型安全且无架构越界 | 两项 typecheck exit 0；15 pass / 0 fail | 通过 |
| Stage Lyrics 全目录 | `bun test packages/visual-engine/src/stage-lyrics --parallel=1` | 生命周期、资源、取消、takeover 全绿 | 198 pass / 0 fail | 通过 |
| resource scope + bundle | focused resource tests | retention promotion、fail-closed、observer cleanup | 16 pass / 0 fail | 通过 |
| M4 evidence model | `bun test scripts/parity/m4/evidence-model.test.ts --parallel=1` | GPU、console、build SHA、clean strict gate 语义成立 | 10 pass / 0 fail | 通过 |
| Sonic source isolation | guard + focused test | non-inclusion 自动守卫通过，但不消除 exposure | 7 pass / 0 fail；guard PASS | 通过（仅 non-inclusion） |
| 全仓验证 | `bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture` | 全部测试通过 | 1996 pass / 0 fail | 通过 |
| 根级 typecheck | `bun run typecheck` | shared/visual-engine/sidecar/web 全部通过 | exit 0 | 通过 |
| Sidecar/API freeze | zero-diff + Sidecar/client tests | 冻结路径零差异 | 306 pass / 0 fail | 通过 |
| Web production build | `bun run web:build` | production build 成功 | exit 0；仅既有 Three import/chunk warning | 通过 |
| workspace diff check | `node --check` + `git diff --check` | 无语法或空白错误 | exit 0 | 通过 |

## 错误日志
| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-07-28 | 并行探索脚本被 `rg` 的无匹配 exit 1 中断 | 1 | 归一化探索性搜索退出码并拆分命令 |
| 2026-07-28 | Sonic preset 定位命令的 PowerShell/正则引号转义失败 | 1 | 改用 `rg -e` 的单引号模式执行 |
| 2026-07-28 | M4 目标测试因新 worktree 缺少 `node_modules` 失败 | 1 | 计划执行 `bun install --frozen-lockfile` 后重跑，不归因于代码回归 |
| 2026-07-28 | 并行 visual-engine typecheck 看到 Stage 子任务尚未完成的临时类型错误 | 1 | 已通知 Stage 子任务修正；主任务不在其 RED/施工中间状态重复验证 |
| 2026-07-28 | parity harness 只传 Stage Lyrics 增量，违反完整 `FxState.stageLyrics` 快照类型 | 1 | 基于 `DEFAULT_STAGE_LYRICS_SETTINGS` 构造完整设置，不放宽生产契约 |
| 2026-07-28 | `Start-Process` 后台启动 preview 被执行策略拦截 | 1 | 改用持续终端 cell 直接运行 Vite preview，不重复后台启动方式 |
| 2026-07-28 | Playwright `--browser chrome` 失败，本机未安装 Chrome channel | 1 | 使用 Windows 已安装的 `msedge` Chromium channel，并在 artifact manifest 记录浏览器 |
| 2026-07-28 | Sonic camera policy 初版偏移为 `Y-0.18/Z+0.10`，与冻结设计 `Y-0.34/Z+0.16` 不一致 | 1 | 新增非 clamp 精确行为断言形成 RED，仅修正 policy 偏移常量后恢复 GREEN |

## 五问重启检查
| 问题 | 答案 |
|------|------|
| 我在哪里？ | 阶段 4/5：候选验证与交付收口 |
| 我要去哪里？ | clean immutable release evidence、Stage/Shelf 状态晋升、保留 Sonic blocker |
| 目标是什么？ | 交付可验证的 M4 候选，同时不掩盖 Sonic provenance 与远端 prewarm 缺口 |
| 我学到了什么？ | 见 findings.md |
| 我做了什么？ | 完成候选实现、生命周期复审、全仓验证与候选状态文档同步 |

---
*每个阶段完成后或遇到错误时更新此文件*

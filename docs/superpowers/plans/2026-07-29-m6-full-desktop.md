# M6 Full Desktop 实施计划

> 本计划只执行 M6 完整桌面。M7 Wallpaper Engine/DWM/WGC/Wallpaper Scene、M8 设置工作台与数据迁移、M9 Rust API 接入准备不得混入。

**Goal：** 在不改变 Sidecar/API/shared DTO/Provider/media URL 和既有 Tauri command 行为的前提下，建立可恢复的 Rust Full Desktop Runtime：WorkerW/Explorer attach、真实 desktop icon layer、interaction lock、Explorer reconcile、journal recovery 与安全退出。

**Architecture：** `FullDesktopRuntime` 是高 Depth Module，持有 state、intent serialization、journal 事务与 rollback；`FullDesktopPlatform` trait 隔离机制，`TauriFullDesktopPlatform` 是 Windows Adapter；watcher 和生命周期编排位于 `app/full_desktop_runtime.rs`，Tauri command 与 Web Port 只是稳定 transport Seam。所有系统修改先持久化 journal，所有恢复入口收敛到同一 runtime。

**Tech Stack：** Rust 2021、Tauri 2、serde、tokio、Windows API target dependency、TypeScript、React 19、Bun test、Vite。

**TDD 约束：** state/journal/runtime/reconcile 的核心恢复流程使用 red-green-refactor；Win32 wrapper、command registration、普通 UI、机械文件移动和文档不强制先写 RED。

**当前状态：** Code Complete / Windows Field Validation Pending (non-blocking)。M5 与 M6 的自动代码门禁均已完成；双屏混合 DPI、Explorer restart、托盘/正常退出和 Windows soak 仍需实机补证。这些证据只阻止 `Field Validated / Release Verified`，不阻止进入 M7。

---

## M6 冻结线

施工全程保持以下内容相对 M6 起点不变：

- `sidecars/api/**`、Bun workspace 与 API 测试；
- `packages/shared/**` 的业务 DTO/schema；
- `apps/web/src/api/sidecar-client.ts` 行为、ProviderId、ApiError、media URL；
- `apps/desktop/scripts/build-sidecar-binary.mjs`、`apps/desktop/src-tauri/build.rs`、`tauri.conf.json` 的 `externalBin`；
- `src-tauri/src/sidecar.rs`、sidecar supervisor、`RuntimeConfig.sidecarBaseUrl`、`get_sidecar_status`；
- 28 个 frozen command 与 M5 12 个 additive command 的名称、参数、serde shape 和错误语义；
- M5 lifecycle ownership：full desktop rollback 必须接入 cleanup，不得替换 Sidecar shutdown 逻辑。

唯一允许新增的 command：

```text
get_full_desktop_runtime_state
set_full_desktop_mode
set_desktop_icons_visible
set_full_desktop_interaction_locked
recover_full_desktop_runtime
```

---

## File map

### Rust deep Modules

- `apps/desktop/src-tauri/src/runtime/full_desktop/mod.rs`
- `apps/desktop/src-tauri/src/runtime/full_desktop/reconcile.rs`
- `apps/desktop/src-tauri/src/platform/windows/full_desktop.rs`

### App composition 与 transport Adapter

- `apps/desktop/src-tauri/src/app/state.rs`
- `apps/desktop/src-tauri/src/app/full_desktop_runtime.rs`
- `apps/desktop/src-tauri/src/app/desktop_runtime.rs`
- `apps/desktop/src-tauri/src/app/lifecycle.rs`
- `apps/desktop/src-tauri/src/app/tray.rs`
- `apps/desktop/src-tauri/src/commands/mod.rs`
- `apps/desktop/src-tauri/src/commands/full_desktop.rs`
- `apps/desktop/src-tauri/src/commands/diagnostics.rs`
- `apps/desktop/src-tauri/src/runtime/settings.rs`
- `apps/desktop/src-tauri/src/runtime/diagnostics.rs`
- `apps/desktop/src-tauri/src/lib.rs`

### Web Port/Adapter/Surface

- `apps/web/src/ports/full-desktop-runtime-port.ts`
- `apps/web/src/adapters/tauri/tauri-full-desktop-runtime.ts`
- `apps/web/src/features/desktop/useFullDesktopRuntime.ts`
- `apps/web/src/features/desktop/FullDesktopControls.tsx`
- `apps/web/src/features/desktop/FullDesktopControls.test.tsx`

### Guards、fixtures 与 evidence

- `scripts/architecture/desktop-command-manifest.mjs`
- `scripts/architecture/full-desktop-boundary.test.ts`
- `scripts/architecture/full-desktop-command-contract.test.ts`
- `scripts/parity/m6/*`
- `docs/parity/capability-matrix.md`
- `docs/parity/upstream-source-map.md`
- M6 design/plan 与 umbrella progress section

---

## Task 0：冻结 M6 契约和起点

**类型：** Characterization；不使用 TDD。

**Files：**

- Modify: `scripts/architecture/desktop-command-manifest.mjs`
- Add: `scripts/architecture/full-desktop-command-contract.test.ts`
- Add: `scripts/architecture/full-desktop-boundary.test.ts`
- Add: `scripts/parity/m6/README.md`

**步骤：**

1. 从 M5 complete worktree 记录 baseline SHA 与 frozen path manifest。
2. 在 command manifest 中固定五个 additive command 的名字、顺序、参数名、serde casing、return shape 和稳定 error mapping。
3. 建立 architecture guard：`commands/full_desktop.rs` 不得 import `windows-sys`；core runtime 不得依赖 Tauri/Web；platform Adapter 不得 import Sidecar/API。
4. 建立 API freeze runner，确保 frozen paths 及其接口语义不被 M6 改写。

**验收：** M6 guard 先 RED，再以最小 skeleton 变 GREEN；现有 command manifest 和 API freeze 均通过。

## Task 1：定义 transport-neutral contracts 与纯状态机（TDD）

**Files：**

- Add: `runtime/full_desktop/mod.rs`
- Add tests: `runtime/full_desktop/mod.rs`

**步骤：**

1. 定义 `FullDesktopMode`（disabled/passive/interactive）、`FullDesktopPhase`、`FullDesktopRuntimeState`、stable `FullDesktopError` 和 typed transition intent。
2. 写 RED 测试覆盖合法 transition、非法 transition、attach failure、recover failure、disable 幂等和 interaction lock 仅在 active mode 有效。
3. 实现纯 reducer：禁止 mutating state 的 public fields，所有 phase change 附带 reason/generation。
4. 定义 `FullDesktopPlatform` trait，输入/输出必须是 typed snapshots，不允许裸 HWND 穿过 runtime **Seam**。

**验收：** reducer 测试覆盖 state graph；无 Windows/Tauri 依赖即可运行；非法状态不能被 command 伪造。

## Task 2：实现恢复 journal 与 settings v2（TDD）

**Files：**

- Modify: `runtime/full_desktop/mod.rs`
- Modify: `runtime/settings.rs`
- Add tests: journal/settings modules

**步骤：**

1. 设计 versioned `FullDesktopRecoveryJournal`：owner PID + creation time + launch nonce、window/icon snapshot、mutation checkpoints、mode 与 rollback metadata。
2. 先写原子 write、flush/rename、checkpoint、completed delete、损坏/未知 schema保留 forensic copy 的 RED 测试。
3. 实现 settings v1→v2 迁移，新增 `fullDesktopMode`，保留 v1 的 closeBehavior/cacheRoot 语义。
4. 实现 PID reuse proof helper；只 PID 相同必须拒绝作为同 owner。

**验收：** 首个 native mutation 前 journal 可恢复地落盘；无 journal 时幂等返回，损坏 journal/未知 schema 持续 fail closed；v1 settings 升级不改变 M5 配置。

## Task 3：实现 Windows TauriFullDesktopPlatform（mechanical + contract tests）

**Files：**

- Add: `platform/windows/full_desktop.rs`
- Modify: platform module exports/Cargo Windows feature list

**步骤：**

1. 封装 Progman/WorkerW discovery、Explorer PID/creation-time 验证、DefView/ListView chain validation。
2. 封装 capture/restore main window parent/style/ex-style/placement/visibility 的 typed native snapshot。
3. 实现 passive attach/detach 的 scoped native mutation，不接受 caller-provided HWND。
4. 实现真实 ListView icon visibility 与可逆 layered color-key；保存并验证原 ex-style、layered attributes、background 和 visibility。
5. 统一 PhysicalRect/DPI/monitor conversion；拒绝无 monitor 或 unit 不明的 geometry。

**验收：** 编译与 handle ownership contract 测试通过；候选 host 不唯一、非 Explorer、class chain 不完整均拒绝；不使用 PowerShell/C# helper、注入或 global hook。

## Task 4：实现 FullDesktopRuntime attach/detach（TDD）

**Files：**

- Modify: `runtime/full_desktop/mod.rs`
- Add tests: core runtime module

**步骤：**

1. 基于 fake Adapter + temporary journal 写 RED：首次 mutation 前 journal、attach 成功、attach 中途失败 rollback、double disable、intent serialization。
2. 实现 runtime 的 single-operation gate；`attaching`/`detaching` 中合并最后 requested mode 或返回稳定 busy error。
3. 实现 passive/interactive 切换，确保先 rollback/re-capture 必要 snapshot，再写新的 checkpoint。
4. 实现 icons visible、interaction locked 操作，状态未知时拒绝，rollback 时逆序恢复 native icon state 与主窗口 input routing。
5. 统一结构化 transition/rollback log，且 snapshot API 无副作用。

**验收：** attach 失败后主窗口回普通顶层，journal 仅在完整 rollback 后删除；重复 exit/disable 无重复 native mutation；core runtime 无 Tauri import。

## Task 5：启动前恢复与 auto-resume suppress（TDD）

**Files：**

- Modify: `lib.rs`
- Modify: `app/state.rs`
- Add: `app/full_desktop_runtime.rs`
- Modify: `app/desktop_runtime.rs`
- Add tests: runtime/bootstrap integration

**步骤：**

1. 将 Settings、Journal、Adapter、FullDesktopRuntime 在动态创建 main window 前装配。
2. 写 RED 测试断言：遗留 journal 的 restore 在 main window build 前；成功恢复后设置 `autoResumeSuppressed=true`；本次启动不按 `fullDesktopMode` 自动 attach。
3. 无 journal 且 preference 非 disabled 时，main window ready 后异步、可取消地请求 auto attach；失败保持普通顶层窗口。
4. 不能证明 old owner、journal corrupt、Explorer unavailable 时进入 `recoveryRequired`，不得猜测系统修改。

**验收：** startup ordering 有测试；硬崩溃后的首次启动不自动再次进入 full desktop；首屏不等待 Explorer watcher。

## Task 6：Explorer watcher 与 reconcile（TDD）

**Files：**

- Add: `runtime/full_desktop/reconcile.rs`
- Modify: `runtime/full_desktop/mod.rs`
- Modify: `app/full_desktop_runtime.rs`
- Add tests: reconcile/runtime modules

**步骤：**

1. 写 RED：仅 active phase 启动 watcher、single-flight、fixed minimum interval、generation change、backoff、shutdown cancel。
2. Adapter 轮询已验证 Explorer/host/ListView identity，不扫描文件系统。
3. identity 变化进入 `recovering`，暂停主窗口 interaction，按 journal 尝试 rollback/re-discovery/reattach。
4. reconcile 成功增加 `explorerGeneration` 并 checkpoint journal；失败恢复普通顶层或保留 journal 进入 `recoveryRequired`。
5. watcher 绝不启动 Sidecar、访问 Provider、触发 cache scan 或改变播放。

**验收：** repeated event 不并发 reconcile；Explorer restart/handle failure 的 fake tests fail closed；watcher 有明确 stop/join path。

## Task 7：接入 M5 lifecycle、tray、Escape 与 shutdown（TDD）

**Files：**

- Modify: `app/desktop_runtime.rs`
- Modify: `app/lifecycle.rs`
- Modify: `app/tray.rs`
- Modify: `app/state.rs`
- Add tests: lifecycle/full-desktop integration

**步骤：**

1. 在 M5 exactly-once cleanup 中插入 `app::full_desktop_runtime::recover_before_exit()`，顺序为停止 watcher → native rollback → 再继续 lyrics/Sidecar/tray cleanup。
2. tray 增加 normal-window recovery 和 mode controls；action 不依赖 Web mounted。
3. Escape 在 passive/interactive 时请求 disabled，其他状态保持现有快捷键语义。
4. `show_main_window` 在 full desktop attaching/recovering/recoveryRequired 时先查询 runtime，避免展示为错误 child window。
5. 退出 timeout 后保留 journal 和诊断，不继续未知 mutation。

**验收：** Escape、tray restore、application_exit、RunEvent exit、attach fail 共用 runtime rollback；shutdown 仍 exactly-once；Sidecar/API 行为无改动。

## Task 8：新增 command Adapter 与 diagnostics

**类型：** Wiring；不强制 TDD（contract guard 必须通过）。

**Files：**

- Add: `commands/full_desktop.rs`
- Modify: `commands/mod.rs`
- Modify: command registration in `lib.rs`
- Modify: `commands/diagnostics.rs`
- Modify: `runtime/diagnostics.rs`

**步骤：**

1. 注册五个 additive command；Adapter 只 deserialize、delegate、serialize stable error/state。
2. 扩展 typed diagnostics：phase、requested/effective mode、journal presence/version、auto-resume suppressed、watcher、generation、icon/lock、recent stable failure。
3. snapshot/read command 不得写 journal、启动 watcher、reconcile 或 attach。
4. 运行 command manifest 与 boundary guard。

**验收：** command 层不 import Win32；既有 40 command 契约不变；diagnostics repeat read 不改变 runtime state。

## Task 9：Web Port、controller 和控制面

**类型：** UI/Adapter；不强制 TDD，交互与 stale-state test 必须补齐。

**Files：**

- Add: `ports/full-desktop-runtime-port.ts`
- Add: `adapters/tauri/tauri-full-desktop-runtime.ts`
- Add: `features/desktop/useFullDesktopRuntime.ts`
- Add: `features/desktop/FullDesktopControls.tsx`
- Add tests: hook/component

**步骤：**

1. Web 使用 typed Port，不在 `App.tsx` 直接 invoke。
2. UI 展示 disabled/passive/interactive、icon visibility、software lock、recoveryRequired 和 auto-resume suppressed。
3. mutation 使用 generation/request token，组件卸载后不得写 stale response；busy 时禁用冲突操作。
4. recover action 仅在 native `recoveryRequired` 暴露；不得用 localStorage 假装已恢复。
5. 设置 preference 由 native settings 权威，Web 不写 legacy full-desktop key。

**验收：** 错误、stale response、unmount 与 busy 行为有测试；AppShell 只组合 controller/surface，不吸收 native policy。

## Task 10：升级设置、诊断与 architecture guards

**Files：**

- Modify: `runtime/settings.rs` tests
- Modify: `runtime/diagnostics.rs` tests
- Modify: `scripts/architecture/*`
- Add: `scripts/parity/m6/capture-evidence.mjs`
- Add: `scripts/parity/m6/verify-evidence.mjs`

**步骤：**

1. 固定 runtime-settings v2 JSON fixture，验证原子写和 v1 migration。
2. 增加 journal startup order、command shape、frozen API、no M7/M9 import 的 guards。
3. evidence runner 对机器可验证的凭证完整性 fail closed：缺少 Windows host、时间戳、required case、artifact 或 30 分钟 soak duration 时不生成通过结论；expected/observed state、真实图标点击与 shell context menu 的语义正确性仍由人工复核，不伪装成机器验证。
4. 记录 field cases：multi-DPI/negative monitor、Explorer restart、kill/relaunch recovery、Escape/tray/normal exit、30min soak。

**验收：** automated guards 和 evidence verifier 不会把缺失 required certificate/artifact 的记录误报为通过；field evidence 的行为语义必须另行人工复核。

## Task 11：全量验证与文档收口

**Files：**

- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/parity/upstream-source-map.md`
- Modify: umbrella M6 progress section
- Modify: M6 design/plan status

**步骤：**

1. 依序运行：

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked --offline -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline

bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture scripts/parity/m6
bun run typecheck
bun run web:build
git diff --check
```

2. 运行 M6 API freeze，确认 Sidecar/API/shared/media baseline 零差异。
3. 代码与自动门禁均通过时，将 `desktop.full-mode`、`desktop.native-icons` 标记为 `implemented`，verification 写 `field-validation-pending`，`blocked_by` 为 `none`。
4. 更新 design/plan 为 `Code Complete / Windows Field Validation Pending (non-blocking)`；严格区分它与 `Field Validated / Release Verified`。

**验收：** 文档的 status、matrix、test count、冻结范围一致；没有把 M7/M9 实现或 field evidence 缺失写成 Code Complete blocker。

**实施结果：** 五个 additive command、Rust state/journal/runtime/platform Adapter、动态主窗口前 startup recovery、Explorer watcher/reconcile、真实 ListView 图标层、settings v2、platform snapshot v3、跨重启损坏 journal 阻断、actual-child 只读诊断、Web Port/Adapter/runtime/controls 与 field-certificate completeness runner 均已落地。最终门禁为 Rust `223 passed`、Bun `2093 passed`；Rust fmt、全 target/feature 离线 clippy `-D warnings`、workspace typecheck、Web production build 及相对 `a2e845b` 的 API freeze（含 `bundle.externalBin`）均通过。runner 不判断图标点击/context menu 等行为语义；双屏混合 DPI、Explorer restart、托盘/正常退出和 Windows soak 尚未实测，不影响 Code Complete。

---

## 完成定义

M6 `Code Complete` 要求 Task 0–11 的代码级验收和全量自动门禁完成。下列 Windows field evidence 是后续 `Field Validated / Release Verified` 门槛，**不阻止** M6 Code Complete 或进入 M7：

- 100%+150% 双屏、左侧负坐标 monitor 的 attach/detach 与重启恢复；
- passive/interactive 的真实 ListView 图标点击、显示/隐藏和 software lock；
- Explorer restart、attach interruption、进程 kill 后下次启动 journal recovery；
- Escape、tray restore、normal exit 与至少 30 分钟后台 soak；
- 确认没有 helper process、hidden icon state 或无法恢复的普通主窗口。

任何无法验证的系统状态一律保留 journal 并进入 `recoveryRequired`；不得为了通过 UI 测试而猜测恢复成功。

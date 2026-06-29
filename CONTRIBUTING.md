# Mineradio Tauri Rewrite 贡献指南

感谢参与贡献。本项目仍处于 Tauri 迁移期，最欢迎范围清晰、证据明确、能独立 review 的小 PR。大型重写、视觉系统迁移、provider 接入、updater/installer 发布链路改动，建议先开 issue 或在现有迁移计划下确认范围。

## 贡献方式

你可以从这些方向参与：

- 修 bug：请尽量附复现步骤、期望行为、实际行为、系统环境和相关日志。
- 补测试：优先覆盖 shared schema、sidecar provider、visual-engine lifecycle、React 状态和 Tauri command 边界。
- 改文档：修正过期状态、补充验证步骤、解释迁移 gate，但不要把未验收能力写成已发布。
- 做小功能：先确认它符合 `docs/migration/DECISIONS.md` 和当前 capability gate。
- 做视觉 parity：必须保留 Electron baseline 的质感、节奏、手感和层级，并附截图或录屏说明。

不建议直接提交的改动：

- 大块重写 `public/index.html`。
- 一个 PR 同时修改 provider、视觉、installer、updater 和发布文档。
- 未经计划要求移动 legacy baseline 文件。
- 未完成 license review 就新增依赖。
- 没有证据就声明 parity 或 release gate 已完成。

## 开始之前

1. 阅读 `README.md`，确认当前项目状态。
2. 阅读本文件，确认贡献流程和验证要求。
3. 修改子模块前，阅读对应目录的 `AGENTS.md`：
   - `apps/web/AGENTS.md`
   - `apps/desktop/src-tauri/AGENTS.md`
   - `sidecars/api/AGENTS.md`
   - `packages/visual-engine/AGENTS.md`
4. 涉及迁移、发布或能力状态时，阅读：
   - `docs/migration/DECISIONS.md`
   - `docs/migration/CAPABILITY_PARITY_CHECKLIST.md`
   - `docs/migration/DEFERRED_CAPABILITIES.md`
5. 涉及依赖、provider、license、packaging 或 notices 时，阅读 `docs/migration/LICENSE_GATE.md`。

`public/`、`desktop/` 和 `server.js` 是 Electron baseline 参考，不是新的 Tauri 运行时架构。除非任务明确要求修改 legacy 行为，否则不要把旧实现当成新主线入口。

## 本地开发

需要先安装：

- Bun
- Rust stable toolchain
- 当前系统对应的 Tauri 2 构建环境
- Windows 10/11 + WebView2，用于接近发布质量的运行验证

安装依赖：

```bash
bun install
```

启动 Tauri 开发环境：

```bash
bun run tauri:dev
```

构建前端：

```bash
bun run web:build
```

单独启动 sidecar API：

```bash
bun run sidecar:dev
```

构建桌面应用：

```bash
bun run tauri:build
```

新主线使用 Bun workspace 脚本。不要用旧 Electron 的 `npm start`、`npm run build:win` 或 electron-builder 流程验收 Tauri 工作。

## 工作流

推荐流程：

1. 从当前目标分支拉取最新代码。
2. 为本次改动创建独立分支。
3. 先确认相关 docs、issue 或 migration gate。
4. 小步修改，避免混入无关格式化或重构。
5. 按改动区域运行 focused checks。
6. 更新相关文档或 gate 备注。
7. 提交 PR，并在描述里列出修改范围、验证结果和剩余风险。

如果你在修 bug，PR 里应写清楚复现路径和修复前后的行为差异。如果你在加功能，PR 里应说明为什么需要该功能、它属于哪个迁移阶段，以及是否影响 release gate。

## 代码分区

| 区域 | 路径 | 说明 |
| --- | --- | --- |
| 桌面壳 | `apps/desktop/` | Tauri/Rust 窗口、命令、sidecar 生命周期和 updater |
| 前端界面 | `apps/web/` | React/Zustand app shell 和用户控件 |
| 共享契约 | `packages/shared/` | zod schema 和跨层类型 |
| 视觉引擎 | `packages/visual-engine/` | Canvas/WebGL/GSAP lifecycle 和 parity 逻辑 |
| 本地服务 | `sidecars/api/` | provider adapter、音频代理、诊断和本地 API |
| 迁移文档 | `docs/migration/` | 决策、发布门禁、parity checklist 和计划 |
| Electron baseline | `public/`、`desktop/`、`server.js` | 仅作参考，除非任务明确要求修改 legacy 行为 |

## 验证命令

按你修改的区域运行对应检查。

共享契约：

```bash
bun test packages/shared
bun run --filter ./packages/shared typecheck
```

Sidecar API：

```bash
bun test sidecars/api
bun run --filter ./sidecars/api typecheck
```

视觉引擎：

```bash
bun test packages/visual-engine
bun run --filter ./packages/visual-engine typecheck
```

前端界面：

```bash
bun test apps/web
bun run --filter ./apps/web typecheck
bun run web:build
```

桌面壳：

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
bun run tauri:build
```

仓库基础检查：

```bash
git diff --check
```

如果改动涉及 legacy Electron 参考文件，还需要运行：

```bash
node --check server.js
```

无法运行某项检查时，请在 PR 里说明原因、环境限制和你实际完成的替代验证。

## 策略门禁

改到相关区域时运行对应 policy check：

```bash
bun run tauri-stack-policy:check
bun run app-data-policy:check
bun run sidecar-runtime-policy:check
bun run main-flow-policy:check
bun run release-identity:check
bun run release-csp:check
bun run installer-policy:check
bun run updater-policy:check
bun run release-notes-policy:check
bun run license:check
bun run license-transitive:check
bun run packaged-notices:check
```

如果 policy check 失败，优先修复回退点。只有规则本身确实过时，才应在 PR 中解释原因并更新规则。

## PR 要求

PR 描述应包含：

- 改了什么。
- 为什么要改。
- 涉及哪些路径或模块。
- 运行了哪些测试或检查。
- 有哪些无法自动验证的手动证据。
- 是否更新了 migration gate、license gate 或 deferred capabilities。
- 还剩哪些风险或后续工作。

Review 期间可以保留多个小提交，方便讨论；合并前可以整理成更清晰的提交历史。请保持 PR 聚焦：如果多个改动可以独立 review，就拆成多个 PR。

更容易被接受的 PR 通常具备：

- 改动范围小。
- 测试或验证结果明确。
- 没有无关格式化。
- 文档和 gate 状态同步。
- 没有新增隐私、license 或发布风险。

## 视觉对齐规则

视觉改动必须保持 Electron baseline，除非迁移决策明确要求改变。

- 不要为了性能牺牲玻璃、粒子、歌词、歌单架或控制台质感。
- 不要为了小 UI 改动重写大块视觉系统。
- 不要在没有对比证据时替换 baseline timing 或交互手感。
- 能写测试的 visual-engine lifecycle 逻辑要补 focused test。
- 用户可见的视觉改动需要在 PR 中附截图或录屏说明。

代码完成不等于 release gate 完成。`docs/migration/CAPABILITY_PARITY_CHECKLIST.md` 中的视觉 parity 行仍需要 WebView2 截图、录屏或手动证据。

## Provider 和数据规则

- 不要提交 cookies、tokens、二维码登录载荷、用户账号数据、下载媒体或生成的 app data。
- diagnostics 不得暴露 `MUSIC_U`、`qm_keyst`、`qqmusic_key`、`wxskey` 等 cookie-like 字段。
- provider 响应应通过 shared zod schema 验证。
- 跨 provider fallback 属于 sidecar service 逻辑，不要塞进 React UI 分支。
- 新 provider 依赖必须先完成 license review。
- 不要加入绕过付费、会员、DRM、版权限制或平台条款的能力。

## 依赖规则

新增依赖前：

1. 确认确实需要它。
2. 检查 license 和 transitive risk。
3. 如果进入发布面，更新 `docs/migration/LICENSE_GATE.md`。
4. 运行相关 license check。

不要添加闭源、license 不清晰、无 license 或 GPL-3.0 不兼容的依赖。

## 文档规则

- `README.md` 是项目介绍，不是完整贡献手册。
- 本文件只写贡献流程、验证和协作规则。
- 任务改变 gate 状态或证据时，更新 `docs/migration/CAPABILITY_PARITY_CHECKLIST.md`。
- 能力被隐藏、延期或按决策移除时，更新 `docs/migration/DEFERRED_CAPABILITIES.md`。
- 依赖、provider、packaging 或 notices 变化时，更新 `docs/migration/LICENSE_GATE.md`。
- 没有真实证据时，不要把 unchecked release gate 写成完成。

## 行为和安全

- 技术讨论请聚焦事实、复现、证据和可维护性。
- 不要公开粘贴凭证、cookies、账号信息、私有日志或用户数据。
- 安全、隐私或授权风险不要只在普通 PR 描述里一笔带过；请明确标注风险、影响范围和验证方式。
- 如果某个改动可能影响公开分发、第三方平台条款或 GPL-3.0 合规性，请先在 issue 或 PR 说明里讲清楚。

## 发布相关贡献

普通功能 PR 不应直接发布 release。

发布工作必须遵守当前迁移门禁：

- `docs/migration/CAPABILITY_PARITY_CHECKLIST.md`
- `docs/migration/LICENSE_GATE.md`
- `docs/migration/release-notes-template.md`

公开分发需要 Windows 安装/启动/卸载证据、updater manifest/signature 证据、packaged notices 验证和最终 license review。

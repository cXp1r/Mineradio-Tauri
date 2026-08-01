# 贡献指南

感谢你愿意参与 MineRadio-Tauri。贡献可以是报告问题、补充文档、改进体验、修复 bug、验证安装包或完善测试。为了让维护和审查更顺畅，请尽量让每次提交保持清晰、可复现、可验证。

## 技术栈

MineRadio-Tauri 当前主线技术栈包括：

- Tauri 2、Rust、WebView2
- Bun workspace
- Vite、TypeScript、React、Zustand
- Bun sidecar runtime
- shared types、zod
- Tauri updater

贡献时请根据任务所在模块选择相应工具链，并在 PR 中说明你实际验证过的范围。

## 提交问题

提交 Issue 时，请尽量包含：

- 你遇到的问题或希望改进的地方。
- 期望行为和实际行为。
- 复现步骤。
- 系统版本、应用版本和安装方式。
- 必要的截图、录屏或日志摘要。

请不要在公开 Issue 中粘贴 Cookie、Token、账号信息、私密链接、本地隐私路径或未脱敏日志。

## 提交功能建议

功能建议请说明：

- 使用场景。
- 想解决的问题。
- 你认为理想的交互或结果。
- 是否会影响现有用户习惯、安装包、更新或第三方服务使用。

如果建议比较大，推荐先开 Issue 讨论，再提交实现。

## 本地开发

安装依赖：

```powershell
bun install
```

启动开发环境：

```powershell
bun run dev
```

常用前端和共享包检查：

```powershell
bun run typecheck
bun test
```

常用 Rust 检查：

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

Windows 桌面开发需要准备：

- Bun
- Rust stable
- Tauri 2 CLI
- Windows WebView2 Runtime

不同 workspace 或 package 可能有更具体的脚本。请优先使用当前模块已经声明的脚本；如果脚本名称和上面的示例不同，请在 PR 中写清楚实际运行过的命令。

## 文件和编码

- 所有文本文件使用 UTF-8。
- 修改文件时不要改变原有编码。
- 代码注释使用中文。

## 隐私和安全

请不要提交或上传：

- `.cookie`
- `.qq-cookie`
- `updates/`
- `node_modules/`
- `dist/`
- 安装包或本地构建产物
- 含 Cookie、Token、账号、私密链接或本地隐私路径的日志

如果你发现安全问题，请先避免公开敏感细节。可以提交脱敏后的问题描述，或通过仓库作者主页联系维护者。

## 代码提交

提交 PR 前，请确认：

- 改动范围集中，方便审查。
- 没有混入无关格式化或临时调试代码。
- 用户可见变化已经说明。
- 运行过必要的检查或手动验证。
- 新增依赖有清楚用途，并且许可证适合随项目分发。

PR 描述建议包含：

- 改动摘要。
- 关联 Issue。
- 验证命令和结果。
- 截图、录屏或手动验证说明。
- 可能的风险或后续工作。

推荐标题格式：

```text
docs: update contributor guide
fix: correct playback state handling
feat: add playlist sorting option
chore: refresh release notes
```

## 验证建议

根据改动类型选择合适的验证方式：

- 文档或配置：`git diff --check`。
- TypeScript 代码：运行对应 workspace 的 typecheck 或 test 脚本。
- Rust 代码：运行带 `apps/desktop/src-tauri/Cargo.toml` manifest path 的 `cargo fmt`、`cargo clippy` 或 `cargo test`。
- 运行行为：启动 Tauri 开发环境，并记录复现或验证步骤。
- 安装包：运行构建命令，并验证安装、启动和卸载。
- 视觉或交互：提供前后对照截图或录屏。

如果某些验证暂时无法完成，请在 PR 中说明原因和剩余风险。

## 许可证

本项目原创核心代码采用 GPL-3.0-only 授权。提交贡献即表示你同意你的原创贡献按该许可证分发。修改 Sonic Topography 视觉层时，还必须保留 `THIRD_PARTY_NOTICES.md` 中的 Ajin 署名、来源链、`Non-Commercial Learning License` 和个人非商业告知，并不得把公开合作证据表述为额外书面授权、再许可或许可放宽。

本项目不是网易云音乐、QQ 音乐或腾讯音乐娱乐集团的官方客户端。贡献中不要加入会误导用户的名称、文案、图标或说明。

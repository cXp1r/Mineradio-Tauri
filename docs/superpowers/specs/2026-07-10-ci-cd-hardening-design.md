# CI/CD 加固设计

## 目标

修复当前发布资产可被同版本覆盖、CI 未覆盖 Rust/Tauri、测试访问真实 QQ 服务以及构建工具链漂移的问题，使每个公开 Release 都能唯一对应一个受检 tag 提交。

## 发布不变量

- Release 只能由 `vX.Y.Z` tag 触发，不再允许从普通分支手动发布。
- tag 版本必须同时等于根 `package.json`、桌面 package、Tauri 配置和 Cargo package 版本。
- 发布任务只 checkout 触发 tag，使用固定 Bun、Rust、runner 与 Action commit。
- 发布任务直接调用固定版本 Tauri CLI 构建签名 NSIS，不再把签名密钥交给未固定的第三方发布 Action。
- GitHub CLI 先创建草稿 Release；安装包、 updater 签名和 `latest.json` 验证通过后才公开。
- 同一 tag 的重跑只能基于同一提交，避免源码归档与二进制来源不一致。

## CI 结构

- Linux job 保留 Bun 安装、类型检查、测试和 Web 构建。
- Windows job 执行 Rust format、Clippy、测试和 Cargo lock 校验，覆盖实际桌面目标平台。
- 两个 job 使用固定 Bun 1.3.14；Rust 使用仓库内固定 toolchain。
- QQ session-cookie 路由测试通过依赖注入使用本地 adapter，不访问真实第三方 API。

## 发布校验脚本

新增独立脚本读取四个版本来源并校验 tag。核心逻辑导出为纯函数，使用 Bun 单元测试覆盖：

- 合法且一致的 `v0.1.0`。
- 非语义化 tag。
- tag 与应用版本不一致。
- 各版本文件互相不一致。

## 安全边界

- Checkout 不持久化 GitHub 凭据。
- Checkout、cache 和 setup-bun 固定到完整 commit SHA；发布本身使用 runner 预装的 GitHub CLI。
- updater 私钥仅传入发布步骤。
- Release 先 draft 后公开，资产验证失败时不会成为 latest。

## 不在本次范围

- Windows Authenticode 需要真实代码签名证书和对应 Secrets，当前无法安全生成。
- GitHub Environment 的 required reviewers、tag ruleset 和 immutable releases 属于仓库设置，需要管理员在 GitHub 侧启用。
- 运行时远程模型与远程 JavaScript 的产品供应链调整单独处理。

## 验证

- Bun 全量测试、typecheck、Web build。
- release version guard 单元测试与命令行成功/失败路径。
- `cargo fmt`、`cargo clippy -D warnings`、`cargo test --locked`。
- actionlint 校验 GitHub Actions 语法和表达式。
- `git diff --check` 与最终工作树检查。

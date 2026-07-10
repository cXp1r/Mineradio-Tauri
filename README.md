# MineRadio-Tauri

<p align="center">
  <img src="assets/icons/mine-radio-tauri.svg" width="128" height="128" alt="MineRadio-Tauri icon" />
</p>

MineRadio-Tauri 是一款 Windows 桌面沉浸式音乐播放器，结合天气电台、搜索播放、歌词舞台、粒子视觉和 3D 歌单架，提供更接近现场感的私人音乐空间。

项目主线基于 Tauri 2 构建，前端、桌面能力、本地服务和共享类型分层开发，重点关注轻量桌面体验、视觉表现、播放稳定性和本地隐私。

## 核心特性

- 天气电台：根据位置、城市和天气状态组织播放体验。
- 多源搜索与播放：支持网易云音乐和 QQ 音乐相关能力。
- 歌词舞台：支持歌词同步、视觉层级、样式和播放状态联动。
- 沉浸式视觉：粒子舞台、Canvas/WebGL、GSAP 动画和播放态视觉。
- 3D 歌单架：面向歌单浏览、选择和播放队列的空间化交互。
- 桌面能力：窗口控制、桌面歌词、系统集成和 Windows 体验。
- 本地服务：通过 sidecar 处理 provider、音乐 API、天气、音频代理、缓存和诊断。
- 应用更新：使用 Tauri updater 作为桌面更新机制。

## 技术栈

- Tauri 2、Rust、WebView2
- Bun workspace
- Vite、TypeScript、React、Zustand
- Bun sidecar runtime
- shared types、zod
- Canvas / WebGL / GSAP visual engine
- Tauri updater

## 本地开发

准备环境：

- Windows 10/11
- Windows WebView2 Runtime
- Bun
- Rust stable
- Tauri 2 CLI

安装依赖：

```powershell
bun install
```

启动开发环境：

```powershell
bun run dev
```

构建：

```powershell
bun run build
```

常用检查：

```powershell
bun run typecheck
bun test
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

不同 workspace 或 package 可能有更具体的脚本，请以当前模块声明的脚本为准。

## 项目结构

```text
MineRadio-Tauri/
├─ .github/
│  └─ ISSUE_TEMPLATE/   # Issue 模板
├─ apps/
│  ├─ desktop/          # Tauri 2 桌面应用
│  └─ web/              # Vite + React 前端
├─ assets/
│  └─ icons/            # 应用图标源文件
├─ packages/
│  ├─ shared/           # shared types + zod schemas
│  └─ visual-engine/    # Canvas/WebGL/GSAP 视觉引擎
├─ sidecars/
│  └─ api/              # Bun sidecar 本地服务
└─ README.md
```

## 开发原则

- React 负责界面状态和用户操作，逐帧视觉渲染由 visual engine 管理。
- Rust/Tauri 负责窗口、系统能力、sidecar 生命周期和更新。
- Bun sidecar 负责 provider、音乐 API、天气、音频代理、缓存和诊断。
- shared 包负责跨层类型、zod schema 和 API 契约。
- 用户 Cookie、Token、日志和本地隐私数据不得进入仓库。

## 第三方音乐平台说明

MineRadio-Tauri 不是网易云音乐、QQ 音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。

项目中的第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。项目不会提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。

## 用户数据与隐私

登录 Cookie、搜索历史、自定义封面、自定义歌词、节奏分析缓存和诊断日志等数据应保存在本机应用数据目录或本地存储中。

提交 Issue、PR、日志或截图前，请确认没有包含 Cookie、Token、账号信息、私密链接、本地隐私路径或可识别个人身份的信息。

更多说明见 [PRIVACY.md](./PRIVACY.md)。

## 发布运维

启用或恢复正式发布前，仓库管理员必须完成 [受保护发布流程 GitHub 管理员 Runbook](./docs/release-runbook.md) 中的全部门禁。

## 参与贡献

欢迎提交 Issue、PR、测试反馈和文档改进。开始前请阅读 [贡献指南](./CONTRIBUTING.md)。

## 致谢

MineRadio-Tauri 由 XxHuberrr 主要设计与打造。感谢早期体验、测试反馈和发布准备中提供帮助的朋友们。

## 版权与授权

Copyright (C) 2026 XxHuberrr.

本项目采用 GPL-3.0 授权。详见 [LICENSE](./LICENSE)。

MineRadio-Tauri 名称、界面视觉设计与原创视觉表达归作者所有；第三方依赖和第三方服务分别遵循其各自授权与服务条款。

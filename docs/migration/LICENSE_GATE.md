# License Gate

更新时间：2026-06-28

本项目是 GPL-3.0 二开项目。Tauri 版公开分发前必须通过本 gate。

## 决策

- 二开项目继续采用 GPL-3.0。
- 保留原作者、原项目、GPL、修改说明和 fork 来源。
- 公开分发建议使用新名称、新 logo、新 app id，避免与原 Mineradio 品牌混淆。
- 不允许直接集成 GPL-3.0 不兼容的 QQ 开源项目代码。
- QQ 开源项目可以研究协议和请求方式；复制代码前必须完成 license 审核。
- GSAP 只使用可合法分发的标准能力，不引入会员/闭源插件。
- NeteaseCloudMusicApi 继续保留原 license 和 NOTICE。
- 新增依赖必须进入 license allowlist。

## License Allowlist

允许：

- GPL-3.0-compatible
- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC
- MPL-2.0

禁止：

- 无 license
- 自定义不可分发 license
- 闭源二进制依赖且无明确再分发授权
- GPL-3.0 incompatible license
- 未确认授权的商业插件或会员插件

## Release Checklist

- [ ] 新项目根 license 为 GPL-3.0。
- [x] README 明确二开/fork 来源和修改状态。  — P10.b 已将 README 改为 Tauri 二开迁移主线说明，明确 `zzstar101/Mineradio` 新仓库/updater channel、旧 Electron baseline 仅作参考、不承诺旧用户数据迁移、公开发布前 gate 未完成。
- [ ] NOTICE 或 THIRD_PARTY_NOTICES 列出所有第三方依赖。  — P10.b 已更新 NOTICE 并新增 `THIRD_PARTY_NOTICES.md`，覆盖当前直接 manifest 依赖/关键技术及 gate 状态；仍需补齐 transitive/Rust crates 全量审核、Three.js/GSAP 最终核验和打包包含验证后再勾选。
- [ ] Tauri/Rust crates license 已检查。
- [ ] Bun/npm dependencies license 已检查。
- [ ] NeteaseCloudMusicApi license 已记录。
- [ ] Three.js license 已记录。
- [ ] GSAP 使用范围已确认不含会员/闭源插件。
- [x] QQ provider 参考项目 license 审核完成。  — DECISIONS.md A6 已锁 `jsososo/QQMusicApi` / npm `qq-music-api` 为 GPL-3.0 可接入；`sansenjian/qq-music-api` 因 README 非商业附加条款与 GPL-3.0 冲突不接入。
- [ ] 打包产物包含必要 license/notice 文件。
- [ ] Release notes 不暗示本项目是网易云、QQ 音乐或原 Mineradio 官方版本。

## 发布前未解决项

以下项目均为公开发布硬门槛。它们不是可以跳过的延期能力，也不能只凭代码侧接入记录关闭；必须有审核记录、打包产物证据或明确发布决策后才能勾选 Release Checklist 和 `CAPABILITY_PARITY_CHECKLIST.md` 的 License / Update gate。

- Rust crates full audit：必须基于最终 `Cargo.lock` / Tauri plugin 集合完成全量直接与传递依赖 license 审核，并消除 Dependency Audit 表里的 Rust `待审核`。
- npm transitive full audit：必须基于最终 `bun.lock` / workspace manifests 完成 npm 直接与传递依赖 full audit；当前只记录了关键直接依赖与部分 provider 传递依赖。
- GSAP standard-only final check：必须确认最终打包内容只包含 GSAP 标准能力，不包含 Club/member/闭源插件、私有插件或未授权商业资产。
- Direct dependency allowlist enforcement：`npm run license:check` 会检查 Tauri 迁移目标 workspace manifests 和 `apps/desktop/src-tauri/Cargo.toml` 的直接依赖，要求它们全部进入 Dependency Audit 表且 Decision 不为 `待审核`。该检查不替代 Rust/npm transitive full audit。
- packaged notices inclusion：必须验证 Windows 安装包/安装后目录包含 GPL、原项目/fork notice、`NOTICE.md`、`THIRD_PARTY_NOTICES.md` 及必要第三方 license 文本。
- release notes wording：真实 GitHub Release notes 必须明确本项目是 GPL-3.0 二开/fork/rewrite，不暗示网易云音乐、QQ 音乐或原 Mineradio 官方身份。
- updater signature/release artifact relation：必须在 B2/B3 的最终发布路径下明确 Tauri updater manifest、签名字段、公钥配置、安装包资产和 release 上传资产之间的关系；若继续 detection-only，不得展示可安装更新为已通过 gate，且需在 release notes/UI 中说明。

## QQ 开源项目审核表

| Project | URL | License | Active | Usage | Copy Code? | Risk | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jsososo/QQMusicApi | https://github.com/jsososo/QQMusicApi | GPL-3.0 | 是（1.6k stars） | 依赖（npm 包 `qq-music-api`），接入 search/songUrl/lyric/playlist/loginStatus/logout | 否（依赖调用，不拷代码） | 与本项目同 GPL-3.0，无歧义 | 接入 |
| sansenjian/qq-music-api | https://github.com/sansenjian/qq-music-api | MIT 文件 + README 「不可商业用途」附加 | 是（fork of Rain120） | 评估候选 | 否 | MIT 附加非商业条款与 GPL-3.0 「no further restrictions」冲突，组合作品不可在 GPL-3.0 下分发 | 不接入 |

## Dependency Audit 表

| Dependency | Ecosystem | License | Purpose | Distribution Risk | Decision |
| --- | --- | --- | --- | --- | --- |
| tauri | Rust (crate) | MIT/Apache-2.0 | 桌面壳 + updater + window/sidecar 能力 | 直接依赖 license 已按本地 crate metadata 核对；Rust transitive full audit 仍需发布前完成 | 通过（direct） |
| @tauri-apps/cli | npm devDependency | MIT/Apache-2.0 | Tauri dev/build CLI | 兼容；安装包包含 notices 仍需验证 | 通过 |
| tauri-build | Rust build-dependency | MIT/Apache-2.0 | Tauri build script integration | 直接依赖 license 已按本地 crate metadata 核对；Rust transitive full audit 仍需发布前完成 | 通过（direct） |
| Bun | Runtime | MIT | sidecar runtime/workspace | MIT 兼容 | 通过 |
| Vite | npm | MIT | 前端构建 | MIT 兼容 | 通过 |
| @vitejs/plugin-react | npm | MIT | Vite React transform / Fast Refresh integration | MIT 兼容 | 通过 |
| React | npm | MIT | UI | MIT 兼容 | 通过 |
| react-dom | npm | MIT | UI renderer | MIT 兼容 | 通过 |
| @types/react | npm devDependency | MIT | React TypeScript types | MIT 兼容 | 通过 |
| @types/react-dom | npm devDependency | MIT | React DOM TypeScript types | MIT 兼容 | 通过 |
| Zustand | npm | MIT | 状态管理 | MIT 兼容 | 通过 |
| zod | npm | MIT | schema validation | MIT 兼容 | 通过 |
| @tauri-apps/api | npm | MIT/Apache-2.0 | Tauri 前端 IPC | 兼容 | 通过 |
| TypeScript | npm devDependency | Apache-2.0 | typecheck/build tooling | Apache-2.0 兼容 | 通过 |
| tauri-plugin-dialog | Rust (crate) | MIT/Apache-2.0 | Rust-owned JSON import/export open/save dialogs | 兼容 | 通过 |
| tauri-plugin-global-shortcut 2.3.2 | Rust (crate) | MIT/Apache-2.0 | Tauri 全局热键注册、冲突检测和事件桥接 | 兼容；真实 Windows OS 注册/触发仍需 capability gate 验证 | 通过（code-side 接入） |
| global-hotkey 0.8.0 | Rust (crate, transitive via tauri-plugin-global-shortcut) | MIT/Apache-2.0 | 系统级 hotkey 注册 backend | 兼容；随 Rust crates full audit 复核 | 通过（transitive） |
| tauri-plugin-single-instance | Rust (crate) | MIT/Apache-2.0 | Tauri 单实例注册与二次启动唤醒主窗口 | 直接依赖 license 已按本地 crate metadata 核对；Windows packaged duplicate-launch evidence 另由 capability gate 跟踪 | 通过（direct） |
| tauri-plugin-updater 2.10.0 | Rust (crate) | MIT/Apache-2.0 | Tauri updater 检测和签名校验通道；P10.a 只启用 check，download/install 仍受签名 gate 阻挡 | 兼容；公开安装更新仍需 pubkey/signature 或最终风险决策 | 通过（检测接入） |
| tauri-plugin-fs | Rust (crate, transitive via tauri-plugin-dialog) | MIT/Apache-2.0 | dialog FilePath conversion / scoped filesystem support | 兼容 | 通过（transitive） |
| rfd | Rust (crate, transitive via tauri-plugin-dialog) | MIT | native file dialog backend | 兼容 | 通过（transitive） |
| serde | Rust (crate) | MIT/Apache-2.0 | Rust command/config serialization | 直接依赖 license 已按本地 crate metadata 核对；Rust transitive full audit 仍需发布前完成 | 通过（direct） |
| serde_json | Rust (crate) | MIT/Apache-2.0 | Rust JSON command payloads and config helpers | 直接依赖 license 已按本地 crate metadata 核对；Rust transitive full audit 仍需发布前完成 | 通过（direct） |
| dirs (crate) | Rust (crate) | MIT | app data/log 路径解析 | MIT 兼容 | 通过 |
| time 0.3 | Rust (crate) | MIT/Apache-2.0 | 格式化 Tauri updater `OffsetDateTime` 为 RFC3339 状态字段 | 兼容 | 通过 |
| hana-music-api | npm | MIT | Netease provider（主用） | MIT 兼容；极新 2 stars/v1.1.1，parity 风险见 DECISIONS.md A8 | 通过（带 parity 风险） |
| NeteaseCloudMusicApi | npm | ISC | Netease provider（回退） | ISC 兼容；维护人历史有争议 | 通过（回退路径保留） |
| three | npm | MIT | 3D/WebGL runtime dependency used by visual-engine | MIT 兼容；visual parity and packaged notices still tracked separately | 通过（direct） |
| Three.js | vendor/baseline reference | MIT | Electron baseline `public/vendor` reference for 3D/WebGL behavior | MIT 兼容；legacy baseline artifact notices still need packaged inclusion verification | 通过（baseline reference） |
| @types/three | npm devDependency | MIT | Three.js TypeScript types | MIT 兼容 | 通过 |
| gsap | npm | Standard no-charge license | animation timelines/easing; code imports `gsap` and `gsap/CustomEase` from the standard npm package only | Club/member/闭源插件禁用；direct usage scan found no Club plugin imports, but packaged notices/release wording remain tracked separately | 通过（direct standard package） |
| GSAP | vendor/baseline reference | Standard no-charge license | Electron baseline `public/vendor/gsap.min.js` reference and legacy runtime | Club/member/闭源插件禁用；public release still needs packaged notices inclusion verification | 通过（baseline reference） |
| happy-dom | npm devDependency | MIT | visual-engine DOM-like test environment | MIT 兼容 | 通过 |
| jsososo/qq-music-api（npm `qq-music-api`） | npm | GPL-3.0 | QQ provider | 与本项目同 GPL-3.0，组合作品可分发 | 通过 |
| axios ^0.21.2 | npm [transitive via qq-music-api] | MIT | HTTP 客户端 | MIT 兼容 | 通过（transitive） |
| cheerio ^1.0.0-rc.3 | npm [transitive via qq-music-api] | MIT | HTML 解析 | MIT 兼容 | 通过（transitive） |
| express ~4.16.1 | npm [transitive via qq-music-api] | MIT | HTTP 服务框架（jsososo 服务模式入口；sidecar 仅依赖 `qq.api` 程序式调用，不启动 express server） | MIT 兼容 | 通过（transitive） |
| js-base64 ^2.5.1 | npm [transitive via qq-music-api] | BSD-3-Clause | Base64 编解码 | BSD-3-Clause 兼容 | 通过（transitive） |
| moment ^2.24.0 | npm [transitive via qq-music-api] | MIT | 时间格式化 | MIT 兼容；该项目已 EOL 但仅 jsososo 内用 | 通过（transitive） |
| xml2js ^0.4.22 | npm [transitive via qq-music-api] | MIT | XML 解析（jsososo QQ 部分接口用） | MIT 兼容 | 通过（transitive） |
| jade ~1.11.0 | npm [transitive via qq-music-api] | MIT | 模板引擎（jsososo express 服务模式备用） | MIT 兼容；已弃用但仅作为 transitive；sidecar 不调 express server | 通过（transitive，with EOL note） |
| cookie-parser ~1.4.4 | npm [transitive via qq-music-api] | MIT | express cookie 中间件（transitive） | MIT 兼容 | 通过（transitive） |
| hono | npm (hana 依赖) | MIT | HTTP 框架 | MIT 兼容 | 通过 |
| music-metadata | npm (hana 依赖) | MIT | 音频元数据 | MIT 兼容 | 通过 |
| qrcode | npm (hana 依赖) | MIT/BSD-3-Clause | QR 登录 | 兼容 | 通过 |

## 通过标准

- 所有依赖都有明确 license。
- 所有 license 与 GPL-3.0 分发兼容。
- 所有 notices 可随安装包和源码分发。
- QQ provider 没有引入不兼容代码。
- 无 `待审核` 项后才能发布公开安装包。

# License Gate

更新时间：2026-06-27

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
- [ ] README 明确二开/fork 来源和修改状态。
- [ ] NOTICE 或 THIRD_PARTY_NOTICES 列出所有第三方依赖。
- [ ] Tauri/Rust crates license 已检查。
- [ ] Bun/npm dependencies license 已检查。
- [ ] NeteaseCloudMusicApi license 已记录。
- [ ] Three.js license 已记录。
- [ ] GSAP 使用范围已确认不含会员/闭源插件。
- [ ] QQ provider 参考项目 license 审核完成。
- [ ] 打包产物包含必要 license/notice 文件。
- [ ] Release notes 不暗示本项目是网易云、QQ 音乐或原 Mineradio 官方版本。

## QQ 开源项目审核表

| Project | URL | License | Active | Usage | Copy Code? | Risk | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jsososo/QQMusicApi | https://github.com/jsososo/QQMusicApi | GPL-3.0 | 是（1.6k stars） | 依赖（npm 包 `qq-music-api`），接入 search/songUrl/lyric/playlist/loginStatus/logout | 否（依赖调用，不拷代码） | 与本项目同 GPL-3.0，无歧义 | 接入 |
| sansenjian/qq-music-api | https://github.com/sansenjian/qq-music-api | MIT 文件 + README 「不可商业用途」附加 | 是（fork of Rain120） | 评估候选 | 否 | MIT 附加非商业条款与 GPL-3.0 「no further restrictions」冲突，组合作品不可在 GPL-3.0 下分发 | 不接入 |

## Dependency Audit 表

| Dependency | Ecosystem | License | Purpose | Distribution Risk | Decision |
| --- | --- | --- | --- | --- | --- |
| Tauri 2 | Rust (crate) | MIT/Apache-2.0 | 桌面壳 + updater + window/sidecar 能力 | 待审（Rust crate license 待逐个核对） | 待审核 |
| Bun | Runtime | MIT | sidecar runtime/workspace | MIT 兼容 | 通过 |
| Vite | npm | MIT | 前端构建 | MIT 兼容 | 通过 |
| React | npm | MIT | UI | MIT 兼容 | 通过 |
| Zustand | npm | MIT | 状态管理 | MIT 兼容 | 通过 |
| zod | npm | MIT | schema validation | MIT 兼容 | 通过 |
| @tauri-apps/api | npm | MIT/Apache-2.0 | Tauri 前端 IPC | 兼容 | 通过 |
| tauri-plugin-dialog | Rust (crate) | MIT/Apache-2.0 | Rust-owned JSON import/export open/save dialogs | 兼容 | 通过 |
| tauri-plugin-fs | Rust (crate, transitive via tauri-plugin-dialog) | MIT/Apache-2.0 | dialog FilePath conversion / scoped filesystem support | 兼容 | 通过（transitive） |
| rfd | Rust (crate, transitive via tauri-plugin-dialog) | MIT | native file dialog backend | 兼容 | 通过（transitive） |
| dirs (crate) | Rust (crate) | MIT | app data/log 路径解析 | MIT 兼容 | 通过 |
| hana-music-api | npm | MIT | Netease provider（主用） | MIT 兼容；极新 2 stars/v1.1.1，parity 风险见 DECISIONS.md A8 | 通过（带 parity 风险） |
| NeteaseCloudMusicApi | npm | ISC | Netease provider（回退） | ISC 兼容；维护人历史有争议 | 通过（回退路径保留） |
| Three.js | npm/vendor | MIT | 3D/WebGL | MIT 兼容 | 待审核（引入时再核） |
| GSAP | npm/vendor | 标准功能 MIT/合规模型 | animation | 会员/闭源插件禁用 | 待审核（仅用标准功能） |
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

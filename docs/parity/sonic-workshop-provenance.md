# Sonic Workshop preset 8 来源与处置

## 结论

维护者决定：**迁移该能力，但只允许独立重实现。** 当前独立实现已经完成。

当前不复制或再分发 Electron 2.0.3 的 vendor bundle。

因此当前工程状态是 `independent-implementation-complete`：

- `visual.sonic-workshop` 为 `implemented / P0 / parity`；
- provenance blocker 已转化为实现约束，`blocked_by=none`；
- `packages/visual-engine/src/sonic-workshop` 依据公开可观察行为和本项目自己的 Interface 独立实现，不依赖上游 vendor bundle；
- legacy `visual.fx` numeric preset `8` 继续迁移到 Sonic Topography `7`，避免把旧偏好重新解释为新能力；
- 当前 Workshop preset 8 只通过新的 `visual.workshop.v1` preference schema 与 `sonic-workshop-v1` activation id 恢复。
- 独立 Module 的输入边界、生命周期和 hard budget 固定在 `sonic-workshop-module-design.md`。
- Windows/WebView2 观感及真实 CPU/GPU/frame timing 为 `Field Validation Pending (non-blocking)`，不阻塞代码完成状态。

这是一项工程与维护决策，不是法律结论。

| decision_id | status | source_owner | implementation_target | bundle_policy | legacy_migration | preference_schema | parity_claim | authority_status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonic-workshop-preset-8 | independent-implementation-complete | CmzYa@3747222633 | independent-visual-module | no-vendor-bundle-import-or-redistribution | legacy-8-to-sonic-topography-7 | distinct-workshop-preset-8 | code-implemented-field-validation-pending | active |

## 可核验来源

活动上游固定为：

- repository：`XxHuberrr/Mineradio`
- tag：`v2.0.3`
- peeled commit：`432c713061759e7724eb3e40e77a5e250ac1aa58`

该提交包含：

| artifact | Git blob | bytes | 说明 |
| --- | --- | ---: | --- |
| `public/sonic-workshop-preset.js` | `37f19b6da7cdf7a91109cae7ac9ccfcd860b8c59` | 31,874 | Mineradio iframe bridge 与 preset 8 装配 |
| `public/vendor/sonic-workshop/assets/index-Z-j1MQ-r.js` | `fe888b0b14e6193da3e772ef6b49ab9f6490dbe7` | 1,262,837 | 上游打包后的 Workshop runtime |
| `public/vendor/sonic-workshop/project.json` | `87ab9d5c4da57dc374950608a4bd7e56bf41ba20` | 8,615 | Wallpaper Engine 元数据 |

上游元数据声明：

- `public/js/modules/07-fx/00-preset-archive-data.js` 将“音域回响”作者标为 CmzYa；
- title：音域回响；
- workshop id：`3747222633`；
- visibility：`public`；
- type：`web`。

公开可见或可赞助只说明获取方式，不自动等同于允许复制和再分发 bundle。本仓库不据此推导许可结论。

## 与 Sonic Topography 的边界

维护者提供的公开社交媒体截图中，视觉预设面板同时显示：

- “音域回响 Sonic-Topography / 作者 Ajin”；
- 其右侧“音域回响 Wallpaper Engine / 作者 CmzYa”。

因此该材料支持 Mineradio 原作者在公开发布内容中同时展示、区分并署名两项来源；preset 8 的 CmzYa 归属不是由 Ajin 来源链推断。截图没有显示 Workshop id `3747222633`，也没有出现 preset 8 vendor bundle 的授权范围或允许再分发原文；这些仍分别由上游 `project.json` 元数据和后续持久授权证据承担。

因此禁止：

- 用 Ajin / Yin Yizhen 的 Sonic Topography 来源链覆盖 preset 8；
- 把原作者公开发布 Mineradio、Workshop 页面公开或存在赞助渠道解释为 bundle 再分发许可；
- 从 Electron 上游复制 `public/vendor/sonic-workshop/**` 到 Tauri 发布物；
- 将代码完成状态宣称为已经通过 Windows/WebView2 实机验证、`Field Validated` 或 `Release Verified`。

## 上游声明审计

在固定提交中：

- 根 `LICENSE` 是 GPL-3.0；
- `NOTICE.md` 与 `docs/THIRD_PARTY_PORTS.md` 没有单列 Sonic Workshop/CmzYa/`3747222633`；
- vendor 目录没有独立 LICENSE 或 NOTICE；
- `project.json` 提供作品元数据，但不提供独立软件许可文本。

这些事实不足以确认 vendor bundle 的版权归属或再分发范围，也不否定权利方可能另行授予过许可。当前工程选择不依赖该不确定性。

## 持续实现约束

当前及后续 Workshop Module 必须：

1. 不导入上述 vendor bundle 或其反编译源码；
2. 只以 typed audio frame、媒体元数据和主题 palette 为输入；
3. 不通过 iframe/全局变量重新建立旧全局运行时；
4. 独占自身 WebGL/Three.js 资源并在 dispose 后归零；
5. 为 160×160 音域网格、低频波纹、高频流星、idle wave、主题和媒体卡片建立独立规格与性能预算；
6. 在独立 schema 中保留明确的 preset identity，并持续保留 legacy numeric `8 → 7` migration 测试；
7. 任何未来直接采用第三方 bundle 的方案都必须重新记录 exact bundle identity 与允许使用、修改和再分发的持久证据。

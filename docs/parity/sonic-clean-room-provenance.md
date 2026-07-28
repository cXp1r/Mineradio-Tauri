# Sonic Clean-room Provenance / Non-inclusion 记录

> 状态：未通过。自动 non-inclusion 守卫已通过，但人员隔离、behavior-only 证据链与既有 exposure remediation 未完成，不得把 Sonic 标记为 clean-room passed。

## 当前处置

- 技术实现只能标记为 `partial`；M4 保持 Open / Blocked。
- `node scripts/architecture/sonic-source-isolation.mjs` 与聚焦测试在当前候选 worktree 通过，只证明仓库内没有可识别的外部资产、非白名单依赖或 copied/vendor/reference 标记。
- 现有对话与审计上下文已经包含受限项目的实现级描述，自动守卫、删除文字或补签声明都不能逆转 exposure。
- 解除阻断需要由未接触受限材料的新实施者依据重新冻结的 behavior-only 黑盒证据独立重写，或取得权利方明确授权并完成许可证审查。
- 未实际分发该第三方项目的代码或资产，因此不得把它加入 `THIRD_PARTY_NOTICES`，以免误导用户认为其内容随应用分发。

## 1. 审查范围

| 字段 | 值 |
| --- | --- |
| 审查 commit | `51ec0502fa9b8d7c969bfedf0dc4ae6ca869bdaf` |
| 审查分支 | `codex/m4-visual-parity` |
| 审查日期 | `2026-07-29` |
| Sonic 源码目录 | `packages/visual-engine/src/sonic-topography/` |
| 行为规格版本 | `<文档路径、commit 与 SHA-256>` |
| fixture 版本 | `<文档路径、commit 与 SHA-256>` |
| 实现文件哈希清单 | `<artifact 路径与 SHA-256>` |

审查必须针对不可变 commit。dirty worktree、未跟踪实现或未固定的聊天记录不能作为最终来源隔离证据。

## 2. 允许材料与可观察证据

实现者只允许接触已经冻结的 behavior-only 规格和下表列出的可观察证据。不得把第三方实现、受限 Shader、内部缺陷说明或实现结构描述放入实现上下文。

| 证据 ID | 可观察行为 | 采集方式 | artifact | SHA-256 | 采集者 | 实现者可访问 |
| --- | --- | --- | --- | --- | --- | --- |
| `<OBS-001>` | `<UI 参数、截图、录屏、运行时输出或交互结果>` | `<黑盒步骤>` | `<path>` | `<hash>` | `<name>` | `<yes/no>` |

若某个常量、资源上限或交互规则无法映射到一条可观察证据或公开 interface，则不能作为 clean-room 实现要求。

## 3. 人员与上下文隔离

| 角色 | 姓名/Agent | 可访问材料 | 禁止材料 | 时间范围 | 声明链接 |
| --- | --- | --- | --- | --- | --- |
| 行为观察者 | `<fill>` | `<fill>` | `<fill>` | `<fill>` | `<fill>` |
| 规格整理者 | `<fill>` | `<fill>` | `<fill>` | `<fill>` | `<fill>` |
| 实现者 | `<fill>` | behavior-only 规格、独立 fixture | 第三方源码、Shader、资产及实现级分析 | `<fill>` | `<fill>` |
| 独立审查者 | `<fill>` | 本项目 diff、规格、测试、证据 | 第三方源码、Shader、资产 | `<fill>` | `<fill>` |

## 4. 实现者声明

- [ ] 我只依据第 2 节列出的可观察证据、公开 interface 和独立 fixture 完成实现。
- [ ] 我没有读取、搜索、获取、复制、翻译或派生任何受限第三方 Sonic 源码、Shader、资产或注释。
- [ ] 我没有接收包含第三方实现表达、内部缺陷或逐行结构映射的聊天摘要、补丁或代码片段。
- [ ] 我已列出实施期间使用的全部输入材料，没有未申报来源。

声明人：`<name>`  
声明日期：`<YYYY-MM-DD>`  
签名或可追溯记录：`<link/hash>`

## 5. Non-inclusion 声明

- [ ] 正式源码与构建产物不包含第三方 Sonic 源码、Shader 文本、资产、注释或 vendor 副本。
- [ ] Sonic 目录没有外部 URL、copyright/vendor/reference-source 标记或非白名单文件类型。
- [ ] Sonic 运行时代码仅使用批准的外部依赖；当前白名单为 `three`，测试额外允许 `bun:test`。
- [ ] 没有通过相对路径导入 `.glsl`、`.vert`、`.frag`、图片、模型、音频、Wasm 或其他复制资产。
- [ ] 未使用的研究对象没有被错误列为随应用分发的第三方依赖。

## 6. 既有 exposure 风险

本模板和自动守卫只能补充可审计性，不能消除既有 exposure 风险。它们只能发现仓库中可识别的来源标记、外部依赖和资产，不能证明代码从未被复制，也不能撤销实现者已经接触过的受限材料。

如果任何实现者曾接触第三方源码、Shader、资产、内部缺陷说明或由其提炼出的实现级结构，应将状态保持为未通过。删除相关文档、补写声明或让自动守卫通过，均不能恢复严格 clean-room。后续处置必须是由未接触受限材料的实现者依据重新冻结的 behavior-only 规格独立重写，或取得权利方明确授权并完成许可证审查。

## 7. 可执行守卫与证据

```powershell
node scripts/architecture/sonic-source-isolation.mjs
bun test scripts/architecture/sonic-source-isolation.test.ts --parallel=1
git diff --check -- scripts/architecture docs/parity
```

| 命令 | 结果 | 执行日期 | commit | 日志 artifact / SHA-256 |
| --- | --- | --- | --- | --- |
| `node scripts/architecture/sonic-source-isolation.mjs` | pass（仅 non-inclusion） | `2026-07-29` | `51ec050` | 未归档（本地 console 输出） |
| focused test | 7 pass / 0 fail | `2026-07-29` | `51ec050` | 未归档（本地 Bun test 输出） |

## 8. 独立审查结论

- [ ] 可观察证据到规格的映射完整。
- [ ] 实现者隔离声明可信且可追溯。
- [x] Non-inclusion 检查通过。
- [x] 自动守卫和聚焦测试在审查 commit 上通过。
- [ ] 没有未处置的 exposure 风险。

最终状态：`未通过`
审查者：Codex 自动 non-inclusion 审查；人员隔离审查未满足
结论日期：`2026-07-29`
审查 commit：`51ec0502fa9b8d7c969bfedf0dc4ae6ca869bdaf`

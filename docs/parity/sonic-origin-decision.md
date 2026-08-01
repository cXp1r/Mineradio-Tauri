# Sonic 来源、公开合作证据与维护者决策

> 状态：来源链已确认，维护者已审阅公开合作证据，并据此作出直接迁移的项目决策。该证据尚未在仓库独立归档，不等于书面授权、再许可或对 `Non-Commercial Learning License` 的放宽。M4 仍需等待直接迁移代码复核和新的 release evidence，当前不得标记 complete。

## 1. 来源链

| 层级 | 项目与版本 | 证据 | 用途 |
| --- | --- | --- | --- |
| Mineradio 基线 | `XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224` | `public/sonic-topography-preset.js` 文件头声明视觉算法由 Sonic Topography 1.1.1 移植 | Tauri 版本需要对齐的直接上游实现与 Mineradio 集成行为 |
| 原始视觉项目 | `yin-yizhen/sonic-topography@3ff303e` | Sonic Topography 1.1.1 源码、README 与 LICENSE | 地形、频段、浮空方块、涟漪、流星和轨迹的原始来源 |
| 作者署名 | 音域回响作者 `Ajin` | 用户提供的公开社交媒体截图 | 作者身份与公开项目联动的来源证据 |

不可省略的来源链为：

```text
XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224
  public/sonic-topography-preset.js
    -> yin-yizhen/sonic-topography@3ff303e
       作者：Ajin
       许可证：Non-Commercial Learning License
```

## 2. 公开合作证据

项目维护者已审阅用户提供的公开社交媒体截图。截图中 Mineradio 作者公开说明其与 Sonic Topography / 音域回响作者开展联动，关键原文为：

> 与音域回响作者 Ajin 联动

当前任务附件的证据指纹为：

| 附件 | SHA-256 |
| --- | --- |
| `codex-clipboard-9210add6-200f-4b2e-aa45-fcf4df606899.jpg` | `B7A3D448A3A004F7FB54477244EE38469455BA0FE8441C2EAAA85EBEB2C3DC49` |
| `codex-clipboard-e116c430-88d3-4201-bf54-0268d7f4a88f.jpg` | `950F622E84D47BF650EDE2A33FEEFCB9A7F423141523B29C01E8C3F5A4715839` |

该公开合作证据与 Mineradio 2.0.2 文件头中的移植声明相互印证。基于这组来源证据，维护者作出项目决策：不再采用隔离式行为重建，直接迁移 Mineradio 2.0.2 已集成的 Sonic 实现，并在 Tauri visual-engine seam 内完成适配。

截图仍属于当前任务对话附件，仓库未保存原图，也没有稳定公开帖子 URL。若后续取得稳定 URL 或可长期保存的原始 artifact，应补充 URL、采集日期与 artifact 路径。现有记录足以解释维护者项目决策，但不能作为可独立审计的书面授权证明。

## 3. 许可与分发告知

原始项目使用 `Non-Commercial Learning License`，版权声明为：

```text
Copyright (c) 2026 Sonic Topography contributors
```

其允许学习、研究、个人非商业使用和本地修改，并要求保留版权、许可证与非商业声明。本记录不声称获得额外书面授权、再许可、商业许可或对原许可证的放宽；公开合作证据也不新增复制、再分发或转授权权利。

项目中的 Sonic Topography 衍生视觉层必须：

- 保留 Sonic Topography、Ajin、原始仓库和版本/commit 署名；
- 保留 `Non-Commercial Learning License` 名称及个人非商业限制；
- 在 `THIRD_PARTY_NOTICES.md` 中持续公开来源链和许可正文；
- 明确 Tauri 适配属于修改版本，不把修改后的问题归因于原作者；
- 不把本记录解释为移除、替换或放宽原始许可条件。

## 4. 直接迁移 seam

直接迁移不是把 Electron 全局脚本原样塞入 Web 应用。实施仍须遵守当前架构 seam：

- 视觉逻辑进入 `packages/visual-engine/src/sonic-topography/`；
- React 仅维护设置和 surface，不拥有逐帧循环；
- 复用共享 analyser、scheduler、resource scope、scene、renderer 和 diagnostics；
- 不创建第二个 AudioContext、RAF、renderer 或资源账本；
- 现有 Sidecar/API 行为继续冻结；
- 来源注释、第三方声明和修改说明必须随代码与安装包一起保留。

直接迁移完成后必须重新运行行为、资源、GPU 和截图 evidence。旧技术候选 `51ec050` 的证据可以作为对比基线，但不能替代直接迁移版本的新证据。

## 5. 历史 clean-room 审计

在公开合作证据被纳入维护者决策前，候选实现曾采用 clean-room / non-inclusion 路线，并在 `51ec0502fa9b8d7c969bfedf0dc4ae6ca869bdaf` 上通过旧的 `sonic-source-isolation` 自动检查。该检查只证明当时候选目录没有可识别的外部资产和来源标记。

维护者现已改用直接迁移路线，因此：

- 人员隔离、behavior-only 证据链和 exposure remediation 不再是完成条件；
- 旧 source-isolation 守卫已由 origin-attribution 守卫替代；
- 历史审计结果保留用于解释决策演进，不再作为 M4 blocker；
- M4 当前未完成的原因是直接迁移代码尚待复核、release evidence 尚待重跑，而不是 provenance 未通过。

## 6. 可执行守卫

```powershell
node scripts/architecture/sonic-origin-attribution.mjs
bun test scripts/architecture/sonic-origin-attribution.test.ts --parallel=1
git diff --check -- scripts/architecture docs/parity THIRD_PARTY_NOTICES.md
```

守卫要求来源记录、`THIRD_PARTY_NOTICES.md` 和直接衍生源码同时保留：完整 Mineradio commit、Sonic Topography commit、Ajin、许可证名称、个人非商业限制、公开合作证据、维护者项目决策，以及“不等于书面授权”的限定。缺少任意一项均失败。

## 7. 当前判定

| 项目 | 状态 |
| --- | --- |
| 来源链 | 已确认 |
| Ajin 署名 | 已确认 |
| 公开合作证据 | 维护者已审阅；未在仓库独立归档 |
| 维护者项目决策 | 采用直接迁移 |
| 书面授权或许可放宽 | 未声称已取得 |
| 许可证与非商业告知 | 已记录，必须随分发保留 |
| clean-room blocker | 已撤销，不再作为 M4 blocker |
| 直接迁移代码复核 | 待完成 |
| 直接迁移后的 release evidence | 待完成 |
| M4 | Open / In Progress |


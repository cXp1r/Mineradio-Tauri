# 受保护发布流程 GitHub 管理员 Runbook

本清单是启用受保护发布流程的强制门禁。仓库管理员必须在创建或推送新的 `v*` tag 前完成全部步骤；任一项未完成时，停止发布，不得临时绕过审核、tag 保护或不可变发布设置。

## 前置条件

- 使用拥有仓库管理权限的账号操作。
- 确认受保护发布工作流位于历史中从未出现过的 `.github/workflows/protected-release.yml`，并使用名为 `production-release` 的 environment。
- 指定唯一的 release actor。必须使用专用 GitHub App、机器人账号或受控 release script；该 actor 只能创建严格匹配 `^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$` 且精确指向触发时默认分支 tip 的 tag。
- 从原始安全保管位置取得 Tauri updater 私钥及密码。GitHub 网页、API 和 CLI 都不能读取现有 secret 的值，因此不能把 repository secret 当作迁移来源。

## 0. 永久停用 legacy workflow 并清空在途执行

无论当前 secret 位于哪个作用域，迁移开始时都先停用历史路径 `.github/workflows/release.yml`。该 workflow 必须永久保持 disabled，切换完成后也不得重新启用：

```powershell
gh workflow disable release.yml --repo zzstar101/Mineradio-Tauri
```

取消 legacy Release workflow 中所有 queued、requested、pending、in-progress 和 waiting run，包括正在等待 environment approval 的 deployment：

```powershell
$statuses = @("queued", "requested", "pending", "in_progress", "waiting")
$runIds = @(
  foreach ($status in $statuses) {
    gh run list --repo zzstar101/Mineradio-Tauri --workflow release.yml --status $status --limit 100 --json databaseId --jq '.[].databaseId'
  }
) | Sort-Object -Unique

$runIds | ForEach-Object {
  gh run cancel $_ --repo zzstar101/Mineradio-Tauri
}
```

在 Actions 页面和 **Settings → Environments** 的 deployment 历史中复查。若仍有 waiting deployment，先拒绝该 deployment 或取消对应 run。重复查询，直到上述状态全部为空。迁移期间通知 release actor 不得创建或推送任何 `v*` tag。

## 1. 评估历史私钥暴露并决定是否轮换

在移动 secret 前记录一次历史风险评估，至少包含：

- repository secret 首次创建时间、最后更新时间和可访问它们的历史 workflow。
- 所有引用 `TAURI_SIGNING_PRIVATE_KEY` 或 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 的 workflow、第三方 Action、package lifecycle script 和 shell 命令。
- 历史 Release run 的触发 actor、审批人、runner 类型、日志与 artifact 保留情况。
- 是否使用过 self-hosted runner，是否存在长期 runner、调试日志、未固定第三方 Action 或把 secret 传入宽泛构建步骤的情况。
- 是否有异常 tag、Release、资产替换、未知签名或权限异常事件。

如果不能合理排除私钥被读取或持久化，应执行密钥轮换。Tauri 客户端内置公钥，不能只替换 GitHub 中的私钥：

1. 私钥仍可信时，先用旧密钥发布一个桥接版本，在客户端中更新为新公钥；确认足够多客户端升级后，再用新私钥签后续版本。
2. 旧私钥已不能继续信任时，停止自动 updater，并通过可信的站点、商店或人工分发提供带新公钥的完整安装包，要求用户重新安装。

不要发布“仅替换私钥”的版本；旧客户端会拒绝其签名，更新链将被切断。把评估结论、证据、执行人、日期和轮换方案保存到受控审计记录中，不要把私钥材料写入仓库。

## 2. 建立独立的 `v*` tag 创建规则

1. 打开 **Settings → Rules → Rulesets → New ruleset → New tag ruleset**。
2. 命名为 `release-tag-creators`，enforcement status 设为 **Active**。
3. 目标只包含 include pattern `v*`，不添加排除项。
4. 启用 **Restrict creations**。
5. bypass list 只添加指定 release actor，并限制为创建发布 tag 所需的最小权限；不要添加管理员、日常开发团队或宽泛组织角色。
6. release actor 的实现必须在创建前拒绝非严格 `vX.Y.Z`、前导零版本、非默认分支 tip、版本文件不一致或 `protected-release.yml` 不存在的请求。
7. 保存后用非 release actor 账号验证不能创建测试 `v*` tag。不要为验证而创建真实版本 tag。

该 ruleset 控制“谁能创建新版本”。迁移期间即使 release actor 已列入 bypass，也必须保持人工冻结，不得创建 tag。

## 3. 创建受保护的发布 environment

1. 打开 **Settings → Environments → New environment**。
2. environment 名称精确填写 `production-release` 并创建，暂时不要添加 secret。
3. 当前仓库明确不配置 **Required reviewers**；发布不会等待人工 environment approval，因此 tag 创建 ruleset 必须保持启用且不得放宽。
4. 在 **Deployment branches and tags** 中选择 **Selected branches and tags**。
5. 只新增一条类型为 **Tag**、模式为 `v*` 的规则；不要添加 branch 规则或更宽的 tag 规则。

完成后确认 environment 不含 repository-level secret 副本，并且 deployment policy 只包含唯一的 `v*` tag 规则。

## 4. 删除 repository secrets，再创建 environment secrets

先打开 **Settings → Secrets and variables → Actions → Repository secrets**，删除：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

使用网页或 API 确认两个名称已不在 repository secret 列表中。不要为了“先测试再删除”保留 repository-level copy；只要副本存在，不使用受保护 environment 的 workflow 就可能读取长期签名密钥。

随后从密码管理器或其他受控安全来源，在 **Settings → Environments → production-release → Environment secrets** 中重新录入同名的两个 secret。GitHub 不会显示录入后的值，不能通过 API 或 CLI 比对；若值有误，应让受保护发布失败后重新覆盖 environment secret，不能恢复 repository-level copy。

最后确认两个名称只存在于 `production-release` environment。发布工作流中的 `secrets.TAURI_SIGNING_PRIVATE_KEY` 和 `secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 只会在使用该 environment 且满足 deployment policy 的 job 中解析。

## 5. 建立无绕过的 tag 更新与删除规则

1. 新建第二个 tag ruleset，命名为 `immutable-v-release-tags`，enforcement status 设为 **Active**。
2. 目标只包含 include pattern `v*`，不添加排除项。
3. 启用 **Restrict updates** 和 **Restrict deletions**。
4. bypass list 保持为空；release actor 也不能移动或删除已创建的版本 tag。
5. 不允许管理员绕过。需要处置安全事件时，先冻结发布并按独立的 break-glass 流程审计 ruleset 变更，不能预留日常 bypass actor。

`release-tag-creators` 与 `immutable-v-release-tags` 必须分开：前者只允许指定 actor 创建新 tag，后者对所有 actor 无例外地禁止更新和删除既有 tag。

## 6. 启用 Immutable releases

1. 打开仓库 **Settings → General**。
2. 在 **Releases** 区域启用 **Immutable releases**。
3. 通过页面或 API 确认设置已生效。

Immutable releases 只作用于启用后正式发布的 release，不会追溯转换旧 release。现有 `v0.1.0` 仍为 `immutable: false`，不能原地变成 immutable；不要删除并重建它。必须发布一个高于 `v0.1.0` 的新版本取代其 Latest 位置，并把旧版本记录为遗留风险。

## 7. 推送加固代码并执行首次受保护发布

在以下条件全部满足后，才把加固后的 workflow 推送到默认分支：

- legacy `release.yml` 仍处于 disabled，且所有 legacy run 已清空。
- 所有在途 Release run 和 waiting deployment 已清空。
- 两个 repository secret 已删除。
- `production-release` environment、仅 `v*` 的 deployment policy 和 environment secret 已就绪，且按当前决策不配置 reviewer。
- 两个 tag ruleset 均为 Active。
- Immutable releases 已启用。

推送代码后启用新的受保护 workflow；不要启用 legacy `release.yml`：

```powershell
gh workflow enable protected-release.yml --repo zzstar101/Mineradio-Tauri
gh workflow disable release.yml --repo zzstar101/Mineradio-Tauri
```

准备一个严格高于 `v0.1.0` 且四个版本文件完全一致的新版本。指定 release actor 必须验证 tag 精确指向创建时默认分支 tip，并确认该提交中的 workflow 路径是 `protected-release.yml`；随后才创建并推送 tag。由于不配置 reviewer，workflow 会在 environment deployment policy 允许后继续签名和发布。

## 8. 验证首次不可变发布

设新版本为 `vX.Y.Z`，发布完成后执行：

```powershell
$tag = "vX.Y.Z"

gh api "repos/zzstar101/Mineradio-Tauri/releases/tags/$tag" `
  --jq '{id,tag_name,draft,prerelease,immutable,assets:[.assets[]|{name,size,state,digest}]}'

gh api repos/zzstar101/Mineradio-Tauri/releases/latest `
  --jq '{id,tag_name,draft,prerelease,immutable}'
```

逐项确认：

- [ ] 新 release 的 `immutable` 为 `true`，`draft` 和 `prerelease` 均为 `false`。
- [ ] 权威 `/releases/latest` 返回同一个 release id 和 tag，而不是仅依赖网页排序。
- [ ] 公开资产恰好为安装包 EXE、EXE `.sig`、`latest.json`、`release-provenance.json` 和 `release-provenance.json.sig` 五项。
- [ ] 每项资产 `state=uploaded`、`size>0` 且带 `sha256:` digest。
- [ ] 下载五项资产后，本地 SHA-256 与 REST API 返回的 digest 逐字一致。
- [ ] `release-provenance.json` 中的 repository、tag、commit SHA、文件大小和 SHA-256 与下载资产一致，且 provenance 签名可由应用内置公钥验证。
- [ ] updater endpoint `https://github.com/zzstar101/Mineradio-Tauri/releases/latest/download/latest.json` 返回该新版本；两个 Windows platform 的 URL 精确指向该 tag 的安装包，签名原样等于下载的 `.sig` 文件。
- [ ] 从已安装客户端执行一次更新检查，能够发现新版本并通过签名验证。

## 9. 切换失败时立即重新冻结

如果首次发布、审批、签名、资产校验、Latest 收敛或客户端更新验证任一项失败：

1. 立即 disable `protected-release.yml`，并确认 legacy `release.yml` 仍为 disabled。
2. 取消所有 queued、in-progress 和 waiting run/deployment。
3. 保持两个 tag ruleset 和 Immutable releases 启用；临时移除 `release-tag-creators` 的 bypass actor，冻结新的 `v*` tag 创建。
4. 不移动、不删除失败版本 tag，不覆盖或重建同版本 release；修复代码后使用更高的新版本。
5. 查明失败原因并重新完成本清单，确认安全门禁恢复后才重新添加 release actor、启用 workflow 和创建新 tag。

## 后续变更规则

- deployment policy、ruleset、immutable releases、是否启用 reviewer 或 secret 作用域的任何变更都按发布安全变更审查。
- 每次发布前确认没有新增 bypass actor；若未来启用 reviewer，应保证 reviewer 与 release actor 独立。
- Tauri 密钥轮换必须同时规划客户端公钥迁移，使用桥接版本或可信的 out-of-band 重新安装；禁止只覆盖 environment secret。
- 已发布版本需要修复时创建更高版本 tag，不得移动旧 tag、删除旧 release 或替换旧资产。

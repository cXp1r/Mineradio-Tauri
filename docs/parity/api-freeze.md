# M0/M1 API 行为冻结线

## 目的

M0 与 M1 只改变前端依赖方向和代码所有权，不改变当前 Tauri 与 API 的运行行为。任何触及本文件所列边界的变更必须移出本轮实施，并在独立设计中评审。

## 保持不变的生产路径

```text
React
  → SidecarClient
  → RuntimeConfig.sidecarBaseUrl
  → Bun sidecar HTTP API
  → 当前 Provider adapters
```

本轮继续保留：

- `apps/web/src/api/sidecar-client.ts` 的 `SidecarClient`；
- `sidecars/api/**` 的 Bun sidecar；
- `RuntimeConfig.sidecarBaseUrl`；
- Rust `sidecar.rs` supervisor、health probe、restart 与状态快照；
- Tauri command `get_sidecar_status`；
- `SidecarRecoveryNotice` 及其轮询、恢复提示和中文文案；
- 登录窗口完成后的 Cookie 注入链路；
- `apps/desktop/scripts/build-sidecar-binary.mjs`；
- `build.rs` 中的 sidecar 构建步骤；
- `tauri.conf.json` 中的 `externalBin`；
- 当前 `@mineradio/shared` schema 与 `ApiError` 字段。

## HTTP 契约冻结

下列内容不得在 M0/M1 中变化：

- endpoint path 和 HTTP method；
- query、请求体和默认 limit；
- success/failure envelope；
- Zod 校验和未知字段裁剪语义；
- `code`、`message`、`provider`、`retryable`、`action`、`playbackKeyReady`、`restriction`、`reason`、`qqCode`、`rawMessage`、`tried`；
- audio、image 与 Soda proxy URL；
- ProviderId 集合 `netease | qq | soda`；
- sidecar ready/recovering/stopped/error 的用户可见结果。

## 允许的准备工作

- 定义不包含 transport 细节的 Port；
- 用 legacy adapter 无损委托 `SidecarClient`；
- 将媒体地址作为 opaque URI 传递；
- 提取 React runtime/controller；
- 增加 adapter conformance tests；
- 为未来 `MineRadio-api` adapter 保留装配点。

## 明确排除

- 不增加 `MineRadio-api` Cargo dependency；
- 不把业务 JSON API 切换到 Tauri IPC；
- 不删除第二进程或 localhost HTTP；
- 不增加酷狗、Spotify 或新的 capability；
- 不改变 Cookie/session 持久化；
- 不修改 sidecar 安全模型或新增 localhost 服务。

## 审计命令

```powershell
git diff -- sidecars/api apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json packages/shared
bun test apps/web/src/api/sidecar-client.test.ts sidecars/api
```

第一条在每个 M0/M1 小提交中应为空；第二条必须零失败。

# M9 未来 API 接入准备设计

**状态：** Code Complete / Automated Verification Complete

**基线：** `bbe28a7`（M1–M8 Code Complete）

## 1. 目标

M9 只建立未来 embedded Rust implementation 可替换的真实 Seam，不切换 transport。完成结果固定为：

1. 所有业务 Module 只依赖 Ports；
2. React Runtime、App、Surface 和 visual-engine 不接触 raw `SidecarClient`、`sidecarBaseUrl` 或 Sidecar route；
3. legacy Adapter 的 28 个 Music Interface 方法和媒体/API runtime Interface 有完整 conformance；
4. 当前生产默认仍是 Bun Sidecar，行为和打包完全不变；
5. future Adapter 只需实现同一 Application Ports 与 conformance，不需修改业务 caller。

## 2. 冻结范围

M9 不修改：

- `sidecars/api/**`；
- `packages/shared/**` schema、DTO、ProviderId；
- Sidecar HTTP method、route、默认参数、错误字段与中文文案；
- Soda 相对代理 URL、audio/image URL 字节结果；
- Rust sidecar supervisor、health/restart 行为；
- `build-sidecar-binary.mjs` 与 `tauri.conf.json#bundle.externalBin`；
- Cookie/session 持久化；
- 酷狗、Spotify 与开发中的 `MineRadio-api`。

M9 不增加 Cargo dependency，不新增 Tauri 业务 command，不删除第二进程。

## 3. Application Runtime Port

`ApplicationRuntimePort` 是本里程碑需要深化的 Module。它的 Interface 只有：

```ts
interface ApplicationRuntimePort {
  connect(): Promise<ApplicationPorts | null>;
}
```

`ApplicationPorts` 聚合现有 `MusicServices`、`ApiRuntimePort`、`MediaUrlPort` 与 `DesktopRuntimePort`。`connect()`：

- 成功时发布完整且同代的 Ports；
- transport 不可用时返回 `null`；
- 启动失败不伪造 ready；
- 不向 caller 暴露 config、base URL、PID 或 concrete client。

Legacy Sidecar Adapter 内部负责：读取 `RuntimeConfig`、验证 base URL、创建一次 `SidecarClient`、组装所有 Ports。未来 embedded Adapter 将位于同一 Seam 后面。

删除该 Module 会迫使 App、recovery runtime 和 tests 重新理解 config/client/transport 组装，因此它通过 deletion test，并为 callers 提供真实 Leverage 与 Locality。

## 4. 业务 caller 收口

- Search compact/detail 都接收 `SearchExperiencePort`；App 不再把 structural-compatible raw client 传入。
- Shelf detail loader 分别接收既有 `LibraryPort`、`DiscoverPort` 与 `SearchExperiencePort`；like action 接收 `LikesPort`。不新建全能 Shelf Port。
- `SidecarRecoveryRuntime` 只接收 `ApplicationRuntimePort`，并通过 `ApplicationPorts.apiRuntime` 维持现有 health/status/recovery 时序。
- `AppRuntimeProvider` 与 playback runtime 只消费 `ApplicationPorts`。

## 5. Opaque media source

`MediaUrlPort` 增加 transport-neutral image source：

```ts
interface MediaImageSource {
  uri: string;
  fallbackUri?: string;
}
```

Legacy Adapter 对远端图片返回当前 image-proxy URI 和 direct fallback；data/blob 保持单 URI；非法输入保持空 URI。Visual Host：

- album CSS 继续用 direct URL；
- WebGL current cover 与 Shelf covers 使用 Media URL Port；
- 只把 opaque URI 传给 visual-engine。

visual-engine 接收 primary/fallback URI，不识别 `/image-proxy`，不解析 query。加载顺序保持：primary Image → primary fetch/blob → explicit fallback Image。这样保留当前降级行为，同时 future custom protocol 不需要伪装成 Sidecar route。

## 6. Conformance 与 architecture guards

核心 TDD 只覆盖：

- Application Runtime connect 的 exactly-once client/Port publication 和不可用语义；
- 28 个 Music 方法 exactly-once、参数顺序、默认值、返回 identity 与 error identity；
- legacy media URI 字节 parity、显式 fallback、opaque visual loading；
- health/capability/login/library bootstrap 时序不变。

架构守卫固定：

- concrete `SidecarClient` 只允许在 `api/**`、`adapters/sidecar/**`；
- App/features/components/visual/ports 禁止 `SidecarClient`、`sidecarBaseUrl`；
- visual-engine 和 Web visual Module 禁止 Sidecar proxy route/query 解析；
- `MediaUrlPort` image source 必须有生产 consumer；
- M9 freeze targets 必须无 diff。

## 7. 完成与不可宣称项

M9 Code Complete 只表示业务 caller 与当前 Sidecar implementation 之间已有可替换 Seam。不得宣称：

- Rust `mineradio-api` 已嵌入；
- 已变为单进程或单二进制；
- localhost HTTP、supervisor 或 `externalBin` 已移除；
- 酷狗/Spotify 已完成；
- embedded Adapter、媒体网关或进程树性能已经验证。

## 8. 实施收口（2026-07-30）

- `ApplicationRuntimePort` 与聚合 `ApplicationPorts` 已落地；Legacy Sidecar Adapter 独占 `RuntimeConfig`、`SidecarClient` 创建与同代 Ports 组装。
- App、`SidecarRecoveryRuntime`、Search、Shelf 与 Visual caller 已只依赖 Ports，不再持有 raw `SidecarClient` 或 `sidecarBaseUrl`；health → capability → login restore → library refresh 与 recovery polling 顺序保持不变。
- Legacy `MusicServices` 已完成 28/28 方法的 exactly-once、参数顺序、默认值、返回 identity 与 error identity conformance，并会枚举实际 leaf Interface 防止未来新增方法静默漏测；API Runtime 与 Media URL Adapter 也完成委托、地址隐藏及 URI 字节兼容验证。
- `MediaImageSource` 已提供 opaque `uri` 与可选 `fallbackUri`。当前 WebGL 封面贯穿 primary/fallback，Shelf 只消费 opaque primary URI；visual-engine 不再识别 `/image-proxy` 或解析 query，CSS album background 仍使用 direct URL。
- M9 architecture guard 已确认 concrete Sidecar transport 隔离、image source 存在生产 consumer，并以 M8 Git 对象冻结 Sidecar API、shared contracts、Rust supervisor、Cargo、sidecar build 与 `externalBin`。
- 当前默认实现仍为 Bun Sidecar；未增加 Rust API dependency、Tauri 业务 command，也未移除 localhost、supervisor、第二进程或第二二进制。

最终自动门禁：Bun `2263 passed / 0 failed`（`10788` assertions），Rust 主 crate `292 passed / 0 failed`，Updater signature example `7 passed / 0 failed`；根 typecheck、Web production build、deterministic performance budget、`cargo fmt --check`、`cargo clippy -D warnings` 与 `git diff --check` 全部通过。

## 9. 后续嵌入前置

- 当前生产不热切换 `ApplicationRuntimePort`。未来做 legacy → embedded Adapter rollout 前，必须定义 generation 换代语义，并覆盖 A → B(null/error) 时旧 Ports 与旧 status poll 的清理。
- `ApplicationPorts.desktop` 依照本次批准设计保留，但 App 仍使用独立 `desktopRuntime`；后续嵌入设计必须选择真正消费它，或把 Desktop Port 移出该聚合。
- M9 freeze guard 的 Git 对象哈希是里程碑锁，不是永久 Interface invariant；M10 首次合法修改 Sidecar/shared/packaging 时必须显式退役或更新。

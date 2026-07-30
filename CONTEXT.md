# MineRadio domain context

## M9 runtime language

- **Application Ports**：Web 应用运行所需的一组稳定 Interface，包含 Music、API Runtime、Media URI 与 Desktop Ports；业务 Module 只能通过这些 Interface 调用外部能力。
- **Application Runtime Port**：启动 Application Ports 的单一 Seam。caller 只知道 `connect()` 的成功、不可用与失败语义，不知道 Sidecar、localhost、Tauri IPC 或未来 embedded Rust implementation。
- **Legacy Sidecar Adapter**：当前生产 Adapter。它独占 `RuntimeConfig.sidecarBaseUrl`、`SidecarClient` 创建和 Bun Sidecar transport 组装，并向 Application Runtime Port 发布 Application Ports。
- **Opaque media source**：由 Media URL Port 产生的媒体 URI 与可选 fallback URI。业务和 visual-engine 只负责传递或加载，不解析 host、route 或 query。

## Invariants

- M9 不引入或切换开发中的 `MineRadio-api`。
- Bun Sidecar route、DTO、Provider、错误字段、媒体 URL 字节结果和 `bundle.externalBin` 保持冻结。
- CSS 封面继续使用 direct URL；WebGL 封面优先使用 legacy image proxy，并保留 direct fallback。
- `SidecarClient` 只能存在于 API implementation 和 legacy Sidecar Adapter 中。

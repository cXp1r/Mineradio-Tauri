import type { ApplicationPorts } from "../ports/application-runtime-port";

// 兼容现有 feature/runtime 命名；具体 transport 组装由 Application Runtime Adapter 独占。
export type AppServices = ApplicationPorts;
export type { ApplicationPorts };

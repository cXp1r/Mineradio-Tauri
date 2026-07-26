import type {
	CapabilityMatrix,
	HealthResponse,
} from "@mineradio/shared";

export interface ApiRuntimeConfig {
	appDataDir: string;
	appVersion: string;
	schemaVersion: string;
	updaterPublicKeyConfigured: boolean;
}

export type ApiRuntimePhase = "starting" | "ready" | "recovering" | "stopped" | "error";

export interface ApiRuntimeStatus {
	phase: ApiRuntimePhase;
	pid: number | null;
	restarts: number;
	lastError: string | null;
	lastHealthOkMs: number | null;
	providers: string[];
	logPath: string;
}

export interface ApiRuntimePort {
	getConfig(): Promise<ApiRuntimeConfig>;
	getStatus(): Promise<ApiRuntimeStatus>;
	health(): Promise<HealthResponse>;
	capabilities(): Promise<CapabilityMatrix>;
}

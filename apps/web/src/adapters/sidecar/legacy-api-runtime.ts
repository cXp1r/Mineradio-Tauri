import type { SidecarClient } from "../../api/sidecar-client";
import type { ApiRuntimePort } from "../../ports/api-runtime-port";
import {
	getRuntimeConfig,
	getSidecarStatus,
} from "../../tauri/runtime";

export interface LegacyApiRuntimeDependencies {
	getRuntimeConfig: typeof getRuntimeConfig;
	getSidecarStatus: typeof getSidecarStatus;
}

const defaultDependencies: LegacyApiRuntimeDependencies = {
	getRuntimeConfig,
	getSidecarStatus,
};

export function createLegacyApiRuntime(
	client: Pick<SidecarClient, "health" | "capabilities">,
	dependencies: LegacyApiRuntimeDependencies = defaultDependencies,
): ApiRuntimePort {
	return {
		async getConfig() {
			const config = await dependencies.getRuntimeConfig();
			return {
				appDataDir: config.appDataDir,
				appVersion: config.appVersion,
				schemaVersion: config.schemaVersion,
				updaterPublicKeyConfigured: config.updaterPublicKeyConfigured,
			};
		},
		async getStatus() {
			const status = await dependencies.getSidecarStatus();
			return {
				phase: status.phase,
				pid: status.pid,
				restarts: status.restarts,
				lastError: status.lastError,
				lastHealthOkMs: status.lastHealthOkMs,
				providers: status.providers,
				logPath: status.logPath,
			};
		},
		health: () => client.health(),
		capabilities: () => client.capabilities(),
	};
}

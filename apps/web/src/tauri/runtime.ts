export interface RuntimeConfig {
	sidecarBaseUrl: string;
	appDataDir: string;
	appVersion: string;
	schemaVersion: string;
}

export type Unlisten = () => void;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ExportJsonFileResult {
	cancelled: boolean;
	path: string | null;
}

export interface ImportJsonFileResult {
	cancelled: boolean;
	path: string | null;
	data: JsonValue | null;
}

interface RawRuntimeConfig {
	sidecar_base_url: string;
	app_data_dir: string;
	app_version: string;
	schema_version: string;
}

export function isTauriRuntime(): boolean {
	if (typeof window === "undefined") return false;
	return (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
}

export async function invokeTauriCommand<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
	if (!isTauriRuntime()) {
		return null;
	}
	const mod = await import("@tauri-apps/api/core");
	const invoke = mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<T>;
	return invoke(cmd, args);
}

export async function listenTauriEvent<T = unknown>(
	eventName: string,
	handler: (payload: T) => void
): Promise<Unlisten> {
	if (!isTauriRuntime()) {
		return () => {};
	}
	const mod = await import("@tauri-apps/api/event");
	const listen = mod.listen as (
		eventName: string,
		handler: (event: { payload: T }) => void
	) => Promise<Unlisten>;
	return listen(eventName, (event) => handler(event.payload));
}

function placeholderRuntimeConfig(): RuntimeConfig {
	return {
		sidecarBaseUrl: "",
		appDataDir: "",
		appVersion: "0.0.0-dev",
		schemaVersion: "0.1.0",
	};
}

function cancelledExportJsonResult(): ExportJsonFileResult {
	return {
		cancelled: true,
		path: null,
	};
}

function cancelledImportJsonResult(): ImportJsonFileResult {
	return {
		cancelled: true,
		path: null,
		data: null,
	};
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
	if (!isTauriRuntime()) {
		return placeholderRuntimeConfig();
	}
	try {
		const raw = await invokeTauriCommand<RawRuntimeConfig>("get_runtime_config");
		if (!raw) {
			return placeholderRuntimeConfig();
		}
		return {
			sidecarBaseUrl: raw.sidecar_base_url,
			appDataDir: raw.app_data_dir,
			appVersion: raw.app_version,
			schemaVersion: raw.schema_version,
		};
	} catch {
		return placeholderRuntimeConfig();
	}
}

export async function exportJsonFile(fileName: string, data: JsonValue): Promise<ExportJsonFileResult> {
	if (!isTauriRuntime()) {
		return cancelledExportJsonResult();
	}
	const result = await invokeTauriCommand<ExportJsonFileResult>("export_json_file", { fileName, data });
	return result ?? cancelledExportJsonResult();
}

export async function importJsonFile(): Promise<ImportJsonFileResult> {
	if (!isTauriRuntime()) {
		return cancelledImportJsonResult();
	}
	const result = await invokeTauriCommand<ImportJsonFileResult>("import_json_file");
	return result ?? cancelledImportJsonResult();
}

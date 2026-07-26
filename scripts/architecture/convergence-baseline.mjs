import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CAPABILITY_HEADER = "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |";
const EXTRACTION_HEADER = "| symbol | kind | purity | current_side_effects | target_module | evidence | migration_order |";
const ELECTRON_BASELINE = "4abaa190de42c632365ae4244e041bad16443224";
const API_FREEZE_MARKERS = [
	"SidecarClient",
	"Bun sidecar",
	"RuntimeConfig.sidecarBaseUrl",
	"get_sidecar_status",
	"SidecarRecoveryNotice",
	"apps/desktop/scripts/build-sidecar-binary.mjs",
	"externalBin",
	"ApiError",
];

export function validateConvergenceBaseline(documents) {
	const errors = [];
	if (!documents.capabilityMatrix.includes(CAPABILITY_HEADER)) {
		errors.push("capability-matrix: missing required header");
	}
	if (!documents.upstreamSourceMap.includes(ELECTRON_BASELINE)) {
		errors.push(`upstream-source-map: missing Electron baseline ${ELECTRON_BASELINE}`);
	}
	if (!documents.appExtractionMap.includes(EXTRACTION_HEADER)) {
		errors.push("app-extraction-map: missing required header");
	}
	for (const marker of API_FREEZE_MARKERS) {
		if (!documents.apiFreeze.includes(marker)) {
			errors.push(`api-freeze: missing ${marker}`);
		}
	}
	if (typeof documents.appSource === "string") {
		for (const symbol of extractTopLevelSymbols(documents.appSource)) {
			if (!documents.appExtractionMap.includes(`\`${symbol}\``)) {
				errors.push(`app-extraction-map: missing symbol ${symbol}`);
			}
		}
	}
	return errors;
}

export function extractTopLevelSymbols(source) {
	const symbols = new Set();
	const declaration = /^(?:export\s+)?(?:const|type|interface|function)\s+([A-Za-z_$][\w$]*)/gm;
	for (const match of source.matchAll(declaration)) {
		symbols.add(match[1]);
	}
	return [...symbols];
}

export async function runConvergenceBaselineCli(repositoryRoot) {
	const paths = {
		capabilityMatrix: "docs/parity/capability-matrix.md",
		upstreamSourceMap: "docs/parity/upstream-source-map.md",
		appExtractionMap: "docs/parity/app-extraction-map.md",
		apiFreeze: "docs/parity/api-freeze.md",
	};
	const documents = {};
	for (const [key, relativePath] of Object.entries(paths)) {
		documents[key] = await readFile(resolve(repositoryRoot, relativePath), "utf8");
	}
	documents.appSource = await readFile(resolve(repositoryRoot, "apps/web/src/app/App.tsx"), "utf8");
	const errors = validateConvergenceBaseline(documents);
	if (errors.length > 0) return { errors, paths: Object.values(paths) };
	return { errors: [], paths: Object.values(paths) };
}

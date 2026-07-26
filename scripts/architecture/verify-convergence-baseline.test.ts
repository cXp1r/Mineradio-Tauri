import { expect, test } from "bun:test";
import {
	extractTopLevelSymbols,
	validateConvergenceBaseline,
} from "./convergence-baseline.mjs";

const validDocuments = {
	capabilityMatrix: "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	upstreamSourceMap: "Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`",
	appExtractionMap: "| symbol | kind | purity | current_side_effects | target_module | evidence | migration_order |\n| --- | --- | --- | --- | --- | --- | --- | --- |",
	apiFreeze: [
		"SidecarClient",
		"Bun sidecar",
		"RuntimeConfig.sidecarBaseUrl",
		"get_sidecar_status",
		"SidecarRecoveryNotice",
		"apps/desktop/scripts/build-sidecar-binary.mjs",
		"externalBin",
		"ApiError",
	].join("\n"),
};

test("M0 baseline accepts the complete frozen contract", () => {
	expect(validateConvergenceBaseline(validDocuments)).toEqual([]);
});

test("M0 baseline reports missing API freeze markers", () => {
	expect(validateConvergenceBaseline({ ...validDocuments, apiFreeze: "SidecarClient" }))
		.toContain("api-freeze: missing Bun sidecar");
});

test("M0 baseline extracts and verifies App top-level symbols", () => {
	const appSource = [
		"const FIRST = 1;",
		"export interface ExampleInput {}",
		"export function createExample() {}",
	].join("\n");
	expect(extractTopLevelSymbols(appSource)).toEqual([
		"FIRST",
		"ExampleInput",
		"createExample",
	]);
	expect(validateConvergenceBaseline({
		...validDocuments,
		appSource,
		appExtractionMap: `${validDocuments.appExtractionMap}\n\`FIRST\`\n\`ExampleInput\``,
	})).toContain("app-extraction-map: missing symbol createExample");
});

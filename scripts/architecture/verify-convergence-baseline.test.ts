import { expect, test } from "bun:test";
import {
	extractTopLevelSymbols,
	validateConvergenceBaseline,
} from "./convergence-baseline.mjs";

const legacyCapabilityHeader = "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |";
const expandedCapabilityHeader = "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | convergence_mode | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |";
const capabilityRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
const legacyCapabilityDelimiter = capabilityRow(Array(13).fill("---"));
const expandedCapabilityDelimiter = capabilityRow(Array(14).fill("---"));
const legacyCapabilityRow = capabilityRow([
	"app.example", "app", "upstream", "target", "baseline", "P0", "app",
	"none", "none", "tests", "none", "none", "bounded",
]);
const expandedCapabilityRow = capabilityRow([
	"app.example", "app", "upstream", "target", "baseline", "P0", "parity",
	"app", "none", "none", "tests", "none", "none", "bounded",
]);

const validDocuments = {
	capabilityMatrix: [
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
	].join("\n"),
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

const expandedCapabilityMatrix = [
	expandedCapabilityHeader,
	expandedCapabilityDelimiter,
	expandedCapabilityRow,
].join("\n");

test("M0 baseline accepts the complete frozen contract", () => {
	expect(validateConvergenceBaseline(validDocuments)).toEqual([]);
});

test("convergence guard accepts the expanded capability matrix schema", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: expandedCapabilityMatrix,
	})).toEqual([]);
});

test("convergence guard identifies capability headers by parsed column names", () => {
	const compactHeader = legacyCapabilityHeader.replaceAll(" | ", "|");
	const capabilityMatrix = [
		compactHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toEqual([]);
});

test("convergence guard reports capability rows with the wrong column count", () => {
	const capabilityMatrix = `${validDocuments.capabilityMatrix}\n| visual.example | visual | incomplete |`;
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain('capability-matrix: line 4 capability "visual.example" has 3 columns; expected 13');
});

test("convergence guard reports malformed capability headers by line", () => {
	const capabilityMatrix = "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by |";
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 1 has 12 columns; expected 13 or 14");
});

test("convergence guard reports unsupported capability columns by header line", () => {
	const capabilityMatrix = legacyCapabilityHeader.replace("target_module", "unexpected_target");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 1 has unsupported columns");
});

test("convergence guard rejects arbitrary columns appended to the legacy schema", () => {
	const unsupportedHeader = legacyCapabilityHeader.replace(
		"performance_budget |",
		"performance_budget | unexpected |",
	);
	const capabilityMatrix = [
		unsupportedHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 1 has unsupported columns");
});

test("convergence guard rejects capability delimiters with the wrong width", () => {
	const [header] = validDocuments.capabilityMatrix.split("\n");
	const capabilityMatrix = `${header}\n| --- |`;
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: delimiter line 2 has 1 columns; expected 13");
});

test("convergence guard reports empty capability identifiers by line", () => {
	const emptyCapabilityRow = legacyCapabilityRow.replace("app.example", "   ");
	const capabilityMatrix = [
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		emptyCapabilityRow,
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 3 has empty capability_id");
});

test("convergence guard reports duplicate capability identifiers with both lines", () => {
	const capabilityMatrix = [
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
		legacyCapabilityRow,
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain('capability-matrix: line 4 capability "app.example" duplicates line 3');
});

test("convergence guard ignores capability tables inside fenced examples", () => {
	const capabilityMatrix = [
		"```md",
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
		"```",
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: missing required header");
});

test("convergence guard ignores capability tables inside HTML comments", () => {
	const capabilityMatrix = [
		"<!--",
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
		"-->",
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: missing required header");
});

test("convergence guard treats escaped pipes as capability cell content", () => {
	const escapedPipeRow = legacyCapabilityRow.replace("upstream", "upstream \\| source");
	const capabilityMatrix = [
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		escapedPipeRow,
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toEqual([]);
});

test("convergence guard reports capability rows missing the closing pipe", () => {
	const malformedCapabilityRow = legacyCapabilityRow.slice(0, -1);
	const capabilityMatrix = [
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		malformedCapabilityRow,
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 3 is malformed");
});

test("convergence guard reports non-canonical rows without outer pipes", () => {
	const malformedCapabilityRow = legacyCapabilityRow.slice(1, -1).trim();
	const capabilityMatrix = [
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		malformedCapabilityRow,
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 3 is malformed");
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

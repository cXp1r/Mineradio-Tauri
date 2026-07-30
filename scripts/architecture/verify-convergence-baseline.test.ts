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
const activeUpstreamIdentity = [
	"| baseline_role | repository | tag | peeled_commit | tree | package_version |",
	"| --- | --- | --- | --- | --- | --- |",
	"| active | XxHuberrr/Mineradio | v2.0.3 | 432c713061759e7724eb3e40e77a5e250ac1aa58 | 6c425be30784088169f761edbbf28f9c476f7d3a | 2.0.3 |",
].join("\n");
const upstreamReleaseProvenance = [
	"| provenance_role | ref | object_id | resolved_commit | tree | package_version |",
	"| --- | --- | --- | --- | --- | --- |",
	"| release_tag | refs/tags/v2.0.3 | 631813e4baaea1c2115182050be736b6491097e5 | 432c713061759e7724eb3e40e77a5e250ac1aa58 | 6c425be30784088169f761edbbf28f9c476f7d3a | 2.0.3 |",
	"| release_branch | refs/heads/release/2.0.3 | 7974c52270c628d7ddb7427eaa0269e024cc0d3f | 7974c52270c628d7ddb7427eaa0269e024cc0d3f | 6c425be30784088169f761edbbf28f9c476f7d3a | 2.0.3 |",
].join("\n");
const withActiveUpstreamIdentity = (body: string) => `${activeUpstreamIdentity}\n\n${body}`;

const validDocuments = {
	capabilityMatrix: withActiveUpstreamIdentity([
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
	].join("\n")),
	upstreamSourceMap: `${activeUpstreamIdentity}\n\n${upstreamReleaseProvenance}`,
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

const expandedCapabilityMatrix = withActiveUpstreamIdentity([
	expandedCapabilityHeader,
	expandedCapabilityDelimiter,
	expandedCapabilityRow,
].join("\n"));

test("M0 baseline accepts the active Mineradio v2.0.3 release identity", () => {
	expect(validateConvergenceBaseline(validDocuments)).toEqual([]);
});

test("M0 baseline rejects the legacy Mineradio v2.0.2 active identity", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: [
			legacyCapabilityHeader,
			legacyCapabilityDelimiter,
			legacyCapabilityRow,
		].join("\n"),
		upstreamSourceMap: "Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`",
	})).toContain("capability-matrix: missing active upstream identity");
});

test("M0 baseline rejects a release branch commit used as the active identity", () => {
	const branchCommit = "7974c52270c628d7ddb7427eaa0269e024cc0d3f";
	const mismatchedIdentity = activeUpstreamIdentity.replace(
		"432c713061759e7724eb3e40e77a5e250ac1aa58",
		branchCommit,
	);
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			activeUpstreamIdentity,
			mismatchedIdentity,
		),
		upstreamSourceMap: `${mismatchedIdentity}\n\n${upstreamReleaseProvenance}`,
	});
	expect(errors).toContain(
		`capability-matrix: active upstream identity line 3 field peeled_commit must be 432c713061759e7724eb3e40e77a5e250ac1aa58; received ${branchCommit}`,
	);
	expect(errors).toContain(
		`upstream-source-map: active upstream identity line 3 field peeled_commit must be 432c713061759e7724eb3e40e77a5e250ac1aa58; received ${branchCommit}`,
	);
});

test("M0 baseline requires tag and release branch provenance", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		upstreamSourceMap: activeUpstreamIdentity,
	})).toContain("upstream-source-map: missing release provenance");
});

test("M0 baseline rejects duplicate release provenance tables", () => {
	const duplicateProvenance = upstreamReleaseProvenance.replace(
		"631813e4baaea1c2115182050be736b6491097e5",
		"1111111111111111111111111111111111111111",
	);
	expect(validateConvergenceBaseline({
		...validDocuments,
		upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n\n${duplicateProvenance}`,
	})).toContain("upstream-source-map: duplicate release provenance headers at lines 5, 10");
});

test("M0 baseline rejects legacy active markers beside the v2.0.3 identity", () => {
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: `${validDocuments.capabilityMatrix}\n\n上游行为基线：\`XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224\`。`,
		upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n\nElectron baseline: \`4abaa190de42c632365ae4244e041bad16443224\``,
	});
	expect(errors).toContain("capability-matrix: legacy Mineradio v2.0.2 active baseline marker remains");
	expect(errors).toContain("upstream-source-map: legacy Mineradio v2.0.2 active baseline marker remains");
});

test("M0 baseline allows legacy active marker text inside fenced history", () => {
	const capabilityHistory = [
		"```md",
		"上游行为基线：`XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224`。",
		"```",
	].join("\n");
	const sourceMapHistory = [
		"```md",
		"Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`",
		"```",
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: `${validDocuments.capabilityMatrix}\n\n${capabilityHistory}`,
		upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n\n${sourceMapHistory}`,
	})).toEqual([]);
});

test("convergence guard accepts the expanded capability matrix schema", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: expandedCapabilityMatrix,
	})).toEqual([]);
});

test("convergence guard identifies capability headers by parsed column names", () => {
	const compactHeader = legacyCapabilityHeader.replaceAll(" | ", "|");
	const capabilityMatrix = withActiveUpstreamIdentity([
		compactHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
	].join("\n"));
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
	})).toContain('capability-matrix: line 8 capability "visual.example" has 3 columns; expected 13');
});

test("convergence guard reports malformed capability headers by line", () => {
	const capabilityMatrix = withActiveUpstreamIdentity("| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by |");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has 12 columns; expected 13 or 14");
});

test("convergence guard reports unsupported capability columns by header line", () => {
	const capabilityMatrix = withActiveUpstreamIdentity(
		legacyCapabilityHeader.replace("target_module", "unexpected_target"),
	);
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has unsupported columns");
});

test("convergence guard rejects arbitrary columns appended to the legacy schema", () => {
	const unsupportedHeader = legacyCapabilityHeader.replace(
		"performance_budget |",
		"performance_budget | unexpected |",
	);
	const capabilityMatrix = withActiveUpstreamIdentity([
		unsupportedHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has unsupported columns");
});

test("convergence guard rejects capability delimiters with the wrong width", () => {
	const capabilityMatrix = withActiveUpstreamIdentity(`${legacyCapabilityHeader}\n| --- |`);
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: delimiter line 6 has 1 columns; expected 13");
});

test("convergence guard reports empty capability identifiers by line", () => {
	const emptyCapabilityRow = legacyCapabilityRow.replace("app.example", "   ");
	const capabilityMatrix = withActiveUpstreamIdentity([
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		emptyCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 7 has empty capability_id");
});

test("convergence guard reports duplicate capability identifiers with both lines", () => {
	const capabilityMatrix = withActiveUpstreamIdentity([
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
		legacyCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain('capability-matrix: line 8 capability "app.example" duplicates line 7');
});

test("convergence guard ignores capability tables inside fenced examples", () => {
	const capabilityMatrix = withActiveUpstreamIdentity([
		"```md",
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
		"```",
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: missing required header");
});

test("convergence guard ignores capability tables inside HTML comments", () => {
	const capabilityMatrix = withActiveUpstreamIdentity([
		"<!--",
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
		"-->",
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: missing required header");
});

test("convergence guard treats escaped pipes as capability cell content", () => {
	const escapedPipeRow = legacyCapabilityRow.replace("upstream", "upstream \\| source");
	const capabilityMatrix = withActiveUpstreamIdentity([
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		escapedPipeRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toEqual([]);
});

test("convergence guard reports capability rows missing the closing pipe", () => {
	const malformedCapabilityRow = legacyCapabilityRow.slice(0, -1);
	const capabilityMatrix = withActiveUpstreamIdentity([
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		malformedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 7 is malformed");
});

test("convergence guard reports non-canonical rows without outer pipes", () => {
	const malformedCapabilityRow = legacyCapabilityRow.slice(1, -1).trim();
	const capabilityMatrix = withActiveUpstreamIdentity([
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		malformedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 7 is malformed");
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

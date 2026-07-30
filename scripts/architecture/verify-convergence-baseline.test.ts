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
const expandedCapabilityColumns = expandedCapabilityHeader
	.slice(1, -1)
	.split("|")
	.map((column) => column.trim());
const renderCapability = (capability: Record<string, string>) => capabilityRow(
	expandedCapabilityColumns.map((column) => capability[column] ?? ""),
);
const legacyCapabilityRow = capabilityRow([
	"app.example", "app", "upstream", "target", "baseline", "P0", "app",
	"none", "none", "tests", "none", "none", "bounded",
]);
const exampleCapability = {
	capability_id: "app.example",
	domain: "app",
	upstream_source: "upstream",
	target_module: "target",
	current_tauri: "baseline",
	parity_level: "P0",
	convergence_mode: "parity",
	owner_layer: "app",
	api_dependency: "none",
	state_migration: "none",
	verification: "tests",
	feature_gate: "none",
	blocked_by: "none",
	performance_budget: "bounded",
};
const expandedCapabilityRow = renderCapability(exampleCapability);
const updaterCapability = {
	capability_id: "updater.github-release",
	domain: "updater",
	upstream_source: "2.0.3 external HTTPS download pages",
	target_module: "GitHub Release + signed Update Runtime",
	current_tauri: "partial",
	parity_level: "P1",
	convergence_mode: "architecture-replacement",
	owner_layer: "Rust/Tauri adapter",
	api_dependency: "none",
	state_migration: "none",
	verification: "Updater Interface TDD",
	feature_gate: "none",
	blocked_by: "none",
	performance_budget: "startup non-blocking",
};
const updaterCapabilityRow = renderCapability(updaterCapability);
const d0InventoryCapabilities = [
	["baseline.electron-2.0.3", "implemented", "P0", "parity", "none"],
	["lyrics.stage-v2", "implemented", "P0", "parity", "none"],
	["visual.cursor-activity", "implemented", "P0", "parity", "none"],
	["visual.shelf-cursor-layer", "implemented", "P0", "parity", "none"],
	["visual.sonic-workshop", "blocked", "P0", "parity", "provenance-decision"],
	["wallpaper.idle-dispose", "implemented", "P0", "parity", "none"],
	["playback.startup-resume", "missing", "P0", "parity", "none"],
	["queue.drag-sort", "missing", "P1", "parity", "none"],
	["library.drag-sort", "missing", "P1", "parity", "none"],
	["lyrics.track-offset", "missing", "P1", "parity", "none"],
	["beatmap.local-song", "partial", "P1", "parity", "none"],
	["local-import.expanded", "partial", "P1", "parity", "none"],
	["hotkeys.editor", "missing", "P1", "parity", "none"],
	["visual.archive", "missing", "P1", "parity", "none"],
	["visual.camera-gesture", "missing", "P2", "parity", "none"],
	["wallpaper.library", "partial", "P1", "parity", "none"],
	["wallpaper.wgc", "missing", "P1", "parity", "none"],
	["accounts.provider-order", "missing", "P1", "parity", "none"],
	["search.multi-provider-offset", "partial", "P1", "parity", "none"],
] as const;
const d0InventoryRows = d0InventoryCapabilities.map(([
	capabilityId,
	currentTauri,
	parityLevel,
	convergenceMode,
	blockedBy,
]) => renderCapability({
	...exampleCapability,
	capability_id: capabilityId,
	current_tauri: currentTauri,
	parity_level: parityLevel,
	convergence_mode: convergenceMode,
	blocked_by: blockedBy,
}));
const completeCapabilityRows = [
	expandedCapabilityRow,
	updaterCapabilityRow,
	...d0InventoryRows,
];
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
const d0SourceMap = [
	"| delta_id | current_tauri | convergence_mode | evidence |",
	"| --- | --- | --- | --- |",
	"| lyrics.nested-render-base | implemented | parity | D1 layer characterization |",
	"| visual.cursor-shelf-layer | implemented | parity | D1 cursor and Shelf runtime |",
	"| updater.github-release | partial | architecture-replacement | D2 signed GitHub Update Runtime |",
	"| visual.sonic-workshop | blocked | parity | independent CmzYa / 3747222633 provenance decision |",
	"| wallpaper.idle-dispose | implemented | parity | Rust idle and repeated dispose tests |",
].join("\n");
const withActiveUpstreamIdentity = (body: string) => `${activeUpstreamIdentity}\n\n${body}`;

const validDocuments = {
	capabilityMatrix: withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		...completeCapabilityRows,
	].join("\n")),
	upstreamSourceMap: `${activeUpstreamIdentity}\n\n${upstreamReleaseProvenance}\n\n${d0SourceMap}`,
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
	})).toContain("upstream-source-map: duplicate release provenance headers at lines 5, 18");
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

test("D0 inventory reports missing reviewed v2.0.3 and inherited gaps", () => {
	const missingCapabilityIds = new Set([
		"baseline.electron-2.0.3",
		"visual.cursor-activity",
		"playback.startup-resume",
	]);
	const missingInventory = d0InventoryRows.filter((_, index) =>
		!missingCapabilityIds.has(d0InventoryCapabilities[index][0])).join("\n");
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			d0InventoryRows.join("\n"),
			missingInventory,
		),
	});
	expect(errors).toContain("capability-matrix: missing D0 inventory capability baseline.electron-2.0.3");
	expect(errors).toContain("capability-matrix: missing D0 inventory capability visual.cursor-activity");
	expect(errors).toContain("capability-matrix: missing D0 inventory capability playback.startup-resume");
});

test("D0 source map requires every reviewed v2.0.3 delta", () => {
	const errors = validateConvergenceBaseline({
		...validDocuments,
		upstreamSourceMap: validDocuments.upstreamSourceMap.replace(
			"| visual.sonic-workshop | blocked | parity | independent CmzYa / 3747222633 provenance decision |\n",
			"",
		),
	});
	expect(errors).toContain("upstream-source-map: missing D0 delta visual.sonic-workshop");
});

test("convergence guard rejects the legacy capability matrix schema", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: withActiveUpstreamIdentity([
			legacyCapabilityHeader,
			legacyCapabilityDelimiter,
			legacyCapabilityRow,
		].join("\n")),
	})).toContain("capability-matrix: header line 5 has 13 columns; expected 14");
});

test("convergence guard rejects invalid capability taxonomy values", () => {
	const cases = [
		{ column: "current_tauri", value: "done" },
		{ column: "parity_level", value: "X" },
		{ column: "parity_level", value: "P3" },
		{ column: "convergence_mode", value: "unknown" },
		{ column: "convergence_mode", value: "" },
	];
	for (const testCase of cases) {
		const capabilityMatrix = withActiveUpstreamIdentity([
			expandedCapabilityHeader,
			expandedCapabilityDelimiter,
			renderCapability({
				...exampleCapability,
				[testCase.column]: testCase.value,
			}),
		].join("\n"));
		const renderedValue = testCase.value || "<empty>";
		expect(validateConvergenceBaseline({
			...validDocuments,
			capabilityMatrix,
		})).toContain(
			`capability-matrix: line 7 capability "app.example" column ${testCase.column} has invalid value "${renderedValue}"`,
		);
	}
});

test("convergence guard requires blocked capabilities to name a blocker", () => {
	const blockedCapability = {
		...exampleCapability,
		current_tauri: "blocked",
	};
	const blockedWithoutOwner = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		renderCapability(blockedCapability),
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: blockedWithoutOwner,
	})).toContain(
		'capability-matrix: line 7 capability "app.example" column blocked_by must name a blocker for blocked state',
	);

	const blockedWithOwner = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		renderCapability({
			...blockedCapability,
			blocked_by: "MineRadio-api",
		}),
		updaterCapabilityRow,
		...d0InventoryRows,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: blockedWithOwner,
	})).toEqual([]);
});

test("convergence guard requires exactly one updater authority", () => {
	const missingUpdaterMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: missingUpdaterMatrix,
	})).toContain("capability-matrix: expected exactly one updater authority; found 0");

	const duplicateUpdaterMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
		updaterCapabilityRow,
		updaterCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: duplicateUpdaterMatrix,
	})).toContain("capability-matrix: expected exactly one updater authority; found 2 at lines 8, 9");
});

test("convergence guard freezes the GitHub Release updater authority tuple", () => {
	const cases = [
		{ field: "capability_id", value: "updater.signed" },
		{ field: "domain", value: "desktop" },
		{ field: "current_tauri", value: "baseline" },
		{ field: "parity_level", value: "P0" },
		{ field: "convergence_mode", value: "parity" },
	];
	const authorityFields = [
		"capability_id",
		"domain",
		"current_tauri",
		"parity_level",
		"convergence_mode",
	];
	for (const testCase of cases) {
		const changedUpdater = {
			...updaterCapability,
			[testCase.field]: testCase.value,
		};
		const capabilityMatrix = withActiveUpstreamIdentity([
			expandedCapabilityHeader,
			expandedCapabilityDelimiter,
			expandedCapabilityRow,
			renderCapability(changedUpdater),
		].join("\n"));
		const actualAuthority = authorityFields
			.map((field) => changedUpdater[field as keyof typeof changedUpdater])
			.join(" / ");
		expect(validateConvergenceBaseline({
			...validDocuments,
			capabilityMatrix,
		})).toContain(
			`capability-matrix: line 8 updater authority must be updater.github-release / updater / partial / P1 / architecture-replacement; found ${actualAuthority}`,
		);
	}
});

test("convergence guard rejects a hidden second capability table", () => {
	const legacyTable = [
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
	].join("\n");
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: `${validDocuments.capabilityMatrix}\n\n${legacyTable}`,
	})).toContain("capability-matrix: duplicate capability headers at lines 5, 29");
});

test("convergence guard identifies capability headers by parsed column names", () => {
	const compactHeader = expandedCapabilityHeader.replaceAll(" | ", "|");
	const capabilityMatrix = withActiveUpstreamIdentity([
		compactHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
		updaterCapabilityRow,
		...d0InventoryRows,
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
	})).toContain('capability-matrix: line 28 capability "visual.example" has 3 columns; expected 14');
});

test("convergence guard reports malformed capability headers by line", () => {
	const capabilityMatrix = withActiveUpstreamIdentity(
		expandedCapabilityHeader.replace(" | convergence_mode", ""),
	);
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has 13 columns; expected 14");
});

test("convergence guard reports unsupported capability columns by header line", () => {
	const capabilityMatrix = withActiveUpstreamIdentity(
		expandedCapabilityHeader.replace("target_module", "unexpected_target"),
	);
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has unsupported columns");
});

test("convergence guard rejects arbitrary columns appended to the legacy schema", () => {
	const unsupportedHeader = expandedCapabilityHeader.replace(
		"performance_budget |",
		"performance_budget | unexpected |",
	);
	const capabilityMatrix = withActiveUpstreamIdentity([
		unsupportedHeader,
		capabilityRow(Array(15).fill("---")),
		capabilityRow([...Array(14).fill("value"), "unexpected"]),
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has 15 columns; expected 14");
});

test("convergence guard rejects capability delimiters with the wrong width", () => {
	const capabilityMatrix = withActiveUpstreamIdentity(`${expandedCapabilityHeader}\n| --- |`);
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: delimiter line 6 has 1 columns; expected 14");
});

test("convergence guard reports empty capability identifiers by line", () => {
	const emptyCapabilityRow = renderCapability({
		...exampleCapability,
		capability_id: "   ",
	});
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		emptyCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 7 has empty capability_id");
});

test("convergence guard reports duplicate capability identifiers with both lines", () => {
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
		expandedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain('capability-matrix: line 8 capability "app.example" duplicates line 7');
});

test("convergence guard ignores capability tables inside fenced examples", () => {
	const capabilityMatrix = withActiveUpstreamIdentity([
		"```md",
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
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
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
		"-->",
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: missing required header");
});

test("convergence guard treats escaped pipes as capability cell content", () => {
	const escapedPipeRow = renderCapability({
		...exampleCapability,
		upstream_source: "upstream \\| source",
	});
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		escapedPipeRow,
		updaterCapabilityRow,
		...d0InventoryRows,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toEqual([]);
});

test("convergence guard reports capability rows missing the closing pipe", () => {
	const malformedCapabilityRow = expandedCapabilityRow.slice(0, -1);
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		malformedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 7 is malformed");
});

test("convergence guard reports non-canonical rows without outer pipes", () => {
	const malformedCapabilityRow = expandedCapabilityRow.slice(1, -1).trim();
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
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

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CAPABILITY_HEADERS = [
	"| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |",
	"| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | convergence_mode | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |",
];
const EXTRACTION_HEADER = "| symbol | kind | purity | current_side_effects | target_module | evidence | migration_order |";
const ACTIVE_UPSTREAM_IDENTITY = {
	repository: "XxHuberrr/Mineradio",
	tag: "v2.0.3",
	peeled_commit: "432c713061759e7724eb3e40e77a5e250ac1aa58",
	tree: "6c425be30784088169f761edbbf28f9c476f7d3a",
	package_version: "2.0.3",
};
const ACTIVE_UPSTREAM_IDENTITY_COLUMNS = [
	"baseline_role",
	...Object.keys(ACTIVE_UPSTREAM_IDENTITY),
];
const UPSTREAM_PROVENANCE_COLUMNS = [
	"provenance_role",
	"ref",
	"object_id",
	"resolved_commit",
	"tree",
	"package_version",
];
const EXPECTED_UPSTREAM_PROVENANCE = {
	release_tag: {
		ref: "refs/tags/v2.0.3",
		object_id: "631813e4baaea1c2115182050be736b6491097e5",
		resolved_commit: ACTIVE_UPSTREAM_IDENTITY.peeled_commit,
		tree: ACTIVE_UPSTREAM_IDENTITY.tree,
		package_version: ACTIVE_UPSTREAM_IDENTITY.package_version,
	},
	release_branch: {
		ref: "refs/heads/release/2.0.3",
		object_id: "7974c52270c628d7ddb7427eaa0269e024cc0d3f",
		resolved_commit: "7974c52270c628d7ddb7427eaa0269e024cc0d3f",
		tree: ACTIVE_UPSTREAM_IDENTITY.tree,
		package_version: ACTIVE_UPSTREAM_IDENTITY.package_version,
	},
};
const LEGACY_ACTIVE_BASELINE_MARKERS = {
	"capability-matrix": "上游行为基线：`XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224`。",
	"upstream-source-map": "Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`",
};
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
	errors.push(...validateCapabilityMatrix(documents.capabilityMatrix));
	errors.push(...validateActiveUpstreamIdentity(
		documents.capabilityMatrix,
		"capability-matrix",
	));
	errors.push(...validateActiveUpstreamIdentity(
		documents.upstreamSourceMap,
		"upstream-source-map",
	));
	errors.push(...validateUpstreamReleaseProvenance(documents.upstreamSourceMap));
	for (const [documentName, source] of [
		["capability-matrix", documents.capabilityMatrix],
		["upstream-source-map", documents.upstreamSourceMap],
	]) {
		if (activeMarkdownContains(
			source,
			LEGACY_ACTIVE_BASELINE_MARKERS[documentName],
		)) {
			errors.push(`${documentName}: legacy Mineradio v2.0.2 active baseline marker remains`);
		}
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

function activeMarkdownContains(source, marker) {
	if (typeof source !== "string") return false;
	const lines = source.split(/\r?\n/);
	const activeLines = identifyActiveMarkdownLines(lines);
	return lines.some((line, index) => activeLines[index] && line.includes(marker));
}

function parseExactMarkdownTable(source, options) {
	const {
		columns,
		documentName,
		missingName,
		tableName,
	} = options;
	if (typeof source !== "string") {
		return {
			errors: [`${documentName}: missing ${missingName}`],
			found: false,
			rows: [],
		};
	}
	const lines = source.split(/\r?\n/);
	const activeLines = identifyActiveMarkdownLines(lines);
	const headerIndexes = [];
	for (let index = 0; index < lines.length; index += 1) {
		const cells = parseMarkdownTableRow(lines[index]);
		if (activeLines[index]
			&& cells?.length === columns.length
			&& cells.every((cell, cellIndex) =>
				cell === columns[cellIndex])) {
			headerIndexes.push(index);
		}
	}
	if (headerIndexes.length === 0) {
		return {
			errors: [`${documentName}: missing ${missingName}`],
			found: false,
			rows: [],
		};
	}
	const errors = [];
	if (headerIndexes.length > 1) {
		errors.push(`${documentName}: duplicate ${tableName} headers at lines ${headerIndexes.map((index) => index + 1).join(", ")}`);
	}
	const headerIndex = headerIndexes[0];
	const delimiter = parseMarkdownTableRow(lines[headerIndex + 1] || "");
	if (!delimiter
		|| delimiter.length !== columns.length
		|| !delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) {
		errors.push(`${documentName}: ${tableName} delimiter line ${headerIndex + 2} is malformed`);
	}
	const rows = [];
	for (let index = headerIndex + 2; index < lines.length; index += 1) {
		const cells = parseMarkdownTableRow(lines[index]);
		if (!cells) break;
		if (cells.length !== columns.length) {
			errors.push(`${documentName}: ${tableName} line ${index + 1} has ${cells.length} columns; expected ${columns.length}`);
			continue;
		}
		rows.push({ cells, line: index + 1 });
	}
	return { errors, found: true, rows };
}

function validateUpstreamReleaseProvenance(source) {
	const documentName = "upstream-source-map";
	const parsed = parseExactMarkdownTable(source, {
		columns: UPSTREAM_PROVENANCE_COLUMNS,
		documentName,
		missingName: "release provenance",
		tableName: "release provenance",
	});
	if (!parsed.found) return parsed.errors;
	const errors = [...parsed.errors];
	const rows = new Map();
	for (const parsedRow of parsed.rows) {
		const role = parsedRow.cells[0];
		if (rows.has(role)) {
			errors.push(`${documentName}: release provenance line ${parsedRow.line} duplicates role "${role}" from line ${rows.get(role).line}`);
			continue;
		}
		rows.set(role, {
			line: parsedRow.line,
			values: Object.fromEntries(UPSTREAM_PROVENANCE_COLUMNS
				.slice(1)
				.map((field, cellIndex) => [field, parsedRow.cells[cellIndex + 1]])),
		});
	}
	for (const [role, expectedValues] of Object.entries(EXPECTED_UPSTREAM_PROVENANCE)) {
		const row = rows.get(role);
		if (!row) {
			errors.push(`${documentName}: missing release provenance role ${role}`);
			continue;
		}
		for (const [field, expected] of Object.entries(expectedValues)) {
			if (row.values[field] !== expected) {
				errors.push(`${documentName}: release provenance line ${row.line} role ${role} field ${field} must be ${expected}; received ${row.values[field]}`);
			}
		}
	}
	return errors;
}

function validateActiveUpstreamIdentity(source, documentName) {
	const parsed = parseExactMarkdownTable(source, {
		columns: ACTIVE_UPSTREAM_IDENTITY_COLUMNS,
		documentName,
		missingName: "active upstream identity",
		tableName: "upstream identity",
	});
	if (!parsed.found) return parsed.errors;
	const errors = [...parsed.errors];
	const activeRows = [];
	for (const row of parsed.rows) {
		if (row.cells[0] === "active") activeRows.push(row);
		else errors.push(`${documentName}: upstream identity line ${row.line} has unsupported baseline_role "${row.cells[0]}"`);
	}
	if (activeRows.length === 0) {
		errors.push(`${documentName}: missing active upstream identity`);
		return errors;
	}
	if (activeRows.length > 1) {
		errors.push(`${documentName}: duplicate active upstream identity rows at lines ${activeRows.map((row) => row.line).join(", ")}`);
	}
	const activeRow = activeRows[0];
	const identity = Object.fromEntries(ACTIVE_UPSTREAM_IDENTITY_COLUMNS
		.slice(1)
		.map((field, index) => [field, activeRow.cells[index + 1]]));
	for (const [field, expected] of Object.entries(ACTIVE_UPSTREAM_IDENTITY)) {
		if (identity[field] !== expected) {
			errors.push(`${documentName}: active upstream identity line ${activeRow.line} field ${field} must be ${expected}; received ${identity[field]}`);
		}
	}
	return errors;
}

function validateCapabilityMatrix(source) {
	if (typeof source !== "string") {
		return ["capability-matrix: missing required header"];
	}
	const lines = source.split(/\r?\n/);
	const activeLines = identifyActiveMarkdownLines(lines);
	const headerIndex = lines.findIndex((line, index) =>
		activeLines[index] && parseMarkdownTableRow(line)?.[0] === "capability_id");
	if (headerIndex < 0) {
		return ["capability-matrix: missing required header"];
	}
	const columns = parseMarkdownTableRow(lines[headerIndex]);
	if (columns.length !== 13 && columns.length !== 14) {
		return [`capability-matrix: header line ${headerIndex + 1} has ${columns.length} columns; expected 13 or 14`];
	}
	const supportedHeader = CAPABILITY_HEADERS.some((header) => {
		const expectedColumns = parseMarkdownTableRow(header);
		return expectedColumns.length === columns.length
			&& expectedColumns.every((column, index) => column === columns[index]);
	});
	if (!supportedHeader) {
		return [`capability-matrix: header line ${headerIndex + 1} has unsupported columns`];
	}
	const capabilityIndex = columns.indexOf("capability_id");
	const errors = [];
	const delimiterIndex = headerIndex + 1;
	const delimiter = parseMarkdownTableRow(lines[delimiterIndex] || "");
	if (!delimiter) {
		errors.push(`capability-matrix: delimiter line ${delimiterIndex + 1} is missing or malformed`);
	} else if (delimiter.length !== columns.length) {
		errors.push(`capability-matrix: delimiter line ${delimiterIndex + 1} has ${delimiter.length} columns; expected ${columns.length}`);
	} else if (!delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) {
		errors.push(`capability-matrix: delimiter line ${delimiterIndex + 1} is malformed`);
	}
	const capabilityLines = new Map();
	for (let index = headerIndex + 2; index < lines.length; index += 1) {
		const line = lines[index];
		const cells = parseMarkdownTableRow(line);
		if (!cells) {
			if (line.includes("|")) {
				errors.push(`capability-matrix: line ${index + 1} is malformed`);
			}
			break;
		}
		if (cells.length !== columns.length) {
			const capability = cells[capabilityIndex] || "<empty>";
			errors.push(`capability-matrix: line ${index + 1} capability "${capability}" has ${cells.length} columns; expected ${columns.length}`);
			continue;
		}
		const row = Object.fromEntries(columns.map((column, cellIndex) =>
			[column, cells[cellIndex]]));
		if (!row.capability_id) {
			errors.push(`capability-matrix: line ${index + 1} has empty capability_id`);
			continue;
		}
		const firstLine = capabilityLines.get(row.capability_id);
		if (firstLine) {
			errors.push(`capability-matrix: line ${index + 1} capability "${row.capability_id}" duplicates line ${firstLine}`);
		} else {
			capabilityLines.set(row.capability_id, index + 1);
		}
	}
	return errors;
}

function identifyActiveMarkdownLines(lines) {
	const active = [];
	let fence = null;
	let htmlComment = false;
	for (const line of lines) {
		const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fence) {
			active.push(false);
			if (match && match[1][0] === fence.character && match[1].length >= fence.length) {
				fence = null;
			}
			continue;
		}
		if (htmlComment) {
			active.push(false);
			if (line.includes("-->")) htmlComment = false;
			continue;
		}
		if (match) {
			fence = { character: match[1][0], length: match[1].length };
			active.push(false);
			continue;
		}
		const commentStart = line.indexOf("<!--");
		if (commentStart >= 0) {
			htmlComment = line.indexOf("-->", commentStart + 4) < 0;
			active.push(false);
			continue;
		}
		active.push(true);
	}
	return active;
}

function parseMarkdownTableRow(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
	const cells = [];
	let current = "";
	for (let index = 1; index < trimmed.length - 1; index += 1) {
		const character = trimmed[index];
		if (character === "\\" && trimmed[index + 1] === "|") {
			current += "|";
			index += 1;
			continue;
		}
		if (character === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	cells.push(current.trim());
	return cells;
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

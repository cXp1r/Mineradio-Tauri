import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CAPABILITY_HEADERS = [
	"| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |",
	"| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | convergence_mode | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |",
];
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
	errors.push(...validateCapabilityMatrix(documents.capabilityMatrix));
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

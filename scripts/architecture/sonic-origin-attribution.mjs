import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "../..");

export const SONIC_ORIGIN_DOCUMENT_PATH = "docs/parity/sonic-origin-decision.md";
export const THIRD_PARTY_NOTICES_PATH = "THIRD_PARTY_NOTICES.md";
export const SONIC_SOURCE_ATTRIBUTION_PATH = "packages/visual-engine/src/sonic-topography/sonic-topography.ts";
export const SONIC_DERIVED_SOURCE_PATHS = Object.freeze([
	"packages/visual-engine/src/sonic-topography/sonic-audio-profile.ts",
	"packages/visual-engine/src/sonic-topography/sonic-floating-blocks.ts",
	"packages/visual-engine/src/sonic-topography/sonic-impulses.ts",
	"packages/visual-engine/src/sonic-topography/sonic-palette.ts",
	"packages/visual-engine/src/sonic-topography/sonic-runtime-mapping.ts",
	"packages/visual-engine/src/sonic-topography/sonic-settings.ts",
	"packages/visual-engine/src/sonic-topography/sonic-shaders.ts",
	"packages/visual-engine/src/sonic-topography/sonic-terrain.ts",
	SONIC_SOURCE_ATTRIBUTION_PATH,
]);

const sourceAttributionRequirements = Object.freeze([
	"XxHuberrr/Mineradio",
	"4abaa190de42c632365ae4244e041bad16443224",
	"public/sonic-topography-preset.js",
	"yin-yizhen/sonic-topography",
	"3ff303e",
	"Ajin",
	"Non-Commercial Learning License",
	"Tauri",
	"THIRD_PARTY_NOTICES.md",
]);

export const SONIC_ORIGIN_REQUIREMENTS = Object.freeze({
	[SONIC_ORIGIN_DOCUMENT_PATH]: Object.freeze([
		"XxHuberrr/Mineradio",
		"4abaa190de42c632365ae4244e041bad16443224",
		"public/sonic-topography-preset.js",
		"yin-yizhen/sonic-topography",
		"3ff303e",
		"Ajin",
		"Non-Commercial Learning License",
		"公开合作证据",
		"维护者项目决策",
		"不等于书面授权",
		"与音域回响作者 Ajin 联动",
		"直接迁移",
		"历史 clean-room 审计",
		"不再作为 M4 blocker",
	]),
	[THIRD_PARTY_NOTICES_PATH]: Object.freeze([
		"Sonic Topography",
		"XxHuberrr/Mineradio",
		"4abaa190de42c632365ae4244e041bad16443224",
		"yin-yizhen/sonic-topography",
		"3ff303e",
		"Ajin",
		"Non-Commercial Learning License",
		"Copyright (c) 2026 Sonic Topography contributors",
		"This project is provided only for learning, research, and personal non-commercial use.",
		"sell, sublicense, rent, or package it as a paid product",
		"公开合作证据",
		"维护者项目决策",
		"不等于书面授权",
		"个人非商业",
	]),
	...Object.fromEntries(
		SONIC_DERIVED_SOURCE_PATHS.map((path) => [path, sourceAttributionRequirements]),
	),
});

export function auditSonicOriginAttributionRecords(records) {
	const recordsByPath = new Map(records.map((record) => [record.path, record.content]));
	const violations = [];

	for (const [path, requiredMarkers] of Object.entries(SONIC_ORIGIN_REQUIREMENTS)) {
		const content = recordsByPath.get(path);
		if (typeof content !== "string") {
			violations.push({ path, kind: "missing-document", detail: path });
			continue;
		}
		for (const marker of requiredMarkers) {
			if (content.includes(marker)) continue;
			violations.push({ path, kind: "missing-attribution", detail: marker });
		}
	}

	return violations;
}

export function auditSonicOriginAttributionRepository(root = repositoryRoot) {
	const records = Object.keys(SONIC_ORIGIN_REQUIREMENTS).map((path) => {
		const absolutePath = resolve(root, path);
		return {
			path,
			content: existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null,
		};
	});
	return auditSonicOriginAttributionRecords(records);
}

function runCli() {
	const requestedRoot = process.argv[2]
		? resolve(process.cwd(), process.argv[2])
		: repositoryRoot;
	const violations = auditSonicOriginAttributionRepository(requestedRoot);
	if (violations.length === 0) {
		console.log(`[sonic-origin-attribution] PASS ${requestedRoot}`);
		return;
	}
	console.error(`[sonic-origin-attribution] FAIL ${violations.length} violation(s)`);
	for (const violation of violations) {
		console.error(`- ${violation.path}: ${violation.kind} (${violation.detail})`);
	}
	process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) runCli();

#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync as runFile, spawnSync as runSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { evaluateM7Evidence } from "./evidence-model.mjs";

const DEFAULT_BASELINE = "a2e845b";
const DEFAULT_OUTPUT = path.resolve("output/parity/m7/manifest.json");

export const M7_FROZEN_PATHS = Object.freeze([
	"sidecars/api",
	"packages/shared",
	"apps/desktop/src-tauri/src/sidecar.rs",
	"apps/desktop/src-tauri/build.rs",
	"apps/desktop/scripts/build-sidecar-binary.mjs",
	"apps/web/src/api/sidecar-client.ts",
	"apps/web/src/adapters/sidecar/legacy-api-runtime.ts",
	"apps/web/src/adapters/sidecar/legacy-media-url.ts",
	"apps/web/src/app/runtime/SidecarRecoveryRuntime.tsx",
]);

export function parseArguments(argv) {
	const options = { baseline: DEFAULT_BASELINE, manualPath: null, outputPath: DEFAULT_OUTPUT, strict: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--strict") { options.strict = true; continue; }
		if (argument === "--help" || argument === "-h") return null;
		const value = argv[index + 1];
		if (!value) throw new Error(`${argument} 缺少值`);
		if (argument === "--manual") options.manualPath = path.resolve(value);
		else if (argument === "--output") options.outputPath = path.resolve(value);
		else if (argument === "--baseline") options.baseline = value;
		else throw new Error(`未知参数: ${argument}`);
		index += 1;
	}
	return options;
}

function commandText(command, args) {
	return runFile(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function collectGit() {
	const status = commandText("git", ["status", "--porcelain"]);
	return {
		commit: commandText("git", ["rev-parse", "HEAD"]),
		branch: commandText("git", ["branch", "--show-current"]),
		dirty: status.length > 0,
		status: status ? status.split(/\r?\n/) : [],
	};
}

function collectSystem(manual) {
	return { platform: process.platform, monitors: manual?.monitors ?? [] };
}

function externalBin(configText) {
	try {
		const value = JSON.parse(configText)?.bundle?.externalBin;
		return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
	} catch {
		return null;
	}
}

export function evaluateExternalBinFreeze({ baselineText, currentText }) {
	const baseline = typeof baselineText === "string" ? externalBin(baselineText) : null;
	const current = typeof currentText === "string" ? externalBin(currentText) : null;
	return {
		passed: baseline !== null && current !== null && JSON.stringify(baseline) === JSON.stringify(current),
		baseline,
		current,
	};
}

export function collectApiFreeze(baseline) {
	const result = runSpawn("git", ["diff", "--quiet", baseline, "--", ...M7_FROZEN_PATHS], {
		cwd: process.cwd(), encoding: "utf8",
	});
	const configPath = "apps/desktop/src-tauri/tauri.conf.json";
	const baselineConfig = runSpawn("git", ["show", `${baseline}:${configPath}`], {
		cwd: process.cwd(), encoding: "utf8",
	});
	const externalBinFreeze = evaluateExternalBinFreeze({
		baselineText: baselineConfig.status === 0 ? baselineConfig.stdout : null,
		currentText: existsSync(configPath) ? readFileSync(configPath, "utf8") : null,
	});
	return {
		baseline,
		passed: result.status === 0 && externalBinFreeze.passed,
		paths: M7_FROZEN_PATHS,
		externalBin: externalBinFreeze,
	};
}

export function createEvidence(options) {
	const manual = options.manualPath && existsSync(options.manualPath)
		? JSON.parse(readFileSync(options.manualPath, "utf8"))
		: null;
	const evidence = {
		schemaVersion: 1,
		capturedAt: new Date().toISOString(),
		command: ["node", "scripts/parity/m7/capture-evidence.mjs", ...process.argv.slice(2)],
		git: collectGit(),
		system: collectSystem(manual),
		apiFreeze: collectApiFreeze(options.baseline),
		manual,
	};
	evidence.evaluation = evaluateM7Evidence(evidence);
	return evidence;
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	if (!options) return;
	const evidence = createEvidence(options);
	mkdirSync(path.dirname(options.outputPath), { recursive: true });
	writeFileSync(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	console.log(`[m7-evidence] manifest: ${options.outputPath}`);
	for (const gate of evidence.evaluation.gates) {
		console.log(`[m7-evidence] ${gate.passed ? "PASS" : "FAIL"} ${gate.id}`);
	}
	if (options.strict && !evidence.evaluation.passed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`[m7-evidence] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

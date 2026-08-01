#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { evaluateM6Evidence } from "./evidence-model.mjs";

const DEFAULT_BASELINE = "a2e845b";
const DEFAULT_OUTPUT = path.resolve("output/parity/m6/manifest.json");

// M6 只能新增完整桌面能力；下面所有 API、sidecar 与媒体 seam 必须保持基线语义。
export const M6_FROZEN_PATHS = Object.freeze([
	"sidecars/api",
	"packages/shared",
	"apps/desktop/src-tauri/src/sidecar.rs",
	"apps/desktop/src-tauri/build.rs",
	"apps/desktop/scripts/build-sidecar-binary.mjs",
	"apps/web/src/api/sidecar-client.ts",
	"apps/web/src/adapters/sidecar/legacy-api-runtime.ts",
	"apps/web/src/adapters/sidecar/legacy-media-url.ts",
	"apps/web/src/app/runtime/SidecarRecoveryRuntime.tsx",
	"apps/web/src/components/shell/SidecarRecoveryNotice.tsx",
]);

function usage() {
	return `用法: node scripts/parity/m6/capture-evidence.mjs [options]\n\n  --manual <path>     Windows 实机验证 JSON；strict 模式必需\n  --output <path>     manifest 输出路径\n  --baseline <ref>    freeze 对比基线，默认 ${DEFAULT_BASELINE}\n  --strict            缺少任一字段或硬门失败时返回非零\n`;
}

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
	return execFileSync(command, args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function collectGit() {
	const status = commandText("git", ["status", "--porcelain"]);
	return { commit: commandText("git", ["rev-parse", "HEAD"]), branch: commandText("git", ["branch", "--show-current"]), dirty: status.length > 0, status: status ? status.split(/\r?\n/) : [] };
}

function collectWindowsSystem() {
	if (process.platform !== "win32") return { platform: process.platform, monitors: [] };
	const script = String.raw`
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
$monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{ deviceName=$_.DeviceName; primary=$_.Primary; bounds=[pscustomobject]@{x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height}; scale=$null }
})
[pscustomobject]@{platform='win32';monitors=$monitors} | ConvertTo-Json -Depth 5 -Compress
`;
	return JSON.parse(commandText("powershell.exe", ["-NoProfile", "-Command", script]));
}

function parseExternalBin(configText, source) {
	try {
		const externalBin = JSON.parse(configText)?.bundle?.externalBin;
		if (!Array.isArray(externalBin) || !externalBin.every((value) => typeof value === "string")) {
			return { passed: false, source, reason: "bundle.externalBin-missing-or-invalid", externalBin: null };
		}
		return { passed: true, source, externalBin };
	} catch (error) {
		return { passed: false, source, reason: `tauri-config-json-invalid: ${error instanceof Error ? error.message : String(error)}`, externalBin: null };
	}
}

export function evaluateExternalBinFreeze({ baselineText, currentText }) {
	if (typeof baselineText !== "string") {
		return { passed: false, reason: "baseline-tauri-config-unreadable", baseline: null, current: null };
	}
	const baseline = parseExternalBin(baselineText, "baseline");
	const current = parseExternalBin(currentText, "current");
	if (!baseline.passed || !current.passed) {
		return { passed: false, reason: baseline.reason ?? current.reason, baseline, current };
	}
	const passed = JSON.stringify(baseline.externalBin) === JSON.stringify(current.externalBin);
	return {
		passed,
		reason: passed ? null : "bundle.externalBin-changed",
		baseline: baseline.externalBin,
		current: current.externalBin,
	};
}

function collectTauriExternalBinFreeze(baseline) {
	const configPath = "apps/desktop/src-tauri/tauri.conf.json";
	const baselineResult = spawnSync("git", ["show", `${baseline}:${configPath}`], { cwd: process.cwd(), encoding: "utf8" });
	const currentText = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
	const comparison = evaluateExternalBinFreeze({
		baselineText: baselineResult.status === 0 ? baselineResult.stdout : null,
		currentText,
	});
	return { path: configPath, baselineRef: baseline, ...comparison };
}

export function collectApiFreeze(baseline) {
	const result = spawnSync("git", ["diff", "--quiet", baseline, "--", ...M6_FROZEN_PATHS], { cwd: process.cwd(), encoding: "utf8" });
	const externalBin = collectTauriExternalBinFreeze(baseline);
	return {
		baseline,
		passed: result.status === 0 && externalBin.passed,
		paths: M6_FROZEN_PATHS,
		tauriExternalBin: externalBin,
	};
}

export function createEvidence(options) {
	const manual = options.manualPath && existsSync(options.manualPath) ? JSON.parse(readFileSync(options.manualPath, "utf8")) : null;
	const evidence = { schemaVersion: 1, capturedAt: new Date().toISOString(), command: ["node", "scripts/parity/m6/capture-evidence.mjs", ...process.argv.slice(2)], git: collectGit(), system: collectWindowsSystem(), apiFreeze: collectApiFreeze(options.baseline), manual };
	evidence.evaluation = evaluateM6Evidence(evidence);
	return evidence;
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	if (!options) { console.log(usage()); return; }
	const evidence = createEvidence(options);
	mkdirSync(path.dirname(options.outputPath), { recursive: true });
	writeFileSync(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	console.log(`[m6-evidence] manifest: ${options.outputPath}`);
	for (const gate of evidence.evaluation.gates) console.log(`[m6-evidence] ${gate.passed ? "PASS" : "FAIL"} ${gate.id}`);
	if (options.strict && !evidence.evaluation.passed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	try { main(); } catch (error) { console.error(`[m6-evidence] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}

#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { evaluateM5Evidence } from "./evidence-model.mjs";

const DEFAULT_BASELINE = "a2e845b";
const DEFAULT_OUTPUT = path.resolve("output/parity/m5/manifest.json");
export const M5_FROZEN_PATHS = Object.freeze([
	"sidecars/api",
	"packages/shared",
	"apps/desktop/src-tauri/src/sidecar.rs",
	"apps/desktop/src-tauri/build.rs",
	"apps/desktop/src-tauri/tauri.conf.json",
	"apps/desktop/scripts/build-sidecar-binary.mjs",
	"apps/web/src/api/sidecar-client.ts",
	"apps/web/src/adapters/sidecar/legacy-api-runtime.ts",
	"apps/web/src/adapters/sidecar/legacy-media-url.ts",
	"apps/web/src/app/runtime/SidecarRecoveryRuntime.tsx",
	"apps/web/src/components/shell/SidecarRecoveryNotice.tsx",
]);

function usage() {
	return `用法: node scripts/parity/m5/capture-evidence.mjs [options]

  --manual <path>     人工验证 JSON；strict 模式必需
  --output <path>     manifest 输出路径
  --baseline <ref>    API freeze 对比基线，默认 ${DEFAULT_BASELINE}
  --strict            任一硬门缺失时返回非零
`;
}

export function parseArguments(argv) {
	const options = {
		baseline: DEFAULT_BASELINE,
		manualPath: null,
		outputPath: DEFAULT_OUTPUT,
		strict: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--strict") {
			options.strict = true;
			continue;
		}
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
	return execFileSync(command, args, {
		cwd: process.cwd(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function readJsonFile(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8"));
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

function collectWindowsSystem() {
	if (process.platform !== "win32") {
		return { platform: process.platform, os: null, monitors: [], processes: [] };
	}
	const script = String.raw`
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber
$monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    deviceName = $_.DeviceName
    primary = $_.Primary
    bounds = [pscustomobject]@{ x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height }
    workingArea = [pscustomobject]@{ x=$_.WorkingArea.X; y=$_.WorkingArea.Y; width=$_.WorkingArea.Width; height=$_.WorkingArea.Height }
    scale = $null
  }
})
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^mineradio' } | ForEach-Object {
  [pscustomobject]@{
    pid = $_.ProcessId
    parentPid = $_.ParentProcessId
    name = $_.Name
    workingSetBytes = $_.WorkingSetSize
  }
})
[pscustomobject]@{ platform='win32'; os=$os; monitors=$monitors; processes=$processes } | ConvertTo-Json -Depth 6 -Compress
`;
	return JSON.parse(commandText("powershell.exe", ["-NoProfile", "-Command", script]));
}

function collectApiFreeze(baseline) {
	const result = spawnSync("git", ["diff", "--quiet", baseline, "--", ...M5_FROZEN_PATHS], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	return {
		baseline,
		passed: result.status === 0,
		paths: M5_FROZEN_PATHS,
	};
}

export function createEvidence(options) {
	const manual = options.manualPath && existsSync(options.manualPath)
		? readJsonFile(options.manualPath)
		: null;
	const evidence = {
		schemaVersion: 1,
		capturedAt: new Date().toISOString(),
		command: ["node", "scripts/parity/m5/capture-evidence.mjs", ...process.argv.slice(2)],
		git: collectGit(),
		system: collectWindowsSystem(),
		apiFreeze: collectApiFreeze(options.baseline),
		manual,
	};
	evidence.evaluation = evaluateM5Evidence(evidence);
	return evidence;
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	if (!options) {
		console.log(usage());
		return;
	}
	const evidence = createEvidence(options);
	mkdirSync(path.dirname(options.outputPath), { recursive: true });
	writeFileSync(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	console.log(`[m5-evidence] manifest: ${options.outputPath}`);
	for (const gate of evidence.evaluation.gates) {
		console.log(`[m5-evidence] ${gate.passed ? "PASS" : "FAIL"} ${gate.id}`);
	}
	if (options.strict && !evidence.evaluation.passed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`[m5-evidence] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

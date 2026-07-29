import { expect, test } from "bun:test";
import { evaluateM5Evidence, REQUIRED_MANUAL_CHECKS } from "./evidence-model.mjs";
import { M5_FROZEN_PATHS, parseArguments } from "./capture-evidence.mjs";

function completeManualEvidence() {
	return {
		monitors: [
			{ primary: true, bounds: { x: 0 }, scale: 1 },
			{ primary: false, bounds: { x: -1920 }, scale: 1.5 },
		],
		checks: Object.fromEntries(REQUIRED_MANUAL_CHECKS.map((id) => [id, true])),
	};
}

test("M5 strict evidence only passes with clean API freeze and complete Windows manual gates", () => {
	const result = evaluateM5Evidence({
		git: { dirty: false },
		system: { platform: "win32", monitors: [] },
		apiFreeze: { passed: true, baseline: "a2e845b" },
		manual: completeManualEvidence(),
	});

	expect(result.passed).toBe(true);
	expect(result.gates.every((gate) => gate.passed)).toBe(true);
});

test("M5 evidence fails closed when dual-DPI or tray verification is missing", () => {
	const manual = completeManualEvidence();
	manual.monitors = [{ primary: true, bounds: { x: 0 }, scale: 1 }];
	manual.checks.trayHideKeepsRuntimeAlive = false;
	const result = evaluateM5Evidence({
		git: { dirty: false },
		system: { platform: "win32" },
		apiFreeze: { passed: true, baseline: "a2e845b" },
		manual,
	});

	expect(result.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "dual-monitor-dpi")?.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "trayHideKeepsRuntimeAlive")?.passed).toBe(false);
});

test("M5 runner keeps strict, baseline, manual and output arguments explicit", () => {
	expect(parseArguments([
		"--strict",
		"--baseline", "base-ref",
		"--manual", "manual.json",
		"--output", "output/m5.json",
	])).toMatchObject({
		strict: true,
		baseline: "base-ref",
	});
});

test("M5 API freeze includes packaging, legacy client and media URL seams", () => {
	expect(M5_FROZEN_PATHS).toContain("apps/desktop/src-tauri/tauri.conf.json");
	expect(M5_FROZEN_PATHS).toContain("apps/web/src/api/sidecar-client.ts");
	expect(M5_FROZEN_PATHS).toContain("apps/web/src/adapters/sidecar/legacy-api-runtime.ts");
	expect(M5_FROZEN_PATHS).toContain("apps/web/src/adapters/sidecar/legacy-media-url.ts");
	expect(M5_FROZEN_PATHS).toContain("apps/web/src/components/shell/SidecarRecoveryNotice.tsx");
});

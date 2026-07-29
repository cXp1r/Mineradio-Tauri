import { expect, test } from "bun:test";
import { evaluateM7Evidence, REQUIRED_M7_FIELD_CHECKS } from "./evidence-model.mjs";
import {
	evaluateExternalBinFreeze,
	M7_FROZEN_PATHS,
	parseArguments,
} from "./capture-evidence.mjs";

function certificate(extra = {}) {
	return {
		passed: true,
		observedAt: "2026-07-29T00:00:00.000Z",
		artifacts: ["C:/evidence/runtime.json"],
		...extra,
	};
}

function completeEvidence() {
	return {
		git: { dirty: false },
		system: { platform: "win32" },
		apiFreeze: { passed: true, baseline: "a2e845b" },
		manual: {
			monitors: [
				{ primary: true, bounds: { x: 0 }, scale: 1 },
				{ primary: false, bounds: { x: -1920 }, scale: 1.5 },
			],
			checks: Object.fromEntries(REQUIRED_M7_FIELD_CHECKS.map((id) => [
				id,
				certificate(id === "trayCrashExitSoak"
					? { durationMinutes: 30 }
					: id === "wgcGlassFallback"
						? { mode: "unsupported-dom-fallback" }
						: {}),
			])),
		},
	};
}

test("M7 evidence accepts a complete Windows Scene lifecycle certificate", () => {
	expect(evaluateM7Evidence(completeEvidence()).passed).toBe(true);
});

test("M7 evidence fails closed for missing artifacts, short soak and wrong DPI topology", () => {
	const evidence = completeEvidence();
	evidence.manual.checks.locationScopedMute.artifacts = [];
	evidence.manual.checks.wgcGlassFallback.mode = "native-wgc";
	evidence.manual.checks.trayCrashExitSoak.durationMinutes = 29.99;
	evidence.manual.monitors[1].bounds.x = 1920;
	const result = evaluateM7Evidence(evidence);
	expect(result.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "locationScopedMute")?.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "wgcGlassFallback")?.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "trayCrashExitSoak")?.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "mixedDpiExplorerRestart")?.passed).toBe(false);
});

test("M7 freeze retains Sidecar, shared DTO, media seam and externalBin", () => {
	expect(M7_FROZEN_PATHS).toContain("sidecars/api");
	expect(M7_FROZEN_PATHS).toContain("packages/shared");
	expect(M7_FROZEN_PATHS).toContain("apps/web/src/adapters/sidecar/legacy-media-url.ts");
	const baseline = JSON.stringify({ bundle: { externalBin: ["binaries/mineradio-sidecar-api"] } });
	expect(evaluateExternalBinFreeze({ baselineText: baseline, currentText: baseline }).passed).toBe(true);
	expect(evaluateExternalBinFreeze({ baselineText: baseline, currentText: "{}" }).passed).toBe(false);
	expect(evaluateExternalBinFreeze({ baselineText: null, currentText: baseline }).passed).toBe(false);
});

test("M7 strict runner parses bounded explicit inputs", () => {
	expect(parseArguments([
		"--strict", "--manual", "manual.json", "--output", "out.json", "--baseline", "base",
	])).toMatchObject({ strict: true, baseline: "base" });
});

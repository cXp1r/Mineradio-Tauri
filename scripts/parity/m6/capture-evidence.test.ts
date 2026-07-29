import { expect, test } from "bun:test";
import { evaluateM6Evidence, REQUIRED_M6_FIELD_CHECKS } from "./evidence-model.mjs";
import { evaluateExternalBinFreeze, M6_FROZEN_PATHS, parseArguments } from "./capture-evidence.mjs";
import { verifyM6EvidenceFile } from "./verify-evidence.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function certificate(extra = {}) {
	return { passed: true, observedAt: "2026-07-29T00:00:00.000Z", artifacts: ["C:/evidence.png"], ...extra };
}

function completeEvidence() {
	return {
		git: { dirty: false }, system: { platform: "win32" }, apiFreeze: { passed: true, baseline: "a2e845b" },
		manual: { monitors: [{ primary: true, bounds: { x: 0 }, scale: 1 }, { primary: false, bounds: { x: -1920 }, scale: 1.5 }], checks: Object.fromEntries(REQUIRED_M6_FIELD_CHECKS.map((id) => [id, certificate(id === "backgroundSoak30Minutes" ? { durationMinutes: 30 } : {})])) },
	};
}

test("M6 strict evidence accepts complete Windows recovery evidence", () => {
	expect(evaluateM6Evidence(completeEvidence()).passed).toBe(true);
});

test("M6 evidence fails closed for absent artifact, negative-coordinate topology, kill recovery and short soak", () => {
	const evidence = completeEvidence();
	evidence.manual.monitors[1].bounds.x = 1920;
	evidence.manual.checks.processKillRecovery = { passed: true, observedAt: "now", artifacts: [] };
	evidence.manual.checks.backgroundSoak30Minutes.durationMinutes = 29.99;
	const result = evaluateM6Evidence(evidence);
	expect(result.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "mixed-dpi-negative-coordinates")?.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "processKillRecovery")?.passed).toBe(false);
	expect(result.gates.find((gate) => gate.id === "backgroundSoak30Minutes")?.passed).toBe(false);
});

test("M6 runner freezes sidecar, shared DTO and legacy media seams", () => {
	expect(M6_FROZEN_PATHS).toContain("sidecars/api");
	expect(M6_FROZEN_PATHS).toContain("packages/shared");
	expect(M6_FROZEN_PATHS).toContain("apps/web/src/adapters/sidecar/legacy-media-url.ts");
	expect(M6_FROZEN_PATHS).not.toContain("apps/desktop/src-tauri/tauri.conf.json");
	expect(parseArguments(["--strict", "--manual", "manual.json", "--output", "out.json", "--baseline", "base"])).toMatchObject({ strict: true, baseline: "base" });
});

test("M6 allows dynamic main-window config but freezes bundle externalBin fail-closed", () => {
	const baseline = JSON.stringify({ app: { windows: [{ label: "main" }] }, bundle: { externalBin: ["binaries/mineradio-sidecar-api"] } });
	const dynamicWindow = JSON.stringify({ app: { windows: [] }, bundle: { externalBin: ["binaries/mineradio-sidecar-api"] } });
	expect(evaluateExternalBinFreeze({ baselineText: baseline, currentText: dynamicWindow }).passed).toBe(true);
	expect(evaluateExternalBinFreeze({ baselineText: baseline, currentText: JSON.stringify({ bundle: { externalBin: [] } }) }).passed).toBe(false);
	expect(evaluateExternalBinFreeze({ baselineText: null, currentText: dynamicWindow }).passed).toBe(false);
});

test("M6 verification rereads manifests and still fails closed", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mineradio-m6-evidence-"));
	const manifest = path.join(directory, "manifest.json");
	const evidence = completeEvidence();
	evidence.manual.checks.escapeTrayNormalExit = { passed: true };
	writeFileSync(manifest, JSON.stringify(evidence), "utf8");
	expect(verifyM6EvidenceFile(manifest).evaluation.passed).toBe(false);
});

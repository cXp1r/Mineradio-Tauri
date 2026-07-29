// M7 真实 Windows 场景证据。runner 只校验 artifact 是否齐全，不推断视觉或听感结果。
export const REQUIRED_M7_FIELD_CHECKS = Object.freeze([
	"officialSceneDwmCapture",
	"wgcGlassFallback",
	"locationScopedMute",
	"realCursorNoInjection",
	"mixedDpiExplorerRestart",
	"trayCrashExitSoak",
	"noResidualSceneOrCaptureResources",
]);

function certificate(value) {
	return Boolean(
		value
		&& value.passed === true
		&& typeof value.observedAt === "string"
		&& Number.isFinite(Date.parse(value.observedAt))
		&& Array.isArray(value.artifacts)
		&& value.artifacts.length > 0
		&& value.artifacts.every((artifact) => typeof artifact === "string" && artifact.trim().length > 0),
	);
}

function mixedDpiTopology(monitors) {
	if (!Array.isArray(monitors) || monitors.length < 2) return false;
	const primary = monitors.find((monitor) => monitor?.primary === true);
	if (!primary || !Number.isFinite(primary?.bounds?.x)) return false;
	const scales = monitors.map((monitor) => Number(monitor?.scale));
	return scales.some((scale) => Math.abs(scale - 1) < 0.01)
		&& scales.some((scale) => Math.abs(scale - 1.5) < 0.01)
		&& monitors.some((monitor) => Number.isFinite(monitor?.bounds?.x)
			&& monitor.bounds.x < primary.bounds.x);
}

export function evaluateM7Evidence(evidence) {
	const manual = evidence?.manual ?? {};
	const checks = manual.checks ?? {};
	const gates = [
		{ id: "windows-host", passed: evidence?.system?.platform === "win32", detail: evidence?.system?.platform ?? null },
		{ id: "clean-worktree", passed: evidence?.git?.dirty === false, detail: evidence?.git?.dirty ?? null },
		{ id: "m7-api-freeze", passed: evidence?.apiFreeze?.passed === true, detail: evidence?.apiFreeze?.baseline ?? null },
		...REQUIRED_M7_FIELD_CHECKS.map((id) => ({
			id,
			passed: certificate(checks[id])
				&& (id !== "wgcGlassFallback"
					|| checks[id]?.mode === "unsupported-dom-fallback")
				&& (id !== "mixedDpiExplorerRestart" || mixedDpiTopology(manual.monitors))
				&& (id !== "trayCrashExitSoak"
					|| (Number.isFinite(checks[id]?.durationMinutes) && checks[id].durationMinutes >= 30)),
			detail: checks[id] ?? null,
		})),
	];
	return { passed: gates.every((gate) => gate.passed), gates };
}

// M6 的实机证据模型。所有缺失字段均视为失败，禁止用“人工已测”字符串绕过门禁。

export const REQUIRED_M6_FIELD_CHECKS = Object.freeze([
	"mixedDpiNegativeCoordinates",
	"explorerRestartRecovery",
	"processKillRecovery",
	"escapeTrayNormalExit",
	"backgroundSoak30Minutes",
	"noHelperOrResidualDesktopState",
]);

function finite(value) {
	return Number.isFinite(value);
}

function validCertificate(value) {
	return Boolean(
		value
		&& value.passed === true
		&& typeof value.observedAt === "string"
		&& value.observedAt.length > 0
		&& Array.isArray(value.artifacts)
		&& value.artifacts.length > 0
	);
}

function hasRequiredMixedDpiTopology(monitors) {
	if (!Array.isArray(monitors) || monitors.length < 2) return false;
	const primary = monitors.find((monitor) => monitor?.primary === true);
	if (!primary || !finite(primary?.bounds?.x)) return false;
	const scales = monitors.map((monitor) => Number(monitor?.scale));
	const has100 = scales.some((scale) => Math.abs(scale - 1) < 0.01);
	const has150 = scales.some((scale) => Math.abs(scale - 1.5) < 0.01);
	const hasLeftNegative = monitors.some((monitor) => finite(monitor?.bounds?.x) && monitor.bounds.x < primary.bounds.x);
	return has100 && has150 && hasLeftNegative;
}

function validSoak(check) {
	return validCertificate(check) && finite(check.durationMinutes) && check.durationMinutes >= 30;
}

export function evaluateM6Evidence(evidence) {
	const manual = evidence?.manual ?? {};
	const checks = manual.checks ?? {};
	const gates = [
		{ id: "windows-host", passed: evidence?.system?.platform === "win32", detail: evidence?.system?.platform ?? null },
		{ id: "clean-worktree", passed: evidence?.git?.dirty === false, detail: evidence?.git?.dirty ?? null },
		{ id: "m6-api-freeze", passed: evidence?.apiFreeze?.passed === true, detail: evidence?.apiFreeze?.baseline ?? null },
		{
			id: "mixed-dpi-negative-coordinates",
			passed: hasRequiredMixedDpiTopology(manual.monitors) && validCertificate(checks.mixedDpiNegativeCoordinates),
			detail: { monitors: manual.monitors ?? null, check: checks.mixedDpiNegativeCoordinates ?? null },
		},
		...REQUIRED_M6_FIELD_CHECKS.filter((id) => id !== "mixedDpiNegativeCoordinates").map((id) => ({
			id,
			passed: id === "backgroundSoak30Minutes" ? validSoak(checks[id]) : validCertificate(checks[id]),
			detail: checks[id] ?? null,
		})),
	];
	return { passed: gates.every((gate) => gate.passed), gates };
}

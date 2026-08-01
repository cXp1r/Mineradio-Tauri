export const REQUIRED_MANUAL_CHECKS = Object.freeze([
	"closeExitNoOrphans",
	"trayHideKeepsRuntimeAlive",
	"trayAndSecondInstanceReactivate",
	"desktopLyricsCrossMonitorDpi",
	"customFontLifecycle",
	"cacheAndResourceGovernance",
	"runtimeConsoleClean",
]);

function validScale(value) {
	return Number.isFinite(value) && value > 0;
}

function hasRequiredMonitorEvidence(monitors) {
	if (!Array.isArray(monitors) || monitors.length < 2) return false;
	const primary = monitors.find((monitor) => monitor?.primary === true);
	if (!primary || !Number.isFinite(primary?.bounds?.x)) return false;
	const scales = monitors.map((monitor) => Number(monitor?.scale)).filter(validScale);
	const has100Percent = scales.some((scale) => Math.abs(scale - 1) < 0.01);
	const has150Percent = scales.some((scale) => Math.abs(scale - 1.5) < 0.01);
	const hasLeftDisplay = monitors.some((monitor) =>
		Number.isFinite(monitor?.bounds?.x) && monitor.bounds.x < primary.bounds.x
	);
	return has100Percent && has150Percent && hasLeftDisplay;
}

export function evaluateM5Evidence(evidence) {
	const manual = evidence?.manual ?? {};
	const monitors = manual.monitors ?? evidence?.system?.monitors ?? [];
	const gates = [
		{
			id: "windows-host",
			passed: evidence?.system?.platform === "win32",
			detail: evidence?.system?.platform ?? null,
		},
		{
			id: "clean-worktree",
			passed: evidence?.git?.dirty === false,
			detail: evidence?.git?.dirty ?? null,
		},
		{
			id: "api-freeze",
			passed: evidence?.apiFreeze?.passed === true,
			detail: evidence?.apiFreeze?.baseline ?? null,
		},
		{
			id: "dual-monitor-dpi",
			passed: hasRequiredMonitorEvidence(monitors),
			detail: monitors,
		},
		...REQUIRED_MANUAL_CHECKS.map((id) => ({
			id,
			passed: manual?.checks?.[id] === true,
			detail: manual?.checks?.[id] ?? null,
		})),
	];
	return {
		passed: gates.every((gate) => gate.passed),
		gates,
	};
}

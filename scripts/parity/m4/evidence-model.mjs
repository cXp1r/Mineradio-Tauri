function finiteNumber(value) {
	return Number.isFinite(Number(value)) ? Number(value) : null;
}

function finiteGpuDuration(value) {
	if (value === null || value === undefined || value === "") return null;
	const duration = Number(value);
	return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export const M4_RELEASE_GPU_MINIMUM_SAMPLES = 240;

export const M4_RELEASE_PERFORMANCE_BUDGETS = Object.freeze({
	frameP95RegressionRatio: 1.1,
	sonic: Object.freeze({
		high: Object.freeze({ cpuP95Ms: 1.5, gpuP95DeltaMs: 5 }),
		ultra: Object.freeze({ cpuP95Ms: 2.5, gpuP95DeltaMs: 8 }),
	}),
});

export function resolveSonicEvidenceQuality(profile, requestedQuality) {
	if (["eco", "balanced", "high", "ultra"].includes(requestedQuality)) return requestedQuality;
	return profile === "release" ? "high" : "eco";
}

function check(id, condition, actual, expected, severity = "hard") {
	return {
		id,
		severity,
		status: condition ? "pass" : "fail",
		actual,
		expected,
	};
}

function sumGateErrors(gates) {
	return Object.values(gates ?? {}).reduce((total, gate) => total + Math.max(0, Number(gate?.errors) || 0), 0);
}

function poolSize(pool) {
	return Math.max(0, Number(pool?.active) || 0) + Math.max(0, Number(pool?.idle) || 0);
}

export function parseConsoleErrorCount(output) {
	if (typeof output !== "string") return null;
	const match = output.match(/\bErrors:\s*(\d+)\b/i);
	return match ? Math.max(0, Number.parseInt(match[1], 10)) : null;
}

export function classifyGpuTiming({ renderer, webgl, frames }) {
	const rawTiming = renderer?.gpuTiming ?? null;
	const extensionSupported = Boolean(
		rawTiming?.extensionSupported
		|| renderer?.gpuTimerQuerySupported
		|| webgl?.timerQuerySupported,
	);
	const sampleCount = Math.max(0, Math.floor(Number(rawTiming?.sampleCount) || 0));
	const p50Ms = finiteGpuDuration(rawTiming?.p50Ms);
	const p95Ms = finiteGpuDuration(rawTiming?.p95Ms);
	const measured = extensionSupported && sampleCount > 0 && p50Ms !== null && p95Ms !== null;
	return {
		status: measured ? "measured" : extensionSupported ? "proxy" : "unavailable",
		measured,
		extensionSupported,
		sampleCount,
		p50Ms: measured ? p50Ms : null,
		p95Ms: measured ? p95Ms : null,
		pendingQueryCount: Math.max(0, Math.floor(Number(rawTiming?.pendingQueryCount) || 0)),
		disjointQueryCount: Math.max(0, Math.floor(Number(rawTiming?.disjointQueryCount) || 0)),
		droppedQueryCount: Math.max(0, Math.floor(Number(rawTiming?.droppedQueryCount) || 0)),
		errorCount: Math.max(0, Math.floor(Number(rawTiming?.errorCount) || 0)),
		contextLost: Boolean(rawTiming?.contextLost),
		proxy: extensionSupported && !measured
			? {
				frameCostP50Ms: finiteNumber(frames?.frameCostP50Ms),
				frameCostP95Ms: finiteNumber(frames?.frameCostP95Ms),
				drawCalls: finiteNumber(renderer?.drawCalls),
				triangles: finiteNumber(renderer?.triangles),
				points: finiteNumber(renderer?.points),
				lines: finiteNumber(renderer?.lines),
			}
			: null,
		reason: measured
			? "GPU frame cost was measured with resolved EXT_disjoint_timer_query_webgl2 queries issued around the production presentation render."
			: extensionSupported
			? "EXT_disjoint_timer_query_webgl2 capability was observed, but this run did not issue or resolve GPU timer queries; CPU frame cost and renderer counters are proxy evidence only."
			: "EXT_disjoint_timer_query_webgl2 was unavailable; no GPU timing was measured.",
	};
}

export function projectRuntimeEvidence(snapshot, webgl) {
	const performance = snapshot?.performance ?? {};
	return {
		performance: { ...(performance.frames ?? {}) },
		gates: { ...(performance.gates ?? {}) },
		resources: { ...(performance.resources ?? {}) },
		tasks: { ...(performance.tasks ?? {}) },
		subsystems: { ...(performance.subsystems ?? {}) },
		renderer: snapshot?.renderer ? { ...snapshot.renderer } : null,
		webgl: webgl ? { ...webgl } : null,
		gpuTiming: classifyGpuTiming({
			renderer: snapshot?.renderer,
			webgl,
			frames: performance.frames,
		}),
	};
}

export function evaluateSceneChecks(scene, snapshot, environment, options = {}) {
	const performance = snapshot?.performance ?? {};
	const runtime = performance.runtime ?? {};
	const tasks = performance.tasks ?? {};
	const resources = performance.resources ?? {};
	const subsystems = performance.subsystems ?? {};
	const renderer = snapshot?.renderer ?? null;
	const viewport = environment?.viewport ?? {};
	const checks = [
		check("runtime.ready", snapshot?.ready === true, snapshot?.ready ?? null, true),
		check("runtime.scene", snapshot?.scene === scene, snapshot?.scene ?? null, scene),
		check("runtime.mounted", runtime.mounted === true, runtime.mounted ?? null, true),
		check("runtime.running", runtime.running === true, runtime.running ?? null, true),
		check("viewport.1920x1080", viewport.width === 1_920 && viewport.height === 1_080, viewport, { width: 1_920, height: 1_080 }),
		check("viewport.dpr", environment?.devicePixelRatio === 1, environment?.devicePixelRatio ?? null, 1),
		check("webgl.webgl2", environment?.webgl?.webgl2 === true, environment?.webgl?.webgl2 ?? null, true),
		check("tasks.failed", Number(tasks.failed) === 0, Number(tasks.failed) || 0, 0),
		check("gates.errors", sumGateErrors(performance.gates) === 0, sumGateErrors(performance.gates), 0),
		check("resources.pressure", resources.pressure !== "hard", resources.pressure ?? null, "normal|soft"),
		check("renderer.present", renderer !== null, renderer !== null, true),
	];
	if (Object.prototype.hasOwnProperty.call(options, "expectedCommit")) {
		checks.push(check(
			"preview.build-commit",
			environment?.buildCommit === options.expectedCommit,
			environment?.buildCommit ?? null,
			options.expectedCommit,
		));
	}
	if (Object.prototype.hasOwnProperty.call(options, "consoleErrors")) {
		const consoleErrorCount = parseConsoleErrorCount(options.consoleErrors);
		checks.push(check(
			"console.errors",
			consoleErrorCount === 0,
			consoleErrorCount,
			0,
		));
	}
	const gpuTiming = classifyGpuTiming({
		renderer,
		webgl: environment?.webgl,
		frames: performance.frames,
	});
	if (options.profile === "release" && options.strict === true) {
		checks.push(check(
			"gpu.timer-query-samples",
			gpuTiming.extensionSupported
				&& gpuTiming.measured
				&& gpuTiming.sampleCount >= M4_RELEASE_GPU_MINIMUM_SAMPLES,
			{
				extensionSupported: gpuTiming.extensionSupported,
				measured: gpuTiming.measured,
				sampleCount: gpuTiming.sampleCount,
				p95Ms: gpuTiming.p95Ms,
			},
			{
				extensionSupported: true,
				measured: true,
				sampleCount: `>= ${M4_RELEASE_GPU_MINIMUM_SAMPLES}`,
				p95Ms: "real timer-query duration",
			},
		));
	}

	if (scene === "stage") {
		const stage = subsystems["stage-lyrics"] ?? {};
		checks.push(
			check("stage.resident-rows", Number(stage.residentRows) > 0, Number(stage.residentRows) || 0, "> 0"),
			check("stage.pending-builds", Number(stage.activeBuilds) === 0 && Number(stage.pendingBuilds) === 0, {
				activeBuilds: Number(stage.activeBuilds) || 0,
				pendingBuilds: Number(stage.pendingBuilds) || 0,
			}, { activeBuilds: 0, pendingBuilds: 0 }),
			check("stage.pending-uploads", Number(stage.pendingUploads) === 0, Number(stage.pendingUploads) || 0, 0),
			check("stage.upload-budget", Number(stage.uploadsThisFrame) <= 1, Number(stage.uploadsThisFrame) || 0, "<= 1"),
		);
	}

	if (scene === "sonic") {
		const sonic = subsystems.sonicTopography ?? {};
		checks.push(
			check("sonic.active", sonic.active === true, sonic.active ?? null, true),
			check("sonic.mesh-count", Number(sonic.meshCount) === 4, Number(sonic.meshCount) || 0, 4),
			check("sonic.resident-mesh-count", Number(sonic.residentMeshCount) === 4, Number(sonic.residentMeshCount) || 0, 4),
			check("sonic.pending-rebuilds", Number(sonic.pendingRebuilds) === 0, Number(sonic.pendingRebuilds) || 0, 0),
			check("sonic.build-failures", Number(sonic.buildFailures) === 0, Number(sonic.buildFailures) || 0, 0),
			check("sonic.geometry-pressure", sonic.geometryPressure !== "hard", sonic.geometryPressure ?? null, "normal|soft"),
		);
		if (options.profile === "release" && options.strict === true) {
			const quality = snapshot?.sonicQuality ?? sonic.quality ?? options.sonicQuality ?? null;
			const requestedQuality = options.sonicQuality ?? quality;
			const budget = M4_RELEASE_PERFORMANCE_BUDGETS.sonic[quality] ?? null;
			const sonicCpuP95Ms = finiteGpuDuration(performance.gates?.["sonic-topography"]?.costP95Ms);
			const gpuBaselineP95Ms = finiteGpuDuration(options.performanceBaseline?.gpuP95Ms);
			const baselineSourceCommit = typeof options.performanceBaseline?.sourceCommit === "string"
				? options.performanceBaseline.sourceCommit.trim()
				: "";
			const baselineSourceManifest = typeof options.performanceBaseline?.sourceManifest === "string"
				? options.performanceBaseline.sourceManifest.trim()
				: "";
			const gpuP95DeltaMs = gpuTiming.p95Ms !== null && gpuBaselineP95Ms !== null
				? gpuTiming.p95Ms - gpuBaselineP95Ms
				: null;
			const frameP95Ms = finiteGpuDuration(performance.frames?.frameCostP95Ms);
			const frameBaselineP95Ms = finiteGpuDuration(options.performanceBaseline?.frameP95Ms);
			const frameP95LimitMs = frameBaselineP95Ms !== null
				? frameBaselineP95Ms * M4_RELEASE_PERFORMANCE_BUDGETS.frameP95RegressionRatio
				: null;

			checks.push(
				check(
					"performance.baseline-source",
					baselineSourceCommit.length > 0 && baselineSourceManifest.length > 0,
					{
						commit: baselineSourceCommit || null,
						manifest: baselineSourceManifest || null,
					},
					{ commit: "required", manifest: "required" },
				),
				check(
					"sonic.release-quality",
					budget !== null && quality === requestedQuality,
					quality,
					requestedQuality ?? "high|ultra",
				),
				check(
					"sonic.cpu-p95",
					budget !== null && sonicCpuP95Ms !== null && sonicCpuP95Ms <= budget.cpuP95Ms,
					sonicCpuP95Ms,
					budget ? `<= ${budget.cpuP95Ms}ms` : "quality-specific budget",
				),
				check(
					"sonic.gpu-p95-delta",
					budget !== null && gpuP95DeltaMs !== null && gpuP95DeltaMs <= budget.gpuP95DeltaMs,
					{
						baselineP95Ms: gpuBaselineP95Ms,
						currentP95Ms: gpuTiming.p95Ms,
						deltaP95Ms: gpuP95DeltaMs,
					},
					budget
						? { baselineP95Ms: "required", currentP95Ms: "required", deltaP95Ms: `<= ${budget.gpuP95DeltaMs}ms` }
						: { quality: "high|ultra" },
				),
				check(
					"runtime.frame-p95-regression",
					frameP95Ms !== null && frameP95LimitMs !== null && frameP95Ms <= frameP95LimitMs,
					{
						baselineP95Ms: frameBaselineP95Ms,
						currentP95Ms: frameP95Ms,
					},
					{
						baselineP95Ms: "required",
						currentP95Ms: `<= baseline * ${M4_RELEASE_PERFORMANCE_BUDGETS.frameP95RegressionRatio}`,
					},
				),
			);
		}
	}

	if (scene === "shelf") {
		const shelf = subsystems.shelf ?? {};
		const cards = shelf.cards ?? {};
		const detailRows = shelf.detailRows ?? {};
		checks.push(
			check("shelf.card-capacity", Number(cards.capacity) === 11, Number(cards.capacity) || 0, 11),
			check("shelf.card-created", Number(cards.created) <= 11, Number(cards.created) || 0, "<= 11"),
			check("shelf.card-resident", poolSize(cards) <= 11, poolSize(cards), "<= 11"),
			check("shelf.detail-capacity", Number(detailRows.capacity) === 11, Number(detailRows.capacity) || 0, 11),
			check("shelf.detail-created", Number(detailRows.created) <= 11, Number(detailRows.created) || 0, "<= 11"),
			check("shelf.detail-resident", poolSize(detailRows) <= 11, poolSize(detailRows), "<= 11"),
			check("shelf.detail-panels", Number(shelf.detailPanels) <= 1, Number(shelf.detailPanels) || 0, "<= 1"),
		);
	}

	return checks;
}

export function evaluateRunChecks(repository, options = {}) {
	const checks = [];
	if (options.profile === "release" && options.strict === true) {
		checks.push(check(
			"repository.clean",
			repository?.dirty === false,
			repository?.dirty ?? null,
			false,
		));
	}
	return checks;
}

export function summarizeChecks(sceneResults) {
	const checks = sceneResults.flatMap((scene) => scene.checks ?? []);
	const hardFailures = checks.filter((item) => item.severity === "hard" && item.status === "fail");
	return {
		status: hardFailures.length === 0 ? "pass" : "fail",
		total: checks.length,
		passed: checks.filter((item) => item.status === "pass").length,
		failed: checks.filter((item) => item.status === "fail").length,
		hardFailures: hardFailures.map((item) => item.id),
	};
}

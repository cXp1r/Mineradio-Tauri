export const M8_WINDOWS_RELEASE_PROTOCOL = Object.freeze({
	coldStartRuns: 5,
	warmupSeconds: 10,
	sampleSeconds: 60,
	sampleRuns: 3,
	sampleIntervalMs: 1_000,
});

const OPTIONAL_METRIC_NAMES = Object.freeze([
	"gpuMemory",
	"frameTime",
	"packageSize",
]);

const FIELD_VALIDATION_NAMES = Object.freeze([
	"lowEndDevice",
	"webView2Upgrade",
	"windowsSoak",
]);

function assertFiniteNonNegative(value, label) {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${label} 必须是非负有限数值`);
	}
}

function median(values) {
	if (!Array.isArray(values) || values.length === 0) {
		throw new Error("中位数至少需要一个样本");
	}
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function percentile(values, ratio) {
	if (!Array.isArray(values) || values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * ratio) - 1),
	);
	return sorted[index];
}

function summarizeSteadyRun(run, index) {
	if (run?.warmupSeconds !== M8_WINDOWS_RELEASE_PROTOCOL.warmupSeconds) {
		throw new Error(`steadyStateRuns[${index}].warmupSeconds 必须为 10`);
	}
	if (run?.sampleSeconds !== M8_WINDOWS_RELEASE_PROTOCOL.sampleSeconds) {
		throw new Error(`steadyStateRuns[${index}].sampleSeconds 必须为 60`);
	}
	if (run?.sampleIntervalMs !== M8_WINDOWS_RELEASE_PROTOCOL.sampleIntervalMs) {
		throw new Error(`steadyStateRuns[${index}].sampleIntervalMs 必须为 1000`);
	}
	const expectedSamples =
		(M8_WINDOWS_RELEASE_PROTOCOL.sampleSeconds * 1_000) /
		M8_WINDOWS_RELEASE_PROTOCOL.sampleIntervalMs;
	if (!Array.isArray(run?.samples) || run.samples.length !== expectedSamples) {
		throw new Error(
			`steadyStateRuns[${index}] 必须包含 ${expectedSamples} 个采样点`,
		);
	}

	for (const [sampleIndex, sample] of run.samples.entries()) {
		for (const metric of ["cpuPercent", "workingSetBytes", "privateBytes"]) {
			assertFiniteNonNegative(
				Number(sample?.[metric]),
				`steadyStateRuns[${index}].samples[${sampleIndex}].${metric}`,
			);
		}
	}

	const cpu = run.samples.map((sample) => Number(sample.cpuPercent));
	const workingSet = run.samples.map((sample) => Number(sample.workingSetBytes));
	const privateBytes = run.samples.map((sample) => Number(sample.privateBytes));
	const gpuMemory = run.samples
		.map((sample) => Number(sample.gpuMemoryBytes))
		.filter(Number.isFinite);
	const frameTime = run.samples
		.map((sample) => Number(sample.frameTimeMs))
		.filter(Number.isFinite);

	return {
		run: index + 1,
		warmupSeconds: run.warmupSeconds,
		sampleSeconds: run.sampleSeconds,
		sampleIntervalMs: run.sampleIntervalMs,
		samples: run.samples,
		summary: {
			cpuMedianPercent: median(cpu),
			workingSetMedianBytes: median(workingSet),
			workingSetPeakBytes: Math.max(...workingSet),
			privateBytesMedian: median(privateBytes),
			privateBytesPeak: Math.max(...privateBytes),
			gpuMemoryMedianBytes: gpuMemory.length ? median(gpuMemory) : null,
			gpuMemoryPeakBytes: gpuMemory.length ? Math.max(...gpuMemory) : null,
			frameTimeP50Ms: percentile(frameTime, 0.5),
			frameTimeP95Ms: percentile(frameTime, 0.95),
		},
	};
}

function normalizeOptionalMetrics(optionalMetrics = {}) {
	return Object.fromEntries(
		OPTIONAL_METRIC_NAMES.map((name) => {
			const metric = optionalMetrics[name] ?? {
				status: "pending",
				note: "尚未采集",
			};
			if (!["captured", "required-manual", "pending"].includes(metric.status)) {
				throw new Error(`${name}.status 无效: ${String(metric.status)}`);
			}
			return [name, metric];
		}),
	);
}

function optionalMetricCaptured(name, metric) {
	if (metric?.status !== "captured") return false;
	if (name === "gpuMemory") {
		return Number.isFinite(metric.medianBytes) &&
			metric.medianBytes >= 0 &&
			Number.isFinite(metric.peakBytes) &&
			metric.peakBytes >= metric.medianBytes;
	}
	if (name === "frameTime") {
		return Number.isFinite(metric.p50Ms) &&
			metric.p50Ms >= 0 &&
			Number.isFinite(metric.p95Ms) &&
			metric.p95Ms >= metric.p50Ms;
	}
	return Number.isSafeInteger(metric.bytes) && metric.bytes > 0;
}

function normalizeFieldValidation(fieldValidation = {}) {
	const defaultNotes = {
		lowEndDevice: "真实低配实体机验证待补",
		webView2Upgrade: "真实旧版本 WebView2 升级目录验证待补",
		windowsSoak: "Windows 30–60 分钟 soak 待补",
	};
	return Object.fromEntries(
		FIELD_VALIDATION_NAMES.map((name) => {
			const check = fieldValidation[name] ?? {
				status: "required-manual",
				note: defaultNotes[name],
			};
			if (!["captured", "required-manual", "pending"].includes(check.status)) {
				throw new Error(`${name}.status 无效: ${String(check.status)}`);
			}
			return [name, check];
		}),
	);
}

function fieldValidationCaptured(name, check) {
	if (check?.status !== "captured" || check?.verified !== true) return false;
	if (!Array.isArray(check.artifactPaths) || check.artifactPaths.length === 0) {
		return false;
	}
	if (name === "windowsSoak") {
		return Number.isFinite(check.durationSeconds) && check.durationSeconds >= 1_800;
	}
	return true;
}

export function buildM8WindowsReleaseEvidence(input) {
	if (!Array.isArray(input?.coldStarts) ||
		input.coldStarts.length !== M8_WINDOWS_RELEASE_PROTOCOL.coldStartRuns) {
		throw new Error("M8 release evidence 必须包含恰好 5 次冷启动");
	}
	for (const [index, sample] of input.coldStarts.entries()) {
		assertFiniteNonNegative(Number(sample?.readyMs), `coldStarts[${index}].readyMs`);
		if (sample?.readiness !== "main-window") {
			throw new Error(`coldStarts[${index}].readiness 必须为 main-window`);
		}
	}
	if (!Array.isArray(input?.steadyStateRuns) ||
		input.steadyStateRuns.length !== M8_WINDOWS_RELEASE_PROTOCOL.sampleRuns) {
		throw new Error("M8 release evidence 必须包含恰好 3 轮稳态采样");
	}

	const steadyStateRuns = input.steadyStateRuns.map(summarizeSteadyRun);
	const optionalMetrics = normalizeOptionalMetrics(input.optionalMetrics);
	const fieldValidation = normalizeFieldValidation(input.fieldValidation);
	const evidence = {
		schemaVersion: 1,
		milestone: "M8",
		capturedAt: input.capturedAt,
		git: input.git,
		host: input.host,
		target: input.target,
		protocol: { ...M8_WINDOWS_RELEASE_PROTOCOL },
		coldStarts: input.coldStarts,
		steadyStateRuns,
		optionalMetrics,
		fieldValidation,
		summary: {
			coldStartMedianMs: median(
				input.coldStarts.map((sample) => Number(sample.readyMs)),
			),
			cpuMedianPercent: median(
				steadyStateRuns.map((run) => run.summary.cpuMedianPercent),
			),
			workingSetMedianBytes: median(
				steadyStateRuns.map((run) => run.summary.workingSetMedianBytes),
			),
			workingSetPeakBytes: Math.max(
				...steadyStateRuns.map((run) => run.summary.workingSetPeakBytes),
			),
			privateBytesMedian: median(
				steadyStateRuns.map((run) => run.summary.privateBytesMedian),
			),
			privateBytesPeak: Math.max(
				...steadyStateRuns.map((run) => run.summary.privateBytesPeak),
			),
		},
	};
	evidence.evaluation = evaluateM8WindowsReleaseEvidence(evidence);
	return evidence;
}

export function evaluateM8WindowsReleaseEvidence(evidence) {
	const protocolValid =
		evidence?.schemaVersion === 1 &&
		evidence?.milestone === "M8" &&
		evidence?.protocol?.coldStartRuns === 5 &&
		evidence?.protocol?.warmupSeconds === 10 &&
		evidence?.protocol?.sampleSeconds === 60 &&
		evidence?.protocol?.sampleRuns === 3 &&
		evidence?.protocol?.sampleIntervalMs === 1_000;
	const coreMetricsCaptured =
		Array.isArray(evidence?.coldStarts) &&
		evidence.coldStarts.length === 5 &&
		Array.isArray(evidence?.steadyStateRuns) &&
		evidence.steadyStateRuns.length === 3 &&
		Number.isFinite(evidence?.summary?.coldStartMedianMs) &&
		Number.isFinite(evidence?.summary?.cpuMedianPercent) &&
		Number.isFinite(evidence?.summary?.workingSetMedianBytes) &&
		Number.isFinite(evidence?.summary?.privateBytesPeak);
	const pendingFields = OPTIONAL_METRIC_NAMES.filter(
		(name) => !optionalMetricCaptured(name, evidence?.optionalMetrics?.[name]),
	).concat(
		FIELD_VALIDATION_NAMES.filter(
			(name) => !fieldValidationCaptured(name, evidence?.fieldValidation?.[name]),
		),
	);
	const codeCompletePassed = protocolValid && coreMetricsCaptured;
	const fieldValidated =
		codeCompletePassed &&
		evidence?.host?.platform === "win32" &&
		evidence?.git?.dirty === false &&
		pendingFields.length === 0;

	return {
		codeCompletePassed,
		fieldValidated,
		status: fieldValidated ? "field-validated" : "field-validation-pending",
		nonBlocking: !fieldValidated,
		pendingFields,
		gates: [
			{ id: "fixed-release-protocol", passed: protocolValid },
			{ id: "core-process-metrics", passed: coreMetricsCaptured },
			{ id: "windows-host", passed: evidence?.host?.platform === "win32" },
			{ id: "clean-worktree", passed: evidence?.git?.dirty === false },
			...OPTIONAL_METRIC_NAMES.map((name) => ({
				id: name,
				passed: optionalMetricCaptured(name, evidence?.optionalMetrics?.[name]),
				status: evidence?.optionalMetrics?.[name]?.status ?? "pending",
			})),
			...FIELD_VALIDATION_NAMES.map((name) => ({
				id: name,
				passed: fieldValidationCaptured(name, evidence?.fieldValidation?.[name]),
				status: evidence?.fieldValidation?.[name]?.status ?? "pending",
				nonBlocking: true,
			})),
		],
	};
}

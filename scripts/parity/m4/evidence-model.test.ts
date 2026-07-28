import { describe, expect, test } from "bun:test";
import {
	classifyGpuTiming,
	evaluateRunChecks,
	evaluateSceneChecks,
	parseConsoleErrorCount,
	projectRuntimeEvidence,
} from "./evidence-model.mjs";

function makeSnapshot(overrides: Record<string, unknown> = {}) {
	return {
		ready: true,
		scene: "stage",
		mode: "deterministic",
		seed: 20_240_728,
		clockMs: 4_200,
		performance: {
			runtime: { mode: "foreground", running: true, mounted: true, generation: 1 },
			frames: {
				rafTicks: 120,
				timerTicks: 0,
				renders: 120,
				skippedRenders: 0,
				frameCostP50Ms: 1,
				frameCostP95Ms: 4,
				longFrames: 0,
			},
			gates: { presentation: { runs: 120, skips: 0, effectiveFps: 60, pendingDtSec: 0, costP50Ms: 1, costP95Ms: 3, errors: 0 } },
			resources: {
				current: { textureBytes: 10, geometryBytes: 20, meshCount: 6, queuedTaskCost: 0, cacheBytes: 0 },
				peak: { textureBytes: 10, geometryBytes: 20, meshCount: 6, queuedTaskCost: 0, cacheBytes: 0 },
				budget: { textureBytes: 100, geometryBytes: 100, meshCount: 100, queuedTaskCost: 100, cacheBytes: 100 },
				pressure: "normal",
				allocations: 6,
				releases: 0,
			},
			tasks: { queued: 0, running: 0, completed: 4, cancelled: 0, staleResultsDropped: 0, failed: 0, peakQueueDepth: 2 },
			subsystems: {
				"stage-lyrics": { activeBuilds: 0, pendingBuilds: 0, pendingUploads: 0, uploadsThisFrame: 1, residentRows: 5 },
			},
		},
		renderer: {
			drawCalls: 4,
			triangles: 20,
			points: 30,
			lines: 0,
			geometries: 4,
			textures: 5,
			gpuTimerQuerySupported: true,
		},
		...overrides,
	};
}

describe("M4 evidence model", () => {
	test("timer-query capability without actual query samples remains a proxy", () => {
		const timing = classifyGpuTiming({
			renderer: makeSnapshot().renderer,
			webgl: { timerQuerySupported: true },
			frames: makeSnapshot().performance.frames,
		});

		expect(timing.status).toBe("proxy");
		expect(timing.measured).toBe(false);
		expect(timing.sampleCount).toBe(0);
		expect(timing.p50Ms).toBeNull();
		expect(timing.p95Ms).toBeNull();
	});

	test("missing timer-query capability is unavailable rather than measured", () => {
		const timing = classifyGpuTiming({
			renderer: { gpuTimerQuerySupported: false },
			webgl: { timerQuerySupported: false },
			frames: makeSnapshot().performance.frames,
		});

		expect(timing.status).toBe("unavailable");
		expect(timing.measured).toBe(false);
		expect(timing.p95Ms).toBeNull();
	});

	test("真实 timer-query samples 会被标记为 measured", () => {
		const timing = classifyGpuTiming({
			renderer: {
				...makeSnapshot().renderer,
				gpuTiming: {
					extensionSupported: true,
					sampleCount: 3,
					pendingQueryCount: 1,
					p50Ms: 1.25,
					p95Ms: 2.75,
					disjointQueryCount: 0,
					droppedQueryCount: 0,
					errorCount: 0,
					contextLost: false,
				},
			},
			webgl: { timerQuerySupported: true },
			frames: makeSnapshot().performance.frames,
		});

		expect(timing.status).toBe("measured");
		expect(timing.measured).toBe(true);
		expect(timing.sampleCount).toBe(3);
		expect(timing.p50Ms).toBe(1.25);
		expect(timing.p95Ms).toBe(2.75);
	});

	test("release profile 在支持扩展时把缺少真实 sample 作为硬失败", () => {
		const checks = evaluateSceneChecks("stage", makeSnapshot(), {
			viewport: { width: 1_920, height: 1_080 },
			devicePixelRatio: 1,
			webgl: { webgl2: true, timerQuerySupported: true },
		}, { profile: "release", strict: true });

		expect(checks.find((check) => check.id === "gpu.timer-query-samples")).toMatchObject({
			severity: "hard",
			status: "fail",
		});
	});

	test("release strict 在缺少 timer-query 扩展时也必须失败", () => {
		const snapshot = makeSnapshot({
			renderer: { ...makeSnapshot().renderer, gpuTimerQuerySupported: false },
		});
		const checks = evaluateSceneChecks("stage", snapshot, {
			viewport: { width: 1_920, height: 1_080 },
			devicePixelRatio: 1,
			webgl: { webgl2: true, timerQuerySupported: false },
		}, { profile: "release", strict: true });

		expect(checks.find((check) => check.id === "gpu.timer-query-samples")).toMatchObject({
			severity: "hard",
			status: "fail",
		});
	});

	test("console error count 会进入 scene hard gate", () => {
		const output = "Total messages: 2 (Errors: 2, Warnings: 0)\n\n[ERROR] first\n[ERROR] second";
		expect(parseConsoleErrorCount(output)).toBe(2);
		const checks = evaluateSceneChecks("stage", makeSnapshot(), {
			viewport: { width: 1_920, height: 1_080 },
			devicePixelRatio: 1,
			webgl: { webgl2: true, timerQuerySupported: true },
		}, { consoleErrors: output });

		expect(checks.find((check) => check.id === "console.errors")).toMatchObject({
			severity: "hard",
			status: "fail",
			actual: 2,
		});
	});

	test("preview build commit 必须匹配 evidence repository commit", () => {
		const checks = evaluateSceneChecks("stage", makeSnapshot(), {
			viewport: { width: 1_920, height: 1_080 },
			devicePixelRatio: 1,
			webgl: { webgl2: true, timerQuerySupported: true },
			buildCommit: "old-build",
		}, { expectedCommit: "current-head" });

		expect(checks.find((check) => check.id === "preview.build-commit")).toMatchObject({
			severity: "hard",
			status: "fail",
			actual: "old-build",
			expected: "current-head",
		});
	});

	test("release strict 要求 repository clean", () => {
		const checks = evaluateRunChecks(
			{ commit: "abc", branch: "codex/m4", dirty: true },
			{ profile: "release", strict: true },
		);

		expect(checks.find((check) => check.id === "repository.clean")).toMatchObject({
			severity: "hard",
			status: "fail",
		});
	});

	test("stage evidence exposes missing resident rows as a failed hard check", () => {
		const snapshot = makeSnapshot({
			performance: {
				...makeSnapshot().performance,
				subsystems: {
					"stage-lyrics": { activeBuilds: 0, pendingBuilds: 0, pendingUploads: 0, uploadsThisFrame: 0, residentRows: 0 },
				},
			},
		});
		const checks = evaluateSceneChecks("stage", snapshot, {
			viewport: { width: 1_920, height: 1_080 },
			devicePixelRatio: 1,
			webgl: { webgl2: true },
		});

		expect(checks.find((check) => check.id === "stage.resident-rows")?.status).toBe("fail");
	});

	test("runtime projection keeps performance sections distinct", () => {
		const projected = projectRuntimeEvidence(makeSnapshot(), { timerQuerySupported: true });

		expect(projected.performance.frameCostP95Ms).toBe(4);
		expect(projected.resources.current.meshCount).toBe(6);
		expect(projected.tasks.completed).toBe(4);
		expect(projected.subsystems["stage-lyrics"].residentRows).toBe(5);
		expect(projected.renderer.drawCalls).toBe(4);
		expect(projected.gpuTiming.status).toBe("proxy");
	});
});

import { expect, test } from "bun:test";
import { createPerformanceCollector, type VisualResourceBudget } from "../index";

const budget: VisualResourceBudget = {
	textureBytes: 100,
	geometryBytes: 100,
	meshCount: 100,
	queuedTaskCost: 10,
	cacheBytes: 100,
};

test("frame and independent gate percentiles use execution cost samples", () => {
	const collector = createPerformanceCollector({ resourceBudget: budget, capacity: 5 });
	for (const costMs of [1, 2, 3, 4, 5]) collector.recordFrame({ source: "raf", rendered: true, costMs });
	collector.recordGate("lyrics", { run: true, effectiveFps: 60, pendingDtSec: 0, costMs: 2 });
	collector.recordGate("lyrics", { run: false, effectiveFps: 30, pendingDtSec: 0.03 });
	collector.recordGate("shelf", { run: true, effectiveFps: 30, pendingDtSec: 0, costMs: 9, error: new Error("draw") });

	const snapshot = collector.getSnapshot();
	expect(snapshot.frames.frameCostP50Ms).toBe(3);
	expect(snapshot.frames.frameCostP95Ms).toBe(5);
	expect(snapshot.gates.lyrics).toEqual({ runs: 1, skips: 1, effectiveFps: 30, pendingDtSec: 0.03, costP50Ms: 2, costP95Ms: 2, errors: 0 });
	expect(snapshot.gates.shelf).toEqual({ runs: 1, skips: 0, effectiveFps: 30, pendingDtSec: 0, costP50Ms: 9, costP95Ms: 9, errors: 1 });
});

test("timer samples count timers without changing render or RAF cost statistics", () => {
	const collector = createPerformanceCollector({ resourceBudget: budget, longFrameThresholdMs: 50 });
	collector.recordFrame({ source: "raf", rendered: true, costMs: 10 });
	collector.recordFrame({ source: "timer", rendered: true, costMs: 100 });

	expect(collector.getSnapshot().frames).toEqual({
		rafTicks: 1,
		timerTicks: 1,
		renders: 1,
		skippedRenders: 0,
		frameCostP50Ms: 10,
		frameCostP95Ms: 10,
		longFrames: 0,
	});
});

test("collector projects task and resource snapshots and returns deep copies", () => {
	const collector = createPerformanceCollector({ resourceBudget: budget });
	collector.setRuntimeState({ mode: "foreground", running: true, mounted: true, generation: 4 });
	collector.setTaskSnapshot({ queued: 2, running: 1, completed: 3, cancelled: 4, staleResultsDropped: 5, failed: 6, peakQueueDepth: 7 });
	collector.setResourceSnapshot({
		current: { textureBytes: 1, geometryBytes: 2, meshCount: 3, queuedTaskCost: 4, cacheBytes: 5 },
		peak: { textureBytes: 6, geometryBytes: 7, meshCount: 8, queuedTaskCost: 9, cacheBytes: 10 },
		budget,
		pressure: "soft",
		allocations: 11,
		releases: 12,
	});
	const subsystemSource = { stageLyrics: { pendingBuilds: 2 } };
	collector.setSubsystemSnapshot(subsystemSource);
	const first = collector.getSnapshot();
	(first.resources.current as { textureBytes: number }).textureBytes = 99;
	(first.gates as Record<string, unknown>).newGate = {};
	subsystemSource.stageLyrics.pendingBuilds = 99;

	const second = collector.getSnapshot();
	expect(second.runtime).toEqual({ mode: "foreground", running: true, mounted: true, generation: 4 });
	expect(second.tasks.completed).toBe(3);
	expect(second.tasks.failed).toBe(6);
	expect(second.resources.current.textureBytes).toBe(1);
	expect(second.resources.peak.cacheBytes).toBe(10);
	expect(second.resources.pressure).toBe("soft");
	expect(second.resources.allocations).toBe(11);
	expect(second.resources.releases).toBe(12);
	expect(second.subsystems.stageLyrics).toEqual({ pendingBuilds: 2 });
	expect(Object.isFrozen(first.subsystems)).toBe(true);
	expect(Object.isFrozen(first.subsystems.stageLyrics)).toBe(true);
});

test("a full collector keeps percentile samples within its fixed capacity", () => {
	const collector = createPerformanceCollector({ resourceBudget: budget, capacity: 3 });
	for (const costMs of [1, 2, 3, 40, 50]) {
		collector.recordFrame({ source: "raf", rendered: true, costMs });
	}

	expect(collector.getSnapshot().frames.frameCostP50Ms).toBe(40);
	expect(collector.getSnapshot().frames.frameCostP95Ms).toBe(50);
});

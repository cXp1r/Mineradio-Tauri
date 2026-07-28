import { expect, test } from "bun:test";
import { createBudgetTaskQueue } from "../../runtime/budget-task-queue";
import { createCancellationScope } from "../../runtime/cancellation-scope";
import { createVisualResourceLedger } from "../../runtime/resource-ledger";
import { createVisualResourceScope } from "../../runtime/resource-scope";
import {
	createStageBuildCoordinator,
	createStageBuildResourceStack,
	type StageLyricBuildJob,
} from "./stage-build-coordinator";

function makeHarness() {
	const resourceScope = createVisualResourceScope("stage-build-test");
	const cancellationScope = createCancellationScope("stage-build-test");
	const ledger = createVisualResourceLedger({
		budget: {
			textureBytes: 1024,
			geometryBytes: 1024,
			meshCount: 10,
			queuedTaskCost: 10,
			cacheBytes: 1024,
		},
	});
	const queue = createBudgetTaskQueue({ resourceScope, cancellationScope, ledger });
	return { queue, resourceScope, cancellationScope };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

test("coordinator advances exactly one resumable phase per queue slice", async () => {
	const { queue } = makeHarness();
	const phases: number[] = [];
	const completed: string[] = [];
	let aborts = 0;
	const coordinator = createStageBuildCoordinator({ queue });
	const job: StageLyricBuildJob<string> = {
		owner: "stage",
		key: "current-row",
		generation: 1,
		priority: "critical",
		cost: 1,
		step(signal, continuation) {
			if (continuation.phase === 0) signal.addEventListener("abort", () => { aborts += 1; }, { once: true });
			phases.push(continuation.phase);
			return continuation.phase === 0
				? { status: "continue", continuation: { phase: 1, label: "raster" } }
				: { status: "complete", result: "ready" };
		},
		cancel() {},
	};
	expect(coordinator.submit(job, (result) => completed.push(result))).toBe(true);
	expect(queue.runSlice(1)).toBe(1);
	await flush();
	expect(phases).toEqual([0]);
	expect(completed).toEqual([]);
	expect(aborts).toBe(0);
	expect(queue.runSlice(1)).toBe(1);
	await coordinator.whenIdle();
	expect(phases).toEqual([0, 1]);
	expect(completed).toEqual(["ready"]);
	expect(aborts).toBe(0);
});

test("replacement cancels the old generation and rejects its late completion", async () => {
	const { queue } = makeHarness();
	const cancelled: number[] = [];
	const completed: number[] = [];
	let oldSignalAborts = 0;
	let resolveOld!: (value: { status: "complete"; result: number }) => void;
	const oldResult = new Promise<{ status: "complete"; result: number }>((resolve) => { resolveOld = resolve; });
	const coordinator = createStageBuildCoordinator({ queue });
	coordinator.submit({
		owner: "stage",
		key: "current-row",
		generation: 1,
		priority: "critical",
		cost: 1,
		step: (signal) => {
			signal.addEventListener("abort", () => { oldSignalAborts += 1; }, { once: true });
			return oldResult;
		},
		cancel: () => cancelled.push(1),
	}, (result) => completed.push(result));
	queue.runSlice(1);
	coordinator.submit({
		owner: "stage",
		key: "current-row",
		generation: 2,
		priority: "critical",
		cost: 1,
		step: () => ({ status: "complete", result: 2 }),
		cancel: () => cancelled.push(2),
	}, (result) => completed.push(result));
	resolveOld({ status: "complete", result: 1 });
	await flush();
	queue.runSlice(1);
	await coordinator.whenIdle();
	expect(cancelled).toEqual([1]);
	expect(completed).toEqual([2]);
	expect(oldSignalAborts).toBe(1);
});

test("resource stack releases partial build resources in reverse order exactly once", () => {
	const released: string[] = [];
	const stack = createStageBuildResourceStack();
	stack.defer(() => released.push("canvas"));
	stack.defer(() => released.push("texture"));
	stack.dispose();
	stack.dispose();
	expect(released).toEqual(["texture", "canvas"]);
});

test("failed build phase cancels the job and releases partial resources", async () => {
	const { queue } = makeHarness();
	const released: string[] = [];
	const resources = createStageBuildResourceStack();
	resources.defer(() => released.push("mask"));
	const coordinator = createStageBuildCoordinator({ queue });
	coordinator.submit({
		owner: "stage",
		key: "failure",
		generation: 1,
		priority: "critical",
		cost: 1,
		step: () => { throw new Error("raster failed"); },
		cancel: () => resources.dispose(),
	}, () => { throw new Error("must not commit"); });
	queue.runSlice(1);
	await coordinator.whenIdle();
	expect(released).toEqual(["mask"]);
	expect(coordinator.getDiagnostics().activeJobs).toBe(0);
});

test("a failing completion callback is counted and cleaned up exactly once", async () => {
	const { queue } = makeHarness();
	let cancelCount = 0;
	const coordinator = createStageBuildCoordinator({ queue });
	coordinator.submit({
		owner: "stage",
		key: "commit-failure",
		generation: 1,
		priority: "critical",
		cost: 1,
		step: () => ({ status: "complete", result: "ready" }),
		cancel: () => { cancelCount += 1; },
	}, () => { throw new Error("scene commit failed"); });
	queue.runSlice(1);
	await coordinator.whenIdle();
	expect(cancelCount).toBe(1);
	expect(coordinator.getDiagnostics().failed).toBe(1);
});

test("a build that becomes stale before commit is cancelled and reaches idle", async () => {
	const { queue } = makeHarness();
	let current = true;
	let cancelCount = 0;
	const completed: string[] = [];
	const coordinator = createStageBuildCoordinator({ queue });
	coordinator.submit({
		owner: "stage",
		key: "stale-before-commit",
		generation: 1,
		priority: "critical",
		cost: 1,
		isCurrent: () => current,
		step: () => ({ status: "complete", result: "late" }),
		cancel: () => { cancelCount += 1; },
	}, (result) => completed.push(result));
	queue.runSlice(1);
	current = false;
	await flush();
	let idle = false;
	void coordinator.whenIdle().then(() => { idle = true; });
	await flush();
	expect(completed).toEqual([]);
	expect(cancelCount).toBe(1);
	expect(coordinator.getDiagnostics().activeJobs).toBe(0);
	expect(coordinator.getDiagnostics().stale).toBe(1);
	expect(idle).toBe(true);
});

test("an older generation cannot replace a newer active generation", async () => {
	const { queue } = makeHarness();
	const cancelled: number[] = [];
	const completed: number[] = [];
	const coordinator = createStageBuildCoordinator({ queue });
	expect(coordinator.submit({
		owner: "stage",
		key: "generation-order",
		generation: 2,
		priority: "critical",
		cost: 1,
		step: () => ({ status: "complete", result: 2 }),
		cancel: () => cancelled.push(2),
	}, (result) => completed.push(result))).toBe(true);
	expect(coordinator.submit({
		owner: "stage",
		key: "generation-order",
		generation: 1,
		priority: "critical",
		cost: 1,
		step: () => ({ status: "complete", result: 1 }),
		cancel: () => cancelled.push(1),
	}, (result) => completed.push(result))).toBe(false);
	queue.runSlice(1);
	await coordinator.whenIdle();
	expect(completed).toEqual([2]);
	expect(cancelled).toEqual([1]);
	expect(coordinator.getDiagnostics().stale).toBe(1);
});

test("an older generation remains stale after the newer generation has completed", async () => {
	const { queue } = makeHarness();
	const cancelled: number[] = [];
	const completed: number[] = [];
	const coordinator = createStageBuildCoordinator({ queue });
	coordinator.submit({
		owner: "stage",
		key: "completed-generation-order",
		generation: 2,
		priority: "critical",
		cost: 1,
		step: () => ({ status: "complete", result: 2 }),
		cancel: () => cancelled.push(2),
	}, (result) => completed.push(result));
	queue.runSlice(1);
	await coordinator.whenIdle();

	expect(coordinator.submit({
		owner: "stage",
		key: "completed-generation-order",
		generation: 1,
		priority: "critical",
		cost: 1,
		step: () => ({ status: "complete", result: 1 }),
		cancel: () => cancelled.push(1),
	}, (result) => completed.push(result))).toBe(false);
	expect(completed).toEqual([2]);
	expect(cancelled).toEqual([1]);
	expect(coordinator.getDiagnostics().stale).toBe(1);
});

test("phase cost larger than the maintenance budget is rejected immediately", () => {
	const { queue } = makeHarness();
	const coordinator = createStageBuildCoordinator({ queue, maxPhaseCost: 1 });
	expect(() => coordinator.submit({
		owner: "stage",
		key: "oversized-phase",
		generation: 1,
		priority: "critical",
		cost: 2,
		step: () => ({ status: "complete", result: "never" }),
		cancel() {},
	}, () => {})).toThrow("maximum phase cost");
	expect(coordinator.getDiagnostics().activeJobs).toBe(0);
});

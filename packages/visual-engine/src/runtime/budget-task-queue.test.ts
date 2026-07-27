import { expect, test } from "bun:test";
import {
	createBudgetTaskQueue,
	createVisualResourceLedger,
	createVisualResourceScope,
	type VisualResourceBudget,
} from "../index";

const budget: VisualResourceBudget = {
	textureBytes: 100,
	geometryBytes: 100,
	meshCount: 100,
	queuedTaskCost: 10,
	cacheBytes: 100,
};

function createQueue() {
	const ledger = createVisualResourceLedger({ budget });
	const scope = createVisualResourceScope("tasks");
	return { ledger, scope, queue: createBudgetTaskQueue({ ledger, resourceScope: scope }) };
}

test("runSlice starts higher priorities first and only within its cost budget", () => {
	const { queue } = createQueue();
	const started: string[] = [];
	for (const [priority, key, cost] of [
		["background", "background", 1],
		["normal", "normal", 2],
		["visible", "visible", 3],
		["critical", "critical", 4],
	] as const) {
		queue.enqueue({ owner: "scene", key, priority, cost, run: () => started.push(key), commit() {} });
	}

	expect(queue.runSlice(5)).toBe(1);
	expect(started).toEqual(["critical"]);
	expect(queue.runSlice(3)).toBe(1);
	expect(started).toEqual(["critical", "visible"]);
});

test("replacement, owner cancellation, and priority cancellation release queued ledger cost", () => {
	const { ledger, queue } = createQueue();
	queue.enqueue({ owner: "cover", key: "a", priority: "normal", cost: 3, run() {}, commit() {} });
	queue.enqueue({ owner: "cover", key: "a", priority: "visible", cost: 2, run() {}, commit() {} });
	queue.enqueue({ owner: "cover", key: "b", priority: "background", cost: 4, run() {}, commit() {} });

	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(6);
	queue.cancelPriority("background");
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(2);
	queue.cancelOwner("cover");
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(0);
	expect(queue.getSnapshot().cancelled).toBe(3);
});

test("soft pressure pauses background work while hard pressure drops optional and background work", () => {
	const { ledger, queue } = createQueue();
	queue.enqueue({ owner: "scene", key: "bg", priority: "background", cost: 8, run() {}, commit() {} });
	queue.enqueue({ owner: "scene", key: "visible", priority: "visible", cost: 1, run() {}, commit() {} });
	expect(ledger.getSnapshot().pressure).toBe("soft");

	queue.runSlice(1);
	expect(queue.getSnapshot().running).toBe(1);
	expect(queue.getSnapshot().queued).toBe(1);
	queue.enqueue({ owner: "scene", key: "critical", priority: "critical", cost: 11, run() {}, commit() {} });

	expect(queue.getSnapshot().queued).toBe(1);
	expect(queue.getSnapshot().cancelled).toBeGreaterThanOrEqual(1);
});

test("only a current open-scope task can commit and stale failures are counted", async () => {
	const { queue, scope } = createQueue();
	let resolveOld: ((value: string) => void) | undefined;
	const old = new Promise<string>((resolve) => { resolveOld = resolve; });
	const commits: string[] = [];
	queue.enqueue({ owner: "cover", key: "art", priority: "visible", cost: 1, run: () => old, commit: (value) => commits.push(value) });
	queue.runSlice(1);
	queue.enqueue({ owner: "cover", key: "art", priority: "visible", cost: 1, run: () => "new", commit: (value) => commits.push(value) });
	queue.runSlice(1);
	resolveOld?.("old");
	await Promise.resolve();
	await Promise.resolve();

	expect(commits).toEqual(["new"]);
	expect(queue.getSnapshot().staleResultsDropped).toBe(1);

	queue.enqueue({ owner: "lyrics", key: "l1", priority: "visible", cost: 1, run: () => "closed", commit: (value) => commits.push(value) });
	scope.dispose();
	queue.runSlice(1);
	await Promise.resolve();
	expect(commits).toEqual(["new"]);
});

test("dispose aborts queued and running work", () => {
	const { ledger, queue } = createQueue();
	let runningSignal: AbortSignal | undefined;
	queue.enqueue({ owner: "a", key: "running", priority: "critical", cost: 1, run: ({ signal }) => { runningSignal = signal; return new Promise(() => {}); }, commit() {} });
	queue.enqueue({ owner: "a", key: "queued", priority: "visible", cost: 2, run() {}, commit() {} });
	queue.runSlice(1);
	queue.dispose();

	expect(runningSignal?.aborted).toBe(true);
	expect(queue.getSnapshot().queued).toBe(0);
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(0);
});

test("owner cancellation aborts an already running task", () => {
	const { queue } = createQueue();
	let signal: AbortSignal | undefined;
	queue.enqueue({ owner: "cover", key: "running", priority: "visible", cost: 1, run: ({ signal: taskSignal }) => { signal = taskSignal; return new Promise(() => {}); }, commit() {} });
	queue.runSlice(1);

	queue.cancelOwner("cover");

	expect(signal?.aborted).toBe(true);
	expect(queue.getSnapshot().cancelled).toBe(1);
});

test("starting a task immediately releases its queued ledger lease", () => {
	const { ledger, queue } = createQueue();
	queue.enqueue({ owner: "cover", key: "start", priority: "visible", cost: 3, run() {}, commit() {} });
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(3);

	queue.runSlice(3);

	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(0);
});

test("a current task failure increments the failed counter", () => {
	const { queue } = createQueue();
	queue.enqueue({ owner: "cover", key: "broken", priority: "visible", cost: 1, run() { throw new Error("broken"); }, commit() {} });

	queue.runSlice(1);

	expect(queue.getSnapshot().failed).toBe(1);
});

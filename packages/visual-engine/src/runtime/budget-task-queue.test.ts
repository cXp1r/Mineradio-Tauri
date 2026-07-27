import { expect, test } from "bun:test";
import {
	createBudgetTaskQueue,
	createCancellationScope,
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

test("runSlice preserves the full critical to background priority order", () => {
	const { queue } = createQueue();
	const started: string[] = [];
	for (const priority of ["background", "normal", "visible", "critical"] as const) {
		queue.enqueue({ owner: "scene", key: priority, priority, cost: 1, run: () => started.push(priority), commit() {} });
	}

	for (let index = 0; index < 4; index += 1) queue.runSlice(1);

	expect(started).toEqual(["critical", "visible", "normal", "background"]);
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

test("abort-handler replacement commits once when owner cancellation is synchronous", async () => {
	const { queue } = createQueue();
	const commits: string[] = [];
	queue.enqueue({
		owner: "cover",
		key: "art",
		priority: "visible",
		cost: 1,
		run: ({ signal }) => {
			signal.addEventListener("abort", () => {
				queue.enqueue({ owner: "cover", key: "art", priority: "visible", cost: 1, run: () => "replacement", commit: (value) => commits.push(value) });
			});
			return new Promise(() => {});
		},
		commit() {},
	});
	queue.runSlice(1);

	queue.cancelOwner("cover");
	queue.runSlice(1);
	await Promise.resolve();
	await Promise.resolve();

	expect(commits).toEqual(["replacement"]);
	expect(queue.getSnapshot().cancelled).toBe(1);
	expect(queue.getSnapshot().staleResultsDropped).toBe(0);
});

test("peak queue depth excludes running tasks", () => {
	const { queue } = createQueue();
	queue.enqueue({ owner: "cover", key: "running", priority: "visible", cost: 1, run: () => new Promise(() => {}), commit() {} });
	queue.runSlice(1);
	queue.enqueue({ owner: "cover", key: "queued", priority: "visible", cost: 1, run() {}, commit() {} });

	const snapshot = queue.getSnapshot();
	expect(snapshot.queued).toBe(1);
	expect(snapshot.running).toBe(1);
	expect(snapshot.peakQueueDepth).toBe(1);
});

test("reentrant enqueue publishes only the final current replacement", async () => {
	const { ledger, queue } = createQueue();
	const commits: string[] = [];
	let reentrantAccepted = false;
	queue.enqueue({
		owner: "cover",
		key: "art",
		priority: "visible",
		cost: 1,
		run: ({ signal }) => {
			signal.addEventListener("abort", () => {
				reentrantAccepted = queue.enqueue({ owner: "cover", key: "art", priority: "visible", cost: 1, run: () => "reentrant", commit: (value) => commits.push(value) });
			});
			return new Promise(() => {});
		},
		commit() {},
	});
	queue.runSlice(1);

	const outerAccepted = queue.enqueue({ owner: "cover", key: "art", priority: "visible", cost: 1, run: () => "outer", commit: (value) => commits.push(value) });
	const snapshot = queue.getSnapshot();
	expect(reentrantAccepted).toBe(true);
	expect(outerAccepted).toBe(false);
	expect(snapshot.queued).toBe(1);
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(1);

	expect(queue.runSlice(1)).toBe(1);
	await Promise.resolve();
	await Promise.resolve();
	expect(commits).toEqual(["reentrant"]);
	expect(queue.getSnapshot().staleResultsDropped).toBe(0);
	expect(queue.getSnapshot().cancelled).toBe(1);
});

test("replacement enqueue rejects work when abort closes its resource scope", () => {
	const { ledger, queue, scope } = createQueue();
	queue.enqueue({
		owner: "cover",
		key: "art",
		priority: "visible",
		cost: 1,
		run: ({ signal }) => {
			signal.addEventListener("abort", () => scope.dispose());
			return new Promise(() => {});
		},
		commit() {},
	});
	queue.runSlice(1);

	const accepted = queue.enqueue({ owner: "cover", key: "art", priority: "visible", cost: 2, run() {}, commit() {} });

	expect(accepted).toBe(false);
	expect(queue.getSnapshot().queued).toBe(0);
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(0);
});

test("hard-pressure cancellation cannot publish after an abort handler closes resources", () => {
	const { ledger, queue, scope } = createQueue();
	queue.enqueue({
		owner: "scene",
		key: "normal",
		priority: "normal",
		cost: 1,
		run: ({ signal }) => {
			signal.addEventListener("abort", () => scope.dispose());
			return new Promise(() => {});
		},
		commit() {},
	});
	queue.runSlice(1);

	const accepted = queue.enqueue({ owner: "scene", key: "critical", priority: "critical", cost: 11, run() {}, commit() {} });

	expect(accepted).toBe(false);
	expect(queue.getSnapshot().queued).toBe(0);
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(0);
});

test("parent cancellation disposes queued work before runSlice can start it", () => {
	const ledger = createVisualResourceLedger({ budget });
	const resourceScope = createVisualResourceScope("tasks");
	const parent = createCancellationScope("parent");
	const queue = createBudgetTaskQueue({ ledger, resourceScope, cancellationScope: parent });
	let starts = 0;
	queue.enqueue({ owner: "cover", key: "art", priority: "visible", cost: 2, run: () => { starts += 1; }, commit() {} });

	parent.dispose();

	expect(queue.runSlice(2)).toBe(0);
	expect(starts).toBe(0);
	expect(queue.getSnapshot().queued).toBe(0);
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(0);
});

test("a synchronous resource close stops the rest of the current slice", () => {
	const { ledger, queue, scope } = createQueue();
	const starts: string[] = [];
	queue.enqueue({ owner: "scene", key: "first", priority: "visible", cost: 1, run: () => { starts.push("first"); scope.dispose(); }, commit() {} });
	queue.enqueue({ owner: "scene", key: "second", priority: "visible", cost: 1, run: () => starts.push("second"), commit() {} });

	expect(queue.runSlice(2)).toBe(1);
	expect(starts).toEqual(["first"]);
	expect(queue.getSnapshot().queued).toBe(0);
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(0);
});

test("queue disposal owns only a child cancellation scope", () => {
	const parent = createCancellationScope("parent");
	const unrelated = parent.issue("unrelated", "ticket");
	const firstLedger = createVisualResourceLedger({ budget });
	const firstResources = createVisualResourceScope("first-resources");
	const firstQueue = createBudgetTaskQueue({ ledger: firstLedger, resourceScope: firstResources, cancellationScope: parent });
	let firstSignal: AbortSignal | undefined;
	firstQueue.enqueue({ owner: "first", key: "running", priority: "visible", cost: 1, run: ({ signal }) => { firstSignal = signal; return new Promise(() => {}); }, commit() {} });
	firstQueue.runSlice(1);

	firstQueue.dispose();

	expect(firstSignal?.aborted).toBe(true);
	expect(parent.isOpen()).toBe(true);
	expect(unrelated.signal.aborted).toBe(false);

	const secondLedger = createVisualResourceLedger({ budget });
	const secondResources = createVisualResourceScope("second-resources");
	const secondQueue = createBudgetTaskQueue({ ledger: secondLedger, resourceScope: secondResources, cancellationScope: parent });
	let secondSignal: AbortSignal | undefined;
	secondQueue.enqueue({ owner: "second", key: "running", priority: "visible", cost: 1, run: ({ signal }) => { secondSignal = signal; return new Promise(() => {}); }, commit() {} });
	secondQueue.runSlice(1);

	parent.dispose();

	expect(secondSignal?.aborted).toBe(true);
});

function exerciseRecursiveCleanup(trigger: "inactive" | "dispose") {
	const { ledger, queue, scope } = createQueue();
	const nestedAccepted: boolean[] = [];
	let listenerDepth = 0;
	let maxListenerDepth = 0;
	for (let index = 0; index < 5; index += 1) {
		queue.enqueue({
			owner: "scene",
			key: `task-${index}`,
			priority: "visible",
			cost: 1,
			run: ({ signal }) => {
				signal.addEventListener("abort", () => {
					listenerDepth += 1;
					maxListenerDepth = Math.max(maxListenerDepth, listenerDepth);
					try {
						nestedAccepted.push(queue.enqueue({ owner: "nested", key: `task-${index}`, priority: "visible", cost: 1, run() {}, commit() {} }));
					} finally {
						listenerDepth -= 1;
					}
				});
				return new Promise(() => {});
			},
			commit() {},
		});
	}
	queue.runSlice(3);
	const before = queue.getSnapshot();
	let thrown: unknown;
	try {
		if (trigger === "inactive") {
			scope.dispose();
			queue.runSlice(5);
		} else {
			queue.dispose();
		}
	} catch (error) {
		thrown = error;
	}
	return {
		before,
		after: queue.getSnapshot(),
		ledger: ledger.getSnapshot(),
		maxListenerDepth,
		nestedAccepted,
		thrown,
	};
}

test("inactive cleanup rejects nested enqueue without recursive abort depth", () => {
	const result = exerciseRecursiveCleanup("inactive");

	expect(result.before).toEqual({ queued: 2, running: 3, completed: 0, cancelled: 0, staleResultsDropped: 0, failed: 0, peakQueueDepth: 5 });
	expect(result.thrown).toBeUndefined();
	expect(result.nestedAccepted).toEqual([false, false, false]);
	expect(result.maxListenerDepth).toBe(1);
	expect(result.after.queued).toBe(0);
	expect(result.after.running).toBe(0);
	expect(result.after.cancelled).toBe(5);
	expect(result.ledger.current.queuedTaskCost).toBe(0);
	expect(result.ledger.releases).toBe(5);
});

test("queue disposal shares the non-recursive cleanup guard", () => {
	const result = exerciseRecursiveCleanup("dispose");

	expect(result.thrown).toBeUndefined();
	expect(result.nestedAccepted).toEqual([false, false, false]);
	expect(result.maxListenerDepth).toBe(1);
	expect(result.after.queued).toBe(0);
	expect(result.after.running).toBe(0);
	expect(result.after.cancelled).toBe(5);
	expect(result.ledger.current.queuedTaskCost).toBe(0);
	expect(result.ledger.releases).toBe(5);
});

test("hard-pressure cancellation keeps nested critical enqueue non-recursive", () => {
	const { ledger, queue } = createQueue();
	const nestedAccepted: boolean[] = [];
	let listenerDepth = 0;
	let maxListenerDepth = 0;
	for (let index = 0; index < 3; index += 1) {
		queue.enqueue({
			owner: "low",
			key: `task-${index}`,
			priority: index % 2 === 0 ? "normal" : "background",
			cost: 1,
			run: ({ signal }) => {
				signal.addEventListener("abort", () => {
					listenerDepth += 1;
					maxListenerDepth = Math.max(maxListenerDepth, listenerDepth);
					try {
						nestedAccepted.push(queue.enqueue({ owner: "critical", key: `nested-${index}`, priority: "critical", cost: 1, run() {}, commit() {} }));
					} finally {
						listenerDepth -= 1;
					}
				});
				return new Promise(() => {});
			},
			commit() {},
		});
	}
	queue.runSlice(3);
	let triggerAccepted = false;
	let thrown: unknown;
	try {
		triggerAccepted = queue.enqueue({ owner: "critical", key: "trigger", priority: "critical", cost: 11, run() {}, commit() {} });
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeUndefined();
	expect(triggerAccepted).toBe(true);
	expect(nestedAccepted).toEqual([true, true, true]);
	expect(maxListenerDepth).toBe(1);
	expect(queue.getSnapshot().queued).toBe(4);
	expect(queue.getSnapshot().running).toBe(0);
	expect(queue.getSnapshot().cancelled).toBe(3);
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(14);
	expect(ledger.getSnapshot().allocations).toBe(7);
	expect(ledger.getSnapshot().releases).toBe(3);

	queue.dispose();

	expect(queue.getSnapshot().queued).toBe(0);
	expect(queue.getSnapshot().cancelled).toBe(7);
	expect(ledger.getSnapshot().current.queuedTaskCost).toBe(0);
	expect(ledger.getSnapshot().allocations).toBe(7);
	expect(ledger.getSnapshot().releases).toBe(7);
});

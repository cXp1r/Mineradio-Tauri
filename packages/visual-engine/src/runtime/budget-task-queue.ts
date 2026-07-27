import {
	createCancellationScope,
	type CancellationScope,
	type CancellationTicket,
} from "./cancellation-scope";
import type {
	VisualResourceAllocation,
	VisualResourceLedger,
	VisualResourcePriority,
} from "./resource-ledger";
import type { VisualResourceScope } from "./resource-scope";

export type BudgetTaskPriority = "critical" | "visible" | "normal" | "background";

export interface BudgetTaskContext {
	readonly signal: AbortSignal;
	readonly ticket: CancellationTicket;
	isCurrent(): boolean;
}

export interface BudgetTask<Result = unknown> {
	readonly owner: string;
	readonly key: string;
	readonly priority: BudgetTaskPriority;
	readonly cost: number;
	run(context: BudgetTaskContext): Result | Promise<Result>;
	commit(result: Result, context: BudgetTaskContext): void;
}

export interface VisualTaskQueueSnapshot {
	readonly queued: number;
	readonly running: number;
	readonly completed: number;
	readonly cancelled: number;
	readonly staleResultsDropped: number;
	readonly failed: number;
	readonly peakQueueDepth: number;
}

export interface BudgetTaskQueueOptions {
	readonly ledger: VisualResourceLedger;
	readonly resourceScope: VisualResourceScope;
	readonly cancellationScope?: CancellationScope;
}

export interface BudgetTaskQueue {
	enqueue<Result>(task: BudgetTask<Result>): boolean;
	runSlice(costBudget: number): number;
	cancelOwner(owner: string): void;
	cancelPriority(priority: BudgetTaskPriority): void;
	dispose(): void;
	getSnapshot(): VisualTaskQueueSnapshot;
}

interface QueueEntry<Result = unknown> {
	readonly task: BudgetTask<Result>;
	readonly ticket: CancellationTicket;
	readonly allocation: VisualResourceAllocation;
	state: "queued" | "running" | "cancelled" | "settled";
}

const PRIORITIES: readonly BudgetTaskPriority[] = [
	"critical",
	"visible",
	"normal",
	"background",
];

const LEDGER_PRIORITIES: Readonly<Record<BudgetTaskPriority, VisualResourcePriority>> = {
	critical: "essential",
	visible: "normal",
	normal: "optional",
	background: "background",
};

function entryId(owner: string, key: string): string {
	return `${owner}\u0000${key}`;
}

function assertFiniteNonNegative(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${label} must be finite and non-negative.`);
	}
}

export function createBudgetTaskQueue(options: BudgetTaskQueueOptions): BudgetTaskQueue {
	const cancellationScope = options.cancellationScope
		? options.cancellationScope.createChild("budget-task-queue")
		: createCancellationScope("budget-task-queue");
	const queued: QueueEntry[] = [];
	const activeById = new Map<string, QueueEntry>();
	let disposed = false;
	let completed = 0;
	let cancelled = 0;
	let staleResultsDropped = 0;
	let failed = 0;
	let peakQueueDepth = 0;
	let cleaning = false;

	const isQueueLive = () =>
		!disposed &&
		options.resourceScope.isOpen() &&
		cancellationScope.isOpen();
	const isTicketLive = (ticket: CancellationTicket) =>
		isQueueLive() &&
		!ticket.signal.aborted &&
		ticket.isCurrent();
	const isCommitAllowed = (entry: QueueEntry) => isTicketLive(entry.ticket);
	const releaseQueuedLease = (entry: QueueEntry) => entry.allocation.release();
	const queueDepth = () => queued.length;
	const runningCount = () =>
		[...activeById.values()].filter((entry) => entry.state === "running").length;
	const forgetCurrent = (entry: QueueEntry) => {
		const id = entryId(entry.task.owner, entry.task.key);
		if (activeById.get(id) === entry) activeById.delete(id);
	};
	const trackDepth = () => {
		peakQueueDepth = Math.max(peakQueueDepth, queueDepth());
	};
	const removeQueued = (entry: QueueEntry) => {
		const index = queued.indexOf(entry);
		if (index >= 0) queued.splice(index, 1);
	};
	const detachEntry = (entry: QueueEntry): boolean => {
		if (entry.state === "cancelled" || entry.state === "settled") return false;
		if (entry.state === "queued") {
			removeQueued(entry);
			releaseQueuedLease(entry);
		}
		entry.state = "cancelled";
		forgetCurrent(entry);
		cancelled += 1;
		return true;
	};
	const invalidateTicket = (ticket: CancellationTicket) => {
		if (ticket.isCurrent() && cancellationScope.isOpen()) {
			cancellationScope.issue(ticket.owner, ticket.key);
		}
	};
	const cancelEntry = (entry: QueueEntry) => {
		if (!detachEntry(entry)) return;
		invalidateTicket(entry.ticket);
	};
	const cancelAllEntries = () => {
		if (cleaning) return;
		cleaning = true;
		try {
			for (const entry of new Set([...queued, ...activeById.values()])) {
				cancelEntry(entry);
			}
		} finally {
			cleaning = false;
		}
	};
	const cleanIfInactive = (): boolean => {
		if (isQueueLive()) return false;
		cancelAllEntries();
		return true;
	};
	const cancelLowPriorityForHardPressure = () => {
		if (options.ledger.getSnapshot().pressure !== "hard") return;
		for (const entry of [...queued, ...activeById.values()]) {
			if (entry.task.priority === "normal" || entry.task.priority === "background") {
				cancelEntry(entry);
			}
		}
	};

	return {
		enqueue(task) {
			if (cleanIfInactive()) return false;
			assertFiniteNonNegative(task.cost, "Task cost");
			const id = entryId(task.owner, task.key);
			const previous = activeById.get(id);
			if (previous) detachEntry(previous);
			const ticket = cancellationScope.issue(task.owner, task.key);
			if (!isTicketLive(ticket)) {
				invalidateTicket(ticket);
				cleanIfInactive();
				return false;
			}
			const admission = options.ledger.admit(
				{ queuedTaskCost: task.cost },
				LEDGER_PRIORITIES[task.priority],
			);
			if (!admission.admitted || !admission.allocation) {
				cancelled += 1;
				invalidateTicket(ticket);
				return false;
			}
			if (!isTicketLive(ticket)) {
				admission.allocation.release();
				invalidateTicket(ticket);
				cleanIfInactive();
				return false;
			}
			const entry: QueueEntry = { task, ticket, allocation: admission.allocation, state: "queued" };
			queued.push(entry);
			activeById.set(id, entry);
			if (!isTicketLive(ticket)) {
				cancelEntry(entry);
				cleanIfInactive();
				return false;
			}
			trackDepth();
			cancelLowPriorityForHardPressure();
			if (!isQueueLive() || entry.state !== "queued" || !isTicketLive(ticket)) {
				cancelEntry(entry);
				cleanIfInactive();
				return false;
			}
			return true;
		},
		runSlice(costBudget) {
			assertFiniteNonNegative(costBudget, "Task slice budget");
			if (cleanIfInactive()) return 0;
			cancelLowPriorityForHardPressure();
			if (cleanIfInactive()) return 0;
			let spent = 0;
			let started = 0;
			while (true) {
				if (cleanIfInactive()) break;
				cancelLowPriorityForHardPressure();
				if (cleanIfInactive()) break;
				const pressure = options.ledger.getSnapshot().pressure;
				const candidate = PRIORITIES
					.map((priority) => queued.find((entry) => entry.task.priority === priority))
					.find((entry) => entry && !(pressure === "soft" && entry.task.priority === "background"));
				if (!candidate || spent + candidate.task.cost > costBudget) break;
				if (!isTicketLive(candidate.ticket)) {
					cancelEntry(candidate);
					continue;
				}
				removeQueued(candidate);
				releaseQueuedLease(candidate);
				candidate.state = "running";
				if (!isTicketLive(candidate.ticket)) {
					cancelEntry(candidate);
					continue;
				}
				spent += candidate.task.cost;
				started += 1;
				const context: BudgetTaskContext = {
					signal: candidate.ticket.signal,
					ticket: candidate.ticket,
					isCurrent: () => isCommitAllowed(candidate),
				};
				let result: unknown | Promise<unknown>;
				try {
					result = candidate.task.run(context);
				} catch (error) {
					candidate.state = "settled";
					forgetCurrent(candidate);
					if (isCommitAllowed(candidate)) failed += 1;
					else staleResultsDropped += 1;
					continue;
				}
				void Promise.resolve(result).then(
					(value) => {
						forgetCurrent(candidate);
						if (!isCommitAllowed(candidate)) {
							staleResultsDropped += 1;
							return;
						}
						try {
							candidate.task.commit(value, context);
							candidate.state = "settled";
							completed += 1;
						} catch {
							candidate.state = "settled";
							failed += 1;
						}
					},
					() => {
						forgetCurrent(candidate);
						candidate.state = "settled";
						if (isCommitAllowed(candidate)) failed += 1;
						else staleResultsDropped += 1;
					},
				);
			}
			return started;
		},
		cancelOwner(owner) {
			for (const entry of [...queued, ...activeById.values()]) {
				if (entry.task.owner === owner) cancelEntry(entry);
			}
		},
		cancelPriority(priority) {
			for (const entry of [...queued, ...activeById.values()]) {
				if (entry.task.priority === priority) cancelEntry(entry);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelAllEntries();
			cancellationScope.dispose();
		},
		getSnapshot() {
			return {
				queued: queued.length,
				running: runningCount(),
				completed,
				cancelled,
				staleResultsDropped,
				failed,
				peakQueueDepth,
			};
		},
	};
}

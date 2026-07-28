import type {
	BudgetTaskPriority,
	BudgetTaskQueue,
	BudgetTaskSettlement,
} from "../../runtime/budget-task-queue";

export interface StageLyricBuildContinuation {
	readonly phase: number;
	readonly label?: string;
}

export type StageLyricBuildStepResult<Result> =
	| {
			readonly status: "continue";
			readonly continuation: StageLyricBuildContinuation;
	  }
	| {
			readonly status: "complete";
			readonly result: Result;
	  };

export interface StageLyricBuildJob<Result> {
	readonly owner: string;
	readonly key: string;
	readonly generation: number;
	readonly priority: BudgetTaskPriority;
	readonly cost: number;
	isCurrent?(): boolean;
	step(
		signal: AbortSignal,
		continuation: StageLyricBuildContinuation,
	): StageLyricBuildStepResult<Result> | Promise<StageLyricBuildStepResult<Result>>;
	cancel(): void;
}

export interface StageBuildCoordinatorDiagnostics {
	readonly activeJobs: number;
	readonly pendingPhases: number;
	readonly runningSteps: number;
	readonly phaseCount: number;
	readonly completed: number;
	readonly cancelled: number;
	readonly stale: number;
	readonly failed: number;
	readonly lastPhaseDurationMs: number;
	readonly peakPhaseDurationMs: number;
	readonly overBudgetPhaseCount: number;
}

export interface StageBuildCoordinator {
	submit<Result>(job: StageLyricBuildJob<Result>, onComplete: (result: Result) => void): boolean;
	cancelOwner(owner: string): void;
	whenIdle(): Promise<void>;
	getDiagnostics(): StageBuildCoordinatorDiagnostics;
	dispose(): void;
}

export interface StageBuildResourceStack {
	readonly disposed: boolean;
	readonly size: number;
	defer(release: () => void): void;
	dispose(): void;
}

export interface StageBuildCoordinatorOptions {
	readonly queue: BudgetTaskQueue;
	readonly now?: () => number;
	readonly phaseFailureThresholdMs?: number;
	readonly maxPhaseCost?: number;
	readonly isScopeOpen?: () => boolean;
}

interface ActiveBuildRecord {
	readonly job: StageLyricBuildJob<unknown>;
	readonly onComplete: (result: unknown) => void;
	readonly controller: AbortController;
	continuation: StageLyricBuildContinuation;
	cancelled: boolean;
}

function recordId(owner: string, key: string): string {
	return `${owner}\u0000${key}`;
}

function assertJob(job: StageLyricBuildJob<unknown>): void {
	if (!job.owner || !job.key) throw new TypeError("Stage build owner and key are required.");
	if (!Number.isInteger(job.generation) || job.generation < 0) {
		throw new RangeError("Stage build generation must be a non-negative integer.");
	}
	if (!Number.isFinite(job.cost) || job.cost < 0) {
		throw new RangeError("Stage build cost must be finite and non-negative.");
	}
}

export function createStageBuildResourceStack(): StageBuildResourceStack {
	const releases: Array<() => void> = [];
	let disposed = false;
	return {
		get disposed() {
			return disposed;
		},
		get size() {
			return releases.length;
		},
		defer(release) {
			if (disposed) throw new Error("Stage build resource stack is disposed.");
			releases.push(release);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (let index = releases.length - 1; index >= 0; index -= 1) {
				try {
					releases[index]();
				} catch {
					// 继续释放其余部分资源，保证失败构建可确定性收口。
				}
			}
			releases.length = 0;
		},
	};
}

export function createStageBuildCoordinator(
	options: StageBuildCoordinatorOptions,
): StageBuildCoordinator {
	const now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
	const phaseFailureThresholdMs = options.phaseFailureThresholdMs ?? 8;
	const maxPhaseCost = options.maxPhaseCost ?? 1;
	if (!Number.isFinite(maxPhaseCost) || maxPhaseCost < 0) {
		throw new RangeError("Stage maximum phase cost must be finite and non-negative.");
	}
	const isScopeOpen = options.isScopeOpen ?? (() => true);
	const active = new Map<string, ActiveBuildRecord>();
	const latestGenerationById = new Map<string, number>();
	const idleWaiters = new Set<() => void>();
	let disposed = false;
	let pendingPhases = 0;
	let runningSteps = 0;
	let phaseCount = 0;
	let completed = 0;
	let cancelled = 0;
	let stale = 0;
	let failed = 0;
	let lastPhaseDurationMs = 0;
	let peakPhaseDurationMs = 0;
	let overBudgetPhaseCount = 0;

	const isIdle = () => active.size === 0 && pendingPhases === 0 && runningSteps === 0;
	const notifyIdle = () => {
		if (!isIdle()) return;
		for (const resolve of idleWaiters) resolve();
		idleWaiters.clear();
	};
	const isCurrent = (record: ActiveBuildRecord) =>
		!disposed &&
		isScopeOpen() &&
		!record.cancelled &&
		!record.controller.signal.aborted &&
		(record.job.isCurrent?.() ?? true) &&
		active.get(recordId(record.job.owner, record.job.key)) === record;
	const cancelRecord = (record: ActiveBuildRecord) => {
		if (record.cancelled) return;
		record.cancelled = true;
		record.controller.abort();
		const id = recordId(record.job.owner, record.job.key);
		if (active.get(id) === record) active.delete(id);
		try {
			record.job.cancel();
		} catch {
			// Job 清理失败不能阻断 coordinator 收口。
		}
		notifyIdle();
	};
	const cancelRejectedJob = (job: StageLyricBuildJob<unknown>) => {
		try {
			job.cancel();
		} catch {
			// 被拒绝的旧 generation 也必须尽量释放其自有部分资源。
		}
	};

	const enqueuePhase = (record: ActiveBuildRecord): boolean => {
		if (!isCurrent(record)) return false;
		const accepted = options.queue.enqueue({
			owner: record.job.owner,
			key: record.job.key,
			priority: record.job.priority,
			cost: record.job.cost,
			async run(context) {
				runningSteps += 1;
				const startedAt = now();
				try {
					if (!isCurrent(record)) throw new Error("Stage build generation is stale.");
					return await record.job.step(record.controller.signal, record.continuation);
				} finally {
					const duration = Math.max(0, now() - startedAt);
					lastPhaseDurationMs = duration;
					peakPhaseDurationMs = Math.max(peakPhaseDurationMs, duration);
					phaseCount += 1;
					if (duration > phaseFailureThresholdMs) overBudgetPhaseCount += 1;
					runningSteps = Math.max(0, runningSteps - 1);
					notifyIdle();
				}
			},
			commit(result, context) {
				if (!context.isCurrent() || !isCurrent(record)) {
					stale += 1;
					cancelRecord(record);
					return;
				}
				if (result.status === "continue") {
					record.continuation = result.continuation;
					if (!enqueuePhase(record)) cancelRecord(record);
					return;
				}
				const id = recordId(record.job.owner, record.job.key);
				if (active.get(id) === record) active.delete(id);
				try {
					record.onComplete(result.result);
					completed += 1;
				} catch (error) {
					cancelRecord(record);
					throw error;
				} finally {
					notifyIdle();
				}
			},
			onSettled(settlement: BudgetTaskSettlement) {
				pendingPhases = Math.max(0, pendingPhases - 1);
				if (settlement === "cancelled") {
					cancelled += 1;
					cancelRecord(record);
				} else if (settlement === "stale") {
					stale += 1;
					cancelRecord(record);
				} else if (settlement === "failed") {
					failed += 1;
					cancelRecord(record);
				}
				notifyIdle();
			},
		});
		if (accepted) pendingPhases += 1;
		return accepted;
	};

	return {
		submit<Result>(job: StageLyricBuildJob<Result>, onComplete: (result: Result) => void) {
			if (disposed) return false;
			assertJob(job as StageLyricBuildJob<unknown>);
			if (job.cost > maxPhaseCost) {
				throw new RangeError(`Stage build cost exceeds maximum phase cost ${maxPhaseCost}.`);
			}
			const id = recordId(job.owner, job.key);
			const latestGeneration = latestGenerationById.get(id);
			if (latestGeneration !== undefined && job.generation <= latestGeneration) {
				stale += 1;
				const previous = active.get(id);
				if (previous?.job !== job) cancelRejectedJob(job as StageLyricBuildJob<unknown>);
				return false;
			}
			latestGenerationById.set(id, job.generation);
			const previous = active.get(id);
			if (previous) cancelRecord(previous);
			const record: ActiveBuildRecord = {
				job: job as StageLyricBuildJob<unknown>,
				onComplete: onComplete as (result: unknown) => void,
				controller: new AbortController(),
				continuation: { phase: 0, label: "start" },
				cancelled: false,
			};
			active.set(id, record);
			if (enqueuePhase(record)) return true;
			cancelRecord(record);
			return false;
		},
		cancelOwner(owner) {
			options.queue.cancelOwner(owner);
			for (const record of [...active.values()]) {
				if (record.job.owner === owner) cancelRecord(record);
			}
		},
		whenIdle() {
			if (isIdle()) return Promise.resolve();
			return new Promise<void>((resolve) => idleWaiters.add(resolve));
		},
		getDiagnostics() {
			return {
				activeJobs: active.size,
				pendingPhases,
				runningSteps,
				phaseCount,
				completed,
				cancelled,
				stale,
				failed,
				lastPhaseDurationMs,
				peakPhaseDurationMs,
				overBudgetPhaseCount,
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			const owners = new Set([...active.values()].map((record) => record.job.owner));
			for (const owner of owners) options.queue.cancelOwner(owner);
			for (const record of [...active.values()]) cancelRecord(record);
			latestGenerationById.clear();
			notifyIdle();
		},
	};
}

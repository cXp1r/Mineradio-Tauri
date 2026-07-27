import type { VisualTaskQueueSnapshot } from "./budget-task-queue";
import type { VisualResourceLedgerSnapshot } from "./resource-ledger";
import type {
	VisualPerformanceSnapshot,
	VisualResourceBudget,
	VisualResourceUsage,
	VisualRuntimeMode,
} from "./visual-engine-contract";

export interface PerformanceCollectorOptions {
	readonly resourceBudget: VisualResourceBudget;
	readonly capacity?: number;
	readonly longFrameThresholdMs?: number;
}

export interface PerformanceFrameSample {
	readonly source: "raf" | "timer";
	readonly rendered: boolean;
	readonly costMs: number;
}

export interface PerformanceGateSample {
	readonly run: boolean;
	readonly effectiveFps: number;
	readonly pendingDtSec: number;
	readonly costMs?: number;
	readonly error?: unknown;
}

export interface PerformanceRuntimeState {
	readonly mode: VisualRuntimeMode;
	readonly running: boolean;
	readonly mounted: boolean;
	readonly generation: number;
}

export interface PerformanceCollector {
	setRuntimeState(state: PerformanceRuntimeState): void;
	recordFrame(sample: PerformanceFrameSample): void;
	recordGate(name: string, sample: PerformanceGateSample): void;
	setTaskSnapshot(snapshot: VisualTaskQueueSnapshot): void;
	setResourceSnapshot(snapshot: VisualResourceLedgerSnapshot): void;
	getSnapshot(): VisualPerformanceSnapshot;
}

class FixedSampleBuffer {
	readonly #samples: Float64Array;
	#length = 0;
	#next = 0;

	constructor(capacity: number) {
		this.#samples = new Float64Array(capacity);
	}

	push(value: number): void {
		this.#samples[this.#next] = value;
		this.#next = (this.#next + 1) % this.#samples.length;
		this.#length = Math.min(this.#length + 1, this.#samples.length);
	}

	percentile(percent: number): number {
		if (this.#length === 0) return 0;
		const ordered = Array.from(this.#samples.slice(0, this.#length)).sort((a, b) => a - b);
		return ordered[Math.ceil(percent * ordered.length) - 1] ?? 0;
	}
}

interface GateState {
	runs: number;
	skips: number;
	effectiveFps: number;
	pendingDtSec: number;
	errors: number;
	costs: FixedSampleBuffer;
}

const EMPTY_USAGE: VisualResourceUsage = {
	textureBytes: 0,
	geometryBytes: 0,
	meshCount: 0,
	queuedTaskCost: 0,
	cacheBytes: 0,
};

const EMPTY_TASKS: VisualTaskQueueSnapshot = {
	queued: 0,
	running: 0,
	completed: 0,
	cancelled: 0,
	staleResultsDropped: 0,
	failed: 0,
	peakQueueDepth: 0,
};

function copyUsage(usage: VisualResourceUsage): VisualResourceUsage {
	return { ...usage };
}

function assertFiniteNonNegative(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${label} must be finite and non-negative.`);
	}
}

export function createPerformanceCollector(options: PerformanceCollectorOptions): PerformanceCollector {
	const capacity = options.capacity ?? 120;
	if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("Capacity must be a positive integer.");
	const longFrameThresholdMs = options.longFrameThresholdMs ?? 50;
	assertFiniteNonNegative(longFrameThresholdMs, "Long frame threshold");
	const frameCosts = new FixedSampleBuffer(capacity);
	const gates = new Map<string, GateState>();
	let runtime: PerformanceRuntimeState = { mode: "released", running: false, mounted: false, generation: 0 };
	let tasks = { ...EMPTY_TASKS };
	let resources: VisualResourceLedgerSnapshot = {
		current: copyUsage(EMPTY_USAGE),
		peak: copyUsage(EMPTY_USAGE),
		budget: copyUsage(options.resourceBudget),
		pressure: "normal",
		allocations: 0,
		releases: 0,
	};
	let rafTicks = 0;
	let timerTicks = 0;
	let renders = 0;
	let skippedRenders = 0;
	let longFrames = 0;

	const gateFor = (name: string): GateState => {
		let gate = gates.get(name);
		if (!gate) {
			gate = { runs: 0, skips: 0, effectiveFps: 0, pendingDtSec: 0, errors: 0, costs: new FixedSampleBuffer(capacity) };
			gates.set(name, gate);
		}
		return gate;
	};

	return {
		setRuntimeState(state) {
			runtime = { ...state };
		},
		recordFrame(sample) {
			assertFiniteNonNegative(sample.costMs, "Frame cost");
			if (sample.source === "timer") {
				timerTicks += 1;
				return;
			}
			rafTicks += 1;
			if (sample.rendered) renders += 1;
			else skippedRenders += 1;
			frameCosts.push(sample.costMs);
			if (sample.costMs > longFrameThresholdMs) longFrames += 1;
		},
		recordGate(name, sample) {
			assertFiniteNonNegative(sample.effectiveFps, "Gate effective FPS");
			assertFiniteNonNegative(sample.pendingDtSec, "Gate pending dt");
			if (sample.costMs !== undefined) assertFiniteNonNegative(sample.costMs, "Gate cost");
			const gate = gateFor(name);
			gate.effectiveFps = sample.effectiveFps;
			gate.pendingDtSec = sample.pendingDtSec;
			if (sample.run) {
				gate.runs += 1;
				if (sample.costMs !== undefined) gate.costs.push(sample.costMs);
			} else {
				gate.skips += 1;
			}
			if (sample.error !== undefined) gate.errors += 1;
		},
		setTaskSnapshot(snapshot) {
			tasks = { ...snapshot };
		},
		setResourceSnapshot(snapshot) {
			resources = {
				current: copyUsage(snapshot.current),
				peak: copyUsage(snapshot.peak),
				budget: copyUsage(snapshot.budget),
				pressure: snapshot.pressure,
				allocations: snapshot.allocations,
				releases: snapshot.releases,
			};
		},
		getSnapshot() {
			const gateSnapshot: Record<
				string,
				VisualPerformanceSnapshot["gates"][string]
			> = {};
			for (const [name, gate] of gates) {
				gateSnapshot[name] = {
					runs: gate.runs,
					skips: gate.skips,
					effectiveFps: gate.effectiveFps,
					pendingDtSec: gate.pendingDtSec,
					costP50Ms: gate.costs.percentile(0.5),
					costP95Ms: gate.costs.percentile(0.95),
					errors: gate.errors,
				};
			}
			return {
				runtime: { ...runtime },
				frames: {
					rafTicks,
					timerTicks,
					renders,
					skippedRenders,
					frameCostP50Ms: frameCosts.percentile(0.5),
					frameCostP95Ms: frameCosts.percentile(0.95),
					longFrames,
				},
				gates: gateSnapshot,
				resources: {
					current: copyUsage(resources.current),
					peak: copyUsage(resources.peak),
					budget: copyUsage(resources.budget),
					pressure: resources.pressure,
					allocations: resources.allocations,
					releases: resources.releases,
				},
				tasks: { ...tasks },
			};
		},
	};
}

import type {
	VisualResourceBudget,
	VisualResourcePressure,
	VisualResourceUsage,
} from "./visual-engine-contract";

export type VisualResourcePriority =
	| "essential"
	| "normal"
	| "optional"
	| "background";

export interface VisualResourceLedgerOptions {
	readonly budget: VisualResourceBudget;
	readonly softPressureRatio?: number;
}

export interface VisualResourceAllocation {
	readonly priority: VisualResourcePriority;
	readonly usage: VisualResourceUsage;
	readonly released: boolean;
	release(): void;
}

export interface VisualResourceAdmission {
	readonly admitted: boolean;
	readonly priority: VisualResourcePriority;
	readonly usage: VisualResourceUsage;
	readonly projected: VisualResourceUsage;
	readonly projectedPressure: VisualResourcePressure;
	readonly allocation: VisualResourceAllocation | null;
}

export interface VisualResourceLedgerSnapshot {
	readonly current: VisualResourceUsage;
	readonly peak: VisualResourceUsage;
	readonly budget: VisualResourceBudget;
	readonly pressure: VisualResourcePressure;
	readonly allocations: number;
	readonly releases: number;
}

export interface VisualResourceLedger {
	admit(
		usage: Partial<VisualResourceUsage>,
		priority: VisualResourcePriority,
	): VisualResourceAdmission;
	getSnapshot(): VisualResourceLedgerSnapshot;
}

const USAGE_KEYS = [
	"textureBytes",
	"geometryBytes",
	"meshCount",
	"queuedTaskCost",
	"cacheBytes",
] as const satisfies readonly (keyof VisualResourceUsage)[];

function copyUsage(usage: VisualResourceUsage): VisualResourceUsage {
	return {
		textureBytes: usage.textureBytes,
		geometryBytes: usage.geometryBytes,
		meshCount: usage.meshCount,
		queuedTaskCost: usage.queuedTaskCost,
		cacheBytes: usage.cacheBytes,
	};
}

function normalizeUsage(
	usage: Partial<VisualResourceUsage>,
): VisualResourceUsage {
	const normalized = {
		textureBytes: usage.textureBytes ?? 0,
		geometryBytes: usage.geometryBytes ?? 0,
		meshCount: usage.meshCount ?? 0,
		queuedTaskCost: usage.queuedTaskCost ?? 0,
		cacheBytes: usage.cacheBytes ?? 0,
	};
	for (const key of USAGE_KEYS) {
		if (!Number.isFinite(normalized[key]) || normalized[key] < 0) {
			throw new RangeError(`Visual resource usage ${key} must be finite and non-negative.`);
		}
	}
	return normalized;
}

function addUsage(
	left: VisualResourceUsage,
	right: VisualResourceUsage,
): VisualResourceUsage {
	const total = {
		textureBytes: left.textureBytes + right.textureBytes,
		geometryBytes: left.geometryBytes + right.geometryBytes,
		meshCount: left.meshCount + right.meshCount,
		queuedTaskCost: left.queuedTaskCost + right.queuedTaskCost,
		cacheBytes: left.cacheBytes + right.cacheBytes,
	};
	for (const key of USAGE_KEYS) {
		if (!Number.isFinite(total[key])) {
			throw new RangeError(`Projected visual resource usage ${key} must be finite.`);
		}
	}
	return total;
}

function pressureForUsage(
	usage: VisualResourceUsage,
	budget: VisualResourceBudget,
	softPressureRatio: number,
): VisualResourcePressure {
	if (USAGE_KEYS.some((key) => usage[key] > budget[key])) return "hard";
	if (
		USAGE_KEYS.some(
			(key) => usage[key] > 0 && usage[key] >= budget[key] * softPressureRatio,
		)
	) {
		return "soft";
	}
	return "normal";
}

export function createVisualResourceLedger(
	options: VisualResourceLedgerOptions,
): VisualResourceLedger {
	const budget = copyUsage(options.budget);
	const softPressureRatio = options.softPressureRatio ?? 0.8;
	for (const key of USAGE_KEYS) {
		if (!Number.isFinite(budget[key]) || budget[key] < 0) {
			throw new RangeError(`Visual resource budget ${key} must be finite and non-negative.`);
		}
	}
	if (
		!Number.isFinite(softPressureRatio) ||
		softPressureRatio <= 0 ||
		softPressureRatio >= 1
	) {
		throw new RangeError("softPressureRatio must be finite and between 0 and 1.");
	}
	let current = normalizeUsage({});
	let peak = normalizeUsage({});
	let allocations = 0;
	let releases = 0;

	return {
		admit(inputUsage, priority) {
			if (
				priority !== "essential" &&
				priority !== "normal" &&
				priority !== "optional" &&
				priority !== "background"
			) {
				throw new TypeError(`Unknown visual resource priority: ${String(priority)}.`);
			}
			const usage = normalizeUsage(inputUsage);
			const projected = addUsage(current, usage);
			const projectedPressure = pressureForUsage(
				projected,
				budget,
				softPressureRatio,
			);
			if (
				projectedPressure === "hard" &&
				(priority === "optional" || priority === "background")
			) {
				return {
					admitted: false,
					priority,
					usage: copyUsage(usage),
					projected: copyUsage(projected),
					projectedPressure,
					allocation: null,
				};
			}
			current = projected;
			for (const key of USAGE_KEYS) {
				peak = { ...peak, [key]: Math.max(peak[key], current[key]) };
			}
			allocations += 1;
			let released = false;
			const allocation: VisualResourceAllocation = {
				priority,
				usage: copyUsage(usage),
				get released() {
					return released;
				},
				release() {
					if (released) return;
					released = true;
					current = {
						textureBytes: Math.max(0, current.textureBytes - usage.textureBytes),
						geometryBytes: Math.max(
							0,
							current.geometryBytes - usage.geometryBytes,
						),
						meshCount: Math.max(0, current.meshCount - usage.meshCount),
						queuedTaskCost: Math.max(
							0,
							current.queuedTaskCost - usage.queuedTaskCost,
						),
						cacheBytes: Math.max(0, current.cacheBytes - usage.cacheBytes),
					};
					releases += 1;
				},
			};

			return {
				admitted: true,
				priority,
				usage: copyUsage(usage),
				projected: copyUsage(projected),
				projectedPressure,
				allocation,
			};
		},
		getSnapshot() {
			return {
				current: copyUsage(current),
				peak: copyUsage(peak),
				budget: copyUsage(budget),
				pressure: pressureForUsage(current, budget, softPressureRatio),
				allocations,
				releases,
			};
		},
	};
}

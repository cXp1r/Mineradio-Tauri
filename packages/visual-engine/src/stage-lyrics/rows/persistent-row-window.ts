import {
	getStageClarityBudget,
	type StageClarityPriority,
	type StageClarityQuality,
} from "../resource-budget/clarity-pool";

export const STAGE_PERSISTENT_ROW_CACHE_LIMIT = 10;

export interface StagePersistentRowCacheKeyParts {
	readonly trackKey: string;
	readonly trackGeneration: number;
	readonly settingsGeneration: number;
	readonly rowIndex: number;
}

export type StagePersistentRowKind = "current" | "adjacent" | "prewarm";

export interface StagePersistentRowWindowOptions {
	readonly trackKey: string;
	readonly trackGeneration: number;
	readonly settingsGeneration: number;
	readonly currentIndex: number;
	readonly rowCount: number;
	readonly quality: StageClarityQuality;
}

export interface StagePersistentRowPlanItem {
	readonly rowIndex: number;
	readonly cacheKey: string;
	readonly kind: StagePersistentRowKind;
	readonly priority: StageClarityPriority;
	readonly resident: boolean;
}

export interface StagePersistentRowWindowPlan {
	readonly rows: readonly StagePersistentRowPlanItem[];
}

function assertGeneration(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer.`);
	}
}

export function createStagePersistentRowCacheKey(
	parts: StagePersistentRowCacheKeyParts,
): string {
	if (!parts.trackKey) throw new TypeError("Stage row track key is required.");
	assertGeneration(parts.trackGeneration, "Stage row track generation");
	assertGeneration(parts.settingsGeneration, "Stage row settings generation");
	assertGeneration(parts.rowIndex, "Stage row index");
	return `stage-row:v1:${encodeURIComponent(parts.trackKey)}:${parts.trackGeneration}:${parts.settingsGeneration}:${parts.rowIndex}`;
}

function buildNearestRowIndices(currentIndex: number, rowCount: number): readonly number[] {
	const targetCount = Math.min(rowCount, STAGE_PERSISTENT_ROW_CACHE_LIMIT);
	if (targetCount === 0) return [];
	const current = Math.max(0, Math.min(rowCount - 1, currentIndex));
	const indices = [current];
	for (let distance = 1; indices.length < targetCount; distance += 1) {
		const next = current + distance;
		if (next < rowCount) indices.push(next);
		if (indices.length >= targetCount) break;
		const previous = current - distance;
		if (previous >= 0) indices.push(previous);
	}
	return indices;
}

export function planStagePersistentRowWindow(
	options: StagePersistentRowWindowOptions,
): StagePersistentRowWindowPlan {
	if (!Number.isSafeInteger(options.rowCount) || options.rowCount < 0) {
		throw new RangeError("Stage row count must be a non-negative safe integer.");
	}
	if (!Number.isSafeInteger(options.currentIndex)) {
		throw new RangeError("Stage current row index must be a safe integer.");
	}
	const residentLimit = getStageClarityBudget(options.quality, 1).residentRows;
	const indices = buildNearestRowIndices(options.currentIndex, options.rowCount);
	return {
		rows: indices.map((rowIndex, index) => {
			const current = index === 0;
			const resident = index < residentLimit;
			return {
				rowIndex,
				cacheKey: createStagePersistentRowCacheKey({
					trackKey: options.trackKey,
					trackGeneration: options.trackGeneration,
					settingsGeneration: options.settingsGeneration,
					rowIndex,
				}),
				kind: current ? "current" : resident ? "adjacent" : "prewarm",
				priority: current ? "essential" : resident ? "normal" : "background",
				resident,
			};
		}),
	};
}

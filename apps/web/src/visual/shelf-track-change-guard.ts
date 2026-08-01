export const SHELF_TRACK_CHANGE_GUARD_MS = 1120;

export interface ShelfTrackChangeGuardSnapshot {
	readonly blocking: boolean;
	readonly changed: boolean;
	readonly generation: number;
}

export interface ShelfTrackChangeGuard {
	sync(): ShelfTrackChangeGuardSnapshot;
}

export interface ShelfTrackChangeGuardOptions {
	readonly getTrackKey: () => string | null | undefined;
	readonly nowMs?: () => number;
	readonly durationMs?: number;
	readonly onChange?: (generation: number) => void;
}

/** 由 Shelf render lane、focus 与 pointer wiring 共享同一代际和保护窗。 */
export function createShelfTrackChangeGuard(
	options: ShelfTrackChangeGuardOptions,
): ShelfTrackChangeGuard {
	const nowMs = options.nowMs ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
	const durationMs = Math.max(0, options.durationMs ?? SHELF_TRACK_CHANGE_GUARD_MS);
	let trackKey = options.getTrackKey() ?? "";
	let generation = 0;
	let guardUntil = -Infinity;

	return {
		sync() {
			const nextTrackKey = options.getTrackKey() ?? "";
			let changed = false;
			if (nextTrackKey !== trackKey) {
				trackKey = nextTrackKey;
				generation += 1;
				changed = true;
				guardUntil = nowMs() + durationMs;
				options.onChange?.(generation);
			}
			return {
				blocking: nowMs() < guardUntil,
				changed,
				generation,
			};
		},
	};
}

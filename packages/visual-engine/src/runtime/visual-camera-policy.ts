export interface VisualCameraTarget {
	readonly x: number;
	readonly y: number;
	readonly z: number;
}

export interface VisualCameraPolicyInput {
	readonly activePreset: number;
	readonly lyricCameraLock: boolean;
	readonly wallpaperLyricLock: boolean;
	readonly shelfFocusTarget: VisualCameraTarget | null;
	readonly stageWorldTarget: VisualCameraTarget | null;
}

export interface VisualCameraPolicyResult {
	readonly source: "shelf" | "stage" | "origin";
	readonly lookAt: VisualCameraTarget;
}

const ORIGIN: VisualCameraTarget = Object.freeze({ x: 0, y: 0, z: 0 });

function finiteTarget(target: VisualCameraTarget | null): target is VisualCameraTarget {
	return target !== null && Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function resolveVisualCameraPolicy(input: VisualCameraPolicyInput): VisualCameraPolicyResult {
	if (finiteTarget(input.shelfFocusTarget)) {
		return {
			source: "shelf",
			lookAt: { ...input.shelfFocusTarget },
		};
	}

	if (
		input.activePreset === 7 &&
		!input.lyricCameraLock &&
		!input.wallpaperLyricLock &&
		finiteTarget(input.stageWorldTarget)
	) {
		return {
			source: "stage",
			lookAt: {
				x: clamp(input.stageWorldTarget.x, -2.4, 2.4),
				y: clamp(input.stageWorldTarget.y - 0.34, -1.55, 1.25),
				z: clamp(input.stageWorldTarget.z + 0.16, -2.6, 1.55),
			},
		};
	}

	return { source: "origin", lookAt: ORIGIN };
}

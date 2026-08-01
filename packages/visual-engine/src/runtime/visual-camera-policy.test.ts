import { expect, test } from "bun:test";
import { resolveVisualCameraPolicy } from "./visual-camera-policy";

test("camera policy gives Shelf focus priority over the eligible Sonic Stage target", () => {
	const result = resolveVisualCameraPolicy({
		activePreset: 7,
		lyricCameraLock: false,
		wallpaperLyricLock: false,
		shelfFocusTarget: { x: 2.32, y: -0.10, z: 0.72 },
		stageWorldTarget: { x: 0.4, y: 0.2, z: -0.3 },
	});

	expect(result).toEqual({
		source: "shelf",
		lookAt: { x: 2.32, y: -0.10, z: 0.72 },
	});
});

test("camera policy applies the Sonic Stage target offset and clamp without Shelf focus", () => {
	const baseline = resolveVisualCameraPolicy({
		activePreset: 7,
		lyricCameraLock: false,
		wallpaperLyricLock: false,
		shelfFocusTarget: null,
		stageWorldTarget: { x: 0.4, y: 0.2, z: -0.3 },
	});

	expect(baseline.source).toBe("stage");
	expect(baseline.lookAt.x).toBeCloseTo(0.4, 6);
	expect(baseline.lookAt.y).toBeCloseTo(-0.14, 6);
	expect(baseline.lookAt.z).toBeCloseTo(-0.14, 6);

	const result = resolveVisualCameraPolicy({
		activePreset: 7,
		lyricCameraLock: false,
		wallpaperLyricLock: false,
		shelfFocusTarget: null,
		stageWorldTarget: { x: 9, y: 4, z: -9 },
	});

	expect(result).toEqual({
		source: "stage",
		lookAt: { x: 2.4, y: 1.25, z: -2.6 },
	});
});

test("camera policy falls back to origin for ineligible or non-finite Stage targets", () => {
	const base = {
		shelfFocusTarget: null,
		stageWorldTarget: { x: 0.4, y: 0.2, z: -0.3 },
	};

	expect(resolveVisualCameraPolicy({
		...base,
		activePreset: 6,
		lyricCameraLock: false,
		wallpaperLyricLock: false,
	})).toEqual({ source: "origin", lookAt: { x: 0, y: 0, z: 0 } });
	expect(resolveVisualCameraPolicy({
		...base,
		activePreset: 7,
		lyricCameraLock: true,
		wallpaperLyricLock: false,
	})).toEqual({ source: "origin", lookAt: { x: 0, y: 0, z: 0 } });
	expect(resolveVisualCameraPolicy({
		...base,
		activePreset: 7,
		lyricCameraLock: false,
		wallpaperLyricLock: true,
	})).toEqual({ source: "origin", lookAt: { x: 0, y: 0, z: 0 } });
	expect(resolveVisualCameraPolicy({
		...base,
		activePreset: 7,
		lyricCameraLock: false,
		wallpaperLyricLock: false,
		stageWorldTarget: { x: Number.NaN, y: 0, z: 0 },
	})).toEqual({ source: "origin", lookAt: { x: 0, y: 0, z: 0 } });
});

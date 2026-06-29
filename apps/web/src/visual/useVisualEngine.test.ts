import { expect, test } from "bun:test";
import { isRuntimeShelfPreviewActive, resolveHomeVisualPreset, resolveSkullShelfCompositionActive, resolveStageLyricLayoutOptions, setRuntimeShelfMode } from "./useVisualEngine";

test("isRuntimeShelfPreviewActive follows side-auto shelf visibility readiness", () => {
	expect(isRuntimeShelfPreviewActive("auto", 0.17)).toBe(true);
	expect(isRuntimeShelfPreviewActive("auto", 0.16)).toBe(false);
	expect(isRuntimeShelfPreviewActive("auto", 0)).toBe(false);
	expect(isRuntimeShelfPreviewActive("always", 0.9)).toBe(false);
	expect(isRuntimeShelfPreviewActive(undefined, 0.9)).toBe(false);
});

test("resolveSkullShelfCompositionActive follows baseline side shelf composition conditions", () => {
	expect(resolveSkullShelfCompositionActive({
		preset: 6,
		shelfMode: "side",
		shelfVisibility: 0.19,
		pinnedOpen: false,
		hasOpenContent: false,
	})).toBe(true);
	expect(resolveSkullShelfCompositionActive({
		preset: 6,
		shelfMode: "side",
		shelfVisibility: 0.03,
		pinnedOpen: true,
		hasOpenContent: false,
	})).toBe(true);
	expect(resolveSkullShelfCompositionActive({
		preset: 6,
		shelfMode: "side",
		shelfVisibility: 0,
		pinnedOpen: false,
		hasOpenContent: true,
	})).toBe(true);
	expect(resolveSkullShelfCompositionActive({
		preset: 6,
		shelfMode: "stage",
		shelfVisibility: 1,
		pinnedOpen: true,
		hasOpenContent: true,
	})).toBe(false);
	expect(resolveSkullShelfCompositionActive({
		preset: 5,
		shelfMode: "side",
		shelfVisibility: 1,
		pinnedOpen: true,
		hasOpenContent: true,
	})).toBe(false);
});

test("setRuntimeShelfMode mutates the render-loop source shelf mode ref", () => {
	const ref = { current: "off" };
	setRuntimeShelfMode(ref, "side");
	expect(ref.current).toBe("side");
});

test("setRuntimeShelfMode notifies the persistent shelf mode source", () => {
	const ref = { current: "off" };
	const calls: string[] = [];
	setRuntimeShelfMode(ref, "side", (mode) => calls.push(mode));
	expect(calls).toEqual(["side"]);
});

test("resolveHomeVisualPreset applies baseline idle wallpaper preset and restores previous preset", () => {
	const activated = resolveHomeVisualPreset(true, 2, 0, null);
	expect(activated).toEqual({ preset: 5, previousPreset: 2, changed: true });

	const held = resolveHomeVisualPreset(true, 5, 0, 2);
	expect(held).toEqual({ preset: 5, previousPreset: 2, changed: false });

	const activatedFromSamePreset = resolveHomeVisualPreset(true, 5, 0, null);
	expect(activatedFromSamePreset).toEqual({ preset: 5, previousPreset: 5, changed: true });

	const restored = resolveHomeVisualPreset(false, 5, 0, 2);
	expect(restored).toEqual({ preset: 2, previousPreset: null, changed: true });

	const restoredToSamePreset = resolveHomeVisualPreset(false, 5, 0, 5);
	expect(restoredToSamePreset).toEqual({ preset: 5, previousPreset: null, changed: false });
});

test("resolveHomeVisualPreset restores playback visual preset on playback entry when no home preview preset is cached", () => {
	const restored = resolveHomeVisualPreset(false, 5, 0, null, {
		playbackActive: true,
		playbackPreset: 2,
	});
	expect(restored).toEqual({ preset: 2, previousPreset: null, changed: true });
});

test("resolveHomeVisualPreset keeps cached pre-home preset ahead of playback preset", () => {
	const restored = resolveHomeVisualPreset(false, 5, 0, 4, {
		playbackActive: true,
		playbackPreset: 2,
	});
	expect(restored).toEqual({ preset: 4, previousPreset: null, changed: true });
});

test("resolveStageLyricLayoutOptions carries baseline camera lock and layout controls", () => {
	const layout = resolveStageLyricLayoutOptions({
		lyricCameraLock: true,
		lyricScale: 1.2,
		lyricOffsetX: -0.3,
		lyricOffsetY: 0.4,
		lyricOffsetZ: 0.8,
		lyricTiltX: 9,
		lyricTiltY: -11,
	});
	expect(layout).toEqual({
		lyricCameraLock: true,
		lyricScale: 1.2,
		lyricOffsetX: -0.3,
		lyricOffsetY: 0.4,
		lyricOffsetZ: 0.8,
		lyricTiltX: 9,
		lyricTiltY: -11,
		preset: undefined,
		skullLyricEdgeGuard: false,
		skullMouthLyrics: false,
	});
});

test("resolveStageLyricLayoutOptions enables skull-mouth lyrics for skull preset", () => {
	const layout = resolveStageLyricLayoutOptions({
		preset: 6,
		lyricCameraLock: false,
	});
	expect(layout.skullMouthLyrics).toBe(true);
});

test("resolveStageLyricLayoutOptions enables skull edge guard while skull orbit is centered", () => {
	const layout = resolveStageLyricLayoutOptions({
		preset: 6,
		lyricCameraLock: false,
		lyricScale: 1.4,
	}, {
		orbitCenterLocked: true,
	});
	expect(layout.skullLyricEdgeGuard).toBe(true);
});

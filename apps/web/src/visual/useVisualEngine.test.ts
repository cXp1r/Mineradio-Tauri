import { expect, test } from "bun:test";
import { createStageLyricsHostSuppliers, createStageLyricsShelfSuppliers, isRuntimeShelfPreviewActive, lyricPaletteFromHex, readVisualCurrentTimeSeconds, resolveHomeVisualPreset, resolveRuntimeWallpaperSafe, resolveSkullMouthLyricsActive, resolveSkullShelfCompositionActive, resolveStageLyricLayoutOptions, resolveStageLyricPalette, shouldDimWallpaperParticlesForShelf, setRuntimeShelfMode } from "./useVisualEngine";

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

test("shouldDimWallpaperParticlesForShelf follows baseline wallpaper side pinned/detail formula", () => {
	expect(shouldDimWallpaperParticlesForShelf({
		preset: 5,
		shelfMode: "side",
		pinnedOpen: true,
		hasOpenContent: false,
	})).toBe(true);
	expect(shouldDimWallpaperParticlesForShelf({
		preset: 5,
		shelfMode: "side",
		pinnedOpen: false,
		hasOpenContent: true,
	})).toBe(true);
	expect(shouldDimWallpaperParticlesForShelf({
		preset: 5,
		shelfMode: "side",
		pinnedOpen: false,
		hasOpenContent: false,
		shelfVisibility: 1,
		hoverCueValue: 1,
	})).toBe(false);
	expect(shouldDimWallpaperParticlesForShelf({
		preset: 6,
		shelfMode: "side",
		pinnedOpen: true,
		hasOpenContent: true,
	})).toBe(false);
	expect(shouldDimWallpaperParticlesForShelf({
		preset: 5,
		shelfMode: "stage",
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

test("readVisualCurrentTimeSeconds prefers frame-accurate audio time over React position state", () => {
	expect(readVisualCurrentTimeSeconds({ currentTime: 12.345 } as HTMLAudioElement, 10_000)).toBe(12.345);
	expect(readVisualCurrentTimeSeconds({ currentTime: NaN } as HTMLAudioElement, 10_000)).toBe(10);
	expect(readVisualCurrentTimeSeconds(null, 0)).toBe(0);
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

test("resolveStageLyricLayoutOptions enables skull-mouth lyrics for visible skull preset", () => {
	const layout = resolveStageLyricLayoutOptions({
		preset: 6,
		lyricCameraLock: false,
	}, {}, {
		skullParticlesVisible: true,
	});
	expect(layout.skullMouthLyrics).toBe(true);
	expect(resolveSkullMouthLyricsActive({
		preset: 6,
		skullParticlesVisible: false,
	})).toBe(false);
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

test("createStageLyricsShelfSuppliers exposes baseline shelf state to lyric lifecycle", () => {
	const shelfManager = {
		getShelfVisibility: () => 0.29,
		getMode: () => "side" as const,
		hasOpenContent: () => false,
		getShelfPinnedOpen: () => true,
		getShelfHoverCueValue: () => 0.31,
	};
	const suppliers = createStageLyricsShelfSuppliers({
		shelfManager,
		shelfModeRef: { current: "side" },
		shelfPresenceRef: { current: "always" },
		fxDefaults: { preset: 6 },
	});

	expect(suppliers.getShelfVisibility()).toBe(0.29);
	expect(suppliers.getShelfMode()).toBe("side");
	expect(suppliers.getShelfHasOpenContent()).toBe(false);
	expect(suppliers.getShelfPinnedOpen()).toBe(true);
	expect(suppliers.getShelfAlwaysVisible()).toBe(true);
	expect(suppliers.getShelfHoverCueValue()).toBe(0.31);
	expect(suppliers.getSkullShelfOpen()).toBe(true);
});

test("createStageLyricsShelfSuppliers resolves skull shelf state from runtime fx ref", () => {
	const shelfManager = {
		getShelfVisibility: () => 0.19,
		getMode: () => "side" as const,
		hasOpenContent: () => false,
		getShelfPinnedOpen: () => false,
		getShelfHoverCueValue: () => 0,
	};
	const suppliers = createStageLyricsShelfSuppliers({
		shelfManager,
		shelfModeRef: { current: "side" },
		fxDefaults: { preset: 0 },
		fxRef: { current: { preset: 6 } },
	});

	expect(suppliers.getSkullShelfOpen()).toBe(true);
});

test("createStageLyricsHostSuppliers bridges glow strength and beat flags from runtime fx", () => {
	const suppliers = createStageLyricsHostSuppliers({
		fxDefaults: { lyricGlow: true, lyricGlowStrength: 0.1, lyricGlowBeat: false },
		fxRef: { current: { lyricGlowStrength: 0.52, lyricGlowBeat: true } },
	});
	expect(suppliers.lyricGlowStrengthSupplier()).toBe(0.52);
	expect(suppliers.lyricGlowBeatFlagSupplier()).toBe(true);

	const disabled = createStageLyricsHostSuppliers({
		fxDefaults: { lyricGlow: false, lyricGlowStrength: 0.85, lyricGlowBeat: true },
	});
	expect(disabled.lyricGlowStrengthSupplier()).toBe(0);
	expect(disabled.lyricGlowBeatFlagSupplier()).toBe(false);
});

test("resolveStageLyricPalette applies cover auto colors and custom lyric overrides", () => {
	const cover = {
		primary: "#112233",
		secondary: "#445566",
		highlight: "#778899",
		glowColor: "#aabbcc",
	};
	expect(resolveStageLyricPalette({}, cover)).toEqual(cover);
	expect(lyricPaletteFromHex("#336699")).toEqual({
		primary: "rgb(47,102,157)",
		secondary: "rgb(43,56,120)",
		highlight: "rgb(120,150,196)",
		glowColor: "rgb(43,56,120)",
	});
	expect(resolveStageLyricPalette({
		lyricColorMode: "custom",
		lyricColor: "#336699",
	}, cover)).toEqual({
		primary: "rgb(47,102,157)",
		secondary: "rgb(43,56,120)",
		highlight: "rgb(120,150,196)",
		glowColor: "rgb(43,56,120)",
	});
	expect(resolveStageLyricPalette({
		lyricColorMode: "custom",
		lyricColor: "#010203",
		lyricHighlightMode: "custom",
		lyricHighlightColor: "#040506",
		lyricGlowLinked: false,
		lyricGlowColor: "#070809",
	}, cover)).toEqual({
		primary: "rgb(19,41,63)",
		secondary: "rgb(35,45,98)",
		highlight: "rgb(35,44,54)",
		glowColor: "rgb(41,48,54)",
	});
	expect(resolveStageLyricPalette({
		lyricHighlightMode: "custom",
		lyricHighlightColor: "#abcdef",
		lyricGlowLinked: true,
	}, cover)).toEqual({
		primary: "#112233",
		secondary: "#445566",
		highlight: "rgb(168,205,242)",
		glowColor: "rgb(139,155,230)",
	});
});

test("resolveRuntimeWallpaperSafe follows live fx preset ahead of defaults", () => {
	expect(resolveRuntimeWallpaperSafe({ fxDefaults: { preset: 0 }, fxRef: { current: { preset: 5 } } })).toBe(true);
	expect(resolveRuntimeWallpaperSafe({ fxDefaults: { preset: 5 }, fxRef: { current: { preset: 6 } } })).toBe(false);
});

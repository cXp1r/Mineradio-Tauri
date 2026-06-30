import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
	normalizeVisualCoverUrl,
	resolveVisualCoverUrl,
	resolveVisualCoverUrlForSidecar,
	resolveRuntimeShelfMode,
	resolveVisualShelfSettings,
	resolveVisualWallpaperSafe,
	syncRuntimeShelfModeOverride,
	syncDesktopLyricsMotionRef,
	createStageLyricsHostSuppliers,
	mapLyricPayload,
	countShelfPanePlaylists,
	VisualEngineHost,
	type DesktopLyricsMotionSnapshot,
} from "./VisualEngineHost";

test("VisualEngineHost server-renders a visual-host placeholder div without invoking WebGL/AudioContext", () => {
	const html = renderToStaticMarkup(
		React.createElement(VisualEngineHost, {
			audioElementRef: { current: null },
			controllerRef: { current: null },
			lyricsPayload: null,
			positionMs: 0,
			isPlaying: false,
		}),
	);
	expect(html).toContain('id="visual-host"');
	expect(html).not.toContain("canvas");
});

test("visual host keeps the WebGL canvas hit-testable for baseline stage drag and wheel controls", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((res) => res.text());
	expect(/#visual-host\s*\{[\s\S]*pointer-events:\s*auto;/.test(css)).toBe(true);
});

test("resolveRuntimeShelfMode keeps runtime side promotion across default off rerenders", () => {
	expect(resolveRuntimeShelfMode("off", "side")).toBe("side");
	expect(resolveRuntimeShelfMode("off", null)).toBe("off");
	expect(resolveRuntimeShelfMode(undefined, "side")).toBe("side");
});

test("syncRuntimeShelfModeOverride clears runtime override when default shelf prop changes", () => {
	const previousDefaultRef = { current: "off" as string | undefined };
	const overrideRef = { current: "side" as string | null };
	syncRuntimeShelfModeOverride(previousDefaultRef, overrideRef, "off");
	expect(overrideRef.current).toBe("side");
	syncRuntimeShelfModeOverride(previousDefaultRef, overrideRef, "stage");
	expect(overrideRef.current).toBeNull();
	expect(previousDefaultRef.current).toBe("stage");
});

test("resolveVisualShelfSettings prefers explicit shelf store settings over fx defaults", () => {
	expect(resolveVisualShelfSettings(
		{ shelf: "off", shelfCameraMode: "dynamic", shelfPresence: "auto" },
		{ mode: "stage", cameraMode: "static", presence: "always", showPodcasts: false, mergeCollections: true },
	)).toEqual({
		mode: "stage",
		cameraMode: "static",
		presence: "always",
		showPodcasts: false,
		mergeCollections: true,
	});
	expect(resolveVisualShelfSettings({ shelf: "off" }, null)).toEqual({
		mode: "off",
		cameraMode: "static",
		presence: "always",
		showPodcasts: true,
		mergeCollections: false,
	});
});

test("resolveVisualWallpaperSafe follows runtime fx preset ahead of defaults", () => {
	expect(resolveVisualWallpaperSafe({ preset: 0 }, { preset: 5 })).toBe(true);
	expect(resolveVisualWallpaperSafe({ preset: 5 }, { preset: 6 })).toBe(false);
});

test("countShelfPanePlaylists follows baseline mine and favorite split", () => {
	expect(countShelfPanePlaylists([
		{ subscribed: false },
		{ subscribed: true },
		{},
	] as never)).toEqual({ mineCount: 2, favCount: 1 });
});

test("resolveVisualCoverUrl prefers explicit currentCoverUrl and falls back to currentTrack.coverUrl", () => {
	expect(resolveVisualCoverUrl("override.jpg", { coverUrl: "track.jpg" } as never)).toBe("override.jpg");
	expect(resolveVisualCoverUrl(undefined, { coverUrl: "track.jpg" } as never)).toBe("track.jpg");
	expect(resolveVisualCoverUrl(null, null)).toBe("");
});

test("resolveVisualCoverUrlForSidecar proxies remote covers through sidecar and preserves inline sources", () => {
	expect(resolveVisualCoverUrlForSidecar("https://img.example/a.jpg", "http://127.0.0.1:4111")).toBe("http://127.0.0.1:4111/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg");
	expect(resolveVisualCoverUrlForSidecar("//p3.music.126.net/cover.jpg", "http://127.0.0.1:4111")).toBe("http://127.0.0.1:4111/image-proxy?url=https%3A%2F%2Fp3.music.126.net%2Fcover.jpg");
	expect(resolveVisualCoverUrlForSidecar("data:image/png;base64,abc", "http://127.0.0.1:4111")).toBe("data:image/png;base64,abc");
	expect(resolveVisualCoverUrlForSidecar("file:///tmp/a.jpg", "http://127.0.0.1:4111")).toBe("");
	expect(resolveVisualCoverUrlForSidecar("https://img.example/a.jpg", "")).toBe("https://img.example/a.jpg");
});

test("normalizeVisualCoverUrl keeps baseline protocol-relative provider covers usable for WebGL", () => {
	expect(normalizeVisualCoverUrl("//p4.music.126.net/a.jpg")).toBe("https://p4.music.126.net/a.jpg");
	expect(normalizeVisualCoverUrl(" https://img.example/a.jpg ")).toBe("https://img.example/a.jpg");
	expect(normalizeVisualCoverUrl("")).toBe("");
});

test("mapLyricPayload preserves native karaoke timing for stage lyrics", () => {
	const lines = mapLyricPayload({
		provider: "netease",
		trackId: "42",
		hasTranslation: false,
		isWordByWord: true,
		lines: [
			{
				timeMs: 1000,
				durationMs: 2000,
				text: "你好",
				charCount: 2,
				words: [
					{ text: "你", timeMs: 1000, durationMs: 500, c0: 0, c1: 1 },
					{ text: "好", timeMs: 1500, durationMs: 500, c0: 1, c1: 2 },
				],
			},
		],
	});

	expect(lines).toEqual([
		{
			t: 1,
			duration: 2,
			text: "你好",
			charCount: 2,
			words: [
				{ text: "你", t: 1, d: 0.5, c0: 0, c1: 1 },
				{ text: "好", t: 1.5, d: 0.5, c0: 1, c1: 2 },
			],
		},
	]);
});

test("syncDesktopLyricsMotionRef copies lifecycle motion snapshot into a mutable ref", () => {
	const target = {
		current: {
			highBloom: 0,
			beatGlow: 0,
			beatPulse: 0,
			bass: 0,
		} satisfies DesktopLyricsMotionSnapshot,
	};
	const lifecycle = {
		getMotionSnapshot: () => ({
			highBloom: 0.42,
			beatGlow: 0.73,
			beatPulse: 1.1,
			bass: 0.64,
		}),
	};

	syncDesktopLyricsMotionRef(target, lifecycle);

	expect(target.current).toEqual({
		highBloom: 0.42,
		beatGlow: 0.73,
		beatPulse: 1.1,
		bass: 0.64,
	});
});

test("createStageLyricsHostSuppliers bridges baseline duration, fallback, particles and native karaoke flags", () => {
	const suppliers = createStageLyricsHostSuppliers({
		durationMsRef: { current: 210000 },
		fallbackTextRef: { current: "Song A - Artist" },
		lyricsHasNativeKaraokeRef: { current: true },
		fxDefaults: { particleLyrics: true, lyricGlowParticles: false },
		fxRef: { current: { particleLyrics: false, lyricGlowParticles: true } },
	});

	expect(suppliers.audioDurationSupplier()).toBe(210);
	expect(suppliers.fallbackTextSupplier()).toBe("Song A - Artist");
	expect(suppliers.particleLyricsFlagSupplier()).toBe(false);
	expect(suppliers.lyricGlowParticlesSupplier()).toBe(true);
	expect(suppliers.lyricsHasNativeKaraokeSupplier()).toBe(true);
});

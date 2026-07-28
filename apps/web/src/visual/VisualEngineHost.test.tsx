import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
	normalizeVisualCoverUrl,
	resolveVisualCoverUrl,
	resolveVisualCoverUrlForSidecar,
	resolveVisualTrackKey,
	resolveRuntimeShelfMode,
	resolveVisualShelfSettings,
	resolveVisualWallpaperSafe,
	syncRuntimeShelfModeOverride,
	syncDesktopLyricsMotionRef,
	createStageLyricsHostSuppliers,
	mapLyricPayload,
	mapShelfItemCoversForSidecar,
	countShelfPanePlaylists,
	coverUrlToCssBackgroundImage,
	VisualEngineHost,
	type DesktopLyricsMotionSnapshot,
} from "./VisualEngineHost";

test("VisualEngineHost builds immutable runtime snapshots while preserving its public controllerRef prop", async () => {
	const source = await fetch(new URL("./VisualEngineHost.tsx", import.meta.url)).then((response) => response.text());
	expect(source).toContain("controllerRef: RefObject<PlayerController | null>");
	expect(source).toContain("buildPlaybackVisualSnapshot");
	expect(source).toContain("buildLyricsVisualSnapshot");
	expect(source).toContain("buildShelfVisualSnapshot");
	expect(source).toContain("buildVisualSettingsSnapshot");
	expect(source).toContain("useMemo");
	expect(source).toContain("playbackSnapshot");
	expect(source).toContain("lyricsSnapshot");
	expect(source).toContain("shelfSnapshot");
	expect(source).toContain("settingsSnapshot");
});

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
	expect(html).toContain('id="custom-bg"');
	expect(html).toContain('id="custom-bg-video"');
	expect(html).toContain('id="album-bg"');
	expect(html).not.toContain("canvas");
});

test("VisualEngineHost restores baseline album background layer from the direct cover URL", () => {
	const html = renderToStaticMarkup(
		React.createElement(VisualEngineHost, {
			audioElementRef: { current: null },
			controllerRef: { current: null },
			lyricsPayload: null,
			positionMs: 0,
			isPlaying: false,
			currentCoverUrl: "https://img.example/a.jpg",
			sidecarBaseUrl: "http://127.0.0.1:4111",
		}),
	);
	expect(html).toContain('id="album-bg"');
	expect(html).toContain('class="visible"');
	// Baseline `loadCoverFromUrl` sets `#album-bg.style.backgroundImage = "url(" + directUrl + ")"`
	// using the direct cover URL (CSS images do not need CORS). The WebGL cover
	// texture separately goes through the sidecar image proxy for crossOrigin.
	expect(html).toContain("https://img.example/a.jpg");
	expect(html).not.toContain("image-proxy");
});

test("visual host keeps the WebGL canvas hit-testable for baseline stage drag and wheel controls", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((res) => res.text());
	expect(/#visual-host\s*\{[\s\S]*pointer-events:\s*auto;/.test(css)).toBe(true);
});

test("album background CSS matches the Electron baseline cover glow layer", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((res) => res.text());
	expect(/#custom-bg\s*\{[\s\S]*position:\s*fixed;[\s\S]*z-index:\s*0;[\s\S]*background:\s*var\(--custom-bg-color,#000\);/.test(css)).toBe(true);
	expect(/#custom-bg::before\s*\{[\s\S]*background-image:\s*var\(--custom-bg-image,none\);[\s\S]*opacity:\s*var\(--custom-bg-image-opacity,0\);/.test(css)).toBe(true);
	expect(/#visual-host\s*\{[\s\S]*z-index:\s*1;[\s\S]*background:\s*transparent;/.test(css)).toBe(true);
	expect(/#album-bg\s*\{[\s\S]*position:\s*fixed;[\s\S]*z-index:\s*0;[\s\S]*filter:\s*blur\(120px\) brightness\(0\.18\) saturate\(1\.5\);[\s\S]*transform:\s*scale\(1\.4\);[\s\S]*transition:\s*background-image 1\.5s ease, opacity 1\.5s ease;/.test(css)).toBe(true);
	expect(/#visual-host canvas\s*\{[\s\S]*z-index:\s*1;/.test(css)).toBe(true);
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

test("resolveVisualTrackKey uses the frozen provider and id identity", () => {
	expect(resolveVisualTrackKey({ provider: "netease", id: "42" } as never)).toBe("netease:42");
	expect(resolveVisualTrackKey(null)).toBe("");
});

test("coverUrlToCssBackgroundImage preserves quoted baseline url syntax safely", () => {
	expect(coverUrlToCssBackgroundImage("https://img.example/a.jpg")).toBe('url("https://img.example/a.jpg")');
	expect(coverUrlToCssBackgroundImage('https://img.example/a"b.jpg')).toBe('url("https://img.example/a\\"b.jpg")');
	expect(coverUrlToCssBackgroundImage("")).toBe(undefined);
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

test("mapLyricPayload sorts stage lyrics and native words like the Electron baseline parser", () => {
	const lines = mapLyricPayload({
		provider: "netease",
		trackId: "42",
		hasTranslation: false,
		isWordByWord: true,
		lines: [
			{
				timeMs: 2000,
				text: "C",
				words: [{ text: "later", timeMs: 2200, c0: 0, c1: 1 }],
			},
			{
				timeMs: 0,
				text: "A",
				words: [
					{ text: "second", timeMs: 500, c0: 1, c1: 2 },
					{ text: "first", timeMs: 0, c0: 0, c1: 1 },
				],
			},
			{ timeMs: 1000, text: "B" },
		],
	});

	expect(lines.map((line) => line.text)).toEqual(["A", "B", "C"]);
	expect(lines[0].words?.map((word) => word.text)).toEqual(["first", "second"]);
});

test("mapShelfItemCoversForSidecar proxies playlist covers for canvas shelf textures", () => {
	expect(mapShelfItemCoversForSidecar([
		{ type: "playlist", title: "A", cover: "https://img.example/a.jpg" },
		{ type: "queue", title: "B", cover: "data:image/png;base64,abc" },
		{ type: "queue", title: "C" },
	], "http://127.0.0.1:4111")).toEqual([
		{ type: "playlist", title: "A", cover: "http://127.0.0.1:4111/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg" },
		{ type: "queue", title: "B", cover: "data:image/png;base64,abc" },
		{ type: "queue", title: "C" },
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

import { expect, test } from "bun:test";
import React, { StrictMode, act, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
	type LyricsVisualSnapshot,
	type PlaybackVisualSnapshot,
	type ShelfVisualSnapshot,
	type VisualEngineFacade,
	type VisualEngineOptions,
	type VisualPerformanceSnapshot,
	type VisualSettingsSnapshot,
	type VisualVisibilityState,
} from "@mineradio/visual-engine";
import { createLegacyVisualEventBridge } from "./runtime/legacy-visual-events";
import type { VisualEnvironmentAdapter } from "./runtime/visual-environment-adapter";
import { createStageLyricsHostSuppliers, createStageLyricsShelfSuppliers, initAudioSource, isRuntimeShelfPreviewActive, lyricPaletteFromHex, readVisualCurrentTimeSeconds, resolveHomeVisualPreset, resolveRuntimeVisualPerformancePolicy, resolveRuntimeWallpaperSafe, resolveSkullMouthLyricsActive, resolveSkullShelfCompositionActive, resolveStageLyricLayoutOptions, resolveStageLyricPalette, shouldDimWallpaperParticlesForShelf, shouldResetLyricStageCameraView, shouldRetryVisualCoverLoad, setRuntimeShelfMode, useVisualEngine, type VisualPerformanceSnapshotReader } from "./useVisualEngine";

test("legacy composition routes adaptive FPS through the runtime visual performance policy", async () => {
	const source = await fetch(new URL("./runtime/create-legacy-visual-composition.ts", import.meta.url)).then((res) => res.text());
	expect(source).toContain("readVisualPerformancePolicy()");
	expect(source).toContain("readRuntimeVisualPerformanceFx()");
	expect(source).toContain("width: policy.renderWidth ?? opts?.width");
	expect(source).toContain("height: policy.renderHeight ?? opts?.height");
	expect(source).toContain("scheduler: context.scheduler");
	expect(source).toContain("performance: context.performance");
});

test("isRuntimeShelfPreviewActive follows side-auto shelf visibility readiness", () => {
	expect(isRuntimeShelfPreviewActive("auto", 0.17)).toBe(true);
	expect(isRuntimeShelfPreviewActive("auto", 0.16)).toBe(false);
	expect(isRuntimeShelfPreviewActive("auto", 0)).toBe(false);
	expect(isRuntimeShelfPreviewActive("always", 0.9)).toBe(false);
	expect(isRuntimeShelfPreviewActive(undefined, 0.9)).toBe(false);
});

test("resolveRuntimeVisualPerformancePolicy maps quality and background state to FPS DPR and expensive effects", () => {
	expect(resolveRuntimeVisualPerformancePolicy({
		fx: { performanceQuality: "eco", performanceBackground: "auto", bloom: true, aiDepth: true, backCover: true },
		devicePixelRatio: 2,
		documentHidden: false,
		windowFocused: true,
		prefersReducedMotion: false,
	})).toEqual({
		adaptiveFps: 30,
		pixelRatio: 0.85,
		bloom: false,
		aiDepth: false,
		backCover: false,
	});
	expect(resolveRuntimeVisualPerformancePolicy({
		fx: { performanceQuality: "high", performanceBackground: "auto", bloom: true, aiDepth: true, backCover: true },
		devicePixelRatio: 2,
		documentHidden: true,
		windowFocused: false,
		prefersReducedMotion: false,
	})).toEqual({
		adaptiveFps: 1,
		pixelRatio: 0.3,
		renderWidth: 4,
		renderHeight: 4,
		bloom: false,
		aiDepth: false,
		backCover: false,
	});
	expect(resolveRuntimeVisualPerformancePolicy({
		fx: { performanceQuality: "high", performanceBackground: "auto", bloom: true, aiDepth: true, backCover: true },
		devicePixelRatio: 2,
		documentHidden: false,
		windowFocused: false,
		prefersReducedMotion: false,
	})).toEqual({
		adaptiveFps: 24,
		pixelRatio: 0.9,
		bloom: false,
		aiDepth: false,
		backCover: false,
	});
	expect(resolveRuntimeVisualPerformancePolicy({
		fx: { performanceQuality: "ultra", performanceBackground: "keep", bloom: true, aiDepth: true, backCover: true },
		devicePixelRatio: 2,
		documentHidden: true,
		windowFocused: false,
		prefersReducedMotion: false,
	})).toEqual({
		adaptiveFps: 0,
		pixelRatio: 1.35,
		bloom: true,
		aiDepth: true,
		backCover: true,
	});
	expect(resolveRuntimeVisualPerformancePolicy({
		fx: { performanceQuality: "balanced", performanceBackground: "release", bloom: true, aiDepth: true, backCover: true },
		devicePixelRatio: 2,
		documentHidden: true,
		windowFocused: false,
		prefersReducedMotion: true,
	})).toEqual({
		adaptiveFps: 1,
		pixelRatio: 0.3,
		renderWidth: 4,
		renderHeight: 4,
		bloom: false,
		aiDepth: false,
		backCover: false,
	});
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

test("initAudioSource reuses the baseline cached MediaElementSource and AudioContext for the same audio element", async () => {
	const originalWindow = globalThis.window;
	const createdSources: unknown[] = [];
	const createdContexts: unknown[] = [];
	let resumeCount = 0;
	const el = {
		paused: false,
		ended: false,
		currentTime: 1.25,
	} as HTMLAudioElement & Record<string, unknown>;
	class FakeNode {
		connections: unknown[] = [];
		connect(node: unknown) {
			this.connections.push(node);
		}
		disconnect() {
			this.connections = [];
		}
	}
	class FakeAnalyser extends FakeNode {
		fftSize = 0;
		frequencyBinCount = 4;
		smoothingTimeConstant = 0;
		getByteFrequencyData(data: Uint8Array) {
			data.fill(24);
		}
		getByteTimeDomainData(data: Uint8Array) {
			data.fill(128);
		}
	}
	class FakeAudioContext {
		state = "suspended";
		sampleRate = 48_000;
		destination = new FakeNode();
		constructor() {
			createdContexts.push(this);
		}
		createAnalyser() {
			return new FakeAnalyser();
		}
		createGain() {
			return { gain: { value: 0 }, connect() {}, disconnect() {} };
		}
		createMediaElementSource(audio: HTMLAudioElement) {
			const source = new FakeNode();
			createdSources.push({ source, audio, context: this });
			return source;
		}
		resume() {
			resumeCount += 1;
			this.state = "running";
			return Promise.resolve();
		}
	}
	globalThis.window = {
		AudioContext: FakeAudioContext,
	} as unknown as Window & typeof globalThis;
	try {
		const first = await initAudioSource(() => el);
		const firstFrame = first();
		const second = await initAudioSource(() => el);
		const secondFrame = second();

		expect(createdContexts.length).toBe(1);
		expect(createdSources.length).toBe(1);
		if (!firstFrame || !secondFrame) throw new Error("expected audio frames");
		expect(firstFrame.playing).toBe(true);
		expect(secondFrame.playing).toBe(true);
		expect(resumeCount).toBeGreaterThan(0);
		first.dispose();
		second.dispose();
	} finally {
		globalThis.window = originalWindow;
	}
});

test("initAudioSource exposes the cached AudioContext before the first analyser frame", async () => {
	const originalWindow = globalThis.window;
	const el = {} as HTMLAudioElement & Record<string, unknown>;
	class FakeNode {
		connect() {}
		disconnect() {}
	}
	class FakeAnalyser extends FakeNode {
		fftSize = 0;
		frequencyBinCount = 4;
		smoothingTimeConstant = 0;
		getByteFrequencyData() {}
		getByteTimeDomainData() {}
	}
	class FakeAudioContext {
		state = "suspended";
		sampleRate = 48_000;
		destination = new FakeNode();
		createAnalyser() {
			return new FakeAnalyser();
		}
		createGain() {
			return { gain: { value: 0 }, connect() {}, disconnect() {} };
		}
		createMediaElementSource() {
			return new FakeNode();
		}
		resume() {
			this.state = "running";
			return Promise.resolve();
		}
	}
	globalThis.window = {
		AudioContext: FakeAudioContext,
	} as unknown as Window & typeof globalThis;
	try {
		const frameSource = await initAudioSource(() => el);
		expect(el._mineradioAudioCtx).toBe(frameSource.audioContext);
		frameSource.dispose();
	} finally {
		globalThis.window = originalWindow;
	}
});

test("shouldResetLyricStageCameraView fires only when leaving Home preview into playback stage", () => {
	expect(shouldResetLyricStageCameraView({ wasHomeActive: true, homeActive: false, playbackActive: true })).toBe(true);
	expect(shouldResetLyricStageCameraView({ wasHomeActive: true, homeActive: false, playbackActive: false })).toBe(false);
	expect(shouldResetLyricStageCameraView({ wasHomeActive: false, homeActive: false, playbackActive: true })).toBe(false);
	expect(shouldResetLyricStageCameraView({ wasHomeActive: true, homeActive: true, playbackActive: true })).toBe(false);
});

test("shouldRetryVisualCoverLoad retries failed cover loads after sidecar recovery without spamming successful textures", () => {
	expect(shouldRetryVisualCoverLoad({
		coverUrl: "",
		hasCover: 0,
		nowMs: 5000,
		lastAttemptAtMs: 0,
		lastAttemptUrl: "",
	})).toBe(false);
	expect(shouldRetryVisualCoverLoad({
		coverUrl: "http://127.0.0.1:4111/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg",
		hasCover: 1,
		nowMs: 5000,
		lastAttemptAtMs: 0,
		lastAttemptUrl: "http://127.0.0.1:4111/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg",
	})).toBe(false);
	expect(shouldRetryVisualCoverLoad({
		coverUrl: "next.jpg",
		hasCover: 0,
		nowMs: 200,
		lastAttemptAtMs: 100,
		lastAttemptUrl: "prev.jpg",
	})).toBe(true);
	expect(shouldRetryVisualCoverLoad({
		coverUrl: "same.jpg",
		hasCover: 0,
		nowMs: 2000,
		lastAttemptAtMs: 1000,
		lastAttemptUrl: "same.jpg",
		intervalMs: 2200,
	})).toBe(false);
	expect(shouldRetryVisualCoverLoad({
		coverUrl: "same.jpg",
		hasCover: 0,
		nowMs: 3300,
		lastAttemptAtMs: 1000,
		lastAttemptUrl: "same.jpg",
		intervalMs: 2200,
	})).toBe(true);
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

test("resolveHomeVisualPreset stops forcing idle wallpaper after a committed DIY preset change", () => {
	const manual = resolveHomeVisualPreset(true, 4, 4, 2, {
		committedPresetChanged: true,
	});
	expect(manual).toEqual({ preset: 4, previousPreset: null, changed: false });

	const held = resolveHomeVisualPreset(true, 4, 4, null, {
		previewEnabled: false,
	});
	expect(held).toEqual({ preset: 4, previousPreset: null, changed: false });
});

test("resolveHomeVisualPreset preserves Sonic instead of replacing it with the idle wallpaper preset", () => {
	const sonic = resolveHomeVisualPreset(true, 7, 7, null);
	expect(sonic).toEqual({ preset: 7, previousPreset: null, changed: false });
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

function playback(trackKey: string): PlaybackVisualSnapshot {
	return Object.freeze({
		trackKey,
		playing: trackKey !== "idle",
		durationMs: 120_000,
		coverUrl: `${trackKey}.jpg`,
		beatMapKey: trackKey,
		beatMap: null,
		splashActive: false,
		homeActive: false,
	});
}

function lyrics(label: string): LyricsVisualSnapshot {
	return Object.freeze({
		lines: Object.freeze([Object.freeze({ t: 0, text: label })]),
		fallbackText: label,
		hasNativeKaraoke: label === "b",
	});
}

function shelf(label: string): ShelfVisualSnapshot {
	return Object.freeze({
		items: Object.freeze([Object.freeze({ title: label })]),
		pane: label === "b" ? "fav" : "mine",
		mode: "side",
		cameraMode: "static",
		presence: "always",
		mergeCollections: false,
		mineCount: label === "b" ? 2 : 1,
		favCount: label === "b" ? 1 : 0,
		secondaryLeftDisplaySeamGuard: label === "b",
	});
}

function settings(label: string): VisualSettingsSnapshot {
	return Object.freeze({
		fx: Object.freeze({ preset: label === "b" ? 2 : 1 }),
		coverResolution: label === "b" ? 2 : 1.55,
		wallpaperSafe: label === "b",
		backgroundPolicy: "auto",
		foregroundFramePolicy: Object.freeze({ mode: "vsync" }),
		prefersReducedMotion: label === "b",
	});
}

const VISIBLE: VisualVisibilityState = Object.freeze({
	documentVisible: true,
	windowVisible: true,
	windowFocused: true,
	windowMinimized: false,
});

const HIDDEN: VisualVisibilityState = Object.freeze({
	documentVisible: false,
	windowVisible: true,
	windowFocused: false,
	windowMinimized: false,
});

interface FacadeRecord {
	readonly facade: VisualEngineFacade;
	readonly order: string[];
	readonly playbackCalls: PlaybackVisualSnapshot[];
	readonly lyricsCalls: LyricsVisualSnapshot[];
	readonly shelfCalls: ShelfVisualSnapshot[];
	readonly settingsCalls: VisualSettingsSnapshot[];
	readonly visibilityCalls: VisualVisibilityState[];
	mountCalls: number;
	disposeCalls: number;
}

function createFacadeRecord(mount: (container: HTMLElement) => Promise<void> = async () => {}): FacadeRecord {
	const record = {
		order: [] as string[],
		playbackCalls: [] as PlaybackVisualSnapshot[],
		lyricsCalls: [] as LyricsVisualSnapshot[],
		shelfCalls: [] as ShelfVisualSnapshot[],
		settingsCalls: [] as VisualSettingsSnapshot[],
		visibilityCalls: [] as VisualVisibilityState[],
		mountCalls: 0,
		disposeCalls: 0,
	} as Omit<FacadeRecord, "facade">;
	const facade: VisualEngineFacade = {
		async mount(container) {
			record.mountCalls += 1;
			record.order.push("mount");
			await mount(container);
		},
		setPlaybackSnapshot(snapshot) {
			record.order.push("playback");
			record.playbackCalls.push(snapshot);
		},
		setLyricsSnapshot(snapshot) {
			record.order.push("lyrics");
			record.lyricsCalls.push(snapshot);
		},
		setShelfSnapshot(snapshot) {
			record.order.push("shelf");
			record.shelfCalls.push(snapshot);
		},
		setVisualSettings(snapshot) {
			record.order.push("settings");
			record.settingsCalls.push(snapshot);
		},
		applyPreset() {},
		setVisibility(snapshot) {
			record.order.push("visibility");
			record.visibilityCalls.push(snapshot);
		},
		getPerformanceSnapshot() {
			throw new Error("performance snapshot is not used by this hook test");
		},
		dispose() {
			record.disposeCalls += 1;
		},
	};
	return Object.assign(record, { facade });
}

interface EnvironmentRecord {
	readonly adapter: VisualEnvironmentAdapter;
	emit(snapshot: VisualVisibilityState): void;
	unsubscribeCalls: number;
	disposeCalls: number;
}

function createEnvironmentRecord(initialSnapshot: VisualVisibilityState = VISIBLE): EnvironmentRecord {
	let currentSnapshot = initialSnapshot;
	let listener: ((snapshot: VisualVisibilityState) => void) | null = null;
	const record = {
		unsubscribeCalls: 0,
		disposeCalls: 0,
	} as Omit<EnvironmentRecord, "adapter" | "emit">;
	const adapter: VisualEnvironmentAdapter = {
		getSnapshot: () => currentSnapshot,
		getPrefersReducedMotion: () => false,
		subscribe(nextListener) {
			listener = nextListener;
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				record.unsubscribeCalls += 1;
				if (listener === nextListener) listener = null;
			};
		},
		dispose() {
			record.disposeCalls += 1;
			listener = null;
		},
	};
	return Object.assign(record, {
		adapter,
		emit(snapshot: VisualVisibilityState) {
			currentSnapshot = snapshot;
			listener?.(snapshot);
		},
	});
}

function deferredVoid() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

async function renderAndFlush(root: ReturnType<typeof createRoot>, element: React.ReactNode): Promise<void> {
	await act(async () => {
		root.render(element);
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function unmountAndFlush(root: ReturnType<typeof createRoot>): Promise<void> {
	await act(async () => {
		root.unmount();
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function prepareReactDom(): Promise<void> {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

test("useVisualEngine submits all initial snapshots and visibility before mount", async () => {
	await prepareReactDom();
	const facade = createFacadeRecord();
	const environment = createEnvironmentRecord(HIDDEN);
	let facadeOptions: VisualEngineOptions | null = null;
	const events = createLegacyVisualEventBridge();
	function Harness() {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const audioElementRef = useRef<HTMLAudioElement | null>(null);
		useVisualEngine({
			hostRef,
			audioElementRef,
			positionMs: 1_000,
			playbackSnapshot: playback("initial"),
			lyricsSnapshot: lyrics("initial"),
			shelfSnapshot: shelf("initial"),
			settingsSnapshot: settings("initial"),
			events,
		}, {
			createFacade: (options) => {
				facadeOptions = options;
				return facade.facade;
			},
			createEnvironmentAdapter: () => environment.adapter,
		});
		return React.createElement("div", { ref: hostRef });
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await renderAndFlush(root, React.createElement(Harness));

	const capturedFacadeOptions = facadeOptions as VisualEngineOptions | null;
	expect(capturedFacadeOptions?.initialVisibility).toEqual(HIDDEN);
	const mountIndex = facade.order.indexOf("mount");
	expect(mountIndex).toBeGreaterThan(-1);
	for (const operation of ["playback", "lyrics", "shelf", "settings", "visibility"]) {
		expect(facade.order.indexOf(operation)).toBeGreaterThan(-1);
		expect(facade.order.indexOf(operation)).toBeLessThan(mountIndex);
	}
	expect(facade.playbackCalls[0]?.trackKey).toBe("initial");
	expect(facade.lyricsCalls[0]?.fallbackText).toBe("initial");
	expect(facade.shelfCalls[0]?.items[0]?.title).toBe("initial");
	expect(facade.settingsCalls[0]?.coverResolution).toBe(1.55);
	expect(facade.visibilityCalls[0]).toEqual(HIDDEN);

	await unmountAndFlush(root);
	container.remove();
});

test("useVisualEngine publishes a read-only performance reader and clears it on disposal", async () => {
	await prepareReactDom();
	const facade = createFacadeRecord();
	const environment = createEnvironmentRecord();
	const performanceSnapshot = { runtime: { generation: 7 } } as unknown as VisualPerformanceSnapshot;
	facade.facade.getPerformanceSnapshot = () => performanceSnapshot;
	const performanceSnapshotReaderRef: { current: VisualPerformanceSnapshotReader | null } = { current: null };
	const events = createLegacyVisualEventBridge();

	function Harness() {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const audioElementRef = useRef<HTMLAudioElement | null>(null);
		useVisualEngine({
			hostRef,
			audioElementRef,
			positionMs: 0,
			playbackSnapshot: playback("diagnostics"),
			lyricsSnapshot: lyrics("diagnostics"),
			shelfSnapshot: shelf("diagnostics"),
			settingsSnapshot: settings("diagnostics"),
			events,
			performanceSnapshotReaderRef,
		}, {
			createFacade: () => facade.facade,
			createEnvironmentAdapter: () => environment.adapter,
		});
		return React.createElement("div", { ref: hostRef });
	}

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await renderAndFlush(root, React.createElement(Harness));
	expect(performanceSnapshotReaderRef.current?.()).toBe(performanceSnapshot);

	await unmountAndFlush(root);
	expect(performanceSnapshotReaderRef.current).toBeNull();
	container.remove();
});

test("useVisualEngine disposes every StrictMode facade and environment instance exactly once", async () => {
	await prepareReactDom();
	const facades: FacadeRecord[] = [];
	const environments: EnvironmentRecord[] = [];
	const events = createLegacyVisualEventBridge();
	const dependencies = {
		createFacade: (_options: VisualEngineOptions) => {
			const facade = createFacadeRecord();
			facades.push(facade);
			return facade.facade;
		},
		createEnvironmentAdapter: () => {
			const environment = createEnvironmentRecord();
			environments.push(environment);
			return environment.adapter;
		},
	};
	function Harness() {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const audioElementRef = useRef<HTMLAudioElement | null>(null);
		useVisualEngine({
			hostRef,
			audioElementRef,
			positionMs: 0,
			playbackSnapshot: playback("strict"),
			lyricsSnapshot: lyrics("strict"),
			shelfSnapshot: shelf("strict"),
			settingsSnapshot: settings("strict"),
			events,
		}, dependencies);
		return React.createElement("div", { ref: hostRef });
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await renderAndFlush(root, React.createElement(StrictMode, null, React.createElement(Harness)));
	await unmountAndFlush(root);

	expect(facades.length).toBe(2);
	expect(facades.map((instance) => instance.disposeCalls)).toEqual([1, 1]);
	expect(environments.length).toBe(2);
	expect(environments.map((instance) => instance.unsubscribeCalls)).toEqual([1, 1]);
	expect(environments.map((instance) => instance.disposeCalls)).toEqual([1, 1]);
	container.remove();
});

test("useVisualEngine submits playback lyrics shelf settings and visibility changes without rebuilding the facade", async () => {
	await prepareReactDom();
	let facadeCreations = 0;
	let facadeOptions: VisualEngineOptions | null = null;
	const facade = createFacadeRecord();
	const environment = createEnvironmentRecord();
	const events = createLegacyVisualEventBridge();
	const dependencies = {
		createFacade: (options: VisualEngineOptions) => {
			facadeCreations += 1;
			facadeOptions = options;
			return facade.facade;
		},
		createEnvironmentAdapter: () => environment.adapter,
	};
	function Harness({ label }: { label: string }) {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const audioElementRef = useRef<HTMLAudioElement | null>(null);
		useVisualEngine({
			hostRef,
			audioElementRef,
			positionMs: label === "b" ? 2_000 : 1_000,
			playbackSnapshot: playback(label),
			lyricsSnapshot: lyrics(label),
			shelfSnapshot: shelf(label),
			settingsSnapshot: settings(label),
			events,
		}, dependencies);
		return React.createElement("div", { ref: hostRef });
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await renderAndFlush(root, React.createElement(Harness, { label: "a" }));
	await renderAndFlush(root, React.createElement(Harness, { label: "b" }));
	await act(async () => {
		environment.emit(HIDDEN);
		await Promise.resolve();
	});

	expect(facadeCreations).toBe(1);
	expect(facade.mountCalls).toBe(1);
	expect(facade.playbackCalls.at(-1)?.trackKey).toBe("b");
	expect(facade.lyricsCalls.at(-1)?.fallbackText).toBe("b");
	expect(facade.shelfCalls.at(-1)?.pane).toBe("fav");
	expect(facade.settingsCalls.at(-1)?.coverResolution).toBe(2);
	expect(facade.visibilityCalls.at(-1)).toEqual(HIDDEN);
	expect((facadeOptions as VisualEngineOptions | null)?.mediaClock.currentTimeSeconds()).toBe(2);

	await unmountAndFlush(root);
	expect(facade.disposeCalls).toBe(1);
	expect(environment.unsubscribeCalls).toBe(1);
	expect(environment.disposeCalls).toBe(1);
	container.remove();
});

test("useVisualEngine ignores a late mount resolution after cleanup", async () => {
	await prepareReactDom();
	const gate = deferredVoid();
	const facade = createFacadeRecord(() => gate.promise);
	const environment = createEnvironmentRecord();
	const reported: unknown[] = [];
	const events = createLegacyVisualEventBridge();
	function Harness() {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const audioElementRef = useRef<HTMLAudioElement | null>(null);
		useVisualEngine({
			hostRef,
			audioElementRef,
			positionMs: 0,
			playbackSnapshot: playback("pending"),
			lyricsSnapshot: lyrics("pending"),
			shelfSnapshot: shelf("pending"),
			settingsSnapshot: settings("pending"),
			events,
		}, {
			createFacade: () => facade.facade,
			createEnvironmentAdapter: () => environment.adapter,
			reportError: (error) => reported.push(error),
		});
		return React.createElement("div", { ref: hostRef });
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await renderAndFlush(root, React.createElement(Harness));
	expect(facade.mountCalls).toBe(1);
	await unmountAndFlush(root);
	gate.resolve();
	await act(async () => { await gate.promise; await Promise.resolve(); });

	expect(reported).toEqual([]);
	expect(facade.disposeCalls).toBe(1);
	expect(environment.unsubscribeCalls).toBe(1);
	expect(environment.disposeCalls).toBe(1);
	container.remove();
});

test("useVisualEngine handles a late mount rejection after cleanup without reporting it", async () => {
	await prepareReactDom();
	const gate = deferredVoid();
	const facade = createFacadeRecord(() => gate.promise);
	const environment = createEnvironmentRecord();
	const reported: unknown[] = [];
	const events = createLegacyVisualEventBridge();
	function Harness() {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const audioElementRef = useRef<HTMLAudioElement | null>(null);
		useVisualEngine({
			hostRef,
			audioElementRef,
			positionMs: 0,
			playbackSnapshot: playback("pending"),
			lyricsSnapshot: lyrics("pending"),
			shelfSnapshot: shelf("pending"),
			settingsSnapshot: settings("pending"),
			events,
		}, {
			createFacade: () => facade.facade,
			createEnvironmentAdapter: () => environment.adapter,
			reportError: (error) => reported.push(error),
		});
		return React.createElement("div", { ref: hostRef });
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await renderAndFlush(root, React.createElement(Harness));
	await unmountAndFlush(root);
	gate.reject(new Error("late mount rejection"));
	await act(async () => { await Promise.resolve(); await Promise.resolve(); });

	expect(reported).toEqual([]);
	expect(facade.disposeCalls).toBe(1);
	expect(environment.unsubscribeCalls).toBe(1);
	expect(environment.disposeCalls).toBe(1);
	container.remove();
});

test("useVisualEngine reports and closes an active mount rejection exactly once", async () => {
	await prepareReactDom();
	const failure = new Error("active mount rejection");
	const facade = createFacadeRecord(async () => { throw failure; });
	const environment = createEnvironmentRecord();
	const reported: unknown[] = [];
	const events = createLegacyVisualEventBridge();
	function Harness({ label }: { label: string }) {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const audioElementRef = useRef<HTMLAudioElement | null>(null);
		useVisualEngine({
			hostRef,
			audioElementRef,
			positionMs: 0,
			playbackSnapshot: playback(label),
			lyricsSnapshot: lyrics(label),
			shelfSnapshot: shelf(label),
			settingsSnapshot: settings(label),
			events,
		}, {
			createFacade: () => facade.facade,
			createEnvironmentAdapter: () => environment.adapter,
			reportError: (error) => reported.push(error),
		});
		return React.createElement("div", { ref: hostRef });
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await renderAndFlush(root, React.createElement(Harness, { label: "failed" }));
	await act(async () => { await Promise.resolve(); await Promise.resolve(); });

	expect(reported).toEqual([failure]);
	expect(facade.disposeCalls).toBe(1);
	expect(environment.unsubscribeCalls).toBe(1);
	expect(environment.disposeCalls).toBe(1);
	const operationCountAfterFailure = facade.order.length;
	await renderAndFlush(root, React.createElement(Harness, { label: "after-failure" }));
	await act(async () => {
		environment.emit(HIDDEN);
		await Promise.resolve();
	});
	expect(facade.order.length).toBe(operationCountAfterFailure);
	await unmountAndFlush(root);
	expect(facade.disposeCalls).toBe(1);
	expect(environment.unsubscribeCalls).toBe(1);
	expect(environment.disposeCalls).toBe(1);
	container.remove();
});

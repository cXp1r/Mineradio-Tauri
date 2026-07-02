import { expect, test } from "bun:test";
import { RENDER_STEP_ORDER, RenderStepSlot } from "@mineradio/visual-engine";
import { createStageLyricsHostSuppliers, createStageLyricsShelfSuppliers, initAudioSource, isRuntimeShelfPreviewActive, lyricPaletteFromHex, readVisualCurrentTimeSeconds, resolveHomeVisualPreset, resolveRuntimeVisualPerformancePolicy, resolveRuntimeWallpaperSafe, resolveSkullMouthLyricsActive, resolveSkullShelfCompositionActive, resolveStageLyricLayoutOptions, resolveStageLyricPalette, shouldDimWallpaperParticlesForShelf, shouldResetLyricStageCameraView, shouldRetryVisualCoverLoad, setRuntimeShelfMode } from "./useVisualEngine";

test("useVisualEngine wires the dedicated lyric particle render slot between shelf and home visual", async () => {
	const source = await fetch(new URL("./useVisualEngine.ts", import.meta.url)).then((res) => res.text());
	const createIndex = source.indexOf("createLyricParticles");
	expect(createIndex).toBeGreaterThan(0);
	expect(source).toContain("renderLoop.registerStep(RenderStepSlot.LyricParticles");
	expect(source).toContain("lyricParticles.update(ctx)");
	expect(source).toContain("homeVisual.applySkullWheel");
	expect(source).toContain("homeVisual.getSkullWheelZoom()");
	expect(RENDER_STEP_ORDER.indexOf(RenderStepSlot.LyricParticles)).toBeGreaterThan(RENDER_STEP_ORDER.indexOf(RenderStepSlot.Shelf));
	expect(RENDER_STEP_ORDER.indexOf(RenderStepSlot.LyricParticles)).toBeLessThan(RENDER_STEP_ORDER.indexOf(RenderStepSlot.HomeVisual));
});

test("useVisualEngine routes adaptive FPS through the runtime visual performance policy", async () => {
	const source = await fetch(new URL("./useVisualEngine.ts", import.meta.url)).then((res) => res.text());
	expect(source).toContain("getAdaptiveFps: () => readVisualPerformancePolicy().adaptiveFps");
	expect(source).toContain("readRuntimeVisualPerformanceFx()");
	expect(source).toContain("width: policy.renderWidth ?? opts?.width");
	expect(source).toContain("height: policy.renderHeight ?? opts?.height");
	expect(source).not.toContain("getAdaptiveFps: () => 0");
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

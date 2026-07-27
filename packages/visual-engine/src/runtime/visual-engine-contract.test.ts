import { expect, test } from "bun:test";
import "./visual-engine-contract";
import type {
	ForegroundFramePolicy,
	LyricsVisualSnapshot,
	PlaybackVisualSnapshot,
	ShelfVisualSnapshot,
	VisualBackgroundPolicy,
	VisualEngineFacade,
	VisualFrameSnapshot,
	VisualMediaClock,
	VisualPerformanceSnapshot,
	VisualPresetId,
	VisualResourceBudget,
	VisualResourcePressure,
	VisualResourceUsage,
	VisualRuntimeMode,
	VisualSettingsSnapshot,
	VisualVisibilityState,
} from "../index";

test("visual engine exports the M3 snapshot and facade contracts", () => {
	const preset: VisualPresetId = 2;
	const backgroundPolicy: VisualBackgroundPolicy = "auto";
	const foregroundFramePolicy: ForegroundFramePolicy = { mode: "vsync" };
	const runtimeMode: VisualRuntimeMode = "foreground";
	const visibility: VisualVisibilityState = {
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	};
	const mediaClock: VisualMediaClock = {
		currentTimeSeconds: () => 12.5,
		durationSeconds: () => 180,
		isPlaying: () => true,
	};
	const playback: PlaybackVisualSnapshot = {
		trackKey: "track-1",
		playing: true,
		durationMs: 180_000,
		coverUrl: "https://example.test/cover.jpg",
		beatMapKey: "track-1:beat-map",
		beatMap: { events: [] },
		splashActive: false,
		homeActive: true,
	};
	const lyrics: LyricsVisualSnapshot = {
		lines: [{ t: 0, text: "Mineradio" }],
		fallbackText: "Mineradio",
		hasNativeKaraoke: false,
	};
	const shelf: ShelfVisualSnapshot = {
		items: [{ title: "Album" }],
		pane: "mine",
		mode: "side",
		cameraMode: "static",
		presence: "always",
		mergeCollections: false,
		mineCount: 1,
		favCount: 0,
		secondaryLeftDisplaySeamGuard: false,
	};
	const settings: VisualSettingsSnapshot = {
		fx: { preset },
		coverResolution: 1.55,
		wallpaperSafe: true,
		backgroundPolicy,
		foregroundFramePolicy,
		prefersReducedMotion: false,
	};
	const frame: VisualFrameSnapshot = {
		revision: 1,
		playback,
		lyrics,
		shelf,
		settings,
	};
	const resourceUsage: VisualResourceUsage = {
		textureBytes: 0,
		geometryBytes: 0,
		meshCount: 0,
		queuedTaskCost: 0,
		cacheBytes: 0,
	};
	const resourceBudget: VisualResourceBudget = { ...resourceUsage };
	const resourcePressure: VisualResourcePressure = "normal";
	const performance: VisualPerformanceSnapshot = {
		runtime: { mode: runtimeMode, running: false, mounted: false, generation: 0 },
		frames: {
			rafTicks: 0,
			timerTicks: 0,
			renders: 0,
			skippedRenders: 0,
			frameCostP50Ms: 0,
			frameCostP95Ms: 0,
			longFrames: 0,
		},
		gates: {},
		resources: {
			current: resourceUsage,
			peak: resourceUsage,
			budget: resourceBudget,
			pressure: resourcePressure,
			allocations: 0,
			releases: 0,
		},
		tasks: {
			queued: 0,
			running: 0,
			completed: 0,
			cancelled: 0,
			staleResultsDropped: 0,
			failed: 0,
			peakQueueDepth: 0,
		},
	};
	const engine: VisualEngineFacade = {
		async mount() {},
		setPlaybackSnapshot() {},
		setLyricsSnapshot() {},
		setShelfSnapshot() {},
		setVisualSettings() {},
		applyPreset() {},
		setVisibility() {},
		getPerformanceSnapshot: () => performance,
		dispose() {},
	};

	engine.setPlaybackSnapshot(playback);
	engine.setLyricsSnapshot(lyrics);
	engine.setShelfSnapshot(shelf);
	engine.setVisualSettings(settings);
	engine.applyPreset(preset);
	engine.setVisibility(visibility);

	expect(frame.revision).toBe(1);
	expect(mediaClock.currentTimeSeconds()).toBe(12.5);
	expect(engine.getPerformanceSnapshot()).toBe(performance);
	expect(typeof engine.mount).toBe("function");
	expect(typeof engine.setPlaybackSnapshot).toBe("function");
	expect(typeof engine.setLyricsSnapshot).toBe("function");
	expect(typeof engine.setShelfSnapshot).toBe("function");
	expect(typeof engine.setVisualSettings).toBe("function");
	expect(typeof engine.applyPreset).toBe("function");
	expect(typeof engine.setVisibility).toBe("function");
	expect(typeof engine.getPerformanceSnapshot).toBe("function");
	expect(typeof engine.dispose).toBe("function");
});

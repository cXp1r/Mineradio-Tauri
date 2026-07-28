import {
	M4_LYRICS_DENSE,
	M4_LYRICS_LONG,
	M4_LYRICS_SEEK_BOUNDARY,
	M4_LYRICS_TRANSLATED,
	M4_SHELF_600,
	M4_SONIC_AUDIO_FRAMES,
} from "@mineradio/visual-engine/src/fixtures/m4";
import {
	createVisualEngine,
	DEFAULT_STAGE_LYRICS_SETTINGS,
	type AudioFrameBytes,
	type ShelfContentRow,
	type SonicPerformanceQuality,
	type VisualEngineFacade,
	type VisualPerformanceSnapshot,
	type VisualSchedulerDriver,
} from "@mineradio/visual-engine";
import { buildLyricsVisualSnapshot, buildPlaybackVisualSnapshot, buildShelfVisualSnapshot, buildVisualSettingsSnapshot } from "../runtime/visual-snapshot-builders";
import { createLegacyVisualComposition, type LegacyVisualDebugController, type ManagedAudioFrameSource } from "../runtime/create-legacy-visual-composition";
import { createLegacyVisualEventBridge } from "../runtime/legacy-visual-events";

export type M4ParityScene = "stage" | "sonic" | "shelf";
export type M4ParityMode = "deterministic" | "realtime";

export function normalizeM4ParitySonicQuality(value: unknown): SonicPerformanceQuality {
	return value === "balanced" || value === "high" || value === "ultra" ? value : "eco";
}

export interface M4ParityRuntimeSnapshot {
	readonly ready: boolean;
	readonly scene: M4ParityScene;
	readonly mode: M4ParityMode;
	readonly seed: number;
	readonly sonicQuality: SonicPerformanceQuality;
	readonly clockMs: number;
	readonly performance: VisualPerformanceSnapshot;
	readonly renderer: ReturnType<LegacyVisualDebugController["getRendererDiagnostics"]> | null;
}

export interface M4ParityRuntime {
	readonly facade: VisualEngineFacade;
	setScene(scene: M4ParityScene): void;
	seek(positionMs: number): void;
	step(frameCount?: number, frameMs?: number): Promise<void>;
	soakShelf(): Promise<void>;
	getSnapshot(): M4ParityRuntimeSnapshot;
	dispose(): void;
}

interface AdvanceM4ParityFramesOptions {
	readonly frameCount: number;
	readonly frameMs: number;
	readonly readClockMs: () => number;
	readonly writeClockMs: (clockMs: number) => void;
	readonly stepFrame: (clockMs: number) => void;
}

export async function advanceM4ParityFrames(options: AdvanceM4ParityFramesOptions): Promise<void> {
	const count = Math.max(1, Math.min(3_600, Math.floor(options.frameCount)));
	for (let index = 0; index < count; index += 1) {
		const clockMs = options.readClockMs() + options.frameMs;
		options.writeClockMs(clockMs);
		options.stepFrame(clockMs);
		await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
	}
}

interface CreateM4ParityRuntimeOptions {
	readonly host: HTMLElement;
	readonly scene: M4ParityScene;
	readonly mode: M4ParityMode;
	readonly seed: number;
	readonly sonicQuality: SonicPerformanceQuality;
}

interface ManualSchedulerDriver extends VisualSchedulerDriver {
	step(nowMs: number): void;
}

function createSeededRandom(seed: number): () => number {
	let state = (seed >>> 0) || 1;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function createManualSchedulerDriver(): ManualSchedulerDriver {
	let nowMs = 0;
	let handle = 0;
	const frames = new Map<number, (timeMs: number) => void>();
	const timers = new Map<number, () => void>();
	return {
		now: () => nowMs,
		requestFrame(callback) {
			const next = ++handle;
			frames.set(next, callback);
			return next;
		},
		cancelFrame(next) {
			frames.delete(next);
		},
		setTimer(callback) {
			const next = ++handle;
			timers.set(next, callback);
			return next;
		},
		clearTimer(next) {
			timers.delete(next);
		},
		step(nextNowMs) {
			nowMs = nextNowMs;
			const callbacks = [...frames.values()];
			frames.clear();
			for (const callback of callbacks) callback(nowMs);
		},
	};
}

function createFixedAudioSource(readClockMs: () => number, readTrackKey: () => string): ManagedAudioFrameSource {
	const mainTime = new Uint8Array(1024).fill(128);
	const beatTime = new Uint8Array(1024).fill(128);
	const source = (() => {
		const timeSeconds = readClockMs() / 1000;
		const phase = Math.floor(timeSeconds * 2) % 4;
		const fixture = phase === 0
			? M4_SONIC_AUDIO_FRAMES.kick
			: phase === 2
				? M4_SONIC_AUDIO_FRAMES.bright
				: M4_SONIC_AUDIO_FRAMES.silence;
		const bins = fixture.createBins();
		return {
			mainFreqData: bins,
			mainTimeData: mainTime,
			mainSampleRate: fixture.sampleRate,
			mainFftSize: fixture.fftSize,
			beatFreqData: bins,
			beatTimeData: beatTime,
			beatSampleRate: fixture.sampleRate,
			beatFftSize: fixture.fftSize,
			playing: true,
			currentTimeSeconds: timeSeconds,
			trackKey: readTrackKey(),
		} satisfies AudioFrameBytes;
	}) as ManagedAudioFrameSource;
	source.audioContext = null;
	source.getDebugState = () => ({
		audioContextState: "none",
		sourceElementReady: false,
		sourceAttached: false,
		sourceAttachFailed: false,
		playing: true,
		currentTimeSeconds: readClockMs() / 1000,
		mainSampleRate: 48_000,
		mainFftSize: 1024,
		mainFreqAvg: 0,
		mainFreqPeak: 1,
		mainTimeRms: 0,
		beatSampleRate: 48_000,
		beatFftSize: 1024,
		beatFreqAvg: 0,
		beatFreqPeak: 1,
		beatTimeRms: 0,
	});
	source.dispose = () => {};
	return source;
}

function makeDetailRows(): ShelfContentRow[] {
	return M4_SHELF_600.map((item, index) => ({
		id: `row-${index + 1}`,
		name: `详情歌曲 ${index + 1}`,
		artist: index % 2 === 0 ? "Mineradio" : "Parity Fixture",
		provider: item.provider,
		cover: item.cover,
	}));
}

function lyricsForScene(scene: M4ParityScene) {
	if (scene === "stage") return M4_LYRICS_TRANSLATED;
	if (scene === "shelf") return M4_LYRICS_SEEK_BOUNDARY;
	return M4_LYRICS_DENSE;
}

export function createM4ParitySceneSettings(
	scene: M4ParityScene,
	sonicQuality: SonicPerformanceQuality = "eco",
) {
	return buildVisualSettingsSnapshot({
		coverResolution: 1,
		wallpaperSafe: false,
		prefersReducedMotion: false,
		fxState: {
			preset: scene === "sonic" ? 7 : 0,
			shelf: scene === "shelf" ? "side" : "off",
			shelfPresence: "always",
			shelfCameraMode: "dynamic",
			performanceQuality: scene === "sonic" ? sonicQuality : "high",
			bloom: true,
			backCover: false,
			aiDepth: false,
			particleLyrics: scene === "stage",
			stageLyrics: {
				...DEFAULT_STAGE_LYRICS_SETTINGS,
				displayMode: "cinema",
				translationMode: "multi",
				motionStyle: scene === "stage" ? "float" : "smooth",
				textureClarity: scene === "stage" ? 2 : 1,
				backgroundStarRiver: true,
			},
		},
	});
}

export async function createM4ParityRuntime(options: CreateM4ParityRuntimeOptions): Promise<M4ParityRuntime> {
	let scene = options.scene;
	let clockMs = scene === "stage" ? 3_600 : 1_000;
	let trackKey = `m4-${scene}`;
	let disposed = false;
	let controller: LegacyVisualDebugController | null = null;
	const random = createSeededRandom(options.seed);
	const manualDriver = options.mode === "deterministic" ? createManualSchedulerDriver() : null;
	const audioElementRef = { current: null };
	const events = createLegacyVisualEventBridge();
	const facade = createVisualEngine({
		mediaClock: {
			currentTimeSeconds: () => clockMs / 1000,
			durationSeconds: () => 780,
			isPlaying: () => true,
		},
		...(manualDriver ? { schedulerDriver: manualDriver } : {}),
		createComposition: () => createLegacyVisualComposition({
			audioElementRef,
			events,
			enableGpuTimerQuery: true,
			getPrefersReducedMotion: () => false,
			createAudioFrameSource: () => createFixedAudioSource(() => clockMs, () => trackKey),
			random,
			onDebugController(next) {
				controller = next;
			},
		}),
	});

	const applyScene = (nextScene: M4ParityScene) => {
		scene = nextScene;
		trackKey = `m4-${scene}`;
		facade.setPlaybackSnapshot(buildPlaybackVisualSnapshot({
			trackKey,
			playing: true,
			durationMs: 780_000,
			coverUrl: "",
			beatMapKey: "",
			beatMap: null,
			splashActive: false,
			homeActive: false,
		}));
		facade.setLyricsSnapshot(buildLyricsVisualSnapshot({
			lines: lyricsForScene(scene),
			fallbackText: "M4 parity fixture",
			hasNativeKaraoke: false,
		}));
		facade.setShelfSnapshot(buildShelfVisualSnapshot({
			items: scene === "shelf" ? M4_SHELF_600 : [],
			pane: "mine",
			mode: scene === "shelf" ? "side" : "off",
			cameraMode: "dynamic",
			presence: "always",
			mergeCollections: false,
			mineCount: scene === "shelf" ? 600 : 0,
			favCount: 0,
			secondaryLeftDisplaySeamGuard: false,
		}));
		facade.setVisualSettings(createM4ParitySceneSettings(scene, options.sonicQuality));
		facade.applyPreset(scene === "sonic" ? 7 : 0);
	};

	applyScene(scene);
	await facade.mount(options.host);
	if (manualDriver) {
		await advanceM4ParityFrames({
			frameCount: 36,
			frameMs: 1_000 / 60,
			readClockMs: () => clockMs,
			writeClockMs: (value) => { clockMs = value; },
			stepFrame: (value) => manualDriver.step(value),
		});
	}

	return {
		facade,
		setScene(nextScene) {
			if (disposed) return;
			applyScene(nextScene);
		},
		seek(positionMs) {
			if (disposed) return;
			clockMs = Math.max(0, Number(positionMs) || 0);
		},
		async step(frameCount = 1, frameMs = 1_000 / 60) {
			if (disposed || !manualDriver) return;
			await advanceM4ParityFrames({
				frameCount,
				frameMs,
				readClockMs: () => clockMs,
				writeClockMs: (value) => { clockMs = value; },
				stepFrame: (value) => manualDriver.step(value),
			});
		},
		async soakShelf() {
			if (disposed || !controller) return;
			applyScene("shelf");
			const rows = makeDetailRows();
			controller.openShelfDetail(0, rows);
			for (let index = 0; index < 600; index += 9) {
				controller.seekShelf(index);
				controller.scrollShelfDetail(9);
				if (manualDriver) {
					await advanceM4ParityFrames({
						frameCount: 1,
						frameMs: 1_000 / 30,
						readClockMs: () => clockMs,
						writeClockMs: (value) => { clockMs = value; },
						stepFrame: (value) => manualDriver.step(value),
					});
				}
			}
		},
		getSnapshot() {
			return {
				ready: !disposed,
				scene,
				mode: options.mode,
				seed: options.seed,
				sonicQuality: options.sonicQuality,
				clockMs,
				performance: facade.getPerformanceSnapshot(),
				renderer: controller?.getRendererDiagnostics() ?? null,
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			facade.dispose();
		},
	};
}

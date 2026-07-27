import { createBudgetTaskQueue } from "./budget-task-queue";
import { createCancellationScope, type CancellationTicket } from "./cancellation-scope";
import { createPerformanceCollector } from "./performance-collector";
import { createVisualResourceLedger } from "./resource-ledger";
import { createVisualResourceScope } from "./resource-scope";
import { createVisualScheduler, type VisualSchedulerDriver } from "./visual-scheduler";
import type {
	LyricsVisualSnapshot,
	ForegroundFramePolicy,
	PlaybackVisualSnapshot,
	ShelfVisualSnapshot,
	VisualEngineCompositionContext,
	VisualEngineFacade,
	VisualEngineOptions,
	VisualFrameSnapshot,
	VisualResourceBudget,
	VisualResourceUsage,
	VisualSettingsSnapshot,
	VisualVisibilityState,
} from "./visual-engine-contract";

type VisualEngineState = "idle" | "mounting" | "mounted" | "disposing" | "disposed";

const DEFAULT_BUDGET: VisualResourceBudget = {
	textureBytes: 256 * 1024 * 1024,
	geometryBytes: 128 * 1024 * 1024,
	meshCount: 1_000,
	queuedTaskCost: 512,
	cacheBytes: 128 * 1024 * 1024,
};

const DEFAULT_VISIBILITY: VisualVisibilityState = {
	documentVisible: true,
	windowVisible: true,
	windowFocused: true,
	windowMinimized: false,
};

const DEFAULT_PLAYBACK: PlaybackVisualSnapshot = Object.freeze({
	trackKey: "",
	playing: false,
	durationMs: null,
	coverUrl: "",
	beatMapKey: "",
	beatMap: null,
	splashActive: false,
	homeActive: false,
});

const DEFAULT_LYRICS: LyricsVisualSnapshot = Object.freeze({
	lines: Object.freeze([]),
	fallbackText: "",
	hasNativeKaraoke: false,
});

const DEFAULT_SHELF: ShelfVisualSnapshot = Object.freeze({
	items: Object.freeze([]),
	pane: "mine",
	mode: "side",
	cameraMode: "static",
	presence: "always",
	mergeCollections: false,
	mineCount: 0,
	favCount: 0,
	secondaryLeftDisplaySeamGuard: false,
});

const DEFAULT_FOREGROUND_FRAME_POLICY: ForegroundFramePolicy = Object.freeze({ mode: "vsync" });

const DEFAULT_SETTINGS: VisualSettingsSnapshot = Object.freeze({
	fx: Object.freeze({}),
	coverResolution: 1,
	wallpaperSafe: true,
	backgroundPolicy: "auto",
	foregroundFramePolicy: DEFAULT_FOREGROUND_FRAME_POLICY,
	prefersReducedMotion: false,
});

class VisualEngineMountCancelledError extends Error {
	constructor() {
		super("Visual engine mount was cancelled.");
		this.name = "VisualEngineMountCancelledError";
	}
}

function copyVisibility(state: VisualVisibilityState): VisualVisibilityState {
	return {
		documentVisible: state.documentVisible,
		windowVisible: state.windowVisible,
		windowFocused: state.windowFocused,
		windowMinimized: state.windowMinimized,
	};
}

function copyBudget(input: Partial<VisualResourceUsage> | undefined): VisualResourceBudget {
	const budget: VisualResourceBudget = {
		textureBytes: input?.textureBytes ?? DEFAULT_BUDGET.textureBytes,
		geometryBytes: input?.geometryBytes ?? DEFAULT_BUDGET.geometryBytes,
		meshCount: input?.meshCount ?? DEFAULT_BUDGET.meshCount,
		queuedTaskCost: input?.queuedTaskCost ?? DEFAULT_BUDGET.queuedTaskCost,
		cacheBytes: input?.cacheBytes ?? DEFAULT_BUDGET.cacheBytes,
	};
	for (const [name, value] of Object.entries(budget)) {
		if (!Number.isFinite(value) || value < 0) {
			throw new RangeError(`Visual resource budget ${name} must be finite and non-negative.`);
		}
	}
	return budget;
}

function createBrowserSchedulerDriver(): VisualSchedulerDriver {
	const now = () => globalThis.performance?.now() ?? Date.now();
	return {
		now,
		requestFrame(callback) {
			if (typeof globalThis.requestAnimationFrame === "function") {
				return globalThis.requestAnimationFrame(callback);
			}
			return globalThis.setTimeout(() => callback(now()), 16);
		},
		cancelFrame(handle) {
			if (typeof globalThis.cancelAnimationFrame === "function") {
				globalThis.cancelAnimationFrame(handle);
				return;
			}
			globalThis.clearTimeout(handle);
		},
		setTimer(callback, delayMs) {
			return globalThis.setTimeout(callback, delayMs);
		},
		clearTimer(handle) {
			globalThis.clearTimeout(handle);
		},
	};
}

function reportCleanupError(stage: string, error: unknown): void {
	try {
		console.error(`[visual-engine] ${stage} failed`, error);
	} catch {
		// 控制台不可用时仍须继续释放剩余资源。
	}
}

function makeFrame(
	revision: number,
	playback: PlaybackVisualSnapshot,
	lyrics: LyricsVisualSnapshot,
	shelf: ShelfVisualSnapshot,
	settings: VisualSettingsSnapshot,
): VisualFrameSnapshot {
	return Object.freeze({ revision, playback, lyrics, shelf, settings });
}

export function createVisualEngine(options: VisualEngineOptions): VisualEngineFacade {
	const budget = copyBudget(options.resourceBudget);
	const cancellation = createCancellationScope("visual-engine");
	const resources = createVisualResourceScope("visual-engine");
	const ledger = createVisualResourceLedger({ budget });
	const tasks = createBudgetTaskQueue({ ledger, resourceScope: resources, cancellationScope: cancellation });
	const performance = createPerformanceCollector({ resourceBudget: budget });
	let visibility = copyVisibility(options.initialVisibility ?? DEFAULT_VISIBILITY);
	let frame = makeFrame(0, DEFAULT_PLAYBACK, DEFAULT_LYRICS, DEFAULT_SHELF, DEFAULT_SETTINGS);
	const scheduler = createVisualScheduler({
		driver: createBrowserSchedulerDriver(),
		initialVisibility: visibility,
		initialBackgroundPolicy: frame.settings.backgroundPolicy,
		initialForegroundFramePolicy: frame.settings.foregroundFramePolicy,
	});
	const composition = options.createComposition();
	let state: VisualEngineState = "idle";
	let lifecycleGeneration = 0;
	let mountStarted = false;
	let running = false;
	let compositionDisposed = false;

	const updatePerformance = () => {
		performance.setResourceSnapshot(ledger.getSnapshot());
		performance.setTaskSnapshot(tasks.getSnapshot());
		performance.setRuntimeState({
			mode: scheduler.getMode(),
			running,
			mounted: state === "mounted",
			generation: scheduler.getGeneration(),
		});
	};

	const isLive = (generation: number, ticket?: CancellationTicket): boolean =>
		state === "mounting" &&
		lifecycleGeneration === generation &&
		cancellation.isOpen() &&
		(ticket === undefined || (!ticket.signal.aborted && ticket.isCurrent()));

	const assertLive = (generation: number, ticket?: CancellationTicket): void => {
		if (!isLive(generation, ticket)) throw new VisualEngineMountCancelledError();
	};

	const disposeComposition = () => {
		if (compositionDisposed) return;
		compositionDisposed = true;
		try {
			composition.dispose();
		} catch (error) {
			reportCleanupError("composition dispose", error);
		}
	};

	const cleanup = () => {
		cancellation.dispose();
		try {
			tasks.dispose();
		} catch (error) {
			reportCleanupError("task queue dispose", error);
		}
		try {
			scheduler.dispose();
		} catch (error) {
			reportCleanupError("scheduler dispose", error);
		}
		disposeComposition();
		try {
			const report = resources.dispose();
			for (const error of report.errors) reportCleanupError("resource dispose", error.cause);
		} catch (error) {
			reportCleanupError("resource scope dispose", error);
		}
		running = false;
		state = "disposed";
		updatePerformance();
	};

	const replaceFrame = (next: {
		playback?: PlaybackVisualSnapshot;
		lyrics?: LyricsVisualSnapshot;
		shelf?: ShelfVisualSnapshot;
		settings?: VisualSettingsSnapshot;
	}) => {
		frame = makeFrame(
			frame.revision + 1,
			next.playback ?? frame.playback,
			next.lyrics ?? frame.lyrics,
			next.shelf ?? frame.shelf,
			next.settings ?? frame.settings,
		);
	};

	const applyMountedFrame = () => {
		composition.applyFrameSnapshot(frame);
	};
	const isMountedLive = (generation: number): boolean =>
		state === "mounted" &&
		lifecycleGeneration === generation &&
		cancellation.isOpen();
	const assertMountedLive = (generation: number): void => {
		if (!isMountedLive(generation)) throw new VisualEngineMountCancelledError();
	};
	const isDisposed = (): boolean => state === "disposed";

	return {
		async mount(container) {
			if (mountStarted) throw new Error("A visual engine facade can only be mounted once.");
			if (state !== "idle") throw new Error("Visual engine is not idle.");
			mountStarted = true;
			state = "mounting";
			lifecycleGeneration += 1;
			const generation = lifecycleGeneration;
			const ticket = cancellation.issue("visual-engine", "mount");
			updatePerformance();
			let rejectAbort: ((reason: unknown) => void) | null = null;
			const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
			const onAbort = () => rejectAbort?.(new VisualEngineMountCancelledError());
			ticket.signal.addEventListener("abort", onAbort, { once: true });
			const context: VisualEngineCompositionContext = {
				container,
				mediaClock: options.mediaClock,
				resources,
				cancellation,
				tasks,
				scheduler,
				performance,
				getFrameSnapshot: () => frame,
			};
			try {
				await Promise.race([composition.mount(context), aborted]);
				ticket.signal.removeEventListener("abort", onAbort);
				assertLive(generation, ticket);
				scheduler.setBackgroundPolicy(frame.settings.backgroundPolicy);
				scheduler.setForegroundFramePolicy(frame.settings.foregroundFramePolicy);
				scheduler.setVisibility(visibility);
				scheduler.start();
				assertLive(generation, ticket);
				running = true;
				state = "mounted";
				updatePerformance();
				const mountedGeneration = lifecycleGeneration;
				applyMountedFrame();
				assertMountedLive(mountedGeneration);
				composition.setVisibility(visibility);
				assertMountedLive(mountedGeneration);
			} catch (error) {
				ticket.signal.removeEventListener("abort", onAbort);
				if (!isDisposed()) {
					state = "disposing";
					lifecycleGeneration += 1;
					cleanup();
				}
				throw error;
			}
		},
		setPlaybackSnapshot(snapshot) {
			if (state === "disposing" || state === "disposed") return;
			replaceFrame({ playback: snapshot });
			if (state !== "mounted") return;
			const generation = lifecycleGeneration;
			applyMountedFrame();
			if (!isMountedLive(generation)) return;
		},
		setLyricsSnapshot(snapshot) {
			if (state === "disposing" || state === "disposed") return;
			replaceFrame({ lyrics: snapshot });
			if (state !== "mounted") return;
			const generation = lifecycleGeneration;
			applyMountedFrame();
			if (!isMountedLive(generation)) return;
		},
		setShelfSnapshot(snapshot) {
			if (state === "disposing" || state === "disposed") return;
			replaceFrame({ shelf: snapshot });
			if (state !== "mounted") return;
			const generation = lifecycleGeneration;
			applyMountedFrame();
			if (!isMountedLive(generation)) return;
		},
		setVisualSettings(snapshot) {
			if (state === "disposing" || state === "disposed") return;
			replaceFrame({ settings: snapshot });
			if (state !== "mounted") return;
			const generation = lifecycleGeneration;
			scheduler.setBackgroundPolicy(frame.settings.backgroundPolicy);
			scheduler.setForegroundFramePolicy(frame.settings.foregroundFramePolicy);
			applyMountedFrame();
			if (!isMountedLive(generation)) return;
			updatePerformance();
		},
		applyPreset(preset) {
			if (state !== "mounted" || !cancellation.isOpen()) return;
			const generation = lifecycleGeneration;
			composition.applyPreset(preset);
			if (!isMountedLive(generation)) return;
		},
		setVisibility(nextVisibility) {
			if (state === "disposing" || state === "disposed") return;
			visibility = copyVisibility(nextVisibility);
			if (state !== "mounted") return;
			const generation = lifecycleGeneration;
			scheduler.setVisibility(visibility);
			composition.setVisibility(visibility);
			if (!isMountedLive(generation)) return;
			updatePerformance();
		},
		getPerformanceSnapshot() {
			updatePerformance();
			return performance.getSnapshot();
		},
		dispose() {
			if (state === "disposing" || state === "disposed") return;
			state = "disposing";
			lifecycleGeneration += 1;
			cleanup();
		},
	};
}

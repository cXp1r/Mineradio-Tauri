import { createFrameGate, type FrameGateDecision } from "./frame-gate";
import type {
	ForegroundFramePolicy,
	VisualBackgroundPolicy,
	VisualRuntimeMode,
	VisualVisibilityState,
} from "./visual-engine-contract";
import { deriveVisualRuntimeMode } from "./visual-visibility";

export interface VisualSchedulerDriver {
	now(): number;
	requestFrame(callback: (nowMs: number) => void): number;
	cancelFrame(handle: number): void;
	setTimer(callback: () => void, delayMs: number): number;
	clearTimer(handle: number): void;
}

export type VisualSchedulerAnimationCallback = (
	nowMs: number,
	decision: FrameGateDecision,
) => undefined;

export type VisualSchedulerMaintenanceCallback = (nowMs: number) => undefined;

export type VisualSchedulerErrorSource = "animation" | "maintenance";

export type VisualSchedulerErrorReporter = (
	error: unknown,
	source: VisualSchedulerErrorSource,
) => undefined;

export interface VisualSchedulerOptions {
	readonly driver: VisualSchedulerDriver;
	readonly onAnimation: VisualSchedulerAnimationCallback;
	readonly onMaintenance?: VisualSchedulerMaintenanceCallback;
	readonly onError?: VisualSchedulerErrorReporter;
	readonly initialVisibility?: VisualVisibilityState;
	readonly initialBackgroundPolicy?: VisualBackgroundPolicy;
	readonly initialForegroundFramePolicy?: ForegroundFramePolicy;
	readonly maintenanceIntervalMs?: number;
}

export interface VisualScheduler {
	start(): void;
	stop(): void;
	stepOnce(nowMs?: number): void;
	setVisibility(state: VisualVisibilityState): void;
	setBackgroundPolicy(policy: VisualBackgroundPolicy): void;
	setForegroundFramePolicy(policy: ForegroundFramePolicy): void;
	getMode(): VisualRuntimeMode;
	getGeneration(): number;
	dispose(): void;
}

const DEFAULT_VISIBILITY: VisualVisibilityState = {
	documentVisible: true,
	windowVisible: true,
	windowFocused: true,
	windowMinimized: false,
};

function copyVisibilityState(
	state: VisualVisibilityState,
): VisualVisibilityState {
	return {
		documentVisible: state.documentVisible,
		windowVisible: state.windowVisible,
		windowFocused: state.windowFocused,
		windowMinimized: state.windowMinimized,
	};
}

function copyForegroundFramePolicy(
	policy: ForegroundFramePolicy,
): ForegroundFramePolicy {
	return policy.mode === "fixed"
		? { mode: "fixed", fps: policy.fps }
		: { mode: "vsync" };
}

export function createVisualScheduler(
	options: VisualSchedulerOptions,
): VisualScheduler {
	const { driver } = options;
	let running = false;
	let disposed = false;
	let generation = 0;
	let visibility = copyVisibilityState(
		options.initialVisibility ?? DEFAULT_VISIBILITY,
	);
	let backgroundPolicy = options.initialBackgroundPolicy ?? "auto";
	let mode = deriveVisualRuntimeMode(visibility, backgroundPolicy);
	const maintenanceIntervalMs = options.maintenanceIntervalMs ?? 1_000;
	let frameHandle: number | null = null;
	let frameToken: object | null = null;
	let timerHandle: number | null = null;
	let timerToken: object | null = null;
	let foregroundFramePolicy = copyForegroundFramePolicy(
		options.initialForegroundFramePolicy ?? { mode: "vsync" },
	);
	const frameGate = createFrameGate({
		rate:
			foregroundFramePolicy.mode === "fixed"
				? foregroundFramePolicy.fps
				: "presentation",
	});

	const canAnimate = () => mode === "foreground" || mode === "background";
	const writeConsoleError = (...args: unknown[]) => {
		try {
			console.error(...args);
		} catch {
			// 控制台 fallback 自身也不能破坏调度循环。
		}
	};
	const reportError = (error: unknown, source: VisualSchedulerErrorSource) => {
		if (!options.onError) {
			writeConsoleError(`[visual-scheduler] ${source} callback failed`, error);
			return;
		}
		try {
			options.onError(error, source);
		} catch (reporterError) {
			writeConsoleError(
				"[visual-scheduler] error reporter failed",
				reporterError,
				`Original ${source} error:`,
				error,
			);
		}
	};
	const runAnimation = (nowMs: number, decision: FrameGateDecision) => {
		try {
			options.onAnimation(nowMs, decision);
		} catch (error) {
			reportError(error, "animation");
		}
	};
	const runMaintenance = (nowMs: number) => {
		if (!options.onMaintenance) return;
		try {
			options.onMaintenance(nowMs);
		} catch (error) {
			reportError(error, "maintenance");
		}
	};
	const cancelFrame = () => {
		frameToken = null;
		if (frameHandle === null) return;
		driver.cancelFrame(frameHandle);
		frameHandle = null;
	};
	const cancelTimer = () => {
		timerToken = null;
		if (timerHandle === null) return;
		driver.clearTimer(timerHandle);
		timerHandle = null;
	};
	const scheduleFrame = () => {
		if (!running || disposed || !canAnimate() || frameToken !== null) return;
		const scheduledGeneration = generation;
		const token = {};
		frameToken = token;
		frameHandle = driver.requestFrame((nowMs) => {
			if (
				scheduledGeneration !== generation ||
				frameToken !== token ||
				!running ||
				disposed ||
				!canAnimate()
			) {
				return;
			}
			frameToken = null;
			frameHandle = null;
			const decision = frameGate.advance(nowMs);
			runAnimation(nowMs, decision);
			if (
				scheduledGeneration === generation &&
				running &&
				!disposed &&
				canAnimate()
			) {
				scheduleFrame();
			}
		});
	};
	const scheduleTimer = () => {
		if (
			!running ||
			disposed ||
			mode !== "deep-sleep" ||
			timerToken !== null
		) {
			return;
		}
		const scheduledGeneration = generation;
		const token = {};
		timerToken = token;
		timerHandle = driver.setTimer(() => {
			if (
				scheduledGeneration !== generation ||
				timerToken !== token ||
				!running ||
				disposed ||
				mode !== "deep-sleep"
			) {
				return;
			}
			timerToken = null;
			timerHandle = null;
			runMaintenance(driver.now());
			if (
				scheduledGeneration === generation &&
				running &&
				!disposed &&
				mode === "deep-sleep"
			) {
				scheduleTimer();
			}
		}, maintenanceIntervalMs);
	};
	const scheduleForMode = () => {
		if (canAnimate()) {
			scheduleFrame();
			return;
		}
		if (mode === "deep-sleep") scheduleTimer();
	};
	const transitionMode = (nextMode: VisualRuntimeMode) => {
		if (nextMode === mode) return;
		mode = nextMode;
		if (!running) {
			frameGate.reset();
			return;
		}
		generation += 1;
		cancelFrame();
		cancelTimer();
		frameGate.reset();
		scheduleForMode();
	};

	return {
		start() {
			if (running || disposed) return;
			running = true;
			generation += 1;
			frameGate.reset();
			scheduleForMode();
		},
		stop() {
			if (!running) return;
			running = false;
			generation += 1;
			cancelFrame();
			cancelTimer();
		},
		stepOnce(nowMs = driver.now()) {
			if (disposed || !canAnimate()) return;
			runAnimation(nowMs, { run: true, dtSec: 0, pendingDtSec: 0 });
		},
		setVisibility(state) {
			visibility = copyVisibilityState(state);
			transitionMode(deriveVisualRuntimeMode(visibility, backgroundPolicy));
		},
		setBackgroundPolicy(policy) {
			backgroundPolicy = policy;
			transitionMode(deriveVisualRuntimeMode(visibility, backgroundPolicy));
		},
		setForegroundFramePolicy(policy) {
			const nextPolicy = copyForegroundFramePolicy(policy);
			const unchanged =
				nextPolicy.mode === foregroundFramePolicy.mode &&
				(nextPolicy.mode === "vsync" ||
					(foregroundFramePolicy.mode === "fixed" &&
						nextPolicy.fps === foregroundFramePolicy.fps));
			if (unchanged) return;
			foregroundFramePolicy = nextPolicy;
			frameGate.setRate(
				nextPolicy.mode === "fixed" ? nextPolicy.fps : "presentation",
			);
		},
		getMode: () => mode,
		getGeneration: () => generation,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (!running) return;
			running = false;
			generation += 1;
			cancelFrame();
			cancelTimer();
		},
	};
}

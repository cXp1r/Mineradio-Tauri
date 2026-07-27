import type * as THREE from "three";
import type { AudioReactivityEngine, AudioSnapshot } from "../audio/audio-snapshot";
import type { RuntimeUniforms } from "./uniforms";
import { createRuntimeUniforms } from "./uniforms";
import { projectPerfState, type PerfStateSnapshot, type RenderPerfMode } from "./perf-state";
import { RENDER_STEP_ORDER, RenderStepSlot } from "./render-step-slot";
import type { FrameContext } from "./frame-context";
import { createFrameGate, type FrameGate, type FrameGateDecision, type FrameGateRate } from "./frame-gate";
import type { PerformanceCollector } from "./performance-collector";
import type { VisualRuntimeMode } from "./visual-engine-contract";
import type { VisualScheduler } from "./visual-scheduler";

export interface RenderLoopOptions {
	renderer: THREE.WebGLRenderer;
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	audio: Pick<AudioReactivityEngine, "update" | "getSnapshot">;
	scheduler: VisualScheduler;
	performance: PerformanceCollector;
	uniforms?: RuntimeUniforms;
	isMainSceneCoveredBySplash?: () => boolean;
	prefersReducedMotion?: () => boolean;
	pointerParallax?: { x: number; y: number };
	pointerTarget?: { x: number; y: number };
	now?: () => number;
	onCacheTrim?: (now: number) => void;
}

type StepCallback = (ctx: FrameContext) => void;

export interface RenderStepOptions {
	readonly cadence?: FrameGateRate;
	readonly isActive?: (mode: VisualRuntimeMode) => boolean;
}

interface StepRegistration {
	readonly fn: StepCallback;
	readonly cadence: FrameGateRate;
	readonly gate: FrameGate;
	readonly gateName: string;
	readonly isActive?: (mode: VisualRuntimeMode) => boolean;
	subscribed: boolean;
}

interface StepRegistrationBatch {
	readonly slot: RenderStepSlot;
	readonly registrations: readonly StepRegistration[];
}

interface TimedResult<T> {
	readonly value?: T;
	readonly costMs: number;
	readonly error?: unknown;
}

const SPLASH_WARM_INTERVAL_MS = 520;
const POINTER_PARALLAX_LERP = 0.040;
const AUDIO_GATE_NAME = "audio-analysis";
const PRESENTATION_GATE_NAME = "presentation";
const FREQUENCY_BAND_MUTATORS = new Set<PropertyKey>([
	"copyWithin",
	"fill",
	"reverse",
	"set",
	"sort",
]);
const NEUTRAL_AUDIO_SNAPSHOT: AudioSnapshot = Object.freeze({
	bass: 0,
	mid: 0,
	treble: 0,
	energy: 0,
	rb: 0,
	rm: 0,
	rt: 0,
	re: 0,
	beatPulse: 0,
	scheduledBeatPulse: 0,
	beatOnsetFlag: false,
});

function rejectFrequencyBandMutation(): never {
	throw new TypeError("AudioSnapshot frequencyBands is read-only.");
}

function copyFrequencyBands(source: Float32Array): Float32Array {
	const copy = new Float32Array(source.length);
	for (let index = 0; index < copy.length; index += 1) copy[index] = source[index] ?? 0;
	return copy;
}

function createReadonlyFrequencyBands(source: Float32Array): Float32Array {
	const values = copyFrequencyBands(source);
	return new Proxy(values, {
		get(target, property) {
			if (property === "buffer") return copyFrequencyBands(target).buffer;
			if (property === "constructor") return target.constructor;
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (FREQUENCY_BAND_MUTATORS.has(property)) return rejectFrequencyBandMutation;
			return (...args: unknown[]) => Reflect.apply(value, copyFrequencyBands(target), args);
		},
		set: rejectFrequencyBandMutation,
		defineProperty: rejectFrequencyBandMutation,
		deleteProperty: rejectFrequencyBandMutation,
		setPrototypeOf: rejectFrequencyBandMutation,
		preventExtensions: rejectFrequencyBandMutation,
	});
}

function defaultCadenceForSlot(slot: RenderStepSlot): FrameGateRate {
	switch (slot) {
		case RenderStepSlot.Beatmap:
		case RenderStepSlot.Ripples:
			return 60;
		case RenderStepSlot.Shelf:
			return 30;
		case RenderStepSlot.LyricParticles:
		case RenderStepSlot.StageLyrics:
			return 45;
		case RenderStepSlot.DesktopOverlaySync:
			return 12;
		default:
			return "presentation";
	}
}

export interface RenderLoop {
	start(): void;
	stop(): void;
	registerStep(slot: RenderStepSlot, fn: StepCallback, options?: RenderStepOptions): () => void;
	dispose(): void;
	getFps(): number;
	getPerfState(): PerfStateSnapshot;
	getPointerParallax(): { x: number; y: number };
	stepOnce(): void;
}

export function createRenderLoop(opts: RenderLoopOptions): RenderLoop {
	const renderer = opts.renderer;
	const scene = opts.scene;
	const camera = opts.camera;
	const audio = opts.audio;
	const scheduler = opts.scheduler;
	const performanceCollector = opts.performance;
	const uniforms = opts.uniforms ?? createRuntimeUniforms();
	const isMainSceneCoveredBySplash = opts.isMainSceneCoveredBySplash ?? (() => false);
	const prefersReducedMotion = opts.prefersReducedMotion ?? (() => false);
	const pointerParallax = opts.pointerParallax ?? { x: 0, y: 0 };
	const pointerTarget = opts.pointerTarget ?? { x: 0, y: 0 };
	const nowFn = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));

	const registry = new Map<RenderStepSlot, Set<StepRegistration>>();
	const nextGateOrdinal = new Map<RenderStepSlot, number>();
	const audioGate = createFrameGate({ rate: 60 });
	let active = false;
	let splashWarmRenderLast = 0;
	let disposed = false;
	let pipelineEpoch = 0;
	let snapshotCache: AudioSnapshot = NEUTRAL_AUDIO_SNAPSHOT;
	let lastMode: VisualRuntimeMode | undefined;
	let lastSchedulerGeneration = scheduler.getGeneration();
	let presentationEffectiveFps = 0;
	let presentationSkippedSinceLastRun = false;
	let renderPerfModeHint: RenderPerfMode | undefined;
	let manualStepDepth = 0;
	const initialPerfTimestamp = nowFn();
	let lastRenderAt = initialPerfTimestamp;
	let lastSampleAt = initialPerfTimestamp;

	function elapsedSince(startedAt: number): number {
		const elapsed = nowFn() - startedAt;
		return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
	}

	function normalizeCaughtError(error: unknown, label: string): unknown {
		return error === undefined ? new Error(`${label} failed with undefined`) : error;
	}

	function runMeasured<T>(label: string, work: () => T): TimedResult<T> {
		const startedAt = nowFn();
		try {
			return { value: work(), costMs: elapsedSince(startedAt) };
		} catch (error) {
			return {
				costMs: elapsedSince(startedAt),
				error: normalizeCaughtError(error, label),
			};
		}
	}

	function combineErrors(label: string, ...errors: readonly unknown[]): unknown {
		const failures: unknown[] = [];
		for (const error of errors) {
			if (error !== undefined) failures.push(error);
		}
		if (failures.length === 0) return undefined;
		if (failures.length === 1) return failures[0];
		return new AggregateError(failures, `${label} failed`);
	}

	function effectiveFps(cadence: FrameGateRate): number {
		return cadence === "presentation" ? presentationEffectiveFps : cadence;
	}

	function updatePresentationPerfHint(decision: FrameGateDecision): void {
		if (!decision.run) {
			presentationSkippedSinceLastRun = true;
			return;
		}
		if (decision.dtSec > 0) presentationEffectiveFps = 1 / decision.dtSec;
		renderPerfModeHint = presentationSkippedSinceLastRun && presentationEffectiveFps > 0
			? (`${Math.round(presentationEffectiveFps)}fps` as RenderPerfMode)
			: "vsync";
		presentationSkippedSinceLastRun = false;
	}

	function recordGateSkip(
		name: string,
		cadence: FrameGateRate,
		pendingDtSec = 0,
		result?: TimedResult<unknown>,
	): void {
		performanceCollector.recordGate(name, {
			run: false,
			effectiveFps: effectiveFps(cadence),
			pendingDtSec,
			costMs: result?.costMs,
			error: result?.error,
		});
	}

	function recordGateRun<T>(
		name: string,
		cadence: FrameGateRate,
		pendingDtSec: number,
		result: TimedResult<T>,
	): void {
		performanceCollector.recordGate(name, {
			run: true,
			effectiveFps: effectiveFps(cadence),
			pendingDtSec,
			costMs: result.costMs,
			error: result.error,
		});
	}

	function resetGates(now?: number): void {
		audioGate.reset(now);
		for (const registrations of registry.values()) {
			for (const registration of registrations) registration.gate.reset(now);
		}
	}

	function recordStepSkips(): void {
		for (const registrations of registry.values()) {
			for (const registration of registrations) {
				registration.gate.reset();
				recordGateSkip(registration.gateName, registration.cadence);
			}
		}
	}

	function buildContext(dt: number, now: number, snapshot: AudioSnapshot): FrameContext {
		return { dt, now, snapshot, uniforms, scene, camera, pointerParallax, pointerTarget };
	}

	function isCurrentPipeline(epoch: number): boolean {
		return active && !disposed && pipelineEpoch === epoch;
	}

	function captureRegistrationSnapshot(): readonly StepRegistrationBatch[] {
		const snapshot: StepRegistrationBatch[] = [];
		for (const slot of RENDER_STEP_ORDER) {
			const registrations = registry.get(slot);
			if (registrations?.size) snapshot.push({ slot, registrations: [...registrations] });
		}
		return snapshot;
	}

	function refreshAudioSnapshot(now: number, pipelineEpochAtTickStart: number): void {
		const decision = audioGate.advance(now);
		if (!decision.run) {
			recordGateSkip(AUDIO_GATE_NAME, 60, decision.pendingDtSec);
			return;
		}
		const updateResult = runMeasured(`${AUDIO_GATE_NAME}.update`, () => {
			audio.update(decision.dtSec);
		});
		if (!isCurrentPipeline(pipelineEpochAtTickStart)) {
			recordGateRun(AUDIO_GATE_NAME, 60, decision.pendingDtSec, updateResult);
			return;
		}
		const snapshotResult = runMeasured(`${AUDIO_GATE_NAME}.getSnapshot`, () => {
			const snapshot = audio.getSnapshot();
			const nextSnapshot: AudioSnapshot = snapshot.frequencyBands === undefined
				? { ...snapshot }
				: {
					...snapshot,
					frequencyBands: createReadonlyFrequencyBands(snapshot.frequencyBands),
				};
			if (prefersReducedMotion()) {
				nextSnapshot.bass = 0;
				nextSnapshot.mid = 0;
				nextSnapshot.treble = 0;
				nextSnapshot.beatPulse = 0;
				nextSnapshot.scheduledBeatPulse = 0;
			}
			return Object.freeze(nextSnapshot);
		});
		snapshotCache = snapshotResult.value ?? NEUTRAL_AUDIO_SNAPSHOT;
		const result: TimedResult<AudioSnapshot> = {
			value: snapshotResult.value,
			costMs: updateResult.costMs + snapshotResult.costMs,
			error: combineErrors(AUDIO_GATE_NAME, updateResult.error, snapshotResult.error),
		};
		recordGateRun(AUDIO_GATE_NAME, 60, decision.pendingDtSec, result);
	}

	function renderPresentation(
		now: number,
		decision: FrameGateDecision,
		pipelineEpochAtTickStart: number,
	): boolean {
		if (!isCurrentPipeline(pipelineEpochAtTickStart)) return false;
		const result = runMeasured(PRESENTATION_GATE_NAME, () => renderer.render(scene, camera));
		recordGateRun(PRESENTATION_GATE_NAME, "presentation", decision.pendingDtSec, result);
		if (!isCurrentPipeline(pipelineEpochAtTickStart)) return false;
		if (result.error === undefined) lastRenderAt = now;
		return result.error === undefined;
	}

	function runRegisteredSteps(
		now: number,
		mode: VisualRuntimeMode,
		presentationDecision: FrameGateDecision,
		snapshot: AudioSnapshot,
		registrationSnapshot: readonly StepRegistrationBatch[],
		pipelineEpochAtTickStart: number,
	): boolean {
		for (const { registrations } of registrationSnapshot) {
			for (const registration of registrations) {
				if (!isCurrentPipeline(pipelineEpochAtTickStart)) return false;
				if (!registration.subscribed) continue;
				let registrationActive = true;
				if (registration.isActive) {
					const result = runMeasured(registration.gateName, () => registration.isActive?.(mode) ?? true);
					if (result.error) {
						registration.gate.reset();
						recordGateSkip(registration.gateName, registration.cadence, 0, result);
						if (!isCurrentPipeline(pipelineEpochAtTickStart)) return false;
						continue;
					}
					if (!isCurrentPipeline(pipelineEpochAtTickStart)) return false;
					if (!registration.subscribed) continue;
					registrationActive = result.value ?? false;
				}
				if (!registrationActive) {
					registration.gate.reset();
					recordGateSkip(registration.gateName, registration.cadence);
					continue;
				}
				if (registration.cadence === "presentation" && !presentationDecision.run) {
					recordGateSkip(registration.gateName, registration.cadence, presentationDecision.pendingDtSec);
					continue;
				}
				const decision = registration.gate.advance(now);
				if (!decision.run) {
					recordGateSkip(registration.gateName, registration.cadence, decision.pendingDtSec);
					continue;
				}
				const context = buildContext(decision.dtSec, now, snapshot);
				const result = runMeasured(registration.gateName, () => registration.fn(context));
				recordGateRun(registration.gateName, registration.cadence, decision.pendingDtSec, result);
				if (!isCurrentPipeline(pipelineEpochAtTickStart)) return false;
			}
		}
		return true;
	}

	function tick(now: number, presentationDecision: FrameGateDecision): boolean {
		if (disposed) return false;
		const mode = scheduler.getMode();
		const schedulerGeneration = scheduler.getGeneration();
		if (mode !== lastMode || schedulerGeneration !== lastSchedulerGeneration) {
			lastMode = mode;
			lastSchedulerGeneration = schedulerGeneration;
			presentationSkippedSinceLastRun = false;
			renderPerfModeHint = undefined;
			resetGates();
		}
		if (manualStepDepth === 0) updatePresentationPerfHint(presentationDecision);
		if (!active || (mode !== "foreground" && mode !== "background")) {
			audioGate.reset();
			recordGateSkip(AUDIO_GATE_NAME, 60);
			recordStepSkips();
			recordGateSkip(PRESENTATION_GATE_NAME, "presentation", presentationDecision.pendingDtSec);
			return false;
		}
		const pipelineEpochAtTickStart = pipelineEpoch;
		const registrationSnapshot = captureRegistrationSnapshot();
		refreshAudioSnapshot(now, pipelineEpochAtTickStart);
		if (!isCurrentPipeline(pipelineEpochAtTickStart)) return false;
		if (presentationDecision.run) {
			uniforms.uTime.value += presentationDecision.dtSec;
		}
		const mainSceneCoveredBySplash = isMainSceneCoveredBySplash();
		if (!isCurrentPipeline(pipelineEpochAtTickStart)) return false;
		if (mainSceneCoveredBySplash) {
			recordStepSkips();
			if (presentationDecision.run && now - splashWarmRenderLast > SPLASH_WARM_INTERVAL_MS) {
				splashWarmRenderLast = now;
				return renderPresentation(now, presentationDecision, pipelineEpochAtTickStart);
			}
			recordGateSkip(PRESENTATION_GATE_NAME, "presentation", presentationDecision.pendingDtSec);
			return false;
		}
		if (presentationDecision.run) {
			pointerParallax.x += (pointerTarget.x - pointerParallax.x) * POINTER_PARALLAX_LERP;
			pointerParallax.y += (pointerTarget.y - pointerParallax.y) * POINTER_PARALLAX_LERP;
		}
		if (!runRegisteredSteps(
			now,
			mode,
			presentationDecision,
			snapshotCache,
			registrationSnapshot,
			pipelineEpochAtTickStart,
		)) {
			return false;
		}
		if (!presentationDecision.run) {
			recordGateSkip(PRESENTATION_GATE_NAME, "presentation", presentationDecision.pendingDtSec);
			return false;
		}
		return renderPresentation(now, presentationDecision, pipelineEpochAtTickStart);
	}

	const unregisterSchedulerCallbacks = scheduler.registerRuntimeCallbacks({
		onAnimation(now, decision) {
			if (disposed || !active) return undefined;
			lastSampleAt = now;
			const startedAt = nowFn();
			let rendered = false;
			try {
				rendered = tick(now, decision);
			} finally {
				if (manualStepDepth === 0) {
					performanceCollector.recordFrame({
						source: "raf",
						rendered,
						costMs: elapsedSince(startedAt),
					});
				}
			}
			return undefined;
		},
		onMaintenance(now) {
			if (disposed || !active) return undefined;
			lastSampleAt = now;
			const startedAt = nowFn();
			lastMode = scheduler.getMode();
			lastSchedulerGeneration = scheduler.getGeneration();
			resetGates();
			if (opts.onCacheTrim) {
				const result = runMeasured("maintenance", () => opts.onCacheTrim?.(now));
				recordGateRun("maintenance", 0, 0, result);
			} else {
				recordGateSkip("maintenance", 0);
			}
			performanceCollector.recordFrame({
				source: "timer",
				rendered: false,
				costMs: elapsedSince(startedAt),
			});
			return undefined;
		},
	});

	return {
		start() {
			if (disposed || active) return;
			pipelineEpoch += 1;
			active = true;
			resetGates();
		},
		stop() {
			if (!active) return;
			pipelineEpoch += 1;
			active = false;
			resetGates();
		},
		registerStep(slot, fn, options = {}) {
			const cadence = options.cadence ?? defaultCadenceForSlot(slot);
			const gateOrdinal = (nextGateOrdinal.get(slot) ?? 0) + 1;
			nextGateOrdinal.set(slot, gateOrdinal);
			const registration: StepRegistration = {
				fn,
				cadence,
				gate: createFrameGate({ rate: cadence }),
				gateName: gateOrdinal === 1 ? slot : `${slot}#${gateOrdinal}`,
				isActive: options.isActive,
				subscribed: true,
			};
			let registrations = registry.get(slot);
			if (!registrations) {
				registrations = new Set();
				registry.set(slot, registrations);
			}
			registrations.add(registration);
			return () => {
				if (!registration.subscribed) return;
				registration.subscribed = false;
				const currentRegistrations = registry.get(slot);
				if (!currentRegistrations) return;
				currentRegistrations.delete(registration);
				if (currentRegistrations.size === 0) registry.delete(slot);
			};
		},
		dispose() {
			if (disposed) return;
			pipelineEpoch += 1;
			disposed = true;
			active = false;
			resetGates();
			unregisterSchedulerCallbacks();
			for (const registrations of registry.values()) {
				for (const registration of registrations) registration.subscribed = false;
			}
			registry.clear();
		},
		getFps() {
			return projectPerfState(performanceCollector.getSnapshot()).fps;
		},
		getPerfState() {
			return projectPerfState(performanceCollector.getSnapshot(), renderPerfModeHint, {
				lastRenderAt,
				lastSampleAt,
			});
		},
		getPointerParallax() {
			return pointerParallax;
		},
		stepOnce() {
			if (disposed) return;
			manualStepDepth += 1;
			try {
				scheduler.stepOnce();
			} finally {
				manualStepDepth -= 1;
			}
		},
	};
}

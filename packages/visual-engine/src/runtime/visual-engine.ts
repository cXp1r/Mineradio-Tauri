import { createBudgetTaskQueue, type BudgetTaskQueue } from "./budget-task-queue";
import {
	createCancellationScope,
	type CancellationScope,
	type CancellationTicket,
} from "./cancellation-scope";
import { createPerformanceCollector } from "./performance-collector";
import {
	createVisualResourceLedger,
	type VisualResourceAllocation,
	type VisualResourceLedger,
	type VisualResourcePriority,
} from "./resource-ledger";
import {
	createVisualResourceScope,
	type VisualResourceRegistration,
	type VisualResourceScope,
} from "./resource-scope";
import {
	createVisualScheduler,
	type VisualScheduler,
	type VisualSchedulerDriver,
} from "./visual-scheduler";
import type {
	LyricsVisualSnapshot,
	ForegroundFramePolicy,
	PlaybackVisualSnapshot,
	ShelfVisualSnapshot,
	VisualEngineCompositionContext,
	VisualEngineFacade,
	VisualEngineOptions,
	VisualFrameSnapshot,
	VisualPresetId,
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

const MAX_FACADE_SYNC_PASSES = 16;

class VisualEngineMountCancelledError extends Error {
	constructor() {
		super("Visual engine mount was cancelled.");
		this.name = "VisualEngineMountCancelledError";
	}
}

class VisualEngineSchedulerStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VisualEngineSchedulerStateError";
	}
}

type VisualEngineSchedulerOwnedOperation =
	| "start"
	| "stop"
	| "dispose"
	| "setVisibility"
	| "setBackgroundPolicy"
	| "setForegroundFramePolicy";

class VisualEngineSchedulerOwnershipError extends Error {
	constructor(operation: VisualEngineSchedulerOwnedOperation) {
		super(`Visual scheduler ownership forbids composition ${operation}().`);
		this.name = "VisualEngineSchedulerOwnershipError";
	}
}

type VisualEngineRuntimeService = "resources" | "tasks" | "cancellation";

class VisualEngineRuntimeServiceOwnershipError extends Error {
	constructor(service?: VisualEngineRuntimeService) {
		super(
			service
				? `Visual engine runtime service ownership forbids composition ${service}.dispose().`
				: "Visual engine runtime service ownership was violated by the composition.",
		);
		this.name = "VisualEngineRuntimeServiceOwnershipError";
	}
}

class VisualResourceBudgetAdmissionError extends Error {
	constructor(registration: VisualResourceRegistration) {
		super(`Visual resource budget denied ${registration.kind} registration for "${registration.owner}".`);
		this.name = "VisualResourceBudgetAdmissionError";
	}
}

function usageForResource(
	registration: VisualResourceRegistration,
): Partial<VisualResourceUsage> | null {
	switch (registration.kind) {
		case "texture":
			return registration.estimatedBytes === undefined
				? null
				: { textureBytes: registration.estimatedBytes };
		case "geometry":
			return registration.estimatedBytes === undefined
				? null
				: { geometryBytes: registration.estimatedBytes };
		case "mesh":
			return { meshCount: 1 };
		case "cache":
			return registration.estimatedBytes === undefined
				? null
				: { cacheBytes: registration.estimatedBytes };
		default:
			return null;
	}
}

function priorityForResource(
	registration: VisualResourceRegistration,
): VisualResourcePriority {
	if (registration.kind === "cache") return "background";
	switch (registration.retention) {
		case "persistent":
			return "essential";
		case "rebuildable":
			return "normal";
		case "ephemeral":
			return "optional";
	}
}

function createBudgetedResourceScope(
	rawScope: VisualResourceScope,
	ledger: VisualResourceLedger,
): VisualResourceScope {
	return {
		get name() {
			return rawScope.name;
		},
		get closed() {
			return rawScope.closed;
		},
		isOpen: () => rawScope.isOpen(),
		register(registration) {
			const usage = usageForResource(registration);
			let allocation: VisualResourceAllocation | null = null;
			if (usage && Object.values(usage).some((value) => value !== 0)) {
				const admission = ledger.admit(usage, priorityForResource(registration));
				if (!admission.admitted || !admission.allocation) {
					throw new VisualResourceBudgetAdmissionError(registration);
				}
				allocation = admission.allocation;
			}
			let leaseReleased = false;
			const releaseLease = () => {
				if (leaseReleased) return;
				leaseReleased = true;
				allocation?.release();
			};
			try {
				return rawScope.register({
					...registration,
					dispose() {
						try {
							registration.dispose();
						} finally {
							releaseLease();
						}
					},
				});
			} catch (error) {
				releaseLease();
				throw error;
			}
		},
		createChild(name) {
			return createBudgetedResourceScope(rawScope.createChild(name), ledger);
		},
		releaseRetention: (retention) => rawScope.releaseRetention(retention),
		dispose: () => rawScope.dispose(),
	};
}

interface GuardedVisualScheduler {
	readonly view: VisualScheduler;
	hasActiveRegistration(): boolean;
	getOwnershipViolationCount(): number;
	clearRegistrationForCleanup(): void;
}

interface GuardedVisualRuntimeServices {
	readonly resources: VisualResourceScope;
	readonly tasks: BudgetTaskQueue;
	readonly cancellation: CancellationScope;
	getOwnershipViolationCount(): number;
}

interface VisualEngineOwnershipViolationBaseline {
	readonly scheduler: number;
	readonly runtimeServices: number;
}

function createGuardedVisualRuntimeServices(
	rawResources: VisualResourceScope,
	rawTasks: BudgetTaskQueue,
	rawCancellation: CancellationScope,
	options: {
		onOwnershipViolation(): void;
	},
): GuardedVisualRuntimeServices {
	let ownershipViolationCount = 0;
	const rejectDispose = (service: VisualEngineRuntimeService): never => {
		ownershipViolationCount += 1;
		const error = new VisualEngineRuntimeServiceOwnershipError(service);
		options.onOwnershipViolation();
		throw error;
	};
	const resources: VisualResourceScope = {
		get name() {
			return rawResources.name;
		},
		get closed() {
			return rawResources.closed;
		},
		isOpen: () => rawResources.isOpen(),
		register: (registration) => rawResources.register(registration),
		createChild: (name) => rawResources.createChild(name),
		releaseRetention: (retention) => rawResources.releaseRetention(retention),
		dispose: () => rejectDispose("resources"),
	};
	const tasks: BudgetTaskQueue = {
		enqueue(task) {
			return rawTasks.enqueue(task);
		},
		runSlice: (costBudget) => rawTasks.runSlice(costBudget),
		cancelOwner: (owner) => rawTasks.cancelOwner(owner),
		cancelPriority: (priority) => rawTasks.cancelPriority(priority),
		dispose: () => rejectDispose("tasks"),
		getSnapshot: () => rawTasks.getSnapshot(),
	};
	const cancellation: CancellationScope = {
		get name() {
			return rawCancellation.name;
		},
		get closed() {
			return rawCancellation.closed;
		},
		isOpen: () => rawCancellation.isOpen(),
		issue: (owner, key) => rawCancellation.issue(owner, key),
		createChild: (name) => rawCancellation.createChild(name),
		dispose: () => rejectDispose("cancellation"),
	};
	return {
		resources,
		tasks,
		cancellation,
		getOwnershipViolationCount: () => ownershipViolationCount,
	};
}

function createGuardedVisualScheduler(
	rawScheduler: VisualScheduler,
	options: {
		isCleanupInProgress(): boolean;
		onActiveRegistrationRemoved(): void;
		onOwnershipViolation(): void;
		runRuntimeCallback(callback: () => undefined): undefined;
	},
): GuardedVisualScheduler {
	let activeRegistration: object | null = null;
	let ownershipViolationCount = 0;
	const rejectAuthorityOperation = (
		operation: VisualEngineSchedulerOwnedOperation,
	): never => {
		ownershipViolationCount += 1;
		const error = new VisualEngineSchedulerOwnershipError(operation);
		options.onOwnershipViolation();
		throw error;
	};
	const view: VisualScheduler = {
		registerRuntimeCallbacks(callbacks) {
			const onAnimation = callbacks.onAnimation;
			const onMaintenance = callbacks.onMaintenance;
			const unregisterRaw = rawScheduler.registerRuntimeCallbacks({
				onAnimation(nowMs, decision) {
					return options.runRuntimeCallback(() => onAnimation(nowMs, decision));
				},
				onMaintenance: onMaintenance
					? (nowMs) => options.runRuntimeCallback(() => onMaintenance(nowMs))
					: undefined,
			});
			const registration = {};
			activeRegistration = registration;
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				const wasActiveRegistration = activeRegistration === registration;
				if (wasActiveRegistration) activeRegistration = null;
				if (options.isCleanupInProgress()) return;
				try {
					unregisterRaw();
				} finally {
					if (wasActiveRegistration) options.onActiveRegistrationRemoved();
				}
			};
		},
		start() {
			return rejectAuthorityOperation("start");
		},
		stop() {
			return rejectAuthorityOperation("stop");
		},
		stepOnce(nowMs) {
			rawScheduler.stepOnce(nowMs);
		},
		setVisibility() {
			return rejectAuthorityOperation("setVisibility");
		},
		setBackgroundPolicy() {
			return rejectAuthorityOperation("setBackgroundPolicy");
		},
		setForegroundFramePolicy() {
			return rejectAuthorityOperation("setForegroundFramePolicy");
		},
		getMode: () => rawScheduler.getMode(),
		getGeneration: () => rawScheduler.getGeneration(),
		dispose() {
			return rejectAuthorityOperation("dispose");
		},
	};
	return {
		view,
		hasActiveRegistration: () => activeRegistration !== null,
		getOwnershipViolationCount: () => ownershipViolationCount,
		clearRegistrationForCleanup() {
			activeRegistration = null;
		},
	};
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
	const hasAnimationFramePair =
		typeof globalThis.requestAnimationFrame === "function" &&
		typeof globalThis.cancelAnimationFrame === "function";
	const requestAnimationFrame = hasAnimationFramePair
		? globalThis.requestAnimationFrame.bind(globalThis)
		: null;
	const cancelAnimationFrame = hasAnimationFramePair
		? globalThis.cancelAnimationFrame.bind(globalThis)
		: null;
	return {
		now,
		requestFrame(callback) {
			if (requestAnimationFrame) {
				return requestAnimationFrame(callback);
			}
			return globalThis.setTimeout(() => callback(now()), 16);
		},
		cancelFrame(handle) {
			if (cancelAnimationFrame) {
				cancelAnimationFrame(handle);
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
	const rawResources = createVisualResourceScope("visual-engine");
	const ledger = createVisualResourceLedger({ budget });
	const resources = createBudgetedResourceScope(rawResources, ledger);
	const tasks = createBudgetTaskQueue({ ledger, resourceScope: resources, cancellationScope: cancellation });
	let handleOwnershipViolation = () => {};
	const runtimeServices = createGuardedVisualRuntimeServices(resources, tasks, cancellation, {
		onOwnershipViolation: () => handleOwnershipViolation(),
	});
	const performance = createPerformanceCollector({ resourceBudget: budget });
	let visibility = copyVisibility(options.initialVisibility ?? DEFAULT_VISIBILITY);
	let frame = makeFrame(0, DEFAULT_PLAYBACK, DEFAULT_LYRICS, DEFAULT_SHELF, DEFAULT_SETTINGS);
	const rawScheduler = createVisualScheduler({
		driver: createBrowserSchedulerDriver(),
		initialVisibility: visibility,
		initialBackgroundPolicy: frame.settings.backgroundPolicy,
		initialForegroundFramePolicy: frame.settings.foregroundFramePolicy,
	});
	let state: VisualEngineState = "idle";
	let lifecycleGeneration = 0;
	let mountStarted = false;
	let running = false;
	let mountCommitted = false;
	let visibilityRevision = 0;
	let compositionDisposed = false;
	let mountedDispatchActive = false;
	let pendingFrameDispatch = false;
	let pendingVisibilityDispatch = false;
	let pendingPresetDispatch: VisualPresetId | null = null;
	let handleActiveRegistrationRemoved = () => {};
	let runRuntimeCallback = (callback: () => undefined): undefined => callback();
	const guardedScheduler = createGuardedVisualScheduler(rawScheduler, {
		isCleanupInProgress: () => state === "disposing" || state === "disposed",
		onActiveRegistrationRemoved: () => handleActiveRegistrationRemoved(),
		onOwnershipViolation: () => handleOwnershipViolation(),
		runRuntimeCallback: (callback) => runRuntimeCallback(callback),
	});
	const scheduler = guardedScheduler.view;
	const composition = options.createComposition();

	const updatePerformance = () => {
		performance.setResourceSnapshot(ledger.getSnapshot());
		performance.setTaskSnapshot(tasks.getSnapshot());
		performance.setRuntimeState({
			mode: rawScheduler.getMode(),
			running,
			mounted: state === "mounted" && mountCommitted,
			generation: rawScheduler.getGeneration(),
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
		mountCommitted = false;
		running = false;
		pendingFrameDispatch = false;
		pendingVisibilityDispatch = false;
		pendingPresetDispatch = null;
		guardedScheduler.clearRegistrationForCleanup();
		cancellation.dispose();
		try {
			tasks.dispose();
		} catch (error) {
			reportCleanupError("task queue dispose", error);
		}
		try {
			rawScheduler.dispose();
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

	const isMountedGenerationCurrent = (generation: number): boolean =>
		state === "mounted" &&
		mountCommitted &&
		lifecycleGeneration === generation;
	const captureOwnershipViolationBaseline = (): VisualEngineOwnershipViolationBaseline => ({
		scheduler: guardedScheduler.getOwnershipViolationCount(),
		runtimeServices: runtimeServices.getOwnershipViolationCount(),
	});
	const getOwnershipViolationError = (
		baseline: VisualEngineOwnershipViolationBaseline,
	): Error | null => {
		if (guardedScheduler.getOwnershipViolationCount() !== baseline.scheduler) {
			return new VisualEngineSchedulerStateError(
				"Visual scheduler lifecycle ownership was violated by the composition.",
			);
		}
		if (runtimeServices.getOwnershipViolationCount() !== baseline.runtimeServices) {
			return new VisualEngineRuntimeServiceOwnershipError();
		}
		return null;
	};
	const assertMountRuntimeReady = (
		ownershipViolationBaseline: VisualEngineOwnershipViolationBaseline,
	): void => {
		const ownershipError = getOwnershipViolationError(ownershipViolationBaseline);
		if (ownershipError) throw ownershipError;
		if (!guardedScheduler.hasActiveRegistration()) {
			throw new VisualEngineSchedulerStateError("Visual scheduler runtime registration is not active.");
		}
	};
	const assertMountCommitLive = (
		generation: number,
		ticket: CancellationTicket,
		ownershipViolationBaseline: VisualEngineOwnershipViolationBaseline,
	): void => {
		assertLive(generation, ticket);
		assertMountRuntimeReady(ownershipViolationBaseline);
	};
	const applyRawSchedulerState = (
		currentFrame: VisualFrameSnapshot,
		currentVisibility: VisualVisibilityState,
	): void => {
		rawScheduler.setBackgroundPolicy(currentFrame.settings.backgroundPolicy);
		rawScheduler.setForegroundFramePolicy(currentFrame.settings.foregroundFramePolicy);
		rawScheduler.setVisibility(currentVisibility);
	};
	const synchronizeInitialState = (
		generation: number,
		ticket: CancellationTicket,
		ownershipViolationBaseline: VisualEngineOwnershipViolationBaseline,
	): void => {
		let appliedFrameRevision: number | null = null;
		let appliedVisibilityRevision: number | null = null;
		for (let pass = 0; pass < MAX_FACADE_SYNC_PASSES; pass += 1) {
			assertMountCommitLive(generation, ticket, ownershipViolationBaseline);
			const currentFrame = frame;
			const currentVisibility = visibility;
			const currentVisibilityRevision = visibilityRevision;
			const shouldApplyFrame = appliedFrameRevision !== currentFrame.revision;
			const shouldApplyVisibility = appliedVisibilityRevision !== currentVisibilityRevision;

			applyRawSchedulerState(currentFrame, currentVisibility);
			assertMountCommitLive(generation, ticket, ownershipViolationBaseline);
			if (shouldApplyFrame) {
				composition.applyFrameSnapshot(currentFrame);
				assertMountCommitLive(generation, ticket, ownershipViolationBaseline);
			}
			if (shouldApplyVisibility) {
				composition.setVisibility(currentVisibility);
				assertMountCommitLive(generation, ticket, ownershipViolationBaseline);
			}
			applyRawSchedulerState(frame, visibility);
			assertMountCommitLive(generation, ticket, ownershipViolationBaseline);
			appliedFrameRevision = currentFrame.revision;
			appliedVisibilityRevision = currentVisibilityRevision;

			if (
				frame.revision === currentFrame.revision &&
				visibilityRevision === currentVisibilityRevision
			) {
				return;
			}
		}
		throw new VisualEngineSchedulerStateError(
			"Visual engine initial delegates did not stabilize before scheduler start.",
		);
	};
	const isDisposed = (): boolean => state === "disposed";
	const invalidateAndCleanup = (): void => {
		if (state === "disposing" || state === "disposed") return;
		state = "disposing";
		lifecycleGeneration += 1;
		cleanup();
	};
	handleOwnershipViolation = () => {
		if (state === "mounted" && mountCommitted) invalidateAndCleanup();
	};
	handleActiveRegistrationRemoved = () => {
		if (state === "mounted" && mountCommitted) invalidateAndCleanup();
	};
	runRuntimeCallback = (callback) => {
		if (!cancellation.isOpen()) {
			invalidateAndCleanup();
			return undefined;
		}
		const ownershipViolationBaseline = captureOwnershipViolationBaseline();
		let callbackThrew = false;
		try {
			return callback();
		} catch (error) {
			callbackThrew = true;
			throw error;
		} finally {
			const ownershipError = getOwnershipViolationError(ownershipViolationBaseline);
			if (ownershipError || !cancellation.isOpen()) {
				invalidateAndCleanup();
				if (ownershipError && !callbackThrew) throw ownershipError;
			}
		}
	};
	const prepareMountedOperation = (generation: number): boolean => {
		if (!isMountedGenerationCurrent(generation)) return false;
		if (!cancellation.isOpen()) {
			invalidateAndCleanup();
			return false;
		}
		if (guardedScheduler.hasActiveRegistration()) return true;
		const error = new VisualEngineSchedulerStateError(
			"Visual scheduler runtime registration is not active.",
		);
		invalidateAndCleanup();
		throw error;
	};
	const runMountedOperation = (
		generation: number,
		operation: () => void,
	): boolean => {
		if (!prepareMountedOperation(generation)) return false;
		const ownershipViolationBaseline = captureOwnershipViolationBaseline();
		try {
			operation();
		} catch (error) {
			invalidateAndCleanup();
			throw error;
		}
		const ownershipError = getOwnershipViolationError(ownershipViolationBaseline);
		if (ownershipError) {
			invalidateAndCleanup();
			throw ownershipError;
		}
		return prepareMountedOperation(generation);
	};
	const hasPendingMountedDispatch = (): boolean =>
		pendingFrameDispatch ||
		pendingVisibilityDispatch ||
		pendingPresetDispatch !== null;
	const drainMountedDispatch = (): void => {
		if (mountedDispatchActive || state !== "mounted" || !mountCommitted) return;
		mountedDispatchActive = true;
		const generation = lifecycleGeneration;
		try {
			for (let pass = 0; pass < MAX_FACADE_SYNC_PASSES; pass += 1) {
				if (!hasPendingMountedDispatch()) return;
				const shouldApplyFrame = pendingFrameDispatch;
				const shouldApplyVisibility = pendingVisibilityDispatch;
				const preset = pendingPresetDispatch;
				const currentFrame = frame;
				const currentVisibility = visibility;
				pendingFrameDispatch = false;
				pendingVisibilityDispatch = false;
				pendingPresetDispatch = null;

				if (!runMountedOperation(
					generation,
					() => applyRawSchedulerState(currentFrame, currentVisibility),
				)) return;
				if (
					shouldApplyFrame &&
					!runMountedOperation(
						generation,
						() => composition.applyFrameSnapshot(currentFrame),
					)
				) return;
				if (
					shouldApplyVisibility &&
					!runMountedOperation(
						generation,
						() => composition.setVisibility(currentVisibility),
					)
				) return;
				if (
					preset !== null &&
					!runMountedOperation(generation, () => composition.applyPreset(preset))
				) return;
				if (!runMountedOperation(
					generation,
					() => applyRawSchedulerState(frame, visibility),
				)) return;
				if (!hasPendingMountedDispatch()) {
					updatePerformance();
					return;
				}
			}
			const error = new VisualEngineSchedulerStateError(
				"Visual engine mounted delegates did not stabilize.",
			);
			invalidateAndCleanup();
			throw error;
		} finally {
			mountedDispatchActive = false;
		}
	};

	return {
		async mount(container) {
			if (mountStarted) throw new Error("A visual engine facade can only be mounted once.");
			if (state !== "idle") throw new Error("Visual engine is not idle.");
			mountStarted = true;
			state = "mounting";
			lifecycleGeneration += 1;
			const generation = lifecycleGeneration;
			const ownershipViolationBaseline = captureOwnershipViolationBaseline();
			const ticket = cancellation.issue("visual-engine", "mount");
			updatePerformance();
			let rejectAbort: ((reason: unknown) => void) | null = null;
			const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
			const onAbort = () => rejectAbort?.(new VisualEngineMountCancelledError());
			ticket.signal.addEventListener("abort", onAbort, { once: true });
			const context: VisualEngineCompositionContext = {
				container,
				mediaClock: options.mediaClock,
				resources: runtimeServices.resources,
				cancellation: runtimeServices.cancellation,
				tasks: runtimeServices.tasks,
				scheduler,
				performance,
				getFrameSnapshot: () => frame,
			};
			try {
				const compositionMount = Promise.resolve().then(() => {
					assertLive(generation, ticket);
					return composition.mount(context);
				});
				try {
					await Promise.race([compositionMount, aborted]);
				} finally {
					ticket.signal.removeEventListener("abort", onAbort);
				}
				assertMountCommitLive(generation, ticket, ownershipViolationBaseline);
				synchronizeInitialState(generation, ticket, ownershipViolationBaseline);
				assertMountCommitLive(generation, ticket, ownershipViolationBaseline);
				rawScheduler.start();
				assertMountCommitLive(generation, ticket, ownershipViolationBaseline);
				running = true;
				state = "mounted";
				mountCommitted = true;
				updatePerformance();
			} catch (error) {
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
			if (state !== "mounted" || !mountCommitted) return;
			pendingFrameDispatch = true;
			drainMountedDispatch();
		},
		setLyricsSnapshot(snapshot) {
			if (state === "disposing" || state === "disposed") return;
			replaceFrame({ lyrics: snapshot });
			if (state !== "mounted" || !mountCommitted) return;
			pendingFrameDispatch = true;
			drainMountedDispatch();
		},
		setShelfSnapshot(snapshot) {
			if (state === "disposing" || state === "disposed") return;
			replaceFrame({ shelf: snapshot });
			if (state !== "mounted" || !mountCommitted) return;
			pendingFrameDispatch = true;
			drainMountedDispatch();
		},
		setVisualSettings(snapshot) {
			if (state === "disposing" || state === "disposed") return;
			replaceFrame({ settings: snapshot });
			if (state !== "mounted" || !mountCommitted) return;
			pendingFrameDispatch = true;
			drainMountedDispatch();
		},
		applyPreset(preset) {
			if (state !== "mounted" || !mountCommitted || !cancellation.isOpen()) return;
			pendingPresetDispatch = preset;
			drainMountedDispatch();
		},
		setVisibility(nextVisibility) {
			if (state === "disposing" || state === "disposed") return;
			visibility = copyVisibility(nextVisibility);
			visibilityRevision += 1;
			if (state !== "mounted" || !mountCommitted) return;
			pendingVisibilityDispatch = true;
			drainMountedDispatch();
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

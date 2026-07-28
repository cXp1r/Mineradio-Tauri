import type { VisualVisibilityState } from "@mineradio/visual-engine";

export interface VisualEnvironmentDocument {
	readonly visibilityState?: DocumentVisibilityState;
	hasFocus?(): boolean;
	addEventListener(type: "visibilitychange", listener: () => void): void;
	removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface VisualEnvironmentWindow {
	addEventListener(type: "focus" | "blur", listener: () => void): void;
	removeEventListener(type: "focus" | "blur", listener: () => void): void;
	matchMedia?(query: string): VisualEnvironmentMediaQueryList | null;
}

export interface VisualEnvironmentMediaQueryList {
	readonly matches: boolean;
	addEventListener?(type: "change", listener: () => void): void;
	removeEventListener?(type: "change", listener: () => void): void;
	addListener?(listener: () => void): void;
	removeListener?(listener: () => void): void;
}

export interface VisualNativeWindowState {
	readonly isVisible: boolean;
	readonly isFocused: boolean;
	readonly isMinimized: boolean;
}

export interface VisualNativeWindowSource {
	getWindowState(): Promise<VisualNativeWindowState>;
	listenWindowState(
		listener: (state: VisualNativeWindowState) => void,
	): Promise<() => void>;
}

export interface VisualEnvironmentAdapter {
	getSnapshot(): VisualVisibilityState;
	getPrefersReducedMotion(): boolean;
	subscribe(listener: (state: VisualVisibilityState) => void): () => void;
	dispose(): void;
}

export interface CreateVisualEnvironmentAdapterOptions {
	readonly document?: VisualEnvironmentDocument;
	readonly window?: VisualEnvironmentWindow;
	readonly nativeSource?: VisualNativeWindowSource;
	readonly reducedMotionMediaQuery?: VisualEnvironmentMediaQueryList;
	/** 仅为调用方迁移兼容保留；环境适配器不会隐式调用 native source。 */
	readonly defaultNativeSource?: VisualNativeWindowSource;
	/** 仅为调用方迁移兼容保留；环境适配器不会自行检测并调用 native source。 */
	readonly isNativeRuntime?: () => boolean;
}

type LifecyclePhase = "stopped" | "starting" | "running" | "stopping";

interface SubscriptionRecord {
	readonly listener: (state: VisualVisibilityState) => void;
	previousState: VisualVisibilityState | null;
	active: boolean;
	pendingInitial: boolean;
	hasInitialError: boolean;
	initialError?: unknown;
}

interface NativeAttempt {
	active: boolean;
	eventRevision: number;
	cleanup: (() => void) | null;
}

interface LifecycleResources {
	readonly generation: number;
	active: boolean;
	nativeStarted: boolean;
	nativeAttempt: NativeAttempt | null;
	cleanup: () => void;
}

function copyVisibility(state: VisualVisibilityState): VisualVisibilityState {
	return Object.freeze({ ...state });
}

function copyNativeWindowState(state: VisualNativeWindowState): VisualNativeWindowState {
	return Object.freeze({
		isVisible: state.isVisible === true,
		isFocused: state.isFocused === true,
		isMinimized: state.isMinimized === true,
	});
}

function isSameVisibilityState(
	left: VisualVisibilityState | null,
	right: VisualVisibilityState,
): boolean {
	return left !== null
		&& left.documentVisible === right.documentVisible
		&& left.windowVisible === right.windowVisible
		&& left.windowFocused === right.windowFocused
		&& left.windowMinimized === right.windowMinimized;
}

function safelyRunCleanup(cleanup: (() => void) | null | undefined): void {
	if (!cleanup) return;
	try {
		cleanup();
	} catch {
		// 单个外部清理失败不能阻断其余监听器释放。
	}
}

function onceCleanup(cleanup: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		cleanup();
	};
}

export function createVisualEnvironmentAdapter(
	options: CreateVisualEnvironmentAdapterOptions = {},
): VisualEnvironmentAdapter {
	const documentTarget = options.document ?? (
		typeof document !== "undefined" ? document : undefined
	);
	const windowTarget = options.window ?? (
		typeof window !== "undefined" ? window : undefined
	);
	const nativeSource = options.nativeSource;
	const reducedMotionQuery = options.reducedMotionMediaQuery
		?? windowTarget?.matchMedia?.("(prefers-reduced-motion: reduce)")
		?? undefined;
	let browserFocused = documentTarget?.hasFocus?.() ?? true;
	let nativeState: VisualNativeWindowState | null = null;
	let prefersReducedMotion = reducedMotionQuery?.matches ?? false;
	let disposed = false;
	let phase: LifecyclePhase = "stopped";
	let reconciling = false;
	let cleanupBarrierDepth = 0;
	let generationCounter = 0;
	let currentLifecycle: LifecycleResources | null = null;
	let reconcile = (): void => {};
	const subscriptions = new Set<SubscriptionRecord>();

	const readSnapshot = (): VisualVisibilityState => copyVisibility({
		documentVisible: documentTarget?.visibilityState !== "hidden",
		windowVisible: nativeState?.isVisible ?? true,
		windowFocused: browserFocused && (nativeState?.isFocused ?? true),
		windowMinimized: nativeState?.isMinimized ?? false,
	});
	const shouldRunLifecycle = (): boolean => !disposed && subscriptions.size > 0;
	const isLifecycleLive = (lifecycle: LifecycleResources): boolean => (
		!disposed
		&& phase === "running"
		&& lifecycle.active
		&& currentLifecycle === lifecycle
		&& currentLifecycle.generation === lifecycle.generation
		&& subscriptions.size > 0
	);
	const deactivateSubscription = (subscription: SubscriptionRecord): void => {
		if (!subscription.active) return;
		subscription.active = false;
		subscription.pendingInitial = false;
		subscriptions.delete(subscription);
	};
	const emitToSubscription = (subscription: SubscriptionRecord): void => {
		if (disposed || !subscription.active) return;
		const nextState = readSnapshot();
		if (disposed || !subscription.active) return;
		if (isSameVisibilityState(subscription.previousState, nextState)) return;
		subscription.previousState = nextState;
		subscription.listener(nextState);
	};
	const broadcast = (): void => {
		for (const subscription of [...subscriptions]) {
			if (subscription.pendingInitial) continue;
			try {
				emitToSubscription(subscription);
			} catch {
				// 一个订阅者失败不能阻断其他订阅者接收环境变化。
			}
		}
	};
	const releaseNativeAttempt = (attempt: NativeAttempt): void => {
		attempt.active = false;
		const cleanup = attempt.cleanup;
		attempt.cleanup = null;
		safelyRunCleanup(cleanup);
	};
	const isNativeAttemptLive = (
		lifecycle: LifecycleResources,
		attempt: NativeAttempt,
	): boolean => (
		attempt.active
		&& lifecycle.nativeAttempt === attempt
		&& isLifecycleLive(lifecycle)
	);
	const failNativeAttempt = (
		lifecycle: LifecycleResources,
		attempt: NativeAttempt,
	): void => {
		if (!attempt.active) return;
		releaseNativeAttempt(attempt);
		if (!isLifecycleLive(lifecycle)) return;
		nativeState = null;
		broadcast();
	};
	const runSerializedCleanup = (cleanup: () => void): void => {
		cleanupBarrierDepth += 1;
		try {
			safelyRunCleanup(cleanup);
		} finally {
			cleanupBarrierDepth -= 1;
			if (cleanupBarrierDepth === 0) reconcile();
		}
	};
	const startNativeLifecycle = (lifecycle: LifecycleResources): void => {
		if (lifecycle.nativeStarted) return;
		lifecycle.nativeStarted = true;
		if (!nativeSource || !isLifecycleLive(lifecycle)) return;

		const attempt: NativeAttempt = {
			active: true,
			eventRevision: 0,
			cleanup: null,
		};
		lifecycle.nativeAttempt = attempt;
		const onNativeWindowState = (state: VisualNativeWindowState) => {
			if (!isNativeAttemptLive(lifecycle, attempt)) return;
			attempt.eventRevision += 1;
			nativeState = copyNativeWindowState(state);
			broadcast();
		};

		let listenPromise: Promise<() => void>;
		try {
			listenPromise = Promise.resolve(nativeSource.listenWindowState(onNativeWindowState));
		} catch {
			failNativeAttempt(lifecycle, attempt);
			return;
		}
		if (!isLifecycleLive(lifecycle)) attempt.active = false;

		void listenPromise.then((unlisten) => {
			const cleanup = onceCleanup(unlisten);
			attempt.cleanup = cleanup;
			if (!isNativeAttemptLive(lifecycle, attempt)) {
				attempt.cleanup = null;
				runSerializedCleanup(cleanup);
				return;
			}

			const getRevision = attempt.eventRevision;
			let getPromise: Promise<VisualNativeWindowState>;
			try {
				getPromise = Promise.resolve(nativeSource.getWindowState());
			} catch {
				if (isNativeAttemptLive(lifecycle, attempt) && nativeState === null) broadcast();
				return;
			}
			void getPromise.then((state) => {
				if (
					!isNativeAttemptLive(lifecycle, attempt)
					|| attempt.eventRevision !== getRevision
				) return;
				nativeState = copyNativeWindowState(state);
				broadcast();
			}, () => {
				if (isNativeAttemptLive(lifecycle, attempt) && nativeState === null) broadcast();
			});
		}, () => failNativeAttempt(lifecycle, attempt));
	};

	const installLifecycleResource = (
		cleanups: Array<() => void>,
		add: () => void,
		remove: () => void,
	): boolean => {
		const cleanup = onceCleanup(remove);
		cleanups.push(cleanup);
		try {
			add();
		} catch (error) {
			safelyRunCleanup(cleanup);
			throw error;
		}
		if (phase !== "starting" || !shouldRunLifecycle()) {
			safelyRunCleanup(cleanup);
			return false;
		}
		return true;
	};
	const startLifecycle = (): void => {
		phase = "starting";
		const cleanups: Array<() => void> = [];
		const lifecycle: LifecycleResources = {
			generation: generationCounter + 1,
			active: false,
			nativeStarted: false,
			nativeAttempt: null,
			cleanup: () => {},
		};
		generationCounter = lifecycle.generation;
		lifecycle.cleanup = onceCleanup(() => {
			for (const cleanup of cleanups) safelyRunCleanup(cleanup);
			if (lifecycle.nativeAttempt) releaseNativeAttempt(lifecycle.nativeAttempt);
		});
		const abortStart = () => {
			lifecycle.active = false;
			lifecycle.cleanup();
			phase = "stopped";
		};
		const onVisibilityChange = () => {
			if (!isLifecycleLive(lifecycle)) return;
			broadcast();
		};
		const onFocus = () => {
			if (!isLifecycleLive(lifecycle)) return;
			browserFocused = true;
			broadcast();
		};
		const onBlur = () => {
			if (!isLifecycleLive(lifecycle)) return;
			browserFocused = false;
			broadcast();
		};
		const onReducedMotionChange = () => {
			if (!isLifecycleLive(lifecycle)) return;
			prefersReducedMotion = reducedMotionQuery?.matches ?? false;
		};

		try {
			nativeState = null;
			browserFocused = documentTarget?.hasFocus?.() ?? true;
			prefersReducedMotion = reducedMotionQuery?.matches ?? false;
			if (!shouldRunLifecycle()) {
				abortStart();
				return;
			}

			if (documentTarget && !installLifecycleResource(
				cleanups,
				() => documentTarget.addEventListener("visibilitychange", onVisibilityChange),
				() => documentTarget.removeEventListener("visibilitychange", onVisibilityChange),
			)) {
				abortStart();
				return;
			}
			if (windowTarget) {
				if (!installLifecycleResource(
					cleanups,
					() => windowTarget.addEventListener("focus", onFocus),
					() => windowTarget.removeEventListener("focus", onFocus),
				)) {
					abortStart();
					return;
				}
				if (!installLifecycleResource(
					cleanups,
					() => windowTarget.addEventListener("blur", onBlur),
					() => windowTarget.removeEventListener("blur", onBlur),
				)) {
					abortStart();
					return;
				}
			}
			if (
				reducedMotionQuery?.addEventListener
				&& reducedMotionQuery.removeEventListener
				&& !installLifecycleResource(
					cleanups,
					() => reducedMotionQuery.addEventListener?.("change", onReducedMotionChange),
					() => reducedMotionQuery.removeEventListener?.("change", onReducedMotionChange),
				)
			) {
				abortStart();
				return;
			}
			if (
				reducedMotionQuery
				&& !(
					reducedMotionQuery.addEventListener
					&& reducedMotionQuery.removeEventListener
				)
				&& reducedMotionQuery.addListener
				&& reducedMotionQuery.removeListener
				&& !installLifecycleResource(
					cleanups,
					() => reducedMotionQuery.addListener?.(onReducedMotionChange),
					() => reducedMotionQuery.removeListener?.(onReducedMotionChange),
				)
			) {
				abortStart();
				return;
			}
			browserFocused = documentTarget?.hasFocus?.() ?? true;
			prefersReducedMotion = reducedMotionQuery?.matches ?? false;
			if (!shouldRunLifecycle()) {
				abortStart();
				return;
			}

			lifecycle.active = true;
			currentLifecycle = lifecycle;
			phase = "running";
		} catch (error) {
			abortStart();
			throw error;
		}
	};
	const stopLifecycle = (): void => {
		const lifecycle = currentLifecycle;
		currentLifecycle = null;
		phase = "stopping";
		nativeState = null;
		if (lifecycle) {
			lifecycle.active = false;
			if (lifecycle.nativeAttempt) lifecycle.nativeAttempt.active = false;
			lifecycle.cleanup();
		}
		phase = "stopped";
	};
	const emitNextPendingInitial = (): "none" | "emitted" | "failed" => {
		for (const subscription of [...subscriptions]) {
			if (!subscription.active || !subscription.pendingInitial) continue;
			subscription.pendingInitial = false;
			try {
				emitToSubscription(subscription);
			} catch (error) {
				subscription.hasInitialError = true;
				subscription.initialError = error;
				deactivateSubscription(subscription);
				return "failed";
			}
			return "emitted";
		}
		return "none";
	};
	const hasPendingInitial = (): boolean => {
		for (const subscription of subscriptions) {
			if (subscription.active && subscription.pendingInitial) return true;
		}
		return false;
	};
	const failPendingSubscriptions = (error: unknown): boolean => {
		let failed = false;
		for (const subscription of [...subscriptions]) {
			if (!subscription.active || !subscription.pendingInitial) continue;
			subscription.hasInitialError = true;
			subscription.initialError = error;
			deactivateSubscription(subscription);
			failed = true;
		}
		return failed;
	};
	reconcile = (): void => {
		if (reconciling || cleanupBarrierDepth > 0) return;
		reconciling = true;
		try {
			for (;;) {
				if (!shouldRunLifecycle()) {
					if (phase === "running") {
						stopLifecycle();
						continue;
					}
					return;
				}
				if (phase === "stopped") {
					try {
						startLifecycle();
					} catch (error) {
						const failedPending = failPendingSubscriptions(error);
						if (!failedPending && shouldRunLifecycle()) throw error;
					}
					continue;
				}
				if (phase !== "running") return;

				const initialResult = emitNextPendingInitial();
				if (initialResult === "failed") {
					const lifecycle = currentLifecycle;
					if (
						shouldRunLifecycle()
						&& lifecycle
						&& !lifecycle.nativeStarted
					) startNativeLifecycle(lifecycle);
					continue;
				}
				if (initialResult === "emitted") {
					const lifecycle = currentLifecycle;
					if (
						hasPendingInitial()
						&& shouldRunLifecycle()
						&& lifecycle
						&& !lifecycle.nativeStarted
					) startNativeLifecycle(lifecycle);
					continue;
				}
				if (!shouldRunLifecycle()) continue;

				const lifecycle = currentLifecycle;
				if (lifecycle && !lifecycle.nativeStarted) {
					startNativeLifecycle(lifecycle);
					continue;
				}
				return;
			}
		} finally {
			reconciling = false;
		}
	};

	const adapter: VisualEnvironmentAdapter = {
		getSnapshot: readSnapshot,
		getPrefersReducedMotion() {
			return prefersReducedMotion;
		},
		subscribe(listener) {
			if (disposed) return () => {};
			const deferredInitial = (
				reconciling
				|| cleanupBarrierDepth > 0
				|| phase === "starting"
				|| phase === "stopping"
			);
			const subscription: SubscriptionRecord = {
				listener,
				previousState: null,
				active: true,
				pendingInitial: true,
				hasInitialError: false,
			};
			const unsubscribe = () => {
				if (!subscription.active) return;
				deactivateSubscription(subscription);
				reconcile();
			};
			subscriptions.add(subscription);
			try {
				reconcile();
			} catch (error) {
				deactivateSubscription(subscription);
				try {
					reconcile();
				} catch {
					// 保留触发当前订阅失败的原始错误。
				}
				throw error;
			}
			if (!deferredInitial && subscription.hasInitialError) throw subscription.initialError;
			return unsubscribe;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const subscription of subscriptions) {
				subscription.active = false;
				subscription.pendingInitial = false;
			}
			subscriptions.clear();
			reconcile();
		},
	};
	return adapter;
}

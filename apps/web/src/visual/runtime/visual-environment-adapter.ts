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
	let lifecycleActive = false;
	let lifecycleGeneration = 0;
	let nativeEventRevision = 0;
	let visibilityListenerInstalled = false;
	let focusListenerInstalled = false;
	let blurListenerInstalled = false;
	let unlistenReducedMotion: (() => void) | null = null;
	let unlistenNative: (() => void) | null = null;

	interface SubscriptionRecord {
		readonly listener: (state: VisualVisibilityState) => void;
		previousState: VisualVisibilityState | null;
		active: boolean;
	}

	const subscriptions = new Set<SubscriptionRecord>();

	const readSnapshot = (): VisualVisibilityState => copyVisibility({
		documentVisible: documentTarget?.visibilityState !== "hidden",
		windowVisible: nativeState?.isVisible ?? true,
		windowFocused: browserFocused && (nativeState?.isFocused ?? true),
		windowMinimized: nativeState?.isMinimized ?? false,
	});
	const isLifecycleLive = (generation: number): boolean => (
		!disposed
		&& lifecycleActive
		&& lifecycleGeneration === generation
		&& subscriptions.size > 0
	);
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
			try {
				emitToSubscription(subscription);
			} catch {
				// 一个订阅者失败不能阻断其他订阅者接收环境变化。
			}
		}
	};
	const onVisibilityChange = () => broadcast();
	const onFocus = () => {
		browserFocused = true;
		broadcast();
	};
	const onBlur = () => {
		browserFocused = false;
		broadcast();
	};
	const onReducedMotionChange = () => {
		prefersReducedMotion = reducedMotionQuery?.matches ?? false;
	};

	const stopLifecycle = (): void => {
		lifecycleActive = false;
		lifecycleGeneration += 1;
		if (visibilityListenerInstalled) {
			visibilityListenerInstalled = false;
			safelyRunCleanup(() => documentTarget?.removeEventListener("visibilitychange", onVisibilityChange));
		}
		if (focusListenerInstalled) {
			focusListenerInstalled = false;
			safelyRunCleanup(() => windowTarget?.removeEventListener("focus", onFocus));
		}
		if (blurListenerInstalled) {
			blurListenerInstalled = false;
			safelyRunCleanup(() => windowTarget?.removeEventListener("blur", onBlur));
		}
		safelyRunCleanup(unlistenReducedMotion);
		unlistenReducedMotion = null;
		safelyRunCleanup(unlistenNative);
		unlistenNative = null;
		nativeState = null;
		nativeEventRevision = 0;
	};

	const installDomListener = (
		add: () => void,
		remove: () => void,
		generation: number,
	): boolean => {
		try {
			add();
		} catch (error) {
			safelyRunCleanup(remove);
			throw error;
		}
		if (!isLifecycleLive(generation)) {
			safelyRunCleanup(remove);
			return false;
		}
		return true;
	};

	const installReducedMotionListener = (generation: number): (() => void) | null => {
		if (!reducedMotionQuery) return null;
		if (reducedMotionQuery.addEventListener && reducedMotionQuery.removeEventListener) {
			const remove = onceCleanup(() => reducedMotionQuery.removeEventListener?.("change", onReducedMotionChange));
			if (!installDomListener(
				() => reducedMotionQuery.addEventListener?.("change", onReducedMotionChange),
				remove,
				generation,
			)) return null;
			return remove;
		}
		if (reducedMotionQuery.addListener && reducedMotionQuery.removeListener) {
			const remove = onceCleanup(() => reducedMotionQuery.removeListener?.(onReducedMotionChange));
			if (!installDomListener(
				() => reducedMotionQuery.addListener?.(onReducedMotionChange),
				remove,
				generation,
			)) return null;
			return remove;
		}
		return null;
	};

	const installBrowserLifecycle = (): number | null => {
		lifecycleActive = true;
		const generation = lifecycleGeneration + 1;
		lifecycleGeneration = generation;
		nativeState = null;
		nativeEventRevision = 0;
		browserFocused = documentTarget?.hasFocus?.() ?? true;
		prefersReducedMotion = reducedMotionQuery?.matches ?? false;
		if (!isLifecycleLive(generation)) return null;

		if (documentTarget) {
			const remove = () => documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
			if (!installDomListener(
				() => documentTarget.addEventListener("visibilitychange", onVisibilityChange),
				remove,
				generation,
			)) return null;
			visibilityListenerInstalled = true;
		}
		if (windowTarget) {
			const removeFocus = () => windowTarget.removeEventListener("focus", onFocus);
			if (!installDomListener(
				() => windowTarget.addEventListener("focus", onFocus),
				removeFocus,
				generation,
			)) return null;
			focusListenerInstalled = true;

			const removeBlur = () => windowTarget.removeEventListener("blur", onBlur);
			if (!installDomListener(
				() => windowTarget.addEventListener("blur", onBlur),
				removeBlur,
				generation,
			)) return null;
			blurListenerInstalled = true;
		}
		unlistenReducedMotion = installReducedMotionListener(generation);
		if (!isLifecycleLive(generation)) return null;
		return generation;
	};

	const startNativeLifecycle = (generation: number): void => {
		if (!nativeSource || !isLifecycleLive(generation)) return;
		let listenPromise: Promise<() => void>;
		try {
			listenPromise = nativeSource.listenWindowState((state) => {
				if (!isLifecycleLive(generation)) return;
				nativeEventRevision += 1;
				nativeState = copyNativeWindowState(state);
				broadcast();
			});
		} catch {
			if (!isLifecycleLive(generation)) return;
			nativeState = null;
			broadcast();
			return;
		}
		if (!isLifecycleLive(generation)) {
			void listenPromise.then((unlisten) => safelyRunCleanup(onceCleanup(unlisten))).catch(() => {});
			return;
		}

		void listenPromise.then((unlisten) => {
			const cleanup = onceCleanup(unlisten);
			if (!isLifecycleLive(generation)) {
				safelyRunCleanup(cleanup);
				return;
			}
			unlistenNative = cleanup;
			const getRevision = nativeEventRevision;
			let getPromise: Promise<VisualNativeWindowState>;
			try {
				getPromise = nativeSource.getWindowState();
			} catch {
				if (nativeState === null) broadcast();
				return;
			}
			void getPromise.then((state) => {
				if (
					!isLifecycleLive(generation)
					|| nativeEventRevision !== getRevision
				) return;
				nativeState = copyNativeWindowState(state);
				broadcast();
			}).catch(() => {
				if (isLifecycleLive(generation) && nativeState === null) broadcast();
			});
		}).catch(() => {
			if (!isLifecycleLive(generation)) return;
			nativeState = null;
			broadcast();
		});
	};

	const adapter: VisualEnvironmentAdapter = {
		getSnapshot: readSnapshot,
		getPrefersReducedMotion() {
			return prefersReducedMotion;
		},
		subscribe(listener) {
			if (disposed) return () => {};
			const firstSubscription = subscriptions.size === 0;
			const subscription: SubscriptionRecord = {
				listener,
				previousState: null,
				active: true,
			};
			const unsubscribe = () => {
				if (!subscription.active) return;
				subscription.active = false;
				subscriptions.delete(subscription);
				if (subscriptions.size === 0) stopLifecycle();
			};
			subscriptions.add(subscription);

			if (firstSubscription) {
				let generation: number | null;
				try {
					generation = installBrowserLifecycle();
				} catch (error) {
					unsubscribe();
					throw error;
				}
				if (generation === null || disposed || !subscription.active) return unsubscribe;
				try {
					emitToSubscription(subscription);
				} catch (error) {
					unsubscribe();
					throw error;
				}
				if (!isLifecycleLive(generation) || !subscription.active) return unsubscribe;
				startNativeLifecycle(generation);
				return unsubscribe;
			}

			try {
				emitToSubscription(subscription);
			} catch (error) {
				unsubscribe();
				throw error;
			}
			return unsubscribe;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const subscription of subscriptions) subscription.active = false;
			subscriptions.clear();
			stopLifecycle();
		},
	};
	return adapter;
}

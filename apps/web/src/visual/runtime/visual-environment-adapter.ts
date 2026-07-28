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

function listenReducedMotionChange(
	query: VisualEnvironmentMediaQueryList | undefined,
	listener: () => void,
): () => void {
	if (!query) return () => {};
	if (query.addEventListener && query.removeEventListener) {
		try {
			query.addEventListener("change", listener);
		} catch (error) {
			safelyRunCleanup(() => query.removeEventListener?.("change", listener));
			throw error;
		}
		return () => query.removeEventListener?.("change", listener);
	}
	if (query.addListener && query.removeListener) {
		try {
			query.addListener(listener);
		} catch (error) {
			safelyRunCleanup(() => query.removeListener?.(listener));
			throw error;
		}
		return () => query.removeListener?.(listener);
	}
	return () => {};
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
	const activeSubscriptions = new Set<() => void>();

	const readSnapshot = (): VisualVisibilityState => copyVisibility({
		documentVisible: documentTarget?.visibilityState !== "hidden",
		windowVisible: nativeState?.isVisible ?? true,
		windowFocused: browserFocused && (nativeState?.isFocused ?? true),
		windowMinimized: nativeState?.isMinimized ?? false,
	});

	const adapter: VisualEnvironmentAdapter = {
		getSnapshot: readSnapshot,
		getPrefersReducedMotion() {
			return prefersReducedMotion;
		},
		subscribe(listener) {
			if (disposed) return () => {};
			let subscriptionDisposed = false;
			let generation = 1;
			let nativeEventRevision = 0;
			let unlistenNative: (() => void) | null = null;
			let unlistenReducedMotion: (() => void) | null = null;
			let previousState: VisualVisibilityState | null = null;
			let visibilityListenerInstalled = false;
			let focusListenerInstalled = false;
			let blurListenerInstalled = false;
			const isSubscriptionLive = () => !disposed && !subscriptionDisposed;

			const emit = () => {
				if (disposed || subscriptionDisposed) return;
				const nextState = readSnapshot();
				if (isSameVisibilityState(previousState, nextState)) return;
				previousState = nextState;
				listener(nextState);
			};
			const onVisibilityChange = () => emit();
			const onFocus = () => {
				browserFocused = true;
				emit();
			};
			const onBlur = () => {
				browserFocused = false;
				emit();
			};
			const onReducedMotionChange = () => {
				prefersReducedMotion = reducedMotionQuery?.matches ?? false;
			};

			const unsubscribe = () => {
				if (subscriptionDisposed) return;
				subscriptionDisposed = true;
				generation += 1;
				activeSubscriptions.delete(unsubscribe);
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
			};
			activeSubscriptions.add(unsubscribe);

			try {
				browserFocused = documentTarget?.hasFocus?.() ?? true;
				prefersReducedMotion = reducedMotionQuery?.matches ?? false;
				if (!isSubscriptionLive()) return unsubscribe;
				if (documentTarget) {
					visibilityListenerInstalled = true;
					documentTarget.addEventListener("visibilitychange", onVisibilityChange);
					if (!isSubscriptionLive()) return unsubscribe;
				}
				if (windowTarget) {
					focusListenerInstalled = true;
					windowTarget.addEventListener("focus", onFocus);
					if (!isSubscriptionLive()) return unsubscribe;
					blurListenerInstalled = true;
					windowTarget.addEventListener("blur", onBlur);
					if (!isSubscriptionLive()) return unsubscribe;
				}
				unlistenReducedMotion = listenReducedMotionChange(reducedMotionQuery, onReducedMotionChange);
				if (!isSubscriptionLive()) {
					safelyRunCleanup(unlistenReducedMotion);
					unlistenReducedMotion = null;
					return unsubscribe;
				}
				emit();
				if (!isSubscriptionLive()) return unsubscribe;
			} catch (error) {
				unsubscribe();
				throw error;
			}

			if (!nativeSource || !isSubscriptionLive()) return unsubscribe;
			const activeGeneration = generation;
			let nativeListenPromise: Promise<() => void>;
			try {
				nativeListenPromise = nativeSource.listenWindowState((state) => {
					if (!isSubscriptionLive() || generation !== activeGeneration) return;
					nativeEventRevision += 1;
					nativeState = copyNativeWindowState(state);
					emit();
				});
			} catch {
				return unsubscribe;
			}
			if (!isSubscriptionLive()) {
				void nativeListenPromise.then((unlisten) => safelyRunCleanup(unlisten)).catch(() => {});
				return unsubscribe;
			}
			void nativeListenPromise.then((unlisten) => {
				if (!isSubscriptionLive() || generation !== activeGeneration) {
					safelyRunCleanup(unlisten);
					return;
				}
				unlistenNative = unlisten;
				const getRevision = nativeEventRevision;
				let initialStatePromise: Promise<VisualNativeWindowState>;
				try {
					initialStatePromise = nativeSource.getWindowState();
				} catch {
					return;
				}
				void initialStatePromise.then((state) => {
					if (
						!isSubscriptionLive() ||
						generation !== activeGeneration ||
						nativeEventRevision !== getRevision
					) return;
					nativeState = copyNativeWindowState(state);
					emit();
				}).catch(() => {});
			}).catch(() => {});
			return unsubscribe;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const unsubscribe of [...activeSubscriptions]) safelyRunCleanup(unsubscribe);
			activeSubscriptions.clear();
		},
	};
	return adapter;
}

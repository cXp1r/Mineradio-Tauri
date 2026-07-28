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

function listenReducedMotionChange(
	query: VisualEnvironmentMediaQueryList | undefined,
	listener: () => void,
): () => void {
	if (!query) return () => {};
	if (query.addEventListener && query.removeEventListener) {
		query.addEventListener("change", listener);
		return () => query.removeEventListener?.("change", listener);
	}
	if (query.addListener && query.removeListener) {
		query.addListener(listener);
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
			let previousState: VisualVisibilityState | null = null;

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

			documentTarget?.addEventListener("visibilitychange", onVisibilityChange);
			windowTarget?.addEventListener("focus", onFocus);
			windowTarget?.addEventListener("blur", onBlur);
			const unlistenReducedMotion = listenReducedMotionChange(reducedMotionQuery, onReducedMotionChange);
			emit();

			if (nativeSource) {
				const activeGeneration = generation;
				void nativeSource.listenWindowState((state) => {
					if (disposed || subscriptionDisposed || generation !== activeGeneration) return;
					nativeEventRevision += 1;
					nativeState = state;
					emit();
				}).then((unlisten) => {
					if (disposed || subscriptionDisposed || generation !== activeGeneration) {
						unlisten();
						return;
					}
					unlistenNative = unlisten;
					const getRevision = nativeEventRevision;
					return nativeSource.getWindowState().then((state) => {
						if (
							disposed ||
							subscriptionDisposed ||
							generation !== activeGeneration ||
							nativeEventRevision !== getRevision
						) return;
						nativeState = state;
						emit();
					});
				}).catch(() => {});
			}

			const unsubscribe = () => {
				if (subscriptionDisposed) return;
				subscriptionDisposed = true;
				generation += 1;
				documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
				windowTarget?.removeEventListener("focus", onFocus);
				windowTarget?.removeEventListener("blur", onBlur);
				unlistenReducedMotion();
				unlistenNative?.();
				unlistenNative = null;
				activeSubscriptions.delete(unsubscribe);
			};
			activeSubscriptions.add(unsubscribe);
			return unsubscribe;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const unsubscribe of [...activeSubscriptions]) unsubscribe();
		},
	};
	return adapter;
}

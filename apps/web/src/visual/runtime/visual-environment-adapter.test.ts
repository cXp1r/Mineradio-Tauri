import { expect, test } from "bun:test";
import { createVisualEnvironmentAdapter } from "./visual-environment-adapter";

interface ListenerTarget {
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

function createListenerTarget(): ListenerTarget & { emit(type: string): void; count(type: string): number } {
	const listeners = new Map<string, Set<() => void>>();
	return {
		addEventListener(type, listener) {
			let values = listeners.get(type);
			if (!values) listeners.set(type, values = new Set());
			values.add(listener);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		emit(type) {
			for (const listener of [...(listeners.get(type) ?? [])]) listener();
		},
		count(type) {
			return listeners.get(type)?.size ?? 0;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => { resolve = next; });
	return { promise, resolve };
}

function createReducedMotionQuery(initialMatches: boolean) {
	const listeners = new Set<() => void>();
	let matches = initialMatches;
	return {
		get matches() { return matches; },
		addEventListener(type: "change", listener: () => void) {
			if (type === "change") listeners.add(listener);
		},
		removeEventListener(type: "change", listener: () => void) {
			if (type === "change") listeners.delete(listener);
		},
		emit(nextMatches: boolean) {
			matches = nextMatches;
			for (const listener of [...listeners]) listener();
		},
		listenerCount() {
			return listeners.size;
		},
	};
}

test("visual environment adapter tracks browser visibility, focus, blur, and unsubscribes cleanly", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let visibilityState: DocumentVisibilityState = "visible";
	let focused = true;
	const adapter = createVisualEnvironmentAdapter({
		document: {
			...documentTarget,
			get visibilityState() { return visibilityState; },
			hasFocus: () => focused,
		},
		window: windowTarget,
		isNativeRuntime: () => false,
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));

	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});
	visibilityState = "hidden";
	documentTarget.emit("visibilitychange");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});
	focused = false;
	windowTarget.emit("blur");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	focused = true;
	windowTarget.emit("focus");
	expect(snapshots.at(-1)).toEqual({
		documentVisible: false,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	});

	unsubscribe();
	expect(documentTarget.count("visibilitychange")).toBe(0);
	expect(windowTarget.count("focus")).toBe(0);
	expect(windowTarget.count("blur")).toBe(0);
	visibilityState = "visible";
	documentTarget.emit("visibilitychange");
	expect(snapshots.length).toBe(4);
});

test("visual environment adapter suppresses duplicate states and cleans the reduced-motion listener", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(true);
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		reducedMotionMediaQuery: reducedMotionQuery,
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));

	expect(adapter.getPrefersReducedMotion()).toBe(true);
	expect(snapshots.length).toBe(1);
	documentTarget.emit("visibilitychange");
	windowTarget.emit("focus");
	expect(snapshots.length).toBe(1);

	reducedMotionQuery.emit(false);
	expect(adapter.getPrefersReducedMotion()).toBe(false);
	expect(reducedMotionQuery.listenerCount()).toBe(1);
	unsubscribe();
	expect(reducedMotionQuery.listenerCount()).toBe(0);
	adapter.dispose();
	adapter.dispose();
});

test("visual environment adapter reads the browser reduced-motion query when no test source is supplied", () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const reducedMotionQuery = createReducedMotionQuery(true);
	let queried = "";
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: {
			...windowTarget,
			matchMedia(query: string) {
				queried = query;
				return reducedMotionQuery;
			},
		},
	});
	const unsubscribe = adapter.subscribe(() => {});

	expect(queried).toBe("(prefers-reduced-motion: reduce)");
	expect(adapter.getPrefersReducedMotion()).toBe(true);
	unsubscribe();
});

test("visual environment adapter combines native visible, focused, and minimized state", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: async () => ({ isVisible: true, isFocused: true, isMinimized: false }),
			listenWindowState: async (listener) => {
				nativeListener.current = listener;
				return () => {};
			},
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	await Promise.resolve();
	await Promise.resolve();

	nativeListener.current?.({ isVisible: false, isFocused: false, isMinimized: true });
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	unsubscribe();
});

test("initial native get starts after listener registration and observes state changes from the registration gap", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const listen = deferred<() => void>();
	let getCalls = 0;
	let backingState = { isVisible: true, isFocused: true, isMinimized: false };
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: () => {
				getCalls += 1;
				return Promise.resolve({ ...backingState });
			},
			listenWindowState: () => listen.promise,
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));

	expect(getCalls).toBe(0);
	backingState = { isVisible: false, isFocused: false, isMinimized: true };
	listen.resolve(() => {});
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(getCalls).toBe(1);
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	unsubscribe();
});

test("late native get cannot overwrite an event received after listener registration", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	const getState = deferred<{ isVisible: boolean; isFocused: boolean; isMinimized: boolean }>();
	const nativeListener: { current?: (state: { isVisible: boolean; isFocused: boolean; isMinimized: boolean }) => void } = {};
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
		window: windowTarget,
		nativeSource: {
			getWindowState: () => getState.promise,
			listenWindowState: (listener) => {
				nativeListener.current = listener;
				return Promise.resolve(() => {});
			},
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	await Promise.resolve();
	await Promise.resolve();
	nativeListener.current?.({ isVisible: false, isFocused: false, isMinimized: true });
	getState.resolve({ isVisible: true, isFocused: true, isMinimized: false });
	await Promise.resolve();
	await Promise.resolve();
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: false,
		windowFocused: false,
		windowMinimized: true,
	});
	unsubscribe();
});

test("unsubscribe or dispose before native listener registration invokes the late unlisten and skips get", async () => {
	for (const cleanupMode of ["unsubscribe", "dispose"] as const) {
		const documentTarget = createListenerTarget();
		const windowTarget = createListenerTarget();
		const listen = deferred<() => void>();
		let getCalls = 0;
		let unlistenCalls = 0;
		const adapter = createVisualEnvironmentAdapter({
			document: { ...documentTarget, visibilityState: "visible", hasFocus: () => true },
			window: windowTarget,
			nativeSource: {
				getWindowState: async () => {
					getCalls += 1;
					return { isVisible: true, isFocused: true, isMinimized: false };
				},
				listenWindowState: () => listen.promise,
			},
		});
		const unsubscribe = adapter.subscribe(() => {});
		if (cleanupMode === "unsubscribe") unsubscribe();
		else adapter.dispose();
		listen.resolve(() => { unlistenCalls += 1; });
		await Promise.resolve();
		await Promise.resolve();
		expect(unlistenCalls).toBe(1);
		expect(getCalls).toBe(0);
	}
});

test("Web fallback never calls an implicit native source", async () => {
	const documentTarget = createListenerTarget();
	const windowTarget = createListenerTarget();
	let nativeCalls = 0;
	const adapter = createVisualEnvironmentAdapter({
		document: { ...documentTarget, visibilityState: "visible", hasFocus: () => false },
		window: windowTarget,
		isNativeRuntime: () => true,
		defaultNativeSource: {
			getWindowState: async () => {
				nativeCalls += 1;
				return { isVisible: false, isFocused: false, isMinimized: false };
			},
			listenWindowState: async () => {
				nativeCalls += 1;
				return () => {};
			},
		},
	});
	const snapshots: unknown[] = [];
	const unsubscribe = adapter.subscribe((snapshot) => snapshots.push(snapshot));
	await Promise.resolve();
	expect(nativeCalls).toBe(0);
	expect(snapshots.at(-1)).toEqual({
		documentVisible: true,
		windowVisible: true,
		windowFocused: false,
		windowMinimized: false,
	});
	unsubscribe();
});

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createDesktopLyricsOverlayActions,
	DesktopLyricsRoot,
	type DesktopLyricsPayloadSetter,
	isDesktopLyricsRoute,
	subscribeDesktopLyricsBridge
} from "./DesktopLyricsRoot";
import {
	normalizeDesktopLyricsEventPayload,
	normalizeDesktopLyricsLockEvent,
	type DesktopLyricsBridge
} from "./desktop-lyrics-bridge";

function createNoopBridge(): DesktopLyricsBridge {
	return {
		async listenPayload() {
			return () => {};
		},
		async listenLockChanged() {
			return () => {};
		},
		async overlayReady() {},
		async setClickThrough() {},
		async moveBy() {}
	};
}

function applyPayloadSetter(
	current: Partial<import("@mineradio/shared").DesktopLyricsPayload>,
	setter: Parameters<DesktopLyricsPayloadSetter>[0]
) {
	return typeof setter === "function" ? setter(current) : setter;
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flushPromises(times = 4) {
	for (let i = 0; i < times; i += 1) {
		await Promise.resolve();
	}
}

test("isDesktopLyricsRoute detects overlay route forms", () => {
	expect(isDesktopLyricsRoute({ pathname: "/desktop-lyrics", search: "" } as Location)).toBe(true);
	expect(isDesktopLyricsRoute({ pathname: "/index.html", search: "?view=desktop-lyrics" } as Location)).toBe(true);
	expect(isDesktopLyricsRoute({ pathname: "/index.html", search: "" } as Location)).toBe(false);
});

test("DesktopLyricsRoot renders default payload through injectable bridge", () => {
	const html = renderToStaticMarkup(React.createElement(DesktopLyricsRoot, { bridge: createNoopBridge() }));
	expect(html).toContain("Mineradio");
	expect(html).toContain("desktop-lyrics-locked");
});

test("normalizeDesktopLyricsEventPayload applies shared defaults to Tauri event payloads", () => {
	const payload = normalizeDesktopLyricsEventPayload({ enabled: true, text: "桌面歌词", progress: 2 });
	expect(payload.text).toBe("桌面歌词");
	expect(payload.progress).toBe(1);
	expect(payload.motion.fps).toBe(60);
});

test("normalizeDesktopLyricsLockEvent accepts boolean lock events", () => {
	expect(normalizeDesktopLyricsLockEvent(true)).toBe(true);
	expect(normalizeDesktopLyricsLockEvent(false)).toBe(false);
});

test("subscribeDesktopLyricsBridge applies payload and lock events", async () => {
	const payloadListeners: Array<(payload: import("@mineradio/shared").DesktopLyricsPayload) => void> = [];
	const lockListeners: Array<(clickThrough: boolean) => void> = [];
	let disposeCount = 0;
	let state: Partial<import("@mineradio/shared").DesktopLyricsPayload> = {};
	const bridge: DesktopLyricsBridge = {
		async listenPayload(listener) {
			payloadListeners.push(listener);
			return () => {
				disposeCount += 1;
			};
		},
		async listenLockChanged(listener) {
			lockListeners.push(listener);
			return () => {
				disposeCount += 1;
			};
		},
		async overlayReady() {},
		async setClickThrough() {},
		async moveBy() {}
	};

	const dispose = subscribeDesktopLyricsBridge(bridge, (setter) => {
		state = applyPayloadSetter(state, setter);
	});
	await Promise.resolve();
	payloadListeners[0]?.(normalizeDesktopLyricsEventPayload({ enabled: true, text: "已同步", clickThrough: false }));
	lockListeners[0]?.(true);

	expect(state.text).toBe("已同步");
	expect(state.clickThrough).toBe(true);

	dispose();
	expect(disposeCount).toBe(2);
});

test("subscribeDesktopLyricsBridge announces overlay ready after registering listeners", async () => {
	const calls: string[] = [];
	const bridge: DesktopLyricsBridge = {
		async listenPayload() {
			calls.push("listenPayload");
			return () => {};
		},
		async listenLockChanged() {
			calls.push("listenLockChanged");
			return () => {};
		},
		async overlayReady() {
			calls.push("overlayReady");
		},
		async setClickThrough() {},
		async moveBy() {}
	};

	subscribeDesktopLyricsBridge(bridge, () => {});
	await flushPromises();

	expect(calls).toEqual(["listenPayload", "listenLockChanged", "overlayReady"]);
});

test("subscribeDesktopLyricsBridge waits for async listener registration before overlay ready", async () => {
	const calls: string[] = [];
	const payloadReady = createDeferred<() => void>();
	const lockReady = createDeferred<() => void>();
	const bridge: DesktopLyricsBridge = {
		async listenPayload() {
			calls.push("listenPayload");
			return payloadReady.promise;
		},
		async listenLockChanged() {
			calls.push("listenLockChanged");
			return lockReady.promise;
		},
		async overlayReady() {
			calls.push("overlayReady");
		},
		async setClickThrough() {},
		async moveBy() {}
	};

	subscribeDesktopLyricsBridge(bridge, () => {});
	await flushPromises();
	expect(calls).toEqual(["listenPayload", "listenLockChanged"]);

	payloadReady.resolve(() => {});
	await flushPromises();
	expect(calls).toEqual(["listenPayload", "listenLockChanged"]);

	lockReady.resolve(() => {});
	await flushPromises();
	expect(calls).toEqual(["listenPayload", "listenLockChanged", "overlayReady"]);
});

test("subscribeDesktopLyricsBridge cancels overlay ready after cleanup", async () => {
	const calls: string[] = [];
	const payloadReady = createDeferred<() => void>();
	const lockReady = createDeferred<() => void>();
	const bridge: DesktopLyricsBridge = {
		async listenPayload() {
			return payloadReady.promise;
		},
		async listenLockChanged() {
			return lockReady.promise;
		},
		async overlayReady() {
			calls.push("overlayReady");
		},
		async setClickThrough() {},
		async moveBy() {}
	};

	const dispose = subscribeDesktopLyricsBridge(bridge, () => {});
	dispose();
	payloadReady.resolve(() => {});
	lockReady.resolve(() => {});
	await flushPromises();

	expect(calls).toEqual([]);
});

test("subscribeDesktopLyricsBridge skips overlay ready after failed listener setup", async () => {
	const calls: string[] = [];
	const bridge: DesktopLyricsBridge = {
		async listenPayload() {
			throw new Error("listener unavailable");
		},
		async listenLockChanged() {
			throw new Error("listener unavailable");
		},
		async overlayReady() {
			calls.push("overlayReady");
		},
		async setClickThrough() {},
		async moveBy() {}
	};

	subscribeDesktopLyricsBridge(bridge, () => {});
	await flushPromises();
	expect(calls).toEqual([]);
});

test("createDesktopLyricsOverlayActions invokes Tauri lock and move commands", async () => {
	const commands: Array<[string, unknown]> = [];
	let state: Partial<import("@mineradio/shared").DesktopLyricsPayload> = { clickThrough: true, position: { x: 80, y: 80 } };
	const bridge: DesktopLyricsBridge = {
		async listenPayload() {
			return () => {};
		},
		async listenLockChanged() {
			return () => {};
		},
		async overlayReady() {},
		async setClickThrough(clickThrough) {
			commands.push(["setClickThrough", clickThrough]);
		},
		async moveBy(dx, dy) {
			commands.push(["moveBy", [dx, dy]]);
		}
	};
	const actions = createDesktopLyricsOverlayActions(
		bridge,
		() => state,
		(setter) => {
			state = applyPayloadSetter(state, setter);
		}
	);

	actions.onToggleLock();
	actions.onMoveBy(12, -3);
	await Promise.resolve();

	expect(state.clickThrough).toBe(false);
	expect(state.position).toEqual({ x: 92, y: 77 });
	expect(commands).toEqual([
		["setClickThrough", false],
		["moveBy", [12, -3]]
	]);
});

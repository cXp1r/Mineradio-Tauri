import { expect, test } from "bun:test";
import { createLegacyVisualEventBridge } from "./legacy-visual-events";

test("legacy visual event bridge forwards the original Shelf payload to the latest callback", () => {
	const oldReceived: unknown[] = [];
	const newReceived: unknown[] = [];
	const payload = { playlistId: "7", provider: "netease" };
	const events = createLegacyVisualEventBridge({
		onShelfPlayPlaylist: (value) => oldReceived.push(value),
	});
	events.onShelfPlayPlaylist(payload as never);
	events.update({ onShelfPlayPlaylist: (value) => newReceived.push(value) });

	events.onShelfPlayPlaylist(payload as never);
	expect(oldReceived.length).toBe(1);
	expect(newReceived.length).toBe(1);
	expect(oldReceived[0]).toBe(payload);
	expect(newReceived[0]).toBe(payload);
});

test("legacy visual event bridge isolates callback failures and reports them", () => {
	const reported: unknown[] = [];
	const events = createLegacyVisualEventBridge({
		onShelfPaneChange: () => { throw new Error("handler failure"); },
		reportError: (error) => reported.push(error),
	});

	events.onShelfPaneChange("mine");
	expect(reported.length).toBe(1);
	expect((reported[0] as Error).message).toBe("handler failure");
});

test("legacy visual event bridge prevents recursive error reporting", () => {
	let handlerCalls = 0;
	let reportCalls = 0;
	let events: ReturnType<typeof createLegacyVisualEventBridge>;
	events = createLegacyVisualEventBridge({
		onShelfPaneChange: () => {
			handlerCalls += 1;
			throw new Error("handler failure");
		},
		reportError: () => {
			reportCalls += 1;
			events.onShelfPaneChange("fav");
		},
	});

	events.onShelfPaneChange("mine");
	expect(handlerCalls).toBe(2);
	expect(reportCalls).toBe(1);
});

test("legacy visual event bridge writes desktop motion into the supplied ref", () => {
	const motionRef: { current: unknown } = { current: null };
	const motion = { activeLine: 2, progress: 0.5 };
	const events = createLegacyVisualEventBridge({ desktopLyricsMotionRef: motionRef as never });

	events.onDesktopLyricsMotion(motion as never);
	expect(motionRef.current).toBe(motion);
});

test("legacy visual event bridge isolates a failing desktop motion ref write and still invokes the callback", () => {
	const reported: unknown[] = [];
	let callbackCalls = 0;
	const motionRef = Object.defineProperty({}, "current", {
		set() {
			throw new Error("motion ref failure");
		},
	});
	const events = createLegacyVisualEventBridge({
		desktopLyricsMotionRef: motionRef as never,
		onDesktopLyricsMotion: () => { callbackCalls += 1; },
		reportError: (error) => reported.push(error),
	});
	let caught: unknown = null;
	try {
		events.onDesktopLyricsMotion({} as never);
	} catch (error) {
		caught = error;
	}

	expect(caught).toBeNull();
	expect(callbackCalls).toBe(1);
	expect(reported.length).toBe(1);
	expect((reported[0] as Error).message).toBe("motion ref failure");
});

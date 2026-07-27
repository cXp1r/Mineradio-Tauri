import { expect, test } from "bun:test";
import { createLegacyVisualEventBridge } from "./legacy-visual-events";

test("legacy visual event bridge forwards the original Shelf payload to the latest callback", () => {
	const received: unknown[] = [];
	const payload = { playlistId: "7", provider: "netease" };
	const events = createLegacyVisualEventBridge({
		onShelfPlayPlaylist: (value) => received.push(value),
	});
	events.update({ onShelfPlayPlaylist: (value) => received.push(value) });

	events.onShelfPlayPlaylist(payload as never);
	expect(received.length).toBe(1);
	expect(received[0]).toBe(payload);
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

test("legacy visual event bridge writes desktop motion into the supplied ref", () => {
	const motionRef: { current: unknown } = { current: null };
	const motion = { activeLine: 2, progress: 0.5 };
	const events = createLegacyVisualEventBridge({ desktopLyricsMotionRef: motionRef as never });

	events.onDesktopLyricsMotion(motion as never);
	expect(motionRef.current).toBe(motion);
});

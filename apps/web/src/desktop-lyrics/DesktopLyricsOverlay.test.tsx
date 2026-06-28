import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
	DesktopLyricsOverlay,
	computeDesktopLyricsStyle,
	createDesktopLyricsPointerHandlers,
	normalizeDesktopLyricsPayload,
	shouldRenderDesktopLyrics,
	type DesktopLyricsDragCallbacks
} from "./DesktopLyricsOverlay";

test("normalizeDesktopLyricsPayload delegates transport defaults to shared contract", () => {
	const payload = normalizeDesktopLyricsPayload({ enabled: true, text: "hello" });
	expect(payload.motion.fps).toBe(60);
	expect(payload.position.x).toBe(80);
	expect(payload.clickThrough).toBe(true);
});

test("shouldRenderDesktopLyrics requires enabled payload with visible text", () => {
	expect(shouldRenderDesktopLyrics({ enabled: true, text: " line " })).toBe(true);
	expect(shouldRenderDesktopLyrics({ enabled: true, text: "   " })).toBe(false);
	expect(shouldRenderDesktopLyrics({ enabled: false, text: "line" })).toBe(false);
});

test("computeDesktopLyricsStyle exposes progress and placement CSS hooks", () => {
	const style = computeDesktopLyricsStyle(
		normalizeDesktopLyricsPayload({
			enabled: true,
			text: "line",
			progress: 0.42,
			position: { x: 123, y: 456 },
			colors: { primary: "#fff", secondary: "#fd0", background: "rgba(0,0,0,.3)", glow: "#fd0" }
		})
	);
	expect(style["--desktop-lyrics-progress"]).toBe("42%");
	expect(style.left).toBe("123px");
	expect(style.top).toBe("456px");
	expect(style["--desktop-lyrics-primary"]).toBe("#fff");
});

test("DesktopLyricsOverlay renders locked class and text from payload", () => {
	const html = renderToStaticMarkup(
		React.createElement(DesktopLyricsOverlay, {
			payload: { enabled: true, text: "正在播放", clickThrough: true, progress: 0.5 }
		})
	);
	expect(html).toContain("desktop-lyrics-overlay");
	expect(html).toContain("desktop-lyrics-locked");
	expect(html).toContain("正在播放");
	expect(html).toContain("--desktop-lyrics-progress:50%");
});

test("DesktopLyricsOverlay middle click locks only when unlocked and pointer drag emits delta", () => {
	const calls: Array<[number, number]> = [];
	let lockToggles = 0;
	const callbacks: DesktopLyricsDragCallbacks = {
		onToggleLock: () => {
			lockToggles += 1;
		},
		onMoveBy: (dx, dy) => {
			calls.push([dx, dy]);
		}
	};
	const props = createDesktopLyricsPointerHandlers(
		normalizeDesktopLyricsPayload({ enabled: true, text: "drag", clickThrough: false }),
		callbacks,
		{ current: null }
	) as unknown as {
		onPointerDown: (event: { button: number; clientX: number; clientY: number; pointerId: number; currentTarget: { setPointerCapture: () => void } }) => void;
		onPointerMove: (event: { clientX: number; clientY: number }) => void;
		onPointerUp: () => void;
	};

	props.onPointerDown({ button: 1, clientX: 10, clientY: 20, pointerId: 1, currentTarget: { setPointerCapture: () => {} } });
	expect(lockToggles).toBe(1);

	props.onPointerDown({ button: 0, clientX: 10, clientY: 20, pointerId: 1, currentTarget: { setPointerCapture: () => {} } });
	props.onPointerMove({ clientX: 16, clientY: 27 });
	props.onPointerMove({ clientX: 20, clientY: 30 });
	props.onPointerUp();

	expect(calls).toEqual([
		[6, 7],
		[4, 3]
	]);
});

test("DesktopLyricsOverlay does not pretend locked click-through can be unlocked by renderer events", () => {
	let lockToggles = 0;
	const props = createDesktopLyricsPointerHandlers(
		normalizeDesktopLyricsPayload({ enabled: true, text: "locked", clickThrough: true }),
		{ onToggleLock: () => { lockToggles += 1; } },
		{ current: null }
	) as unknown as {
		onPointerDown: (event: { button: number; clientX: number; clientY: number; pointerId: number; currentTarget: { setPointerCapture: () => void } }) => void;
	};

	props.onPointerDown({ button: 1, clientX: 10, clientY: 20, pointerId: 1, currentTarget: { setPointerCapture: () => {} } });
	expect(lockToggles).toBe(0);
});

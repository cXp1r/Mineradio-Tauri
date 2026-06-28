import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import React from "react";
import { PlayerConsoleHost } from "./PlayerConsoleHost";

test("PlayerConsoleHost server-renders the bottom-bar markup", () => {
	const html = renderToStaticMarkup(React.createElement(PlayerConsoleHost, {}));
	expect(html).toContain('id="bottom-bar"');
	expect(html).toContain('id="play-btn"');
	expect(html).toContain('id="play-mode-btn"');
	expect(html).toContain('id="control-cover"');
	expect(html).toContain('id="time-display"');
});

test("PlayerConsoleHost renders window chrome stub buttons that accept callbacks without throwing", () => {
	let mini = 0;
	let max = 0;
	let fs = 0;
	let close = 0;
	const html = renderToStaticMarkup(
		React.createElement(PlayerConsoleHost, {
			onMinimize: () => { mini += 1; },
			onToggleMaximize: () => { max += 1; },
			onToggleFullscreen: () => { fs += 1; },
			onClose: () => { close += 1; },
		}),
	);
	expect(html).toContain("console-host-minimize");
	expect(html).toContain("console-host-maximize");
	expect(html).toContain("console-host-close");
	void mini; void max; void fs; void close;
});

test("PlayerConsoleHost renders baseline playback quality options and active short label", () => {
	const html = renderToStaticMarkup(
		React.createElement(PlayerConsoleHost, {
			playbackQuality: "lossless",
		}),
	);
	expect(html).toContain('id="quality-control"');
	expect(html).toContain('id="quality-btn-label"');
	expect(html).toContain(">SQ<");
	expect(html).toContain('data-quality="jymaster"');
	expect(html).toContain("超清母带");
	expect(html).toContain('data-quality="hires"');
	expect(html).toContain('data-quality="lossless"');
	expect(html).toContain('data-quality="exhigh"');
	expect(html).toContain('data-quality="standard"');
});

test("PlayerConsoleHost renders baseline lyric source segment and opens custom lyric editor", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let opened = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			lyricSourceMode: "original",
			hasCustomLyric: true,
			onLyricSourceChange: (mode) => {
				if (mode === "custom") opened += 1;
			},
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(container.querySelector("#lyric-source-seg")).not.toBeNull();
	expect(container.querySelector("#lyric-source-original")?.className).toContain("active");
	expect(container.querySelector("#lyric-source-custom")?.className).toContain("has-custom");
	(container.querySelector("#lyric-source-custom") as HTMLButtonElement).click();
	expect(opened).toBe(1);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost renders shelf mode controls and emits baseline setting callbacks", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			shelfMode: "stage",
			shelfCameraMode: "dynamic",
			shelfPresence: "auto",
			onShelfModeChange: (mode) => calls.push(`mode:${mode}`),
			onShelfCameraModeChange: (mode) => calls.push(`camera:${mode}`),
			onShelfPresenceChange: (presence) => calls.push(`presence:${presence}`),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(container.querySelector('#shelf-seg [data-shelf="stage"]')?.className).toContain("active");
	expect(container.querySelector('#shelf-camera-seg [data-shelf-camera="dynamic"]')?.className).toContain("active");
	expect(container.querySelector('#shelf-presence-seg [data-shelf-presence="auto"]')?.className).toContain("active");
	(container.querySelector('#shelf-seg [data-shelf="off"]') as HTMLButtonElement).click();
	(container.querySelector('#shelf-camera-seg [data-shelf-camera="static"]') as HTMLButtonElement).click();
	(container.querySelector('#shelf-presence-seg [data-shelf-presence="always"]') as HTMLButtonElement).click();
	expect(calls).toEqual(["mode:off", "camera:static", "presence:always"]);
	root.unmount();
	container.remove();
});

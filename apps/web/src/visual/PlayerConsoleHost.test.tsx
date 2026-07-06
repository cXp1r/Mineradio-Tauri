import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import React from "react";
import type { Track } from "@mineradio/shared";
import { PlayerConsoleHost } from "./PlayerConsoleHost";

function makeTrack(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: `Song ${id}`,
		artists: ["Alice"],
		album: "Album",
		coverUrl: "",
		durationMs: 1000,
		qualityHints: [],
		playableState: "playable",
	};
}

test("PlayerConsoleHost server-renders the bottom-bar markup", () => {
	const html = renderToStaticMarkup(React.createElement(PlayerConsoleHost, {}));
	expect(html).toContain('id="bottom-bar"');
	expect(html).toContain('id="play-btn"');
	expect(html).toContain('id="play-mode-btn"');
	expect(html).toContain('id="control-cover"');
	expect(html).toContain('id="time-display"');
	expect(html.indexOf('id="quality-control"')).toBeLessThan(html.indexOf('id="heart-btn"'));
	expect(html).toContain('<path d="M12 5v14"></path><path d="M5 12h14"></path>');
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

test("PlayerConsoleHost renders provider-reported quality options when supplied", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlayerConsoleHost, {
      playbackQuality: "320",
      qualityOptions: [
        {
          provider: "qq",
          id: "flac",
          label: "FLAC",
          short: "FLAC",
          detail: "42MB",
          requestQuality: "flac",
          source: "declared",
        },
        {
          provider: "qq",
          id: "320",
          label: "320k MP3",
          short: "320",
          detail: "9MB",
          requestQuality: "320",
          source: "declared",
        },
      ],
    }),
  );

  expect(html).toContain(">320<");
  expect(html).toContain('data-quality="flac"');
  expect(html).toContain('data-quality="320"');
  expect(html).not.toContain('data-quality="jymaster"');
  expect(html).not.toContain('data-quality="standard"');
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

test("PlayerConsoleHost virtualizes the mini queue popover for long queues", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const queue = Array.from({ length: 240 }, (_, index) => makeTrack(String(index)));
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			miniQueueOpen: true,
			queue,
			currentTrack: queue[0],
			onPlayQueueIndex: (index: number) => calls.push(`play:${index}`),
			onInsertQueueNext: (index: number) => calls.push(`next:${index}`),
			onRemoveQueueIndex: (index: number) => calls.push(`remove:${index}`),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(container.querySelector("#mini-queue-list")?.getAttribute("data-virtualized")).toBe("true");
	expect(container.querySelectorAll(".mini-queue-item").length).toBeLessThan(60);
	(container.querySelector(".mini-queue-main") as HTMLButtonElement).click();
	(container.querySelector(".mini-queue-next") as HTMLButtonElement).click();
	(container.querySelector(".mini-queue-remove:last-child") as HTMLButtonElement).click();
	expect(calls).toEqual(["play:0", "next:0", "remove:0"]);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost renders shelf content switches and emits baseline callbacks", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			shelfShowPodcasts: false,
			shelfMergeCollections: true,
			onShelfShowPodcastsChange: (show) => calls.push(`podcasts:${show}`),
			onShelfMergeCollectionsChange: (merge) => calls.push(`merge:${merge}`),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(container.querySelector('[data-shelf-content="podcasts"]')?.className).not.toContain("active");
	expect(container.querySelector('[data-shelf-content="merge"]')?.className).toContain("active");
	(container.querySelector('[data-shelf-content="podcasts"]') as HTMLButtonElement).click();
	(container.querySelector('[data-shelf-content="merge"]') as HTMLButtonElement).click();
	expect(calls).toEqual(["podcasts:true", "merge:false"]);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost routes the collect button to the baseline collect picker callback", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let opened = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			onCollectCurrent: () => { opened += 1; },
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	(container.querySelector("#collect-btn") as HTMLButtonElement).click();
	expect(opened).toBe(1);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost renders liked heart state and forwards current like clicks", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let toggles = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			currentLiked: true,
			onToggleLikeCurrent: () => { toggles += 1; },
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const button = container.querySelector("#heart-btn") as HTMLButtonElement;
	expect(button.className).toContain("liked");
	expect(button.className).toContain("active");
	expect(button.getAttribute("aria-pressed")).toBe("true");
	expect(button.title).toBe("取消红心");
	button.click();
	expect(toggles).toBe(1);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost disables the heart button while like mutation is busy", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let toggles = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			currentLikeBusy: true,
			onToggleLikeCurrent: () => { toggles += 1; },
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const button = container.querySelector("#heart-btn") as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	expect(button.className).toContain("busy");
	button.click();
	expect(toggles).toBe(0);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost fullscreen button no longer emits stale Tauri placeholder notice", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			onToggleFullscreen: () => calls.push("fullscreen"),
			onNotice: (message) => calls.push(`notice:${message}`),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const button = container.querySelector(".fullscreen-toggle-btn") as HTMLButtonElement;
	button.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
	button.click();
	expect(calls).toEqual(["fullscreen"]);
	root.unmount();
	container.remove();
});

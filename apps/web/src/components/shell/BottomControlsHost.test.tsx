import { expect, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import React from "react";
import { BottomControlsHost } from "./BottomControlsHost";

test("BottomControlsHost forwards window chrome callbacks to the player console", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => calls.push("reveal"),
			onMinimize: () => calls.push("minimize"),
			onToggleMaximize: () => calls.push("maximize"),
			onToggleFullscreen: () => calls.push("fullscreen"),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	(container.querySelector(".console-host-minimize") as HTMLButtonElement).click();
	(container.querySelector(".console-host-maximize") as HTMLButtonElement).click();
	(container.querySelector(".fullscreen-toggle-btn") as HTMLButtonElement).click();

	expect(calls).toEqual(["minimize", "maximize", "fullscreen"]);
	root.unmount();
	container.remove();
});

test("BottomControlsHost forwards current heart state and click callback", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => calls.push("reveal"),
			currentLiked: true,
			onToggleLikeCurrent: () => calls.push("like"),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const button = container.querySelector("#heart-btn") as HTMLButtonElement;
	expect(button.className).toContain("liked");
	expect(button.getAttribute("aria-pressed")).toBe("true");
	button.click();
	expect(calls).toEqual(["like"]);
	root.unmount();
	container.remove();
});

test("BottomControlsHost forwards optional volume panel extras without changing default controls", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => undefined,
			renderVolumePanelExtras: (active: boolean) => React.createElement(
				"div",
				{ className: "bottom-volume-extra", "data-active": active ? "1" : "0" },
			),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(container.querySelector("#volume-slider")).not.toBeNull();
	expect(container.querySelector(".bottom-volume-extra")?.getAttribute("data-active")).toBe("0");
	root.unmount();
	container.remove();
});

test("BottomControlsHost mirrors baseline bottom handle wake and auto-hide hover timing", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.className = "";
	const calls: string[] = [];
	const timers: Array<{ callback: () => void; delay?: number }> = [];
	const cleared: number[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	flushSync(() => root.render(
		React.createElement(BottomControlsHost, {
			visible: false,
			onReveal: () => calls.push("reveal"),
			onHide: () => calls.push("hide"),
			deps: {
				setTimeoutRef: ((callback: () => void, delay?: number) => {
					timers.push({ callback, delay });
					return timers.length;
				}) as typeof window.setTimeout,
				clearTimeoutRef: ((id: number) => {
					cleared.push(id);
				}) as typeof window.clearTimeout,
			},
		}),
	));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const handle = container.querySelector("#bottom-handle") as HTMLButtonElement;
	const bar = container.querySelector("#bottom-bar") as HTMLDivElement;
	handle.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
	expect(calls).toEqual(["reveal"]);
	expect(document.body.classList.contains("controls-handle-awake")).toBe(true);

	handle.dispatchEvent(new window.MouseEvent("mouseleave", { bubbles: true }));
	expect(timers.length).toBeGreaterThanOrEqual(2);
	expect(timers[timers.length - 2]?.delay).toBe(480);
	timers[timers.length - 2]?.callback();
	expect(calls).toEqual(["reveal", "hide"]);
	timers[timers.length - 1]?.callback();
	expect(document.body.classList.contains("controls-handle-awake")).toBe(false);

	bar.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
	expect(document.body.classList.contains("controls-handle-awake")).toBe(true);
	expect(cleared.length).toBeGreaterThan(0);
	bar.dispatchEvent(new window.MouseEvent("mouseleave", { bubbles: true }));
	expect(timers[timers.length - 2]?.delay).toBe(480);
	timers[timers.length - 2]?.callback();
	expect(calls).toEqual(["reveal", "hide", "reveal", "hide"]);

	root.unmount();
	container.remove();
	document.body.className = "";
});

test("BottomControlsHost keeps the visible console open while the pointer is over the bar", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.className = "";
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	flushSync(() => root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			miniQueueOpen: false,
			onReveal: () => {},
			onHide: () => {},
		}),
	));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const bar = container.querySelector("#bottom-bar") as HTMLDivElement;
	expect(bar.classList.contains("visible")).toBe(true);
	expect(bar.classList.contains("soft-hidden")).toBe(false);

	bar.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
	bar.dispatchEvent(new window.Event("pointerenter", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 560));

	expect(bar.classList.contains("visible")).toBe(true);
	expect(bar.classList.contains("soft-hidden")).toBe(false);

	root.unmount();
	container.remove();
	document.body.className = "";
});

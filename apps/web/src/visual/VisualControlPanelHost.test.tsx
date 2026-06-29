import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import React from "react";
import { VisualControlPanelHost } from "./VisualControlPanelHost";

test("VisualControlPanelHost server-renders the baseline fx fab and panel shell", () => {
	const html = renderToStaticMarkup(React.createElement(VisualControlPanelHost, {}));
	expect(html).toContain('id="fx-fab"');
	expect(html).toContain('id="fx-fab-hide-btn"');
	expect(html).toContain('id="fx-panel"');
	expect(html).toContain("视觉控制台");
	expect(html).toContain("MINERADIO VISUALS");
	expect(html).toContain('id="preset-grid"');
	expect(html).toContain('class="preset-card');
	expect(html.match(/class="preset-card/g)?.length).toBe(7);
	expect(html).toContain('data-preset="6"');
	expect(html).toContain("安魂");
	expect(html).toContain("YUI7W");
});

test("VisualControlPanelHost renders baseline DIY control sections", () => {
	const html = renderToStaticMarkup(React.createElement(VisualControlPanelHost, {}));
	expect(html).toContain('id="ui-accent-picker"');
	expect(html).toContain('id="visual-tint-picker"');
	expect(html).toContain('id="fx-intensity"');
	expect(html).toContain('id="fx-depth"');
	expect(html).toContain('id="fx-coverres"');
	expect(html).toContain('id="fx-cineshake"');
	expect(html).toContain('id="fx-lyricglow"');
	expect(html).toContain('id="fx-lyric-fold"');
	expect(html).toContain('id="lyric-font-grid"');
	expect(html).toContain('data-font="stone-song"');
	expect(html).toContain('id="fx-overlay-fold"');
	expect(html).not.toContain('id="t-float"');
	expect(html).toContain('id="t-desktopLyrics"');
	expect(html).toContain('id="t-wallpaperMode"');
	expect(html).toContain("开发中");
	expect(html).toContain('id="fx-stage-fold"');
	expect(html).toContain('id="shelf-seg"');
	expect(html).not.toContain('data-cam="gesture"');
	expect(html).not.toContain("手势触碰");
	expect(html).toContain('id="fx-advanced"');
	expect(html).toContain('id="performance-quality-seg"');
});

test("VisualControlPanelHost opens the panel and emits baseline preset/setting callbacks", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(VisualControlPanelHost, {
			preset: 0,
			intensity: 0.85,
			settings: {
				cinema: true,
				wallpaperMode: false,
			},
			onPresetChange: (preset) => calls.push(`preset:${preset}`),
			onNumberSettingChange: (key, value) => calls.push(`${key}:${value}`),
			onBooleanSettingChange: (key, value) => calls.push(`${key}:${value}`),
			onStringSettingChange: (key, value) => calls.push(`${key}:${value}`),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(container.querySelector("#fx-panel")?.className).not.toContain("show");
	(container.querySelector("#fx-fab") as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(container.querySelector("#fx-panel")?.className).toContain("show");
	expect(container.querySelector("#fx-fab")?.className).toContain("active");
	(container.querySelector('.preset-card[data-preset="4"]') as HTMLButtonElement).click();
	const intensity = container.querySelector("#fx-intensity") as HTMLInputElement;
	const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	valueSetter?.call(intensity, "1.2");
	intensity.dispatchEvent(new window.Event("input", { bubbles: true }));
	(container.querySelector('[data-font="stone-song"]') as HTMLButtonElement).click();
	(container.querySelector("#t-cinema") as HTMLButtonElement).click();
	(container.querySelector("#t-wallpaperMode") as HTMLButtonElement).click();

	expect(calls).toEqual([
		"preset:4",
		"intensity:1.2",
		"lyricFont:stone-song",
		"cinema:false",
	]);
	root.unmount();
	container.remove();
});

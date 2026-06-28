import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App, isHomeBlankDismissElement, shouldShowEmptyHome } from "./App";
import type { SplashHostProps } from "../visual/SplashHost";

test("App keeps the empty-home music page mounted behind the splash gate", () => {
	const html = renderToStaticMarkup(React.createElement(App));
	expect(html).toContain('class="visual-splash-root"');
	expect(html).toContain('id="visual-host"');
	expect(html).toContain('id="empty-home"');
	expect(html).toContain('id="search-area"');
	expect(html).toContain('id="top-right"');
	expect(html).toContain('id="bottom-handle"');
	expect(html).toContain('id="bottom-bar"');
	expect(html).toContain('id="user-btn"');
	expect(html).toContain("🚧此处施工，敬请期待🚧");
	expect(html).toContain("展开播放器控制台");
	expect(html).toContain("每日推荐");
});

test("App unmounts SplashHost after splash dismissed instead of leaving hidden splash listeners alive", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const host = document.createElement("div");
	document.body.appendChild(host);
	let dismissed: (() => void) | null = null;
	function MockSplash(props: SplashHostProps) {
		dismissed = () => props.onDismissed?.();
		return <div className="visual-splash-root" data-testid="splash" />;
	}
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={MockSplash} />));
	expect(host.querySelector(".visual-splash-root")).not.toBeNull();
	flushSync(() => dismissed?.());
	expect(host.querySelector(".visual-splash-root")).toBeNull();
	root.unmount();
	host.remove();
});

test("Home blank dismiss accepts only empty Home surfaces", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.innerHTML = `
		<section id="empty-home">
			<div class="empty-home-shell" id="blank"></div>
			<button class="home-card" id="card">card</button>
			<input id="search-input" />
			<div id="bottom-handle"></div>
		</section>
	`;
	expect(isHomeBlankDismissElement(document.getElementById("blank"))).toBe(true);
	expect(isHomeBlankDismissElement(document.getElementById("card"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("search-input"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("bottom-handle"))).toBe(false);
});

test("shouldShowEmptyHome follows baseline force/suppress/playback gates", () => {
	const base = {
		splashActive: false,
		homeForcedOpen: false,
		homeSuppressed: false,
		hasCurrentTrack: false,
		queueLength: 0,
		isPlaying: false,
	};
	expect(shouldShowEmptyHome(base)).toBe(true);
	expect(shouldShowEmptyHome({ ...base, splashActive: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, homeSuppressed: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, hasCurrentTrack: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, queueLength: 1 })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, isPlaying: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, immersiveActive: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, shelfDetailOpen: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, shelfPinnedOpen: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, splashActive: true, homeForcedOpen: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, hasCurrentTrack: true, homeForcedOpen: true })).toBe(true);
});

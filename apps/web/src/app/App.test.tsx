import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
	App,
	applyDesktopWindowShellState,
	buildDesktopLyricsPayloadPatch,
	deriveSidecarRecoveryNoticeState,
	desktopLyricsBeatMapKey,
	isHomeBlankDismissElement,
	shouldUseSecondaryLeftDisplaySeamGuard,
	shouldShowEmptyHome,
} from "./App";
import type { SplashHostProps } from "../visual/SplashHost";
import type { SidecarStatus, RuntimeConfig } from "../tauri/runtime";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { CUSTOM_LYRIC_PREF_STORE_KEY, CUSTOM_LYRIC_STORE_KEY } from "../lyrics/custom-lyrics";
import { SidecarClientError, type SidecarClient } from "../api/sidecar-client";
import type { VisualEngineHostProps } from "../visual/VisualEngineHost";
import { cloneFxState } from "@mineradio/visual-engine";
import type { Track } from "@mineradio/shared";

class AppStubAudioElement extends EventTarget {
	currentTime = 0;
	duration = Number.NaN;
	src = "";
	volume = 1;
	preload = "";
	loadCalled = 0;
	playCalled = 0;
	pauseCalled = 0;
	error: MediaError | null = null;
	load(): void {
		this.loadCalled += 1;
	}
	async play(): Promise<void> {
		this.playCalled += 1;
		this.dispatchEvent(new Event("play"));
	}
	pause(): void {
		this.pauseCalled += 1;
		this.dispatchEvent(new Event("pause"));
	}
}

const appStubAudioInstances: AppStubAudioElement[] = [];

function installAppStubAudio(): () => void {
	const previousWindowAudio = (window as unknown as { Audio?: typeof Audio }).Audio;
	const hadGlobalAudio = "Audio" in globalThis;
	const previousGlobalAudio = (globalThis as unknown as { Audio?: typeof Audio }).Audio;
	const hadGlobalHtmlAudioElement = "HTMLAudioElement" in globalThis;
	const previousGlobalHtmlAudioElement = (globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement;
	const TrackingAudio = class extends AppStubAudioElement {
		constructor() {
			super();
			appStubAudioInstances.push(this);
		}
	} as unknown as typeof Audio;
	appStubAudioInstances.length = 0;
	(window as unknown as { Audio?: typeof Audio }).Audio = TrackingAudio;
	(globalThis as unknown as { Audio?: typeof Audio }).Audio = TrackingAudio;
	(globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement = AppStubAudioElement as unknown as typeof HTMLAudioElement;
	return () => {
		appStubAudioInstances.length = 0;
		(window as unknown as { Audio?: typeof Audio }).Audio = previousWindowAudio;
		if (hadGlobalAudio) {
			(globalThis as unknown as { Audio?: typeof Audio }).Audio = previousGlobalAudio;
		} else {
			delete (globalThis as unknown as { Audio?: typeof Audio }).Audio;
		}
		if (hadGlobalHtmlAudioElement) {
			(globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement = previousGlobalHtmlAudioElement;
		} else {
			delete (globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement;
		}
	};
}

test("App keeps the empty-home music page mounted behind the splash gate", () => {
	const html = renderToStaticMarkup(React.createElement(App));
	expect(html).toContain('class="visual-splash-root"');
	expect(html).toContain('id="visual-host"');
	expect(html).toContain('id="empty-home"');
	expect(html).toContain('id="search-area"');
	expect(html).toContain('id="top-right"');
	expect(html).toContain('id="fx-fab"');
	expect(html).toContain('id="fx-panel"');
	expect(html).toContain('id="bottom-handle"');
	expect(html).toContain('id="bottom-bar"');
	expect(html).toContain('id="user-btn"');
	expect(html).toContain('id="update-shell"');
	expect(html).toContain("🚧此处施工，敬请期待🚧");
	expect(html).toContain("展开播放器控制台");
	expect(html).toContain("每日推荐");
});

test("App keeps hidden wallpaper capability placeholder copy out of the product shell", () => {
	const html = renderToStaticMarkup(React.createElement(App));
	expect(html).not.toContain("壁纸模式开发中");
	expect(html).not.toContain('id="t-wallpaperMode"');
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

function sidecarStatus(overrides: Partial<SidecarStatus> = {}): SidecarStatus {
	return {
		phase: "ready",
		baseUrl: "http://127.0.0.1:40000",
		pid: 1,
		restarts: 0,
		lastError: null,
		lastHealthOkMs: 10,
		providers: ["netease", "qq"],
		logPath: "",
		...overrides,
	};
}

test("deriveSidecarRecoveryNoticeState only marks ready as recovered after an unhealthy phase or restart", () => {
	const firstReady = deriveSidecarRecoveryNoticeState(sidecarStatus(), null);
	expect(firstReady.recovered).toBe(false);
	expect(firstReady.phase).toBe("ready");

	const recovering = deriveSidecarRecoveryNoticeState(sidecarStatus({ phase: "recovering", restarts: 1 }), firstReady);
	expect(recovering.recovered).toBe(false);
	expect(recovering.phase).toBe("recovering");

	const recovered = deriveSidecarRecoveryNoticeState(sidecarStatus({ phase: "ready", restarts: 1 }), recovering);
	expect(recovered.recovered).toBe(true);
	expect(recovered.restarts).toBe(1);

	const restartedWhileReady = deriveSidecarRecoveryNoticeState(sidecarStatus({ phase: "ready", restarts: 2 }), firstReady);
	expect(restartedWhileReady.recovered).toBe(true);
});

test("applyDesktopWindowShellState mirrors baseline desktop shell classes", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.documentElement.className = "";
	document.body.className = "";

	applyDesktopWindowShellState({
		isMaximized: true,
		isNativeFullScreen: false,
		isHtmlFullScreen: false,
		isWindowFullScreen: true,
		isFullScreen: false,
		isMinimized: false,
		isVisible: true,
		isFocused: true,
		isPrimaryDisplay: true,
		hasDisplayOnLeft: false,
		hasDisplayOnRight: false,
		displayBounds: null,
	});

	expect(document.documentElement.classList.contains("desktop-shell-root")).toBe(true);
	expect(document.body.classList.contains("desktop-shell")).toBe(true);
	expect(document.body.classList.contains("desktop-maximized")).toBe(true);
	expect(document.body.classList.contains("desktop-fullscreen")).toBe(true);

	applyDesktopWindowShellState({
		isMaximized: false,
		isNativeFullScreen: false,
		isHtmlFullScreen: false,
		isWindowFullScreen: false,
		isFullScreen: false,
		isMinimized: false,
		isVisible: true,
		isFocused: true,
		isPrimaryDisplay: true,
		hasDisplayOnLeft: false,
		hasDisplayOnRight: false,
		displayBounds: null,
	});

	expect(document.body.classList.contains("desktop-maximized")).toBe(false);
	expect(document.body.classList.contains("desktop-fullscreen")).toBe(false);
});

test("shouldUseSecondaryLeftDisplaySeamGuard mirrors baseline secondary display predicate", () => {
	const base = {
		isMaximized: false,
		isNativeFullScreen: false,
		isHtmlFullScreen: false,
		isWindowFullScreen: false,
		isFullScreen: false,
		isMinimized: false,
		isVisible: true,
		isFocused: true,
		hasDisplayOnRight: false,
		displayBounds: null,
	};
	expect(shouldUseSecondaryLeftDisplaySeamGuard(null)).toBe(false);
	expect(shouldUseSecondaryLeftDisplaySeamGuard({
		...base,
		isPrimaryDisplay: false,
		hasDisplayOnLeft: true,
	})).toBe(true);
	expect(shouldUseSecondaryLeftDisplaySeamGuard({
		...base,
		isPrimaryDisplay: true,
		hasDisplayOnLeft: true,
	})).toBe(false);
	expect(shouldUseSecondaryLeftDisplaySeamGuard({
		...base,
		isPrimaryDisplay: false,
		hasDisplayOnLeft: false,
	})).toBe(false);
});

test("buildDesktopLyricsPayloadPatch mirrors baseline metadata typography motion and playback fields", () => {
	const fx = cloneFxState();
	fx.lyricFont = "stone-song";
	fx.lyricWeight = 750;
	fx.lyricLetterSpacing = 0.12;
	fx.lyricLineHeight = 1.24;
	fx.lyricScale = 1.4;
	fx.lyricGlow = true;
	fx.lyricGlowBeat = true;
	fx.lyricGlowStrength = 0.52;
	fx.lyricGlowParticles = true;
	fx.desktopLyricsCinema = false;
	fx.desktopLyricsHighlight = true;

	const payload = buildDesktopLyricsPayloadPatch(fx, "line", 0.42, {
		title: "Track",
		artist: "Artist",
		playing: true,
		progressSpan: 5.2,
		positionMs: 42000,
		durationMs: 210000,
		playbackRate: 1.25,
		highBloom: 0.7,
		beatGlow: 0.8,
		beatPulse: 0.9,
		bass: 0.4,
		hasNativeKaraoke: true,
		beatMapKey: "netease:42",
		beatMap: { kicks: [1.2, 2.4] },
	});

	expect(payload.title).toBe("Track");
	expect(payload.artist).toBe("Artist");
	expect(payload.playing).toBe(true);
	expect(payload.progressSpan).toBe(5.2);
	expect(payload.fontFamily).toContain("Source Han Serif SC Heavy");
	expect(payload.fontWeight).toBe(900);
	expect(payload.letterSpacing).toBe(0.12);
	expect(payload.lineHeight).toBe(1.24);
	expect(payload.lyricScale).toBe(1.4);
	expect(payload.feather).toBe(0.03);
	expect(payload.beatMapKey).toBe("netease:42");
	expect(payload.beatMap).toEqual({ kicks: [1.2, 2.4] });
	expect(payload.lyricGlowParticles).toBe(true);
	expect(payload.cinema).toBe(false);
	expect(payload.highlightFollow).toBe(true);
	expect(payload.motion.lyricGlow).toBe(true);
	expect(payload.motion.lyricGlowBeat).toBe(true);
	expect(payload.motion.lyricGlowStrength).toBe(0.52);
	expect(payload.motion.highBloom).toBe(0.7);
	expect(payload.motion.beatGlow).toBe(0.8);
	expect(payload.motion.beatPulse).toBe(0.9);
	expect(payload.motion.bass).toBe(0.4);
	expect(payload.playback.time).toBe(42);
	expect(payload.playback.duration).toBe(210);
	expect(payload.playback.rate).toBe(1.25);
});

test("App custom lyric modal saves text and applies custom lyrics to current track", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "42",
		sourceId: "42",
		title: "Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "unknown",
	});
	usePlaybackStore.getState().setPlaying(false);
	useLyricsStore.getState().setPayload({
		provider: "netease",
		trackId: "42",
		lines: [{ timeMs: 0, text: "Song - Artist", source: "fallback" }],
		hasTranslation: false,
		isWordByWord: false,
	});

	const host = document.createElement("div");
	document.body.appendChild(host);
	let dismissSplash: (() => void) | null = null;
	function MockSplash(props: SplashHostProps) {
		dismissSplash = () => props.onDismissed?.();
		return null;
	}
	function MockVisual() {
		return <div id="visual-host" />;
	}
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={MockSplash} VisualComponent={MockVisual} />));
	flushSync(() => dismissSplash?.());
	await new Promise((resolve) => setTimeout(resolve, 0));
	const customSourceButton = host.querySelector("#lyric-source-custom") as HTMLButtonElement;
	expect(customSourceButton).not.toBeNull();
	customSourceButton.click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.querySelector("#custom-lyric-modal.show")).not.toBeNull();
	const input = host.querySelector("#custom-lyric-input") as HTMLTextAreaElement;
	Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(input, "自定义第一句\n自定义第二句");
	input.dispatchEvent(new window.Event("input", { bubbles: true }));
	input.dispatchEvent(new window.Event("change", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	(host.querySelector("#custom-lyric-save") as HTMLButtonElement).click();

	const saved = JSON.parse(localStorage.getItem(CUSTOM_LYRIC_STORE_KEY) || "{}");
	expect(saved["id:42"].text).toBe("自定义第一句\n自定义第二句");
	expect(JSON.parse(localStorage.getItem(CUSTOM_LYRIC_PREF_STORE_KEY) || "{}")["id:42"]).toBe("custom");
	expect(useLyricsStore.getState().payload?.lines[0]?.text).toBe("自定义第一句");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
});

test("App applies baseline lyric fallback when provider lyric fetch rejects", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "lyric-fail-1",
		sourceId: "lyric-fail-1",
		title: "Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "unknown",
	});

	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", proxied: true };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));

	for (let i = 0; i < 8 && !useLyricsStore.getState().payload?.lines.length; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(useLyricsStore.getState().payload?.lines[0]).toEqual({
		timeMs: 0,
		text: "Song - Artist",
		source: "fallback",
		durationMs: 9999000,
		charCount: 13,
	});
	expect(useLyricsStore.getState().error).toBe("lyric api failed");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App replaces stale lyrics with current track fallback while provider lyric fetch is pending", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	useLyricsStore.getState().setPayload({
		provider: "netease",
		trackId: "old-track",
		lines: [{ timeMs: 0, text: "Old lyric", source: "lrc" }],
		hasTranslation: false,
		isWordByWord: false,
	});
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "pending-lyric-1",
		sourceId: "pending-lyric-1",
		title: "Pending Song",
		artists: ["Pending Artist"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "unknown",
	});

	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", proxied: true };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			return await new Promise(() => undefined);
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));

	for (let i = 0; i < 8 && useLyricsStore.getState().payload?.trackId === "old-track"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(useLyricsStore.getState().payload?.trackId).toBe("pending-lyric-1");
	expect(useLyricsStore.getState().payload?.lines[0]).toEqual({
		timeMs: 0,
		text: "Pending Song - Pending Artist",
		source: "fallback",
		durationMs: 9999000,
		charCount: 29,
	});

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App shows the baseline trial banner when provider returns a trial-only URL", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "trial-1",
		sourceId: "trial-1",
		title: "Trial Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 60000,
		qualityHints: [],
		playableState: "trial_only",
	});

	const fakeClient = {
		async resolveSongUrl() {
			return {
				url: "https://example.com/trial.mp3",
				quality: "标准",
				proxied: false,
				provider: "netease",
				trial: true,
				playable: true,
				loggedIn: false,
				vipLevel: "none",
				reason: "trial_only",
				message: "当前未登录 · 仅播放试听片段",
			};
		},
		audioProxyUrl(url: string) {
			return `http://127.0.0.1:39999/audio-proxy?url=${encodeURIComponent(url)}`;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "trial-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));

	for (let i = 0; i < 12 && !host.querySelector("#trial-banner.show"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const banner = host.querySelector("#trial-banner");
	expect(banner?.classList.contains("show")).toBe(true);
	expect(host.querySelector("#trial-text")?.textContent).toBe("当前未登录 · 仅播放试听片段");
	const loginButton = host.querySelector("#trial-login-btn") as HTMLButtonElement | null;
	expect(loginButton?.style.display).not.toBe("none");
	loginButton?.click();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(host.querySelector("#login-modal")).not.toBeNull();

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App clears the trial banner when the audio element reports a playback error", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "trial-error-1",
		sourceId: "trial-error-1",
		title: "Trial Error Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 60000,
		qualityHints: [],
		playableState: "trial_only",
	});

	const fakeClient = {
		async resolveSongUrl() {
			return {
				url: "https://example.com/trial-error.mp3",
				quality: "标准",
				proxied: false,
				provider: "netease",
				trial: true,
				playable: true,
				loggedIn: false,
				vipLevel: "none",
				reason: "trial_only",
				message: "当前未登录 · 仅播放试听片段",
			};
		},
		audioProxyUrl(url: string) {
			return `http://127.0.0.1:39999/audio-proxy?url=${encodeURIComponent(url)}`;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "trial-error-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));

	for (let i = 0; i < 12 && !host.querySelector("#trial-banner.show"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(host.querySelector("#trial-banner")?.classList.contains("show")).toBe(true);

	appStubAudioInstances[0]?.dispatchEvent(new Event("error"));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.querySelector("#trial-banner")?.classList.contains("show")).toBe(false);

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App resolves playback beatmap and forwards it to visual host", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "beat-1",
		sourceId: "beat-1",
		title: "Beat Song",
		artists: ["Beat Artist"],
		album: "",
		coverUrl: "",
		durationMs: 120000,
		qualityHints: [],
		playableState: "unknown",
		type: "podcast",
		programId: "program-1",
	} as unknown as Track);

	const beatmapCalls: unknown[] = [];
	const map = { cameraBeats: [{ t: 1.2, strength: 0.8 }], analyzedAt: 123, duration: 120, tempoSource: "podcast-dj-offline" };
	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/beat.mp3", quality: "standard", proxied: false };
		},
		audioProxyUrl(url: string) {
			return `http://127.0.0.1:39999/audio-proxy?url=${encodeURIComponent(url)}`;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "beat-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
		async podcastDjBeatmap(url: string, durationSec: number, introSec: number) {
			beatmapCalls.push({ url, durationSec, introSec });
			return { ok: true, map };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	let latestVisualProps: VisualEngineHostProps | null = null;
	function MockVisual(props: VisualEngineHostProps) {
		latestVisualProps = props;
		return <div id="visual-host" />;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={MockVisual} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));

	for (let i = 0; i < 12 && beatmapCalls.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	for (let i = 0; i < 12 && !(latestVisualProps as unknown as { beatMap?: unknown } | null)?.beatMap; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(beatmapCalls).toEqual([
		{ url: "https://example.com/beat.mp3", durationSec: 120, introSec: 0 },
	]);
	expect((latestVisualProps as unknown as { beatMapKey?: string })?.beatMapKey).toBe(desktopLyricsBeatMapKey(map, "dj"));
	expect((latestVisualProps as unknown as { beatMap?: unknown })?.beatMap).toEqual(map);

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App does not run the podcast DJ beatmap analyzer for ordinary songs", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "song-1",
		sourceId: "song-1",
		title: "Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 120000,
		qualityHints: [],
		playableState: "unknown",
	});

	const beatmapCalls: unknown[] = [];
	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/song.mp3", quality: "standard", proxied: false };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "song-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
		async podcastDjBeatmap(url: string) {
			beatmapCalls.push(url);
			return { ok: true, map: { cameraBeats: [1] } };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));

	for (let i = 0; i < 8; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(beatmapCalls).toEqual([]);

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App starts baseline Home private radar from discover songs", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const fakeClient = {
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: true,
				user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
				mode: "member",
				dailySongs: [
					{
						provider: "netease",
						id: "home-1",
						sourceId: "home-1",
						title: "Home One",
						artists: ["Alice"],
						album: "",
						coverUrl: "",
						durationMs: 1000,
						qualityHints: [],
						playableState: "playable",
					},
					{
						provider: "qq",
						id: "home-2",
						sourceId: "home-2",
						title: "Home Two",
						artists: ["Bob"],
						album: "",
						coverUrl: "",
						durationMs: 2000,
						qualityHints: [],
						playableState: "unknown",
					},
				],
				playlists: [],
				podcasts: [],
				updatedAt: 1,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	(host.querySelector('[data-home-card="private"]') as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["home-1", "home-2"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("home-1");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	localStorage.clear();
});

test("App starts baseline Home weather radio from a weather rail song", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const fakeClient = {
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: false,
				user: null,
				mode: "starter",
				dailySongs: [],
				playlists: [],
				podcasts: [],
				updatedAt: 1,
			};
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: {
					provider: "open-meteo",
					location: {
						name: "上海",
						country: "中国",
						admin1: "",
						latitude: 31.23,
						longitude: 121.47,
						timezone: "Asia/Shanghai",
						fallback: false,
					},
					label: "雨",
					weatherCode: 61,
					temperature: 22,
					apparentTemperature: 21,
					humidity: 88,
					precipitation: 1,
					cloudCover: 90,
					windSpeed: 6,
					windGusts: 10,
					isDay: 1,
					time: "",
					updatedAt: 1,
					error: "",
					mood: {
						key: "rain",
						title: "雨天电台",
						tagline: "留一点潮湿的空间给旋律",
						energy: 0.38,
						warmth: 0.42,
						focus: 0.64,
						melancholy: 0.66,
						keywords: ["雨天 R&B"],
					},
				},
				radio: {
					title: "雨天电台",
					subtitle: "留一点潮湿的空间给旋律",
					seedQueries: ["雨天 R&B"],
					songs: [
						{
							provider: "netease",
							id: "rain-1",
							sourceId: "rain-1",
							title: "Rain One",
							artists: ["Alice"],
							album: "",
							coverUrl: "",
							durationMs: 1000,
							qualityHints: [],
							playableState: "playable",
						},
						{
							provider: "qq",
							id: "rain-2",
							sourceId: "rain-2",
							title: "Rain Two",
							artists: ["Bob"],
							album: "",
							coverUrl: "",
							durationMs: 2000,
							qualityHints: [],
							playableState: "unknown",
						},
					],
					updatedAt: 1,
				},
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	const weatherTile = Array.from(host.querySelectorAll(".home-tile"))
		.find((button) => button.textContent?.includes("Rain Two")) as HTMLButtonElement;
	weatherTile.click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["rain-1", "rain-2"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("rain-2");
	expect(host.querySelector("#toast.show")?.textContent).toContain("雨天电台 · 2 首");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	localStorage.clear();
});

test("App imports a local audio file from the baseline Home import tile", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const oldCreateObjectUrl = URL.createObjectURL;
	const created: unknown[] = [];
	URL.createObjectURL = ((file: unknown) => {
		created.push(file);
		return "blob:local-song";
	}) as typeof URL.createObjectURL;

	const fakeClient = {
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: false,
				user: null,
				mode: "starter",
				dailySongs: [],
				playlists: [],
				podcasts: [],
				updatedAt: 1,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const tile = Array.from(host.querySelectorAll(".home-tile"))
			.find((button) => button.textContent?.includes("导入本地音乐")) as HTMLButtonElement;
		tile.click();
		const input = host.querySelector("#file-input") as HTMLInputElement;
		expect(input.accept).toBe(".mp3,.flac,.wav,.ogg,.m4a,.jpg,.jpeg,.png,.webp");

		const file = new File(["audio"], "Local Song.mp3", { type: "audio/mpeg", lastModified: 123 });
		Object.defineProperty(input, "files", { value: [file], configurable: true });
		input.dispatchEvent(new window.Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(created).toEqual([file]);
		expect(usePlaybackStore.getState().queue.map((track) => track.title)).toEqual(["Local Song"]);
		expect(usePlaybackStore.getState().currentTrack?.title).toBe("Local Song");
		expect(usePlaybackStore.getState().currentTrack?.artists).toEqual(["本地文件"]);
	} finally {
		URL.createObjectURL = oldCreateObjectUrl;
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		localStorage.clear();
	}
});

test("App opens the baseline collect picker for shelf detail collect and adds only after a playlist is chosen", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const added: unknown[] = [];
	const fakeClient = {
		async playlistList(provider: string) {
			if (provider === "netease") {
				return [
					{ provider: "netease", id: "mine-1", name: "我的歌单", coverUrl: "mine.jpg", trackCount: 12, trackIds: [] },
					{ provider: "netease", id: "sub-1", name: "收藏来的歌单", coverUrl: "", trackCount: 4, trackIds: [], subscribed: true },
				];
			}
			return [
				{ provider: "qq", id: "qq-1", name: "QQ 收藏", coverUrl: "", trackCount: 2, trackIds: [] },
			];
		},
		async addSongToPlaylist(provider: string, playlistId: string, trackId: string) {
			added.push({ provider, playlistId, trackId });
			return { provider, playlistId, trackId, code: 200 };
		},
	} as unknown as SidecarClient;

	let triggerCollect: (() => void) | null = null;
	function MockVisual(props: VisualEngineHostProps) {
		triggerCollect = () => props.onShelfDetailRowClick?.({
			index: 0,
			action: "collect",
			row: {
				id: "song-1",
				name: "First Song",
				artist: "Alice",
				cover: "cover.jpg",
				provider: "netease",
				type: "playable",
				sourceId: "song-1",
				title: "First Song",
				artists: ["Alice"],
				album: "",
				coverUrl: "cover.jpg",
				playableState: "playable",
				qualityHints: [],
			},
		});
		return <div id="visual-host" />;
	}
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={MockVisual} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	flushSync(() => triggerCollect?.());
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.querySelector("#collect-modal.show")).not.toBeNull();
	expect(host.querySelector("#collect-current")?.textContent).toContain("First Song");
	expect(host.querySelector("#collect-list")?.textContent).toContain("我的歌单");
	expect(host.querySelector("#collect-list")?.textContent).not.toContain("收藏来的歌单");
	expect(host.querySelector("#collect-list")?.textContent).not.toContain("QQ 收藏");
	expect(added).toEqual([]);

	(host.querySelector('[data-collect-pid="mine-1"]') as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(added).toEqual([{ provider: "netease", playlistId: "mine-1", trackId: "song-1" }]);
	expect(host.querySelector("#collect-modal.show")).toBeNull();

	root.unmount();
	host.remove();
	localStorage.clear();
});

test("App opens the collect picker for QQ detail rows and filters to writable QQ playlists", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const added: unknown[] = [];
	const fakeClient = {
		async playlistList(provider: string) {
			if (provider === "netease") {
				return [
					{ provider: "netease", id: "ne-1", name: "网易云歌单", coverUrl: "", trackCount: 1, trackIds: [] },
				];
			}
			return [
				{ provider: "qq", id: "qq-mine", name: "QQ 自建", coverUrl: "", trackCount: 5, trackIds: [] },
				{ provider: "qq", id: "qq-sub", name: "QQ 收藏来的歌单", coverUrl: "", trackCount: 7, trackIds: [], subscribed: true },
			];
		},
		async addSongToPlaylist(provider: string, playlistId: string, trackId: string) {
			added.push({ provider, playlistId, trackId });
			return { provider, playlistId, trackId, code: 100, success: true };
		},
	} as unknown as SidecarClient;

	let triggerCollect: (() => void) | null = null;
	function MockVisual(props: VisualEngineHostProps) {
		triggerCollect = () => props.onShelfDetailRowClick?.({
			index: 0,
			action: "collect",
			row: {
				id: "qq-song-1",
				name: "QQ Song",
				artist: "Bob",
				cover: "",
				provider: "qq",
				type: "playable",
				sourceId: "qq-song-1",
				title: "QQ Song",
				artists: ["Bob"],
				album: "",
				coverUrl: "",
				playableState: "playable",
				qualityHints: [],
			},
		});
		return <div id="visual-host" />;
	}
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={MockVisual} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	flushSync(() => triggerCollect?.());
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.querySelector("#collect-modal.show")).not.toBeNull();
	expect(host.querySelector("#collect-current")?.textContent).toContain("QQ Song");
	expect(host.querySelector("#collect-list")?.textContent).toContain("QQ 自建");
	expect(host.querySelector("#collect-list")?.textContent).not.toContain("QQ 收藏来的歌单");
	expect(host.querySelector("#collect-list")?.textContent).not.toContain("网易云歌单");
	expect(added).toEqual([]);

	(host.querySelector('[data-collect-pid="qq-mine"]') as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(added).toEqual([{ provider: "qq", playlistId: "qq-mine", trackId: "qq-song-1" }]);
	expect(host.querySelector("#collect-modal.show")).toBeNull();

	root.unmount();
	host.remove();
	localStorage.clear();
});

test("App checks current Netease like state and wires bottom heart mutations through sidecar", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "like-current-1",
		sourceId: "like-current-1",
		title: "Like Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	const checked: string[][] = [];
	const likedCalls: Array<{ provider: string; id: string; liked: boolean }> = [];
	const fakeClient = {
		async checkSongLikes(_provider: string, ids: string[]) {
			checked.push(ids);
			return { provider: "netease", ids, liked: { "like-current-1": true } };
		},
		async likeSong(provider: string, id: string, liked: boolean) {
			likedCalls.push({ provider, id, liked });
			return { provider, id, liked, code: 200 };
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", proxied: true };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));

	for (let i = 0; i < 8 && checked.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(checked).toEqual([["like-current-1"]]);
	for (let i = 0; i < 8 && !host.querySelector("#heart-btn")?.className.includes("liked"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const heart = host.querySelector("#heart-btn") as HTMLButtonElement;
	expect(heart.className).toContain("liked");
	expect(heart.getAttribute("aria-pressed")).toBe("true");

	heart.click();
	for (let i = 0; i < 8 && likedCalls.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(likedCalls).toEqual([{ provider: "netease", id: "like-current-1", liked: false }]);
	for (let i = 0; i < 8 && !host.querySelector("#toast.show")?.textContent?.includes("已取消红心"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(host.querySelector("#toast.show")?.textContent).toContain("已取消红心");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App shows QQ unsupported notice for bottom heart without calling like mutation", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "qq",
		id: "qq-like-unsupported",
		sourceId: "qq-like-unsupported",
		title: "QQ Song",
		artists: ["Bob"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	let likeCalled = 0;
	const fakeClient = {
		async checkSongLikes() {
			throw new Error("QQ should not run like check");
		},
		async likeSong() {
			likeCalled += 1;
			throw new Error("QQ should not run like mutation");
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", proxied: true };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#heart-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !host.querySelector("#toast.show")?.textContent?.includes("QQ 音乐红心同步待登录接口接入"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(likeCalled).toBe(0);
	expect(host.querySelector("#toast.show")?.textContent).toContain("QQ 音乐红心同步待登录接口接入");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App rolls back bottom heart state and shows baseline failure copy when Netease like fails", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "like-fail-1",
		sourceId: "like-fail-1",
		title: "Fail Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	const fakeClient = {
		async checkSongLikes(_provider: string, ids: string[]) {
			return { provider: "netease", ids, liked: { "like-fail-1": false } };
		},
		async likeSong() {
			throw new Error("like failed");
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", proxied: true };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#heart-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !host.querySelector("#toast.show")?.textContent?.includes("红心操作失败"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const heart = host.querySelector("#heart-btn") as HTMLButtonElement;
	expect(host.querySelector("#toast.show")?.textContent).toContain("红心操作失败");
	expect(heart.getAttribute("aria-pressed")).toBe("false");
	expect(heart.className).not.toContain("liked");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App opens login modal when Netease heart mutation requires login", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "like-login-required",
		sourceId: "like-login-required",
		title: "Login Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	const fakeClient = {
		async checkSongLikes(_provider: string, ids: string[]) {
			return { provider: "netease", ids, liked: { "like-login-required": false } };
		},
		async likeSong() {
			throw new SidecarClientError({
				code: "LOGIN_REQUIRED",
				message: "login required",
				provider: "netease",
				retryable: false,
				action: "login",
			});
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", proxied: true };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} createSidecarClient={() => fakeClient} initialRuntimeConfig={rootConfig} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#heart-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !host.querySelector("#login-modal"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#toast.show")?.textContent).toContain("登录后可同步到网易云");
	expect(host.querySelector("#login-modal")).not.toBeNull();
	expect(host.querySelector("#heart-btn")?.className).not.toContain("liked");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

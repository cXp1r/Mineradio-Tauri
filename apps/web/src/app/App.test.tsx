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
	isHomeBlankDismissElement,
	shouldUseSecondaryLeftDisplaySeamGuard,
	shouldShowEmptyHome,
} from "./App";
import type { SplashHostProps } from "../visual/SplashHost";
import type { SidecarStatus, RuntimeConfig } from "../tauri/runtime";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { CUSTOM_LYRIC_PREF_STORE_KEY, CUSTOM_LYRIC_STORE_KEY } from "../lyrics/custom-lyrics";
import type { SidecarClient } from "../api/sidecar-client";
import type { VisualEngineHostProps } from "../visual/VisualEngineHost";
import { cloneFxState } from "@mineradio/visual-engine";

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

function installAppStubAudio(): () => void {
	const previousWindowAudio = (window as unknown as { Audio?: typeof Audio }).Audio;
	const hadGlobalAudio = "Audio" in globalThis;
	const previousGlobalAudio = (globalThis as unknown as { Audio?: typeof Audio }).Audio;
	const hadGlobalHtmlAudioElement = "HTMLAudioElement" in globalThis;
	const previousGlobalHtmlAudioElement = (globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement;
	const AudioCtor = AppStubAudioElement as unknown as typeof Audio;
	(window as unknown as { Audio?: typeof Audio }).Audio = AudioCtor;
	(globalThis as unknown as { Audio?: typeof Audio }).Audio = AudioCtor;
	(globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement = AppStubAudioElement as unknown as typeof HTMLAudioElement;
	return () => {
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

test("App starts weather radio from the Home private radio card by replacing the queue and playing the first song", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const fakeClient = {
		async playlistList() {
			return [];
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
	(host.querySelector('[data-home-radio-start="true"]') as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["rain-1", "rain-2"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("rain-1");
	expect(host.querySelector("#toast.show")?.textContent).toContain("雨天电台 · 2 首");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	localStorage.clear();
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

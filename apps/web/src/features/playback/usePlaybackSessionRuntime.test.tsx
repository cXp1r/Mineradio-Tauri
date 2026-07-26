import { expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { LyricPayload, Track } from "@mineradio/shared";
import {
	PlayerController,
	type ErrorPayload,
	type MediaEventPayload,
	type TimeUpdatePayload,
} from "../../audio/player-controller";
import type { AppServices } from "../../app/app-services";
import { usePlaybackStore } from "../../stores/playback-store";
import { PlaybackSessionCoordinator } from "./playback-session-coordinator";
import {
	usePlaybackSessionRuntime,
	type PlaybackSessionRuntimeResult,
} from "./usePlaybackSessionRuntime";
import { usePlaybackUiController } from "./usePlaybackUiController";

const TRACK: Track = {
	provider: "netease",
	id: "session-1",
	sourceId: "session-1",
	title: "Session Song",
	artists: ["Session Artist"],
	album: "",
	coverUrl: "",
	durationMs: 60_000,
	qualityHints: [],
	playableState: "unknown",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function mediaEventPayload(
	loadContext: object | null,
	sourceUrl = "https://media.example/test.mp3",
): MediaEventPayload {
	return { loadContext, sourceUrl };
}

function errorEventPayload(
	loadContext: object | null,
	message: string,
	sourceUrl = "https://media.example/test.mp3",
): ErrorPayload {
	return { ...mediaEventPayload(loadContext, sourceUrl), code: 2, message };
}

class RuntimeAudioElement extends EventTarget {
	currentTime = 0;
	duration = 60;
	src = "";
	currentSrc = "";
	crossOrigin: string | null = null;
	volume = 1;
	paused = true;
	error: { code: number; message: string } | null = null;
	loadCalled = 0;
	playCalled = 0;
	private resolvePendingPlay!: () => void;
	private readonly pendingPlay = new Promise<void>((resolve) => {
		this.resolvePendingPlay = resolve;
	});

	load(): void {
		this.loadCalled += 1;
	}

	play(): Promise<void> {
		this.playCalled += 1;
		this.paused = false;
		return this.playCalled === 1 ? Promise.resolve() : this.pendingPlay;
	}

	pause(): void {
		this.paused = true;
	}

	releasePendingPlay(): void {
		this.resolvePendingPlay();
	}
}

function asHtmlAudioElement(audio: RuntimeAudioElement): HTMLAudioElement {
	return audio as unknown as HTMLAudioElement;
}

function resetPlaybackStore(): void {
	usePlaybackStore.setState({
		currentTrack: null,
		playbackIntentId: 0,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		volume: 0.84,
		muted: false,
		mode: "loop",
		queue: [],
	});
}

test("a newer playback intent for the same track rejects the stale URL result", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const firstUrl = deferred<{
		url: string;
		quality: string;
		proxied: boolean;
		trial: boolean;
		loggedIn: boolean;
		message: string;
	}>();
	const secondUrl = deferred<{
		url: string;
		quality: string;
		proxied: boolean;
		trial: boolean;
		loggedIn: boolean;
		message: string;
	}>();
	const loadedUrls: string[] = [];
	let playCount = 0;
	let resolveCount = 0;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string) {
			loadedUrls.push(url);
		},
		seek() {},
		async play() {
			playCount += 1;
		},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return await (resolveCount === 1 ? firstUrl.promise : secondUrl.promise);
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness({ playbackIntentId }: { playbackIntentId: number }) {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness playbackIntentId={1} />));
	for (let i = 0; i < 8 && resolveCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	flushSync(() => root.render(<Harness playbackIntentId={2} />));
	for (let i = 0; i < 8 && resolveCount < 2; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(resolveCount).toBe(2);
	firstUrl.resolve({
		url: "https://media.example/stale-intent.mp3",
		quality: "standard",
		proxied: false,
		trial: true,
		loggedIn: false,
		message: "stale intent banner",
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(loadedUrls).toEqual([]);
	expect(playCount).toBe(0);
	expect(runtimeRef.current?.trialBanner).toBeNull();

	secondUrl.resolve({
		url: "https://media.example/current-intent.mp3",
		quality: "standard",
		proxied: false,
		trial: true,
		loggedIn: false,
		message: "current intent banner",
	});
	for (let i = 0; i < 8 && playCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(loadedUrls).toEqual(["https://media.example/current-intent.mp3"]);
	expect(playCount).toBe(1);
	expect(runtimeRef.current?.trialBanner?.text).toBe("current intent banner");

	root.unmount();
	host.remove();
});

test("a quality change claims a new load in the current playback intent", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const loads: Array<{ url: string; loadContext: object | null }> = [];
	const requestedQualities: string[] = [];
	let playCount = 0;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loads.push({ url, loadContext: loadContext ?? null });
		},
		seek() {},
		async play() {
			playCount += 1;
		},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(_track: Track, quality: string) {
					requestedQualities.push(quality);
					return {
						url: `https://media.example/quality-${quality}.mp3`,
						quality,
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && (loads.length < 1 || playCount < 1); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	flushSync(() => runtimeRef.current!.setPlaybackQuality("flac"));
	for (let i = 0; i < 8 && (loads.length < 2 || playCount < 2); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const firstHandle = loads[0]!.loadContext as {
		playbackSessionId: number;
		playbackToken: number;
		reloadReason?: string;
	};
	const qualityHandle = loads[1]!.loadContext as {
		playbackSessionId: number;
		playbackToken: number;
		reloadReason?: string;
	};
	expect(requestedQualities).toEqual(["standard", "flac"]);
	expect(loads.map((load) => load.url)).toEqual([
		"https://media.example/quality-standard.mp3",
		"https://media.example/quality-flac.mp3",
	]);
	expect(qualityHandle.playbackSessionId).toBe(firstHandle.playbackSessionId);
	expect(qualityHandle.playbackToken).toBeGreaterThan(firstHandle.playbackToken);
	expect(qualityHandle.reloadReason).toBe("quality");
	expect(playCount).toBe(2);

	root.unmount();
	host.remove();
});

test("lifecycle handlers forward only the authoritative load and end it once", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const loads: Array<{ url: string; loadContext: object | null }> = [];
	const timeUpdates: TimeUpdatePayload[] = [];
	const durationChanges: TimeUpdatePayload[] = [];
	let endedCount = 0;
	let resolveCount = 0;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loads.push({ url, loadContext: loadContext ?? null });
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return {
						url: `https://media.example/lifecycle-${resolveCount}.mp3`,
						quality: "standard",
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness({ playbackIntentId }: { playbackIntentId: number }) {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
			onRuntimeTimeUpdate: (payload) => timeUpdates.push(payload),
			onRuntimeDurationChange: (payload) => durationChanges.push(payload),
			onRuntimeEnded: () => {
				endedCount += 1;
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness playbackIntentId={1} />));
	for (let i = 0; i < 8 && loads.length < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const firstHandlers = runtimeRef.current!;
	const staleLoadContext = loads[0]!.loadContext;

	flushSync(() => root.render(<Harness playbackIntentId={2} />));
	for (
		let i = 0;
		i < 8 && (loads.length < 2 || coordinator.snapshot().phase !== "playing");
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const currentHandlers = runtimeRef.current!;
	const currentLoadContext = loads[1]!.loadContext;
	const forgedLoadContext = { ...(currentLoadContext as Record<string, unknown>) };
	const currentSourceUrl = loads[1]!.url;

	expect(typeof currentHandlers.handleRuntimeTimeUpdate).toBe("function");
	expect(typeof currentHandlers.handleRuntimeDurationChange).toBe("function");
	expect(typeof currentHandlers.handleRuntimeEnded).toBe("function");
	expect(currentHandlers.handleRuntimeTimeUpdate).toBe(firstHandlers.handleRuntimeTimeUpdate);
	expect(currentHandlers.handleRuntimeDurationChange).toBe(firstHandlers.handleRuntimeDurationChange);
	expect(currentHandlers.handleRuntimeEnded).toBe(firstHandlers.handleRuntimeEnded);

	const currentTimeUpdate: TimeUpdatePayload = {
		...mediaEventPayload(currentLoadContext, currentSourceUrl),
		positionMs: 12_345,
		durationMs: 60_000,
	};
	const currentDurationChange: TimeUpdatePayload = {
		...mediaEventPayload(currentLoadContext, currentSourceUrl),
		positionMs: 12_345,
		durationMs: 61_000,
	};
	for (const loadContext of [null, staleLoadContext, forgedLoadContext]) {
		currentHandlers.handleRuntimeTimeUpdate({
			...currentTimeUpdate,
			loadContext,
		});
		currentHandlers.handleRuntimeDurationChange({
			...currentDurationChange,
			loadContext,
		});
		currentHandlers.handleRuntimeEnded(mediaEventPayload(loadContext, currentSourceUrl));
	}
	currentHandlers.handleRuntimeTimeUpdate(currentTimeUpdate);
	currentHandlers.handleRuntimeDurationChange(currentDurationChange);

	expect(timeUpdates).toEqual([currentTimeUpdate]);
	expect(timeUpdates[0]).toBe(currentTimeUpdate);
	expect(durationChanges).toEqual([currentDurationChange]);
	expect(durationChanges[0]).toBe(currentDurationChange);
	expect(endedCount).toBe(0);
	expect(coordinator.snapshot().phase).toBe("playing");

	const currentEnded = mediaEventPayload(currentLoadContext, currentSourceUrl);
	currentHandlers.handleRuntimeEnded(currentEnded);
	currentHandlers.handleRuntimeEnded(currentEnded);

	expect(endedCount).toBe(1);
	expect(coordinator.snapshot().phase).toBe("ended");

	root.unmount();
	host.remove();
});

test("single-mode ended starts exactly one replacement load and play", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	resetPlaybackStore();
	const store = usePlaybackStore.getState();
	store.setMode("single");
	store.setQueue([TRACK]);
	store.playAt(0);

	const loads: Array<{ url: string; loadContext: object | null }> = [];
	const seekPositions: number[] = [];
	let playCount = 0;
	let resolveCount = 0;
	let finalizedCount = 0;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loads.push({ url, loadContext: loadContext ?? null });
		},
		seek(positionMs: number) {
			seekPositions.push(positionMs);
		},
		async play() {
			playCount += 1;
		},
		pause() {},
	} as unknown as PlayerController;
	const controllerRef = { current: controller as PlayerController | null };
	const lyricsPayloadRef = { current: null as LyricPayload | null };
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return {
						url: `https://media.example/single-${resolveCount}.mp3`,
						quality: "standard",
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;
	const noOp = () => undefined;

	function Harness() {
		const currentTrack = usePlaybackStore((state) => state.currentTrack);
		const playbackIntentId = usePlaybackStore((state) => state.playbackIntentId);
		const positionMs = usePlaybackStore((state) => state.positionMs);
		const playbackMode = usePlaybackStore((state) => state.mode);
		const setPlaying = usePlaybackStore((state) => state.setPlaying);
		const setPositionMs = usePlaybackStore((state) => state.setPosition);
		const setDurationMs = usePlaybackStore((state) => state.setDuration);
		const setPlaybackMode = usePlaybackStore((state) => state.setMode);
		const setQueue = usePlaybackStore((state) => state.setQueue);
		const clearQueue = usePlaybackStore((state) => state.clearQueue);
		const rawLifecycle = usePlaybackUiController({
			controllerRef,
			lyricsPayloadRef,
			playbackMode,
			setPositionMs,
			setDurationMs,
			setLyricsIndex: noOp,
			setMiniQueue: noOp,
			insertQueueNext: noOp,
			setPlaybackMode,
			setQueue,
			clearQueue,
			recordListenProgress: noOp,
			finalizeListenSession: () => {
				finalizedCount += 1;
			},
			enterPlaybackSurface: noOp,
			setHomeForcedOpen: noOp,
			setHomeSuppressed: noOp,
			clearCurrentBeatMap: noOp,
			applyCustomCoverImage: async () => undefined,
			showToast: noOp,
		});
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef,
			localAudioUrlsRef: rawLifecycle.localAudioUrlsRef,
			currentTrack,
			playbackIntentId,
			positionMs,
			getPlaybackSnapshot: () => {
				const snapshot = usePlaybackStore.getState();
				return {
					currentTrack: snapshot.currentTrack,
					positionMs: snapshot.positionMs,
					durationMs: snapshot.durationMs,
					isPlaying: snapshot.isPlaying,
				};
			},
			setPlaying,
			setPositionMs,
			togglePlayFallback: noOp,
			setSearchError: noOp,
			showToast: noOp,
			setHomeForcedOpen: noOp,
			setHomeSuppressed: noOp,
			setLyricsPayload: noOp,
			setLyricsLoading: noOp,
			setLyricsError: noOp,
			resetLyrics: noOp,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: noOp,
			onRuntimeTimeUpdate: rawLifecycle.handleRuntimeTimeUpdate,
			onRuntimeDurationChange: rawLifecycle.handleRuntimeDurationChange,
			onRuntimeEnded: rawLifecycle.handleRuntimeEnded,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && (loads.length < 1 || playCount < 1); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	flushSync(() => {
		runtimeRef.current!.handleRuntimeEnded(
			mediaEventPayload(loads[0]!.loadContext, loads[0]!.url),
		);
	});
	for (let i = 0; i < 8 && (loads.length < 2 || playCount < 2); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(finalizedCount).toBe(1);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
	expect(loads.map((load) => load.url)).toEqual([
		"https://media.example/single-1.mp3",
		"https://media.example/single-2.mp3",
	]);
	expect(playCount).toBe(2);
	expect(seekPositions).toEqual([]);

	root.unmount();
	host.remove();
	resetPlaybackStore();
});

test("the playback session publishes fallback lyrics before loading and resuming remote audio", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const events: string[] = [];
	const lyricPayloads: LyricPayload[] = [];
	const controller = {
		load(url: string) {
			events.push(`load:${url}`);
		},
		seek(positionMs: number) {
			events.push(`seek:${positionMs}`);
		},
		async play() {
			events.push("play");
		},
		pause() {
			events.push("pause");
		},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					return {
						url: "https://media.example/session-1.mp3",
						quality: "standard",
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl(url: string) {
				return `http://127.0.0.1/audio-proxy?url=${encodeURIComponent(url)}`;
			},
			playableUrl(url: string) {
				return url;
			},
		},
	} as unknown as AppServices;
	let latest: PlaybackSessionRuntimeResult | null = null;

	function Harness() {
		latest = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 1_234,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 1_234,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: (open) => events.push(`home-forced:${open}`),
			setHomeSuppressed: (suppressed) => events.push(`home-suppressed:${suppressed}`),
			setLyricsPayload: (payload) => lyricPayloads.push(payload),
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));

	for (let i = 0; i < 12 && !events.includes("play"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(latest).not.toBeNull();
	expect(lyricPayloads[0]?.trackId).toBe("session-1");
	expect(lyricPayloads[0]?.lines[0]?.text).toBe("Session Song - Session Artist");
	expect(events).toEqual([
		`load:http://127.0.0.1/audio-proxy?url=${encodeURIComponent("https://media.example/session-1.mp3")}`,
		"seek:1234",
		"play",
		"home-forced:false",
		"home-suppressed:true",
	]);

	root.unmount();
	host.remove();
});

test("a controller load failure marks the accepted source as terminally failed", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const searchErrors: string[] = [];
	const toasts: string[] = [];
	const playing: boolean[] = [];
	const controller = {
		load() {
			throw new Error("controller load failed");
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					return {
						url: "https://media.example/load-failure.mp3",
						quality: "standard",
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: (value) => playing.push(value),
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: (message) => searchErrors.push(message),
			showToast: (message) => toasts.push(message),
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 12 && coordinator.snapshot().phase !== "failed"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(coordinator.snapshot().phase).toBe("failed");
	expect(coordinator.snapshot().failureReason).toBe("controller load failed");
	expect(playing.at(-1)).toBe(false);
	expect(searchErrors).toEqual(["controller load failed"]);
	expect(toasts).toEqual(["controller load failed"]);

	root.unmount();
	host.remove();
});

test("a controller play rejection marks the accepted source as terminally failed", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const searchErrors: string[] = [];
	const toasts: string[] = [];
	const controller = {
		load() {},
		seek() {},
		async play() {
			throw new Error("controller play failed");
		},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					return {
						url: "https://media.example/play-failure.mp3",
						quality: "standard",
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: (message) => searchErrors.push(message),
			showToast: (message) => toasts.push(message),
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 12 && coordinator.snapshot().phase !== "failed"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(coordinator.snapshot().phase).toBe("failed");
	expect(coordinator.snapshot().failureReason).toBe("controller play failed");
	expect(searchErrors).toEqual(["controller play failed"]);
	expect(toasts).toEqual(["controller play failed"]);

	root.unmount();
	host.remove();
});

test("a stale lyric response cannot replace the next track fallback", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const firstLyric = deferred<LyricPayload>();
	const lyricPayloads: LyricPayload[] = [];
	const secondTrack: Track = {
		...TRACK,
		id: "session-2",
		sourceId: "session-2",
		title: "Second Song",
		artists: ["Second Artist"],
	};
	const controller = {
		load() {},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					return {
						url: `https://media.example/${track.id}.mp3`,
						quality: "standard",
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric(track: Track) {
					if (track.id === TRACK.id) return await firstLyric.promise;
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;
	let activeTrack = TRACK;

	function Harness({ track }: { track: Track }) {
		activeTrack = track;
		usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: track,
			playbackIntentId: track.id === TRACK.id ? 1 : 2,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: activeTrack,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: (payload) => lyricPayloads.push(payload),
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness track={TRACK} />));
	for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync(() => root.render(<Harness track={secondTrack} />));
	for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

	firstLyric.resolve({
		provider: "netease",
		trackId: TRACK.id,
		lines: [{ timeMs: 0, text: "Stale lyric", source: "lrc" }],
		hasTranslation: false,
		isWordByWord: false,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(lyricPayloads.at(-1)?.trackId).toBe(secondTrack.id);
	expect(lyricPayloads.at(-1)?.lines[0]?.text).toBe("Second Song - Second Artist");

	root.unmount();
	host.remove();
});

test("old controller events stay silent while the next track URL is pending", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const pendingSecondUrl = deferred<{
		url: string;
		quality: string;
		proxied: boolean;
	}>();
	const secondTrack: Track = {
		...TRACK,
		id: "session-pending",
		sourceId: "session-pending",
		title: "Pending Song",
	};
	const playing: boolean[] = [];
	const searchErrors: string[] = [];
	const toasts: string[] = [];
	let runtimePauseCount = 0;
	let loadCount = 0;
	let loadedContext: object | null = null;
	let loadedSourceUrl = "";
	let secondResolveStarted = false;
	let activeTrack = TRACK;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loadCount += 1;
			loadedContext = loadContext ?? null;
			loadedSourceUrl = url;
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					if (track.id === secondTrack.id) {
						secondResolveStarted = true;
						return await pendingSecondUrl.promise;
					}
					return {
						url: `https://media.example/${track.id}.mp3`,
						quality: "standard",
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric(track: Track) {
					return {
						provider: track.provider,
						trackId: track.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness({ track }: { track: Track }) {
		activeTrack = track;
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: track,
			playbackIntentId: track.id === TRACK.id ? 1 : 2,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: activeTrack,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: (value) => playing.push(value),
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: (message) => searchErrors.push(message),
			showToast: (message) => toasts.push(message),
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
			onRuntimePause: () => {
				runtimePauseCount += 1;
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness track={TRACK} />));
	for (let i = 0; i < 12 && coordinator.snapshot().phase !== "playing"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const firstSessionId = coordinator.snapshot().playbackSessionId;
	const oldEvents = {
		play: runtimeRef.current!.handleRuntimePlay,
		pause: runtimeRef.current!.handleRuntimePause,
		error: runtimeRef.current!.handleRuntimeError,
	};
	const oldLoadContext = loadedContext;
	const oldSourceUrl = loadedSourceUrl;
	flushSync(() => root.render(<Harness track={secondTrack} />));
	for (
		let i = 0;
		i < 12 &&
		(!secondResolveStarted ||
			coordinator.snapshot().playbackSessionId === firstSessionId);
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const resolving = coordinator.snapshot();
	const playingCount = playing.length;
	expect(resolving.phase).toBe("resolving");
	expect(resolving.trackKey).toBe(`${secondTrack.provider}:${secondTrack.id}`);
	expect(secondResolveStarted).toBe(true);
	expect(loadCount).toBe(1);

	oldEvents.play(mediaEventPayload(oldLoadContext, oldSourceUrl));
	oldEvents.pause(mediaEventPayload(oldLoadContext, oldSourceUrl));
	oldEvents.error(errorEventPayload(oldLoadContext, "old media failed", oldSourceUrl));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(coordinator.snapshot()).toBe(resolving);
	expect(loadCount).toBe(1);
	expect(playing.length).toBe(playingCount);
	expect(runtimePauseCount).toBe(0);
	expect(searchErrors).toEqual([]);
	expect(toasts).toEqual([]);

	root.unmount();
	host.remove();
});

test("native events are accepted only after currentSrc matches the newly loaded source", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const audio = new RuntimeAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(audio));
	const controllerRef = { current: controller as PlayerController | null };
	const localAudioUrlsRef = { current: new Map<string, string>() };
	const recoveryUrl = deferred<{
		url: string;
		quality: string;
		proxied: boolean;
	}>();
	const secondTrack: Track = {
		...TRACK,
		id: "session-bound",
		sourceId: "session-bound",
		title: "Bound Song",
	};
	const playing: boolean[] = [];
	const searchErrors: string[] = [];
	const toasts: string[] = [];
	let resolveCount = 0;
	let activeTrack = TRACK;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					resolveCount += 1;
					if (resolveCount >= 3) return await recoveryUrl.promise;
					return {
						url: `https://media.example/${track.id}.mp3`,
						quality: "standard",
						proxied: false,
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness({ track }: { track: Track }) {
		activeTrack = track;
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef,
			localAudioUrlsRef,
			currentTrack: track,
			playbackIntentId: track.id === TRACK.id ? 1 : 2,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: activeTrack,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: (value) => playing.push(value),
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: (message) => searchErrors.push(message),
			showToast: (message) => toasts.push(message),
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness track={TRACK} />));
	for (let i = 0; i < 12 && coordinator.snapshot().phase !== "playing"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	audio.currentSrc = audio.src;
	const firstSourceUrl = audio.currentSrc;
	const unsubscribe = [
		controller.on("play", (payload) => runtimeRef.current?.handleRuntimePlay(payload)),
		controller.on("error", (payload) => runtimeRef.current?.handleRuntimeError(payload)),
	];

	flushSync(() => root.render(<Harness track={secondTrack} />));
	for (
		let i = 0;
		i < 12 &&
		(audio.playCalled < 2 ||
			audio.src === firstSourceUrl ||
			coordinator.snapshot().phase !== "loading");
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const newSourceUrl = audio.src;
	const loading = coordinator.snapshot();
	const playingCount = playing.length;
	const resolveCountBeforeOldEvents = resolveCount;
	audio.error = { code: 2, message: "late old source event" };

	audio.dispatchEvent(new Event("play"));
	audio.dispatchEvent(new Event("error"));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(audio.currentSrc).toBe(firstSourceUrl);
	expect(newSourceUrl).not.toBe(firstSourceUrl);
	expect(coordinator.snapshot()).toBe(loading);
	expect(playing.length).toBe(playingCount);
	expect(resolveCount).toBe(resolveCountBeforeOldEvents);
	expect(searchErrors).toEqual([]);
	expect(toasts).toEqual([]);

	audio.currentSrc = newSourceUrl;
	audio.dispatchEvent(new Event("play"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(coordinator.snapshot().phase).toBe("playing");
	expect(playing.at(-1)).toBe(true);
	const acceptedPlaying = coordinator.snapshot();

	audio.error = { code: 2, message: "current source event" };
	audio.dispatchEvent(new Event("error"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(resolveCount).toBe(3);
	expect(coordinator.snapshot()).not.toBe(acceptedPlaying);
	expect(coordinator.snapshot().phase).toBe("recovering");

	audio.releasePendingPlay();
	recoveryUrl.resolve({
		url: "https://media.example/session-bound-recovery.mp3",
		quality: "standard",
		proxied: false,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (const off of unsubscribe) off();
	root.unmount();
	host.remove();
});

test("repeated media errors start at most one automatic source recovery", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let resolveCount = 0;
	let loadCount = 0;
	let loadedContext: object | null = null;
	let loadedSourceUrl = "";
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = { current: null };
	const controller = {
		load(url: string, loadContext?: object) {
			loadCount += 1;
			loadedContext = loadContext ?? null;
			loadedSourceUrl = url;
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return {
						url: `https://media.example/recovery-${resolveCount}.mp3`,
						quality: "standard",
						proxied: false,
						trial: false,
					};
				},
			},
			lyrics: {
				async lyric() {
					return {
						provider: TRACK.provider,
						trackId: TRACK.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 5_000,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 5_000,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && loadCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const firstLoadContext = loadedContext;
	const firstSourceUrl = loadedSourceUrl;
	runtimeRef.current!.handleRuntimeError(
		errorEventPayload(firstLoadContext, "media failed", firstSourceUrl),
	);
	runtimeRef.current!.handleRuntimeError(
		errorEventPayload(firstLoadContext, "media failed again", firstSourceUrl),
	);
	for (let i = 0; i < 8 && (resolveCount < 2 || loadCount < 2); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	runtimeRef.current!.handleRuntimeError(errorEventPayload(
		loadedContext,
		"media failed after recovery",
		loadedSourceUrl,
	));
	for (let i = 0; i < 4; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(resolveCount).toBe(2);

	root.unmount();
	host.remove();
});

test("a trial media error clears the banner without resolving another source", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let resolveCount = 0;
	let loadCount = 0;
	let loadedContext: object | null = null;
	let loadedSourceUrl = "";
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = { current: null };
	const controller = {
		load(url: string, loadContext?: object) {
			loadCount += 1;
			loadedContext = loadContext ?? null;
			loadedSourceUrl = url;
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return {
						url: "https://media.example/trial.mp3",
						quality: "standard",
						proxied: false,
						trial: true,
						loggedIn: false,
						message: "当前未登录 · 仅播放试听片段",
					};
				},
			},
			lyrics: {
				async lyric() {
					return {
						provider: TRACK.provider,
						trackId: TRACK.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && (loadCount < 1 || !runtimeRef.current?.trialBanner); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(runtimeRef.current?.trialBanner?.text).toBe("当前未登录 · 仅播放试听片段");
	runtimeRef.current!.handleRuntimeError(errorEventPayload(
		loadedContext,
		"trial media failed",
		loadedSourceUrl,
	));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(resolveCount).toBe(1);
	expect(runtimeRef.current?.trialBanner).toBeNull();

	root.unmount();
	host.remove();
});

test("a local track loads its blob URL without calling playback or media ports", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const loadedUrls: string[] = [];
	let resolveCount = 0;
	const controller = {
		load(url: string) {
			loadedUrls.push(url);
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					throw new Error("local audio must not resolve remotely");
				},
			},
			lyrics: {},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl() {
				throw new Error("local audio must not use media ports");
			},
			playableUrl() {
				throw new Error("local audio must not use media ports");
			},
		},
	} as unknown as AppServices;

	function Harness() {
		usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: {
				current: new Map([[`${TRACK.provider}:${TRACK.id}`, "blob:session-1"]]),
			},
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && loadedUrls.length < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(loadedUrls).toEqual(["blob:session-1"]);
	expect(resolveCount).toBe(0);

	root.unmount();
	host.remove();
});

test("runtime event handlers keep stable identities when application services connect", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const results: PlaybackSessionRuntimeResult[] = [];
	const controllerRef = { current: null as PlayerController | null };
	const localAudioUrlsRef = { current: new Map<string, string>() };
	const getPlaybackSnapshot = () => ({
		currentTrack: null,
		positionMs: 0,
		durationMs: null,
		isPlaying: false,
	});
	const noOp = () => undefined;
	const services = {
		music: {},
		mediaUrl: {},
	} as unknown as AppServices;

	function Harness({ appServices }: { appServices: AppServices | null }) {
		results.push(usePlaybackSessionRuntime({
			appServices,
			controllerRef,
			localAudioUrlsRef,
			currentTrack: null,
			playbackIntentId: 0,
			positionMs: 0,
			getPlaybackSnapshot,
			setPlaying: noOp,
			setPositionMs: noOp,
			togglePlayFallback: noOp,
			setSearchError: noOp,
			showToast: noOp,
			setHomeForcedOpen: noOp,
			setHomeSuppressed: noOp,
			setLyricsPayload: noOp,
			setLyricsLoading: noOp,
			setLyricsError: noOp,
			resetLyrics: noOp,
			beatMapKeyForMap: () => "none",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: noOp,
		}));
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness appServices={null} />));
	const before = results.at(-1)!;
	flushSync(() => root.render(<Harness appServices={services} />));
	const after = results.at(-1)!;

	expect(after.handleRuntimePlay).toBe(before.handleRuntimePlay);
	expect(after.handleRuntimePause).toBe(before.handleRuntimePause);
	expect(after.handleRuntimeTimeUpdate).toBe(before.handleRuntimeTimeUpdate);
	expect(after.handleRuntimeDurationChange).toBe(before.handleRuntimeDurationChange);
	expect(after.handleRuntimeEnded).toBe(before.handleRuntimeEnded);
	expect(after.handleRuntimeError).toBe(before.handleRuntimeError);

	root.unmount();
	host.remove();
});

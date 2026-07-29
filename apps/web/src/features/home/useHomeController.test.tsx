import { expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
	DiscoverHomeResponse,
	Track,
	WeatherRadioResponse,
} from "@mineradio/shared";
import type { DiscoverPort } from "../../ports/music/discover-port";
import {
	useHomeController,
	type HomeControllerResult,
} from "./useHomeController";

const track: Track = {
	provider: "netease",
	id: "song-1",
	sourceId: "song-1",
	title: "测试歌曲",
	artists: ["测试歌手"],
	album: "测试专辑",
	coverUrl: "",
	qualityHints: [],
	playableState: "playable",
	durationMs: 120_000,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function home(updatedAt: number): DiscoverHomeResponse {
	return {
		loggedIn: true,
		user: null,
		dailySongs: [],
		playlists: [],
		podcasts: [],
		mode: "member",
		updatedAt,
	};
}

function createOptions(discover: DiscoverPort | null, saves: unknown[] = []) {
	return {
		discover,
		library: null,
		search: null,
		currentTrack: track,
		positionMs: 0,
		durationMs: 120_000,
		providerLoggedIn: true,
		libraryPanelPinned: false,
		playback: { setQueue: () => undefined, playAt: () => undefined },
		searchQuery: () => undefined,
		openLogin: () => undefined,
		openLibrarySurface: () => undefined,
		enterPlaybackSurface: () => undefined,
		closeLibraryPanel: () => undefined,
		closeShelf: () => undefined,
		selectShelfPlaylist: () => undefined,
		setConsole: () => undefined,
		setMiniQueue: () => undefined,
		showToast: () => undefined,
		storage: {
			read: () => [],
			save: (value: unknown) => {
				saves.push(value);
			},
		},
		autoRefresh: false,
	};
}

test("stale Home discover response cannot overwrite a newer request", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const first = deferred<DiscoverHomeResponse>();
	const second = deferred<DiscoverHomeResponse>();
	let request = 0;
	const discover = {
		discoverHome: () => (++request === 1 ? first.promise : second.promise),
	} as unknown as DiscoverPort;
	const controllerRef: { current: HomeControllerResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useHomeController(createOptions(discover));
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	const oldRequest = controllerRef.current!.refreshDiscover();
	const newRequest = controllerRef.current!.refreshDiscover();
	second.resolve(home(2));
	await newRequest;
	first.resolve(home(1));
	await oldRequest;
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(controllerRef.current?.discover?.updatedAt).toBe(2);

	root.unmount();
	host.remove();
});

test("Home exposes local discover and weather failures and clears each error after retry", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let discoverCalls = 0;
	let weatherCalls = 0;
	const weather = { ok: true } as unknown as WeatherRadioResponse;
	const discover = {
		discoverHome: async () => {
			discoverCalls += 1;
			if (discoverCalls === 1) throw new Error("推荐服务离线");
			if (discoverCalls === 3) throw new Error("推荐重试失败");
			return home(2);
		},
		weatherRadio: async () => {
			weatherCalls += 1;
			if (weatherCalls === 1) throw new Error("天气服务离线");
			if (weatherCalls === 3) throw new Error("天气重试失败");
			return weather;
		},
	} as unknown as DiscoverPort;
	const controllerRef: { current: HomeControllerResult | null } = { current: null };
	const options = createOptions(discover);

	function Harness() {
		controllerRef.current = useHomeController(options);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	await controllerRef.current!.refreshDiscover();
	await controllerRef.current!.refreshWeatherRadio();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(controllerRef.current?.discoverError).toBe("推荐服务离线");
	expect(controllerRef.current?.weatherRadioError).toBe("天气服务离线");

	await controllerRef.current!.refreshDiscover();
	await controllerRef.current!.refreshWeatherRadio();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(controllerRef.current?.discover?.updatedAt).toBe(2);
	expect(controllerRef.current?.weatherRadio).toBe(weather);
	expect(controllerRef.current?.discoverError).toBeNull();
	expect(controllerRef.current?.weatherRadioError).toBeNull();

	await controllerRef.current!.refreshDiscover();
	await controllerRef.current!.refreshWeatherRadio();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(controllerRef.current?.discover?.updatedAt).toBe(2);
	expect(controllerRef.current?.discoverError).toBe("推荐重试失败");
	expect(controllerRef.current?.weatherRadio).toBe(weather);
	expect(controllerRef.current?.weatherRadioError).toBe("天气重试失败");

	root.unmount();
	host.remove();
});

test("listen session commits on completed playback but not on a short incomplete session", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const saves: unknown[] = [];
	const controllerRef: { current: HomeControllerResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useHomeController(createOptions(null, saves));
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	controllerRef.current!.finalizeListenSession(false);
	expect(saves.length).toBe(0);
	root.unmount();
	host.remove();

	const completedHost = document.createElement("div");
	document.body.appendChild(completedHost);
	const completedRoot = createRoot(completedHost);
	flushSync(() => completedRoot.render(<Harness />));
	controllerRef.current!.finalizeListenSession(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(saves.length).toBe(1);

	completedRoot.unmount();
	completedHost.remove();
});

import { expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PlaylistSummary, Track } from "@mineradio/shared";
import type { LibraryPort } from "../../ports/music/library-port";
import {
	useLibraryController,
	type LibraryControllerResult,
} from "./useLibraryController";

const neteasePlaylist: PlaylistSummary = {
	provider: "netease",
	id: "ne-1",
	name: "网易云歌单",
	coverUrl: "",
	trackCount: 1,
	trackIds: [],
	subscribed: false,
};

const qqPlaylist: PlaylistSummary = {
	provider: "qq",
	id: "qq-1",
	name: "QQ 歌单",
	coverUrl: "",
	trackCount: 1,
	trackIds: [],
	subscribed: false,
};

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
};

function createOptions(library: LibraryPort, messages: string[] = []) {
	return {
		library,
		discover: null,
		getCurrentTrack: () => track,
		playback: {
			setQueue: () => undefined,
			playAt: () => undefined,
			enterPlaybackSurface: () => undefined,
		},
		searchQuery: () => undefined,
		openLogin: () => undefined,
		resetSearch: () => undefined,
		setSearchError: () => undefined,
		showToast: (message: string) => messages.push(message),
		storage: { read: () => [], save: () => undefined },
	};
}

test("provider refresh replaces only that provider playlists", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let neteaseVersion = 1;
	const library = {
		async playlistList(provider: string) {
			if (provider === "netease") {
				return [{ ...neteasePlaylist, id: `ne-${neteaseVersion}` }];
			}
			return provider === "qq" ? [qqPlaylist] : [];
		},
	} as unknown as LibraryPort;
	const controllerRef: { current: LibraryControllerResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useLibraryController(createOptions(library));
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	await controllerRef.current!.refresh();
	await new Promise((resolve) => setTimeout(resolve, 0));
	neteaseVersion = 2;
	await controllerRef.current!.refreshProvider("netease");
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(controllerRef.current?.playlists.map((item) => item.id).sort()).toEqual([
		"ne-2",
		"qq-1",
	]);

	root.unmount();
	host.remove();
});

test("collect success closes picker and failure clears busy state", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const messages: string[] = [];
	let shouldFail = false;
	const library = {
		async playlistList() {
			return [neteasePlaylist];
		},
		async addSongToPlaylist() {
			if (shouldFail) throw new Error("收藏失败测试");
			return {
				provider: "netease",
				playlistId: "ne-1",
				trackId: "song-1",
				added: true,
			};
		},
	} as unknown as LibraryPort;
	const controllerRef: { current: LibraryControllerResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useLibraryController(createOptions(library, messages));
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	controllerRef.current!.openCollectPicker(track);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await controllerRef.current!.collectToPlaylist("ne-1");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(controllerRef.current?.collectTarget).toBeNull();
	expect(controllerRef.current?.collectBusyPlaylistId).toBeNull();

	shouldFail = true;
	controllerRef.current!.openCollectPicker(track);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await controllerRef.current!.collectToPlaylist("ne-1");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(controllerRef.current?.collectTarget?.id).toBe("song-1");
	expect(controllerRef.current?.collectBusyPlaylistId).toBeNull();
	expect(messages).toContain("收藏失败测试");

	root.unmount();
	host.remove();
});

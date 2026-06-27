import { expect, test, beforeEach, afterEach } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchPanel } from "./SearchPanel";
import { SidecarClient } from "../../api/sidecar-client";
import { useSearchStore } from "../../stores/search-store";
import { usePlaybackStore } from "../../stores/playback-store";
import { playSearchResult, isPlayable } from "./play-search-result";
import type { Track } from "@mineradio/shared";

const BASE = "http://127.0.0.1:65535";

let originalUseSyncExternalStore: typeof React.useSyncExternalStore;

beforeEach(() => {
	originalUseSyncExternalStore = React.useSyncExternalStore;
	React.useSyncExternalStore = ((
		subscribe: (listener: () => void) => () => void,
		getSnapshot: () => unknown,
		getServerSnapshot?: () => unknown,
	) => {
		const snap = (getServerSnapshot ?? getSnapshot).bind(null);
		void snap;
		return originalUseSyncExternalStore(
			subscribe as (listener: () => void) => () => void,
			getSnapshot as () => unknown,
			getSnapshot as () => unknown,
		);
	}) as typeof React.useSyncExternalStore;
});

afterEach(() => {
	React.useSyncExternalStore = originalUseSyncExternalStore;
});

function makeTrack(id: string, title: string, playableState: Track["playableState"] = "playable"): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title,
		artists: ["Artist"],
		album: "Album",
		coverUrl: "",
		qualityHints: [],
		playableState,
	};
}

function resetStores(): void {
	useSearchStore.setState({
		results: [],
		loading: false,
		error: null,
		provider: "netease",
		keyword: "",
	});
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "queue",
		queue: [],
	});
}

test("SearchPanel renders provided results and disables buttons for non-playable states", () => {
	resetStores();
	const tracks = [makeTrack("a", "A"), makeTrack("b", "B", "vip_required")];
	useSearchStore.getState().setResults(tracks);
	const html = renderToStaticMarkup(
		<SearchPanel client={new SidecarClient(BASE)} />,
	);
	expect(html).toContain('data-track-id="a"');
	expect(html).toContain('data-track-id="b"');
	expect(html).toContain('data-disabled="true"');
	expect(html).toContain('data-playable-state="vip_required"');
});

test("SearchPanel shows QQ provider note when provider is qq", () => {
	resetStores();
	useSearchStore.getState().setProvider("qq");
	const html = renderToStaticMarkup(
		<SearchPanel client={new SidecarClient(BASE)} />,
	);
	expect(html).toContain("QQ provider 不在 P4.5 接入范围");
	expect(html).toContain('data-provider="qq"');
});

test("playSearchResult enqueues and plays the clicked track", () => {
	resetStores();
	const tracks = [makeTrack("a", "A"), makeTrack("b", "B")];
	playSearchResult(tracks[1]);
	expect(usePlaybackStore.getState().queue.length).toBe(1);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("playSearchResult on second track advances currentTrack", () => {
	resetStores();
	const tracks = [makeTrack("a", "A"), makeTrack("b", "B")];
	usePlaybackStore.getState().setQueue(tracks);
	playSearchResult(tracks[1]);
	expect(usePlaybackStore.getState().queue.length).toBeGreaterThanOrEqual(2);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("isPlayable returns false only for hard-disabled states", () => {
	expect(isPlayable("unavailable")).toBe(false);
	expect(isPlayable("paid_required")).toBe(false);
	expect(isPlayable("vip_required")).toBe(false);
	expect(isPlayable("login_required")).toBe(false);
	expect(isPlayable("playable")).toBe(true);
	expect(isPlayable("trial_only")).toBe(true);
	expect(isPlayable("unknown")).toBe(true);
});
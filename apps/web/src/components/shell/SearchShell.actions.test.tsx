import { afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Track } from "@mineradio/shared";
import { usePlaybackStore } from "../../stores/playback-store";
import { useSearchStore } from "../../stores/search-store";
import { SearchShell } from "./SearchShell";

let originalUseSyncExternalStore: typeof React.useSyncExternalStore;
let domRoot: HTMLElement | null = null;

beforeEach(() => {
	originalUseSyncExternalStore = React.useSyncExternalStore;
	React.useSyncExternalStore = ((
		subscribe: (listener: () => void) => () => void,
		getSnapshot: () => unknown,
		getServerSnapshot?: () => unknown,
	) =>
		originalUseSyncExternalStore(
			subscribe,
			getSnapshot,
			getServerSnapshot ?? getSnapshot,
		)) as typeof React.useSyncExternalStore;
	resetStores();
});

afterEach(() => {
	React.useSyncExternalStore = originalUseSyncExternalStore;
	domRoot?.remove();
	domRoot = null;
});

function makeTrack(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: `Song ${id}`,
		artists: ["Artist"],
		album: "Album",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
	};
}

function resetStores(): void {
	useSearchStore.setState({
		results: [],
		loading: false,
		error: null,
		provider: "netease",
		keyword: "Song",
	});
	usePlaybackStore.setState({
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		mode: "loop",
		queue: [],
	});
}

async function renderSearchShell(
	element: React.ReactElement,
): Promise<{ root: Root; container: HTMLElement }> {
	if (typeof document === "undefined") {
		await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	}
	domRoot = document.createElement("div");
	document.body.appendChild(domRoot);
	const root = createRoot(domRoot);
	flushSync(() => root.render(element));
	await Promise.resolve();
	return { root, container: domRoot };
}

test("SearchShell renders baseline like and collect action buttons for each song result", async () => {
	const track = makeTrack("100");
	useSearchStore.getState().setResults([track]);

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={null}
			onResultLike={() => undefined}
			onResultCollect={() => undefined}
			isResultLiked={(candidate) => candidate.id === "100"}
		/>,
	);

	expect(container.querySelectorAll(".search-shell-action.song-action-btn").length).toBe(2);
	expect(container.querySelector(".search-shell-like.liked")).not.toBeNull();
	expect(container.querySelector<HTMLButtonElement>('[aria-label="取消红心"]')).not.toBeNull();
	expect(container.querySelector<HTMLButtonElement>('[aria-label="收藏到歌单"]')).not.toBeNull();
	root.unmount();
});

test("SearchShell action buttons call like and collect callbacks without starting playback", async () => {
	const track = makeTrack("100");
	const calls: string[] = [];
	useSearchStore.getState().setResults([track]);

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={null}
			onResultLike={(candidate) => calls.push(`like:${candidate.id}`)}
			onResultCollect={(candidate) => calls.push(`collect:${candidate.id}`)}
		/>,
	);

	const like = container.querySelector<HTMLButtonElement>(".search-shell-like");
	const collect = container.querySelector<HTMLButtonElement>(".search-shell-collect");
	expect(like).not.toBeNull();
	expect(collect).not.toBeNull();
	like!.click();
	collect!.click();

	expect(calls).toEqual(["like:100", "collect:100"]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	root.unmount();
});

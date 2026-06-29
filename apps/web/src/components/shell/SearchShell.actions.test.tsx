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

test("SearchShell renders baseline like collect and next action buttons for each song result", async () => {
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

	expect(container.querySelectorAll(".search-shell-action").length).toBe(3);
	expect(container.querySelector(".search-shell-like.liked")).not.toBeNull();
	expect(container.querySelector<HTMLButtonElement>('[aria-label="取消红心"]')).not.toBeNull();
	expect(container.querySelector<HTMLButtonElement>('[aria-label="收藏到歌单"]')).not.toBeNull();
	expect(container.querySelector<HTMLButtonElement>('[aria-label="下一首播放"]')).not.toBeNull();
	root.unmount();
});

test("SearchShell action buttons call like collect and next callbacks without starting playback", async () => {
	const track = makeTrack("100");
	const calls: string[] = [];
	useSearchStore.getState().setResults([track]);

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={null}
			onResultLike={(candidate) => calls.push(`like:${candidate.id}`)}
			onResultCollect={(candidate) => calls.push(`collect:${candidate.id}`)}
			onResultNext={(candidate) => calls.push(`next:${candidate.id}`)}
		/>,
	);

	const like = container.querySelector<HTMLButtonElement>(".search-shell-like");
	const collect = container.querySelector<HTMLButtonElement>(".search-shell-collect");
	const next = container.querySelector<HTMLButtonElement>(".search-shell-next");
	expect(like).not.toBeNull();
	expect(collect).not.toBeNull();
	expect(next).not.toBeNull();
	like!.click();
	collect!.click();
	next!.click();

	expect(calls).toEqual(["like:100", "collect:100", "next:100"]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	root.unmount();
});

test("SearchShell artist link routes to baseline artist search without starting playback", async () => {
	const track = makeTrack("100");
	const calls: string[] = [];
	useSearchStore.getState().setResults([track]);

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={null}
			onArtistSearch={(artist, candidate) => calls.push(`${artist}:${candidate.id}`)}
		/>,
	);

	(container.querySelector(".search-artist-link") as HTMLElement).click();
	expect(calls).toEqual(["Artist:100"]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	root.unmount();
});

test("SearchShell follows baseline peek class from its host state", async () => {
	useSearchStore.setState({ keyword: "", results: [], loading: false, error: null });
	const first = await renderSearchShell(<SearchShell client={null} peek={false} />);
	expect(first.container.querySelector("#search-area")?.classList.contains("peek")).toBe(false);
	first.root.unmount();
	first.container.remove();
	domRoot = null;

	const second = await renderSearchShell(<SearchShell client={null} peek />);
	expect(second.container.querySelector("#search-area")?.classList.contains("peek")).toBe(true);
	second.root.unmount();
});

test("SearchShell clears stale results after clearing input so host peek can hide", async () => {
	useSearchStore.setState({
		results: [makeTrack("100")],
		loading: false,
		error: null,
		provider: "netease",
		keyword: "",
	});

	const { root, container } = await renderSearchShell(<SearchShell client={null} peek={false} />);
	await Promise.resolve();

	expect(useSearchStore.getState().results).toEqual([]);
	expect(container.querySelector("#search-results")?.classList.contains("show")).toBe(false);
	expect(container.querySelector("#search-area")?.classList.contains("peek")).toBe(false);
	root.unmount();
});

test("SearchShell podcast mode renders podcast radios and opens the selected radio", async () => {
	useSearchStore.setState({
		results: [],
		loading: false,
		error: null,
		provider: "netease",
		keyword: "",
	});
	const calls: string[] = [];
	const opened: string[] = [];
	const client = {
		async podcastHot(limit: number) {
			calls.push(`hot:${limit}`);
			return {
				podcasts: [{
					id: "radio-1",
					rid: "radio-1",
					name: "午夜播客",
					coverUrl: "",
					description: "",
					djName: "DJ Alice",
					category: "音乐",
					programCount: 12,
					subCount: 0,
				}],
				more: false,
			};
		},
	} as never;

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={client}
			requestedMode="podcast"
			onPodcastOpen={(radio) => opened.push(radio.id)}
		/>,
	);
	for (let i = 0; i < 8 && !container.querySelector("[data-podcast-id]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(calls).toEqual(["hot:18"]);
	expect(container.querySelector("[data-podcast-id=\"radio-1\"]")?.textContent).toContain("午夜播客");
	(container.querySelector("[data-podcast-id=\"radio-1\"]") as HTMLButtonElement).click();
	expect(opened).toEqual(["radio-1"]);
	root.unmount();
});

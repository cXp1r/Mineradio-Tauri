import { afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { PodcastProgram, Track } from "@mineradio/shared";
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

function makePodcastProgram(id: string, radioId = "radio-big"): PodcastProgram {
	return {
		provider: "netease",
		id: `program-song-${id}`,
		sourceId: `program-song-${id}`,
		title: `第 ${id} 期`,
		artists: ["DJ Alice"],
		album: "长播客",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
		type: "podcast",
		programId: `program-${id}`,
		radioId,
		radioName: "长播客",
		djName: "DJ Alice",
		description: "",
		createTime: 0,
		serialNum: Number(id),
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

test("SearchShell virtualizes long song result lists while preserving row actions", async () => {
	const calls: string[] = [];
	const tracks = Array.from({ length: 180 }, (_, index) => makeTrack(String(index)));
	useSearchStore.getState().setResults(tracks);

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={null}
			onResultLike={(candidate) => calls.push(`like:${candidate.id}`)}
			onResultCollect={(candidate) => calls.push(`collect:${candidate.id}`)}
			onResultNext={(candidate) => calls.push(`next:${candidate.id}`)}
		/>,
	);

	const list = container.querySelector(".search-shell-list");
	expect(list?.getAttribute("data-virtualized")).toBe("true");
	expect(container.querySelectorAll(".search-shell-row").length).toBeLessThan(60);
	expect(container.querySelector(".search-shell-list")?.textContent).toContain("Song 0");
	(container.querySelector(".search-shell-like") as HTMLButtonElement).click();
	(container.querySelector(".search-shell-collect") as HTMLButtonElement).click();
	(container.querySelector(".search-shell-next") as HTMLButtonElement).click();

	expect(calls).toEqual(["like:0", "collect:0", "next:0"]);
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

test("SearchShell artist link is an independent baseline button outside the row play button", async () => {
	const track = makeTrack("100");
	const calls: string[] = [];
	useSearchStore.getState().setResults([track]);

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={null}
			onResultPlay={(candidate) => calls.push(`play:${candidate.id}`)}
			onArtistSearch={(artist, candidate) => calls.push(`artist:${artist}:${candidate.id}`)}
		/>,
	);

	const artist = container.querySelector<HTMLButtonElement>(".search-artist-link");
	expect(artist?.tagName).toBe("BUTTON");
	expect(artist?.closest(".search-shell-row-btn")).toBeNull();
	artist!.click();

	expect(calls).toEqual(["artist:Artist:100"]);
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

test("SearchShell podcast mode drills into programs with back next and play actions", async () => {
	useSearchStore.setState({
		results: [],
		loading: false,
		error: null,
		provider: "netease",
		keyword: "",
	});
	const calls: string[] = [];
	const nextCalls: string[] = [];
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
		async podcastPrograms(id: string, limit: number) {
			calls.push(`programs:${id}:${limit}`);
			return {
				radio: { id, rid: id, name: "午夜播客", djName: "DJ Alice" },
				programs: [{
					provider: "netease",
					id: "program-song-1",
					sourceId: "program-song-1",
					title: "第一期",
					artists: ["DJ Alice"],
					album: "午夜播客",
					coverUrl: "",
					qualityHints: [],
					playableState: "playable",
					type: "podcast",
					programId: "program-1",
					radioId: id,
					radioName: "午夜播客",
					djName: "DJ Alice",
				}],
				more: false,
				total: 1,
			};
		},
	} as never;

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={client}
			requestedMode="podcast"
			onResultNext={(track) => nextCalls.push(track.id)}
		/>,
	);
	for (let i = 0; i < 8 && !container.querySelector("[data-podcast-id]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(calls).toEqual(["hot:18"]);
	expect(container.querySelector("[data-podcast-id=\"radio-1\"]")?.textContent).toContain("午夜播客");
	(container.querySelector("[data-podcast-id=\"radio-1\"]") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !container.querySelector("[data-podcast-program-id]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(calls).toEqual(["hot:18", "programs:radio-1:36"]);
	expect(container.querySelector(".podcast-result-head")?.textContent).toContain("午夜播客");
	expect(container.querySelector("[data-podcast-program-id=\"program-1\"]")?.textContent).toContain("第一期");

	(container.querySelector(".search-shell-next") as HTMLButtonElement).click();
	expect(nextCalls).toEqual(["program-song-1"]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();

	(container.querySelector(".podcast-back-btn") as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(container.querySelector("[data-podcast-id=\"radio-1\"]")).not.toBeNull();

	(container.querySelector("[data-podcast-id=\"radio-1\"]") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !container.querySelector("[data-podcast-program-id]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	(container.querySelector("[data-podcast-program-id=\"program-1\"]") as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("program-song-1");
	expect(container.querySelector("[data-podcast-program-id=\"program-1\"]")).toBeNull();
	expect(container.querySelector("#search-results")?.classList.contains("show")).toBe(false);
	root.unmount();
});

test("SearchShell virtualizes long podcast program lists", async () => {
	useSearchStore.setState({
		results: [],
		loading: false,
		error: null,
		provider: "netease",
		keyword: "",
	});
	const nextCalls: string[] = [];
	const client = {
		async podcastHot() {
			return {
				podcasts: [{
					id: "radio-big",
					rid: "radio-big",
					name: "长播客",
					coverUrl: "",
					description: "",
					djName: "DJ Alice",
					category: "音乐",
					programCount: 180,
					subCount: 0,
				}],
				more: false,
			};
		},
		async podcastPrograms(id: string) {
			return {
				radio: { id, rid: id, name: "长播客", djName: "DJ Alice" },
				programs: Array.from({ length: 180 }, (_, index) => makePodcastProgram(String(index), id)),
				more: false,
				total: 180,
			};
		},
	} as never;

	const { root, container } = await renderSearchShell(
		<SearchShell
			client={client}
			requestedMode="podcast"
			onResultNext={(track) => nextCalls.push(track.id)}
		/>,
	);
	for (let i = 0; i < 8 && !container.querySelector("[data-podcast-id]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	(container.querySelector("[data-podcast-id=\"radio-big\"]") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !container.querySelector("[data-podcast-program-id]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const list = container.querySelector(".search-shell-podcast-program-list");
	expect(list?.getAttribute("data-virtualized")).toBe("true");
	expect(container.querySelectorAll(".search-shell-row").length).toBeLessThan(60);
	expect(list?.textContent).toContain("第 0 期");
	(container.querySelector(".search-shell-next") as HTMLButtonElement).click();
	expect(nextCalls).toEqual(["program-song-0"]);
	root.unmount();
});

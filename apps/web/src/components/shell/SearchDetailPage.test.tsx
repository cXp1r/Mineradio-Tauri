import { afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Track } from "@mineradio/shared";
import { useSearchStore } from "../../stores/search-store";
import { SearchDetailPage } from "./SearchDetailPage";

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
	useSearchStore.setState({
		results: [],
		loading: false,
		error: null,
		provider: "netease",
		keyword: "晴天",
		mode: "song",
		detailOpen: true,
		recentQueries: [],
	});
});

afterEach(() => {
	React.useSyncExternalStore = originalUseSyncExternalStore;
	domRoot?.remove();
	domRoot = null;
	useSearchStore.getState().reset();
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
		durationMs: 245000,
		qualityHints: [],
		playableState: "playable",
	};
}

async function renderSearchDetail(
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

async function waitForSearchRows(container: HTMLElement): Promise<void> {
	for (let i = 0; i < 12 && !container.querySelector("[data-search-detail-play]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

test("SearchDetailPage renders committed keyword and song row actions", async () => {
	const client = {
		async searchAll(keyword: string, limit: number) {
			expect(keyword).toBe("晴天");
			expect(limit).toBe(30);
			return [makeTrack("song-1")];
		},
	} as never;

	const { root, container } = await renderSearchDetail(
		<SearchDetailPage
			client={client}
			onClose={() => undefined}
			onPlayResults={() => undefined}
			onAppendQueue={() => undefined}
			onResultNext={() => undefined}
			onResultLike={() => undefined}
			onResultCollect={() => undefined}
			onArtistSearch={() => undefined}
		/>,
	);
	await waitForSearchRows(container);

	expect(container.querySelector("[data-search-detail]")).not.toBeNull();
	expect(container.textContent).toContain("晴天");
	expect(container.querySelector("[data-search-detail-play]")).not.toBeNull();
	expect(container.querySelector("[data-search-detail-append]")).not.toBeNull();
	expect(container.querySelector("[data-search-detail-next]")).not.toBeNull();
	root.unmount();
});

test("SearchDetailPage song row buttons call play append and next callbacks", async () => {
	const calls: string[] = [];
	const client = {
		async searchAll() {
			return [makeTrack("song-1")];
		},
	} as never;

	const { root, container } = await renderSearchDetail(
		<SearchDetailPage
			client={client}
			onClose={() => undefined}
			onPlayResults={(_tracks, index) => calls.push(`play:${index}`)}
			onAppendQueue={(track) => calls.push(`append:${track.id}`)}
			onResultNext={(track) => calls.push(`next:${track.id}`)}
			onResultLike={() => undefined}
			onResultCollect={() => undefined}
			onArtistSearch={() => undefined}
		/>,
	);
	await waitForSearchRows(container);

	container.querySelector<HTMLButtonElement>("[data-search-detail-play]")?.click();
	container.querySelector<HTMLButtonElement>("[data-search-detail-append]")?.click();
	container.querySelector<HTMLButtonElement>("[data-search-detail-next]")?.click();

	expect(calls).toEqual(["play:0", "append:song-1", "next:song-1"]);
	root.unmount();
});

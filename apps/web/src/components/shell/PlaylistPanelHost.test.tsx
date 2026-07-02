import { expect, test } from "bun:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { PlaylistDetail, PlaylistSummary, PodcastCollection, Track } from "@mineradio/shared";
import { PlaylistPanelHost } from "./PlaylistPanelHost";

function makeTrack(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: `Song ${id}`,
		artists: ["Alice"],
		album: "Album",
		coverUrl: "",
		durationMs: 1000,
		qualityHints: [],
		playableState: "playable",
	};
}

function makePodcastCollection(index: number): PodcastCollection {
	return {
		key: `podcast-${index}`,
		title: `播客集合 ${index}`,
		sub: "Radio",
		itemType: "radio",
		count: index,
		coverUrl: "",
	};
}

async function renderPanel(element: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	flushSync(() => root.render(element));
	await new Promise((resolve) => setTimeout(resolve, 0));
	return {
		container,
		unmount: () => {
			root.unmount();
			container.remove();
		},
	};
}

test("PlaylistPanelHost renders baseline panel ids tabs and queue actions", async () => {
	const calls: string[] = [];
	const tracks = [makeTrack("1"), makeTrack("2")];
	const { container, unmount } = await renderPanel(
		<PlaylistPanelHost
			open
			pinned
			tab="queue"
			queue={tracks}
			currentTrack={tracks[1] ?? null}
			mode="loop"
			playlists={[]}
			podcastCollections={[]}
			onTabChange={(tab) => calls.push(`tab:${tab}`)}
			onPinToggle={() => calls.push("pin")}
			onShuffle={() => calls.push("shuffle")}
			onCycleMode={() => calls.push("mode")}
			onClearQueue={() => calls.push("clear")}
			onPlayQueueIndex={(index) => calls.push(`play:${index}`)}
			onQueueArtist={(artist) => calls.push(`artist:${artist}`)}
			onInsertQueueNext={(index) => calls.push(`next:${index}`)}
			onRemoveQueueIndex={(index) => calls.push(`remove:${index}`)}
		/>,
	);

	const panel = container.querySelector("#playlist-panel");
	expect(panel?.className).toContain("show");
	expect(panel?.className).toContain("pinned");
	expect(container.querySelector("#tab-queue")?.className).toContain("active");
	expect(container.querySelector("#queue-list")?.textContent).toContain("Song 1");
	expect(container.querySelector(".queue-item.now")?.textContent).toContain("Song 2");

	(container.querySelector("#playlist-pin-btn") as HTMLButtonElement).click();
	(container.querySelector(".queue-head-act .fx-mini-btn:last-child") as HTMLButtonElement).click();
	(container.querySelector(".queue-toolbar-actions .fx-mini-btn:first-child") as HTMLButtonElement).click();
	(container.querySelector(".queue-toolbar-actions .fx-mini-btn:last-child") as HTMLButtonElement).click();
	(container.querySelector(".queue-artist-link") as HTMLButtonElement).click();
	(container.querySelector(".queue-next") as HTMLButtonElement).click();
	(container.querySelector(".qi-act button:last-child") as HTMLButtonElement).click();
	container.querySelectorAll(".queue-item")[1]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	(container.querySelector("#tab-pl") as HTMLButtonElement).click();

	expect(calls).toEqual(["pin", "shuffle", "mode", "clear", "artist:Alice", "next:0", "remove:0", "play:1", "tab:playlists"]);
	unmount();
});

test("PlaylistPanelHost virtualizes large queue panes without changing visible row actions", async () => {
	const calls: string[] = [];
	const tracks = Array.from({ length: 240 }, (_, index) => makeTrack(String(index)));
	const { container, unmount } = await renderPanel(
		<PlaylistPanelHost
			open
			tab="queue"
			queue={tracks}
			currentTrack={tracks[0] ?? null}
			mode="loop"
			playlists={[]}
			podcastCollections={[]}
			onTabChange={() => undefined}
			onPlayQueueIndex={(index) => calls.push(`play:${index}`)}
			onInsertQueueNext={(index) => calls.push(`next:${index}`)}
			onRemoveQueueIndex={(index) => calls.push(`remove:${index}`)}
		/>,
	);

	expect(container.querySelector("#queue-list")?.getAttribute("data-virtualized")).toBe("true");
	expect(container.querySelectorAll(".queue-item").length).toBeLessThan(60);
	expect(container.querySelector("#queue-list")?.textContent).toContain("Song 0");
	container.querySelectorAll(".queue-item")[1]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	(container.querySelector(".queue-next") as HTMLButtonElement).click();
	(container.querySelector(".qi-act button:last-child") as HTMLButtonElement).click();

	expect(calls).toEqual(["play:1", "next:0", "remove:0"]);
	unmount();
});

test("PlaylistPanelHost expands playlist detail and plays detail tracks", async () => {
	const playlist: PlaylistSummary = {
		provider: "netease",
		id: "pl-1",
		name: "我的歌单",
		coverUrl: "",
		trackCount: 2,
		trackIds: [],
		subscribed: false,
	};
	const tracks = [makeTrack("10"), makeTrack("11")];
	const calls: string[] = [];
	const { container, unmount } = await renderPanel(
		<PlaylistPanelHost
			open
			tab="playlists"
			queue={[]}
			currentTrack={null}
			mode="loop"
			playlists={[playlist]}
			podcastCollections={[]}
			onTabChange={() => undefined}
			onLoadPlaylistDetail={async (): Promise<PlaylistDetail> => ({ ...playlist, tracks })}
			onPlayTracks={(items, index, title) => calls.push(`${title}:${index}:${items.length}`)}
			onQueueArtist={(artist) => calls.push(`artist:${artist}`)}
		/>,
	);

	expect(container.querySelector("#pl-list")?.textContent).toContain("我的歌单");
	(container.querySelector(".pl-card") as HTMLDivElement).click();
	for (let i = 0; i < 8 && !container.querySelector("[data-pl-detail]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(container.querySelector(".pl-card.expanded")).not.toBeNull();
	expect(container.querySelector(".pl-inline-detail")?.textContent).toContain("Song 10");
	(container.querySelector(".pl-detail-play") as HTMLButtonElement).click();
	(container.querySelector("[data-pl-detail-row=\"1\"]") as HTMLDivElement).click();
	(container.querySelector(".pl-detail-row-artist") as HTMLButtonElement).click();

	expect(calls).toEqual(["我的歌单:0:2", "我的歌单:1:2", "artist:Alice"]);
	unmount();
});

test("PlaylistPanelHost virtualizes large playlist detail panes", async () => {
	const playlist: PlaylistSummary = {
		provider: "netease",
		id: "pl-big",
		name: "超大歌单",
		coverUrl: "",
		trackCount: 600,
		trackIds: [],
		subscribed: false,
	};
	const tracks = Array.from({ length: 600 }, (_, index) => makeTrack(String(index)));
	const calls: string[] = [];
	const { container, unmount } = await renderPanel(
		<PlaylistPanelHost
			open
			tab="playlists"
			queue={[]}
			currentTrack={null}
			mode="loop"
			playlists={[playlist]}
			podcastCollections={[]}
			onTabChange={() => undefined}
			onLoadPlaylistDetail={async (): Promise<PlaylistDetail> => ({ ...playlist, tracks })}
			onPlayTracks={(items, index) => calls.push(`${index}:${items.length}`)}
		/>,
	);

	(container.querySelector(".pl-card") as HTMLDivElement).click();
	for (let i = 0; i < 8 && !container.querySelector("[data-pl-detail]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(container.querySelector(".pl-detail-list")?.getAttribute("data-virtualized")).toBe("true");
	expect(container.querySelectorAll(".pl-detail-row").length).toBeLessThan(70);
	(container.querySelector("[data-pl-detail-row=\"1\"]") as HTMLDivElement).click();
	expect(calls).toEqual(["1:600"]);
	unmount();
});

test("PlaylistPanelHost renders baseline podcast tab and opens collections", async () => {
	const calls: string[] = [];
	const { container, unmount } = await renderPanel(
		<PlaylistPanelHost
			open
			tab="podcasts"
			queue={[]}
			currentTrack={null}
			mode="loop"
			playlists={[]}
			podcastCollections={[{ key: "created", title: "创建的播客", sub: "Radio", itemType: "radio", count: 3, coverUrl: "" }]}
			onTabChange={() => undefined}
			onPodcastCollectionOpen={(collection) => calls.push(collection.key)}
		/>,
	);

	expect(container.querySelector("#tab-podcast")?.className).toContain("active");
	expect(container.querySelector("#podcast-list")?.textContent).toContain("创建的播客");
	(container.querySelector("[data-podcast-key=\"created\"]") as HTMLDivElement).click();
	expect(calls).toEqual(["created"]);
	unmount();
});

test("PlaylistPanelHost virtualizes large podcast collection panes without changing collection actions", async () => {
	const calls: string[] = [];
	const collections = Array.from({ length: 180 }, (_, index) => makePodcastCollection(index));
	const { container, unmount } = await renderPanel(
		<PlaylistPanelHost
			open
			tab="podcasts"
			queue={[]}
			currentTrack={null}
			mode="loop"
			playlists={[]}
			podcastCollections={collections}
			onTabChange={() => undefined}
			onPodcastCollectionOpen={(collection) => calls.push(collection.key)}
		/>,
	);

	expect(container.querySelector("#podcast-list")?.getAttribute("data-virtualized")).toBe("true");
	expect(container.querySelectorAll(".podcast-card").length).toBeLessThan(60);
	expect(container.querySelector("#podcast-list")?.textContent).toContain("播客集合 0");
	expect(container.querySelector("#podcast-list")?.textContent).not.toContain("播客集合 179");
	(container.querySelector("[data-podcast-key=\"podcast-1\"]") as HTMLDivElement).click();
	expect(calls).toEqual(["podcast-1"]);
	unmount();
});

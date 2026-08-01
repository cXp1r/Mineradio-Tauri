import { expect, test } from "bun:test";
import type { DiscoverHomeResponse, Track } from "@mineradio/shared";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchDetailPage } from "../components/shell/SearchDetailPage";
import { HomeDashboardHero } from "../features/home/HomeDashboardHero";
import { createMemoryHomeHeroVideoRepository } from "../features/home/home-hero-video-repository";
import { SettingsWorkbench } from "../features/settings/SettingsWorkbench";
import { EmptyHomeHost } from "../home/EmptyHomeHost";
import { useSearchStore } from "../stores/search-store";

function track(index: number): Track {
	return {
		provider: "netease",
		id: `track-${index}`,
		sourceId: `track-${index}`,
		title: `Track ${index}`,
		artists: ["Artist"],
		album: "Album",
		coverUrl: "",
		durationMs: 180_000,
		qualityHints: [],
		playableState: "playable",
	};
}

test("Home rail keeps a hard visible DOM cap with oversized discover input", () => {
	const discover: DiscoverHomeResponse = {
		loggedIn: false,
		user: null,
		dailySongs: [],
		playlists: Array.from({ length: 200 }, (_, index) => ({
			provider: "netease" as const,
			id: `playlist-${index}`,
			name: `Playlist ${index}`,
			coverUrl: "",
			trackCount: 30,
			trackIds: [],
			subscribed: false,
		})),
		podcasts: [],
		mode: "starter",
		updatedAt: 1,
	};
	const html = renderToStaticMarkup(<EmptyHomeHost discover={discover} />);
	const visibleTiles = html.match(/class="home-tile(?: |")/g)?.length ?? 0;

	expect(visibleTiles).toBe(32);
});

test("Search detail virtual window bounds visible rows for a large result set", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	useSearchStore.setState({
		detailOpen: true,
		keyword: "budget",
		mode: "netease",
		results: Array.from({ length: 600 }, (_, index) => track(index)),
		podcasts: [],
		programs: [],
		selectedPodcast: null,
		loading: false,
		loadingNext: false,
		error: null,
		exhausted: true,
		visibleCount: 600,
		recentQueries: [],
	});
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(
			<SearchDetailPage
				client={null}
				onClose={() => {}}
				onPlayResults={() => {}}
				onAppendQueue={() => {}}
				onResultNext={() => {}}
				onResultLike={() => {}}
				onResultCollect={() => {}}
				onArtistSearch={() => {}}
			/>,
		));
		const visibleRows = host.querySelectorAll("[data-search-detail-play]").length;

		expect(visibleRows <= 20).toBe(true);
		expect(host.querySelector('[data-virtualized="true"]')).not.toBeNull();
	} finally {
		root.unmount();
		host.remove();
		useSearchStore.getState().reset();
	}
});

test("Settings keeps the complete forty-entry history inside its scroll budget", () => {
	const entries = Array.from({ length: 40 }, (_, index) => ({
		id: `entry-${index}`,
		label: `Setting ${index}`,
		changedPaths: ["intensity"],
		before: { intensity: index },
		after: { intensity: index + 1 },
		committedAt: index,
	}));
	const html = renderToStaticMarkup(
		<SettingsWorkbench
			activeTab="common"
			query=""
			history={{ busy: false, error: null, entries }}
			onTabChange={() => {}}
			onQueryChange={() => {}}
			onUndo={() => {}}
			onRollbackTo={() => {}}
			onEnableLowSpec={() => {}}
			onResetPreferences={() => {}}
		/>,
	);
	const visibleHistory = html.match(/data-settings-rollback=/g)?.length ?? 0;

	expect(visibleHistory).toBe(40);
});

test("Home Hero unmount clears its timer and lifecycle listeners", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const originalSetInterval = window.setInterval;
	const originalClearInterval = window.clearInterval;
	const originalWindowAdd = window.addEventListener;
	const originalWindowRemove = window.removeEventListener;
	const originalDocumentAdd = document.addEventListener;
	const originalDocumentRemove = document.removeEventListener;
	const timers = new Set<number>();
	let nextTimer = 1;
	const listeners = {
		pagehideAdded: 0,
		pagehideRemoved: 0,
		visibilityAdded: 0,
		visibilityRemoved: 0,
	};
	window.setInterval = (() => {
		const timer = nextTimer;
		nextTimer += 1;
		timers.add(timer);
		return timer;
	}) as typeof window.setInterval;
	window.clearInterval = ((timer: number) => {
		timers.delete(timer);
	}) as typeof window.clearInterval;
	window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
		if (type === "pagehide") listeners.pagehideAdded += 1;
		originalWindowAdd.call(window, type, listener, options);
	}) as typeof window.addEventListener;
	window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
		if (type === "pagehide") listeners.pagehideRemoved += 1;
		originalWindowRemove.call(window, type, listener, options);
	}) as typeof window.removeEventListener;
	document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
		if (type === "visibilitychange") listeners.visibilityAdded += 1;
		originalDocumentAdd.call(document, type, listener, options);
	}) as typeof document.addEventListener;
	document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
		if (type === "visibilitychange") listeners.visibilityRemoved += 1;
		originalDocumentRemove.call(document, type, listener, options);
	}) as typeof document.removeEventListener;

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	try {
		flushSync(() => root.render(
			<HomeDashboardHero
				active
				repository={createMemoryHomeHeroVideoRepository()}
			/>,
		));
		expect(timers.size).toBe(1);
		expect(listeners.pagehideAdded).toBe(1);
		expect(listeners.visibilityAdded).toBe(1);

		root.unmount();
		expect(timers.size).toBe(0);
		expect(listeners.pagehideRemoved).toBe(listeners.pagehideAdded);
		expect(listeners.visibilityRemoved).toBe(listeners.visibilityAdded);
	} finally {
		window.setInterval = originalSetInterval;
		window.clearInterval = originalClearInterval;
		window.addEventListener = originalWindowAdd;
		window.removeEventListener = originalWindowRemove;
		document.addEventListener = originalDocumentAdd;
		document.removeEventListener = originalDocumentRemove;
		host.remove();
	}
});

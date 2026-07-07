import type { PlaylistSummary, PodcastCollection, Track } from "@mineradio/shared";
import type { ShelfItem, ShelfPane } from "@mineradio/visual-engine";

function trackKey(track: Track | null): string {
	return track ? `${track.provider}:${track.id}` : "";
}

export function mapQueueToShelfItems(queue: Track[], currentTrack: Track | null): ShelfItem[] {
	const currentKey = trackKey(currentTrack);
	return queue.map((track, index) => {
		const artists = track.artists.filter(Boolean).join(" / ");
		return {
			type: "queue",
			title: track.title,
			sub: artists || track.album || "",
			cover: track.coverUrl,
			tag: trackKey(track) === currentKey ? "正在播放" : `#${index + 1}`,
			queueIndex: index,
			provider: track.provider,
		};
	});
}

function providerAbbr(provider: PlaylistSummary["provider"]): string {
	if (provider === "netease") return "NE";
	if (provider === "soda") return "SODA";
	return "QQ";
}

function playlistTag(playlist: PlaylistSummary): string {
	return playlist.subscribed ? "收藏歌单" : "我的歌单";
}

function playlistSub(provider: PlaylistSummary["provider"], trackCount: number | undefined): string {
	const prefix = providerAbbr(provider);
	if (typeof trackCount !== "number") return prefix;
	return `${prefix} · ${trackCount} 首`;
}

export function mapPlaylistsToShelfItems(playlists: PlaylistSummary[]): ShelfItem[] {
	return playlists
		.filter((playlist) => playlist.id && playlist.name)
		.map((playlist) => ({
			type: "playlist",
			title: playlist.name,
			sub: playlistSub(playlist.provider, playlist.trackCount),
			cover: playlist.coverUrl,
			tag: playlistTag(playlist),
			playlistId: playlist.id,
			provider: playlist.provider,
		}));
}

export interface ShelfContentSettings {
	showPodcasts: boolean;
	mergeCollections: boolean;
	pane?: ShelfPane;
}

function splitPlaylists(playlists: PlaylistSummary[]): { mine: PlaylistSummary[]; fav: PlaylistSummary[] } {
	const mine: PlaylistSummary[] = [];
	const fav: PlaylistSummary[] = [];
	for (const playlist of playlists) {
		(playlist.subscribed ? fav : mine).push(playlist);
	}
	return { mine, fav };
}

export function resolveActivePlaylists(
	playlists: PlaylistSummary[],
	settings?: Partial<Pick<ShelfContentSettings, "mergeCollections" | "pane">>,
): PlaylistSummary[] {
	const panes = splitPlaylists(playlists);
	if (settings?.mergeCollections === true) return [...panes.mine, ...panes.fav];
	if (settings?.pane === "fav") return panes.fav.length ? panes.fav : panes.mine;
	return panes.mine.length ? panes.mine : panes.fav;
}

export function mapPodcastCollectionsToShelfItems(collections: PodcastCollection[]): ShelfItem[] {
	return collections
		.filter((collection) => collection.key && collection.title)
		.map((collection) => ({
			type: "podcastCollection",
			title: collection.title,
			sub: `${collection.count || 0} items`,
			cover: collection.coverUrl,
			tag: "我的播客",
			podcastKey: collection.key,
			itemType: collection.itemType,
		}));
}

export function resolveShelfItems(input: {
	playlists: PlaylistSummary[];
	podcastCollections?: PodcastCollection[];
	queue: Track[];
	currentTrack: Track | null;
	settings?: Partial<ShelfContentSettings>;
}): ShelfItem[] {
	const settings = {
		showPodcasts: input.settings?.showPodcasts !== false,
		mergeCollections: input.settings?.mergeCollections === true,
		pane: input.settings?.pane === "fav" ? "fav" as const : "mine" as const,
	};
	const activePlaylists = resolveActivePlaylists(input.playlists, settings);
	const accountItems = [
		...mapPlaylistsToShelfItems(activePlaylists),
		...(settings.showPodcasts && (settings.pane === "mine" || settings.mergeCollections) ? mapPodcastCollectionsToShelfItems(input.podcastCollections ?? []) : []),
	];
	return accountItems.length > 0 ? accountItems : mapQueueToShelfItems(input.queue, input.currentTrack);
}

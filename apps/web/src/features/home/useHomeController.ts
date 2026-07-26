import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	DiscoverHomeResponse,
	Track,
	WeatherRadioResponse,
} from "@mineradio/shared";
import type { DiscoverPort } from "../../ports/music/discover-port";
import type { LibraryPort } from "../../ports/music/library-port";
import type { SearchExperiencePort } from "../../ports/music/search-port";
import type {
	HomeListenSummary,
	HomePlaylistDetailView,
} from "../../home/EmptyHomeHost";
import { trackLikeKey } from "../likes/likes-policy";
import {
	beginHomeListenSession,
	buildHomeListenSummary,
	isEffectiveHomeListenSession,
	shouldUseCachedHomeDiscoverPlaylist,
	updateHomeListenHistory,
	updateHomeListenSession,
	type HomeListenHistoryRecord,
	type HomeListenSession,
} from "./home-policy";

const HOME_LISTEN_STATS_STORE_KEY = "mineradio-listen-stats-v1";

export interface HomeListenStorage {
	read(): HomeListenHistoryRecord[];
	save(history: HomeListenHistoryRecord[]): void;
}

export interface HomeControllerResult {
	discover: DiscoverHomeResponse | null;
	weatherRadio: WeatherRadioResponse | null;
	playlistDetail: HomePlaylistDetailView | null;
	discoverLoading: boolean;
	weatherRadioLoading: boolean;
	forcedOpen: boolean;
	suppressed: boolean;
	listenSummary: HomeListenSummary | null;
	setForcedOpen(open: boolean): void;
	setSuppressed(suppressed: boolean): void;
	refreshDiscover(): Promise<DiscoverHomeResponse | null>;
	refreshWeatherRadio(): Promise<WeatherRadioResponse | null>;
	recordListenPause(): void;
	recordListenProgress(positionMs: number, durationMs: number | null): void;
	finalizeListenSession(completed?: boolean): void;
	playDaily(): void;
	playPrivate(): Promise<void>;
	playDiscoverSongs(index: number): Promise<void>;
	openPlaylist(index: number): Promise<void>;
	closePlaylistDetail(): void;
	playPlaylistDetail(index: number): void;
	searchPlaylistDetailArtist(artist: string): void;
	openPodcast(index: number): Promise<void>;
	openPodcastSearch(): void;
	playWeatherSong(index: number): Promise<void>;
	openInsight(): void;
	playRecent(): void;
	enterPlaybackSurface(): void;
}

function browserStorage(): HomeListenStorage {
	return {
		read() {
			if (typeof localStorage === "undefined") return [];
			try {
				const parsed = JSON.parse(
					localStorage.getItem(HOME_LISTEN_STATS_STORE_KEY) || "{}",
				) as { history?: unknown };
				const rawHistory = Array.isArray(parsed.history) ? parsed.history : [];
				return rawHistory.slice(0, 24).flatMap((item) => {
					if (!item || typeof item !== "object") return [];
					const record = item as Record<string, unknown>;
					const track = record.track as Track | undefined;
					if (!track?.id || !track.title) return [];
					return [
						{
							track,
							plays: Math.max(1, Number(record.plays) || 1),
							lastPlayedAt: Math.max(0, Number(record.lastPlayedAt) || 0),
							listenMs: Math.max(0, Number(record.listenMs) || 0),
							completed: Math.max(0, Number(record.completed) || 0),
						},
					];
				});
			} catch {
				return [];
			}
		},
		save(history) {
			if (typeof localStorage === "undefined") return;
			try {
				localStorage.setItem(
					HOME_LISTEN_STATS_STORE_KEY,
					JSON.stringify({ history: history.slice(0, 24), updatedAt: Date.now() }),
				);
			} catch {
				// 本地统计写入失败不应影响播放。
			}
		},
	};
}

const defaultStorage = browserStorage();

export function useHomeController({
	discover: discoverPort,
	library,
	search,
	currentTrack,
	positionMs,
	durationMs,
	providerLoggedIn,
	libraryPanelPinned,
	playback,
	searchQuery,
	openLogin,
	openLibrarySurface,
	enterPlaybackSurface,
	closeLibraryPanel,
	closeShelf,
	selectShelfPlaylist,
	setConsole,
	setMiniQueue,
	showToast,
	storage = defaultStorage,
	autoRefresh = true,
}: {
	discover: DiscoverPort | null;
	library: LibraryPort | null;
	search: SearchExperiencePort | null;
	currentTrack: Track | null;
	positionMs: number;
	durationMs: number | null;
	providerLoggedIn: boolean | (() => boolean);
	libraryPanelPinned: boolean;
	playback: { setQueue(tracks: Track[]): void; playAt(index: number): void };
	searchQuery(keyword: string, mode?: "song" | "podcast"): void;
	openLogin(): void;
	openLibrarySurface(): void;
	enterPlaybackSurface(): void;
	closeLibraryPanel(): void;
	closeShelf(): void;
	selectShelfPlaylist(id: string | null): void;
	setConsole(open: boolean): void;
	setMiniQueue(open: boolean): void;
	showToast(message: string): void;
	storage?: HomeListenStorage;
	autoRefresh?: boolean;
}): HomeControllerResult {
	const [discover, setDiscover] = useState<DiscoverHomeResponse | null>(null);
	const [weatherRadio, setWeatherRadio] = useState<WeatherRadioResponse | null>(
		null,
	);
	const [playlistDetail, setPlaylistDetail] =
		useState<HomePlaylistDetailView | null>(null);
	const [discoverLoading, setDiscoverLoading] = useState(false);
	const [weatherRadioLoading, setWeatherRadioLoading] = useState(false);
	const [forcedOpen, setForcedOpen] = useState(false);
	const [suppressed, setSuppressed] = useState(false);
	const [listenHistory, setListenHistory] = useState(storage.read);
	const discoverRequestRef = useRef(0);
	const weatherRequestRef = useRef(0);
	const lastListenKeyRef = useRef("");
	const listenSessionRef = useRef<HomeListenSession | null>(null);
	const playbackRef = useRef({ currentTrack, positionMs, durationMs });
	const dependenciesRef = useRef({
		discoverPort,
		library,
		search,
		providerLoggedIn,
		libraryPanelPinned,
		playback,
		searchQuery,
		openLogin,
		openLibrarySurface,
		enterPlaybackSurface,
		closeLibraryPanel,
		closeShelf,
		selectShelfPlaylist,
		setConsole,
		setMiniQueue,
		showToast,
		storage,
	});
	playbackRef.current = { currentTrack, positionMs, durationMs };
	dependenciesRef.current = {
		discoverPort,
		library,
		search,
		providerLoggedIn,
		libraryPanelPinned,
		playback,
		searchQuery,
		openLogin,
		openLibrarySurface,
		enterPlaybackSurface,
		closeLibraryPanel,
		closeShelf,
		selectShelfPlaylist,
		setConsole,
		setMiniQueue,
		showToast,
		storage,
	};
	const hasProviderLogin = useCallback(() => {
		const value = dependenciesRef.current.providerLoggedIn;
		return typeof value === "function" ? value() : value;
	}, []);

	const refreshDiscover = useCallback(async () => {
		const port = dependenciesRef.current.discoverPort;
		if (!port) {
			setDiscover(null);
			setDiscoverLoading(false);
			return null;
		}
		const sequence = ++discoverRequestRef.current;
		setDiscoverLoading(true);
		try {
			const next = await port.discoverHome();
			if (sequence === discoverRequestRef.current) setDiscover(next);
			return next;
		} catch {
			const fallback: DiscoverHomeResponse = {
				loggedIn: false,
				user: null,
				dailySongs: [],
				playlists: [],
				podcasts: [],
				mode: "starter",
				updatedAt: Date.now(),
			};
			if (sequence === discoverRequestRef.current) setDiscover(fallback);
			return fallback;
		} finally {
			if (sequence === discoverRequestRef.current) setDiscoverLoading(false);
		}
	}, []);

	const refreshWeatherRadio = useCallback(async () => {
		const port = dependenciesRef.current.discoverPort;
		if (!port) {
			setWeatherRadio(null);
			setWeatherRadioLoading(false);
			return null;
		}
		const sequence = ++weatherRequestRef.current;
		setWeatherRadioLoading(true);
		try {
			const next = await port.weatherRadio({
				city: "上海",
				timezone:
					typeof Intl !== "undefined"
						? Intl.DateTimeFormat().resolvedOptions().timeZone || "auto"
						: "auto",
			});
			if (sequence === weatherRequestRef.current) setWeatherRadio(next);
			return next;
		} catch {
			if (sequence === weatherRequestRef.current) setWeatherRadio(null);
			return null;
		} finally {
			if (sequence === weatherRequestRef.current) setWeatherRadioLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!autoRefresh) return;
		if (!discoverPort) {
			setDiscover(null);
			setWeatherRadio(null);
			setDiscoverLoading(false);
			setWeatherRadioLoading(false);
			return;
		}
		void refreshDiscover();
		void refreshWeatherRadio();
	}, [
		autoRefresh,
		discoverPort,
		typeof providerLoggedIn === "boolean" ? providerLoggedIn : false,
		refreshDiscover,
		refreshWeatherRadio,
	]);

	const finalizeListenSession = useCallback((completed = false) => {
		const snapshot = playbackRef.current;
		const session = updateHomeListenSession(
			listenSessionRef.current,
			snapshot.positionMs,
			snapshot.durationMs,
			Date.now(),
			true,
		);
		listenSessionRef.current = null;
		if (
			!session ||
			!isEffectiveHomeListenSession(session, completed, snapshot.durationMs)
		) {
			return;
		}
		setListenHistory((history) => {
			const next = updateHomeListenHistory(
				history,
				session.track,
				Date.now(),
				session.listenMs,
				completed,
			);
			dependenciesRef.current.storage.save(next);
			return next;
		});
	}, []);

	const recordListenPause = useCallback(() => {
		const snapshot = playbackRef.current;
		listenSessionRef.current = updateHomeListenSession(
			listenSessionRef.current,
			snapshot.positionMs,
			snapshot.durationMs,
			Date.now(),
			true,
		);
	}, []);

	const recordListenProgress = useCallback(
		(nextPositionMs: number, nextDurationMs: number | null) => {
			listenSessionRef.current = updateHomeListenSession(
				listenSessionRef.current,
				nextPositionMs,
				nextDurationMs,
				Date.now(),
			);
		},
		[],
	);

	useEffect(() => {
		const key = trackLikeKey(currentTrack);
		if (!currentTrack || !key) {
			finalizeListenSession(false);
			lastListenKeyRef.current = "";
			return;
		}
		if (key === lastListenKeyRef.current) return;
		finalizeListenSession(false);
		lastListenKeyRef.current = key;
		listenSessionRef.current = beginHomeListenSession(
			currentTrack,
			Date.now(),
			positionMs,
		);
	}, [currentTrack, finalizeListenSession, positionMs]);

	const hasLogin = useCallback(
		() => discover?.loggedIn || hasProviderLogin(),
		[discover?.loggedIn, hasProviderLogin],
	);

	const enterPlayback = useCallback(() => {
		setPlaylistDetail(null);
		setForcedOpen(false);
		setSuppressed(true);
		dependenciesRef.current.enterPlaybackSurface();
	}, []);

	const playDiscoverSongs = useCallback(
		async (index: number) => {
			const current = dependenciesRef.current;
			const nextDiscover = discover?.loggedIn ? discover : await refreshDiscover();
			if (!hasLogin() && !nextDiscover?.loggedIn) {
				current.openLogin();
				current.showToast("登录后同步你的今日歌曲");
				return;
			}
			const songs = nextDiscover?.dailySongs ?? [];
			const targetIndex = Math.max(0, Math.min(index, songs.length - 1));
			if (!songs.length || !songs[targetIndex]) {
				current.searchQuery(index > 0 ? "私人雷达" : "每日推荐", "song");
				return;
			}
			current.playback.setQueue(songs);
			current.playback.playAt(targetIndex);
			enterPlayback();
		},
		[discover, enterPlayback, hasLogin, refreshDiscover],
	);

	const playDaily = useCallback(() => {
		void playDiscoverSongs(0);
	}, [playDiscoverSongs]);

	const openPlaylist = useCallback(
		async (index: number) => {
			const current = dependenciesRef.current;
			const useCached = shouldUseCachedHomeDiscoverPlaylist(
				discover,
				hasProviderLogin(),
			);
			const nextDiscover = useCached ? discover : await refreshDiscover();
			const item = nextDiscover?.playlists[index];
			if (!item) {
				if (!hasLogin() && !nextDiscover?.loggedIn) current.searchQuery("", "song");
				else current.openLibrarySurface();
				return;
			}
			if (!current.library) {
				current.showToast("sidecar 未连接，稍后再试");
				return;
			}
			const key = `${item.provider}:${item.id}`;
			setPlaylistDetail({ key, playlist: item, tracks: [], loading: true });
			setSuppressed(false);
			setForcedOpen(true);
			current.setConsole(false);
			current.setMiniQueue(false);
			if (!current.libraryPanelPinned) current.closeLibraryPanel();
			current.closeShelf();
			current.selectShelfPlaylist(null);
			try {
				const detail = await current.library.playlistDetail(item.provider, item.id);
				setPlaylistDetail((value) =>
					value?.key === key
						? { key, playlist: detail, tracks: detail.tracks, loading: false }
						: value,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "歌单载入失败";
				setPlaylistDetail((value) =>
					value?.key === key
						? { ...value, loading: false, error: message, tracks: [] }
						: value,
				);
				current.showToast(message);
			}
		},
		[discover, hasLogin, hasProviderLogin, refreshDiscover],
	);

	const closePlaylistDetail = useCallback(() => setPlaylistDetail(null), []);

	const playPlaylistDetail = useCallback(
		(index: number) => {
			const current = dependenciesRef.current;
			const tracks = playlistDetail?.tracks ?? [];
			if (!playlistDetail || playlistDetail.loading) {
				current.showToast("歌单仍在载入");
				return;
			}
			if (!tracks.length) {
				current.showToast("歌单暂时没有可播放歌曲");
				return;
			}
			const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
			current.playback.setQueue(tracks);
			current.playback.playAt(safeIndex);
			const title = playlistDetail.playlist.name || "歌单";
			setPlaylistDetail(null);
			enterPlayback();
			current.showToast(title);
		},
		[enterPlayback, playlistDetail],
	);

	const searchPlaylistDetailArtist = useCallback((artist: string) => {
		const keyword = artist.trim();
		if (!keyword) return;
		setPlaylistDetail(null);
		dependenciesRef.current.searchQuery(keyword, "song");
	}, []);

	const playPrivate = useCallback(async () => {
		const current = dependenciesRef.current;
		const nextDiscover = discover?.loggedIn ? discover : await refreshDiscover();
		if (!hasLogin() && !nextDiscover?.loggedIn) {
			current.openLogin();
			current.showToast("登录后同步更多歌曲");
			return;
		}
		if (nextDiscover?.dailySongs.length) {
			await playDiscoverSongs(0);
			return;
		}
		if (nextDiscover?.playlists.length) {
			await openPlaylist(0);
			return;
		}
		current.openLibrarySurface();
	}, [discover, hasLogin, openPlaylist, playDiscoverSongs, refreshDiscover]);

	const playPodcastRadio = useCallback(async (id: string, title = "播客") => {
		const current = dependenciesRef.current;
		if (!id || !current.search) {
			current.searchQuery(title || "播客", "podcast");
			return;
		}
		try {
			const detail = await current.search.podcastPrograms(id, 30, 0);
			if (!detail.programs.length) {
				current.searchQuery(title || "播客", "podcast");
				return;
			}
			current.playback.setQueue(detail.programs);
			current.playback.playAt(0);
			enterPlayback();
			current.showToast(title || "播客");
		} catch (error) {
			current.showToast(error instanceof Error ? error.message : "播客载入失败");
		}
	}, [enterPlayback]);

	const openPodcast = useCallback(
		async (index: number) => {
			const nextDiscover = discover?.loggedIn ? discover : await refreshDiscover();
			const item = nextDiscover?.podcasts[index];
			if (!item) {
				dependenciesRef.current.searchQuery("", "podcast");
				return;
			}
			await playPodcastRadio(item.id, item.name || "播客");
		},
		[discover, playPodcastRadio, refreshDiscover],
	);

	const playWeatherSong = useCallback(
		async (index: number) => {
			const current = dependenciesRef.current;
			let radio = weatherRadio;
			if (!radio?.radio.songs.length) {
				current.showToast("正在生成天气电台");
				radio = await refreshWeatherRadio();
			}
			const songs = radio?.radio.songs ?? [];
			if (!songs.length) {
				const seed = radio?.radio.seedQueries[0] || "雨天 R&B";
				current.showToast("天气队列暂时为空，先打开搜索");
				current.searchQuery(seed, "song");
				return;
			}
			const targetIndex = Math.max(0, Math.min(index, songs.length - 1));
			current.playback.setQueue(songs);
			current.playback.playAt(targetIndex);
			enterPlayback();
			current.showToast(`${radio?.radio.title || "天气电台"} · ${songs.length} 首`);
		},
		[enterPlayback, refreshWeatherRadio, weatherRadio],
	);

	const openPodcastSearch = useCallback(() => {
		dependenciesRef.current.searchQuery("", "podcast");
	}, []);

	const listenSummary = useMemo(
		() => buildHomeListenSummary(listenHistory),
		[listenHistory],
	);

	const openInsight = useCallback(() => {
		const current = dependenciesRef.current;
		const artist = listenSummary?.topArtist?.name;
		if (artist) {
			current.searchQuery(artist);
			return;
		}
		const song = listenSummary?.topSong?.track.title;
		if (song) {
			current.searchQuery(song);
			return;
		}
		current.showToast("播放几首歌后会生成听歌画像");
	}, [listenSummary]);

	const playRecent = useCallback(() => {
		const current = dependenciesRef.current;
		const track = listenSummary?.recent?.track;
		if (track) {
			current.playback.setQueue([track]);
			current.playback.playAt(0);
			enterPlayback();
			return;
		}
		current.showToast("还没有听歌记录");
	}, [enterPlayback, listenSummary]);

	return {
		discover,
		weatherRadio,
		playlistDetail,
		discoverLoading,
		weatherRadioLoading,
		forcedOpen,
		suppressed,
		listenSummary,
		setForcedOpen,
		setSuppressed,
		refreshDiscover,
		refreshWeatherRadio,
		recordListenPause,
		recordListenProgress,
		finalizeListenSession,
		playDaily,
		playPrivate,
		playDiscoverSongs,
		openPlaylist,
		closePlaylistDetail,
		playPlaylistDetail,
		searchPlaylistDetailArtist,
		openPodcast,
		openPodcastSearch,
		playWeatherSong,
		openInsight,
		playRecent,
		enterPlaybackSurface: enterPlayback,
	};
}

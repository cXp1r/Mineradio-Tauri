import { type CSSProperties, type ReactElement } from "react";
import type { DiscoverHomeResponse, PlaylistSummary, PodcastRadio, Track, WeatherRadioResponse } from "@mineradio/shared";

export interface EmptyHomeHostProps {
	discover?: DiscoverHomeResponse | null;
	weatherRadio?: WeatherRadioResponse | null;
	listenSummary?: HomeListenSummary | null;
	active?: boolean;
	loading?: boolean;
	isPlaying?: boolean;
	positionMs?: number;
	durationMs?: number | null;
	onSearchFocus?: () => void;
	onOpenLibrary?: () => void;
	onOpenConsole?: () => void;
	onSearchQuery?: (query: string) => void;
	onUpload?: () => void;
	onGuide?: () => void;
	onOpenLogin?: () => void;
	onPlayDaily?: () => void;
	onPlayPrivate?: () => void;
	onPlaySong?: (index: number) => void;
	onOpenPlaylist?: (index: number) => void;
	onOpenPodcast?: (index: number) => void;
	onOpenPodcastSearch?: () => void;
	onOpenInsight?: () => void;
	onPlayRecent?: () => void;
	onPlayWeatherSong?: (index: number) => void;
}

export interface HomeListenRecord {
	track: Track;
	plays: number;
}

export interface HomeListenSummary {
	recent?: HomeListenRecord | null;
	topSong?: HomeListenRecord | null;
	topArtist?: { name: string; plays: number; coverUrl?: string } | null;
	totalPlays?: number;
}

interface HomeWaveBar {
	height: number;
	opacity: number;
}

interface HomeWaveFrame {
	bars: HomeWaveBar[];
	smooth: number[];
}

const HOME_WAVE_BAR_COUNT = 24;
const HOME_RAIL_MAX_TILES = 32;
const HOME_RAIL_PRIMARY_SONG_COUNT = 4;

const STARTER_TILES = [
	{ kind: "login", tone: "library", title: "登录同步歌单", sub: "网易云 / QQ 音乐", action: "Login" },
	{ kind: "search", tone: "search", title: "搜索一首歌", sub: "原唱优先", action: "Search", query: "" },
	{ kind: "local", tone: "local", title: "导入本地音乐", sub: "本地文件也能可视化", action: "Import" },
	{ kind: "podcastSearch", tone: "podcast", title: "搜索播客", sub: "长内容 / 电台", action: "Podcast" },
	{ kind: "guide", tone: "guide", title: "看看视觉舞台", sub: "粒子 / 歌词 / 封面", action: "Visual" },
] as const;

type StarterTile = (typeof STARTER_TILES)[number];

type HomeTile =
	| StarterTile
	| { kind: "recent"; tone: string; title: string; sub: string; action: string; record: HomeListenRecord; coverUrl?: string }
	| { kind: "profile"; tone: string; title: string; sub: string; action: string; query: string; coverUrl?: string }
	| { kind: "song"; tone: string; title: string; sub: string; action: string; index: number; coverUrl?: string }
	| { kind: "playlist"; tone: string; title: string; sub: string; action: string; index: number; coverUrl?: string }
	| { kind: "podcast"; tone: string; title: string; sub: string; action: string; index: number; coverUrl?: string }
	| { kind: "weatherSong"; tone: string; title: string; sub: string; action: string; index: number; coverUrl?: string };

function artistLine(track: Track | null | undefined, fallback = "推荐歌曲"): string {
	if (!track) return fallback;
	return track.artists.length ? track.artists.join(" / ") : fallback;
}

function coverStyle(url: string | undefined): CSSProperties | undefined {
	return url ? { backgroundImage: `url("${url}")` } : undefined;
}

function clampHomeWave(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function buildHomeWaveFrame(input: {
	timeMs: number;
	isPlaying?: boolean;
	positionMs?: number;
	durationMs?: number | null;
}, previous: number[] = []): HomeWaveFrame {
	const smooth = Array.from({ length: HOME_WAVE_BAR_COUNT }, (_, index) => previous[index] || 0);
	const nowT = Math.max(0, input.timeMs) / 1000;
	const positionSeconds = Math.max(0, Number(input.positionMs || 0)) / 1000;
	const progress = input.durationMs && input.durationMs > 0
		? clampHomeWave(Number(input.positionMs || 0) / input.durationMs, 0, 1)
		: 0;
	const playingPulse = input.isPlaying
		? 0.16 + Math.abs(Math.sin(positionSeconds * 2.15 + progress * Math.PI)) * 0.26
		: 0;
	const bars = smooth.map((previousValue, index) => {
		const ratio = HOME_WAVE_BAR_COUNT > 1 ? index / (HOME_WAVE_BAR_COUNT - 1) : 0;
		const fallbackBin = 0.16 + Math.sin(nowT * 1.4 + index * 0.34) * 0.06;
		const beatPulse = input.isPlaying ? Math.abs(Math.sin(positionSeconds * 4.2 + index * 0.08)) * 0.24 : 0;
		const target = clampHomeWave(Math.max(
			fallbackBin,
			playingPulse * 0.35 + fallbackBin * 0.18 + beatPulse * 0.24 + ratio * 0.018,
		), 0.03, 1);
		const next = previousValue + (target - previousValue) * (target > previousValue ? 0.34 : 0.12);
		smooth[index] = next;
		return {
			height: Math.max(4, next * 18),
			opacity: clampHomeWave(0.36 + next * 0.68, 0.32, 1),
		};
	});
	return { bars, smooth };
}

function cardCoverClass(url: string | undefined): string {
	return url ? "home-card-art has-cover" : "home-card-art";
}

function playlistSub(playlist: PlaylistSummary | null | undefined): string {
	if (!playlist) return "打开左侧歌单库";
	return `${playlist.trackCount ? `${playlist.trackCount} 首 · ` : ""}打开左侧歌单库`;
}

function podcastSub(podcast: PodcastRadio | null | undefined): string {
	if (!podcast) return "长内容 / 电台";
	return podcast.djName || podcast.category || "Podcast";
}

function pushTile(tiles: HomeTile[], tile: HomeTile, max = HOME_RAIL_MAX_TILES): void {
	if (tiles.length < max) tiles.push(tile);
}

function buildHomeTiles(
	discover: DiscoverHomeResponse | null | undefined,
	weatherRadio: WeatherRadioResponse | null | undefined,
	listenSummary: HomeListenSummary | null | undefined,
): HomeTile[] {
	const weatherSongs = weatherRadio?.radio.songs ?? [];
	const playlists = discover?.playlists ?? [];
	const podcasts = discover?.podcasts ?? [];
	const tiles: HomeTile[] = [];

	if (listenSummary?.recent?.track) {
		const recent = listenSummary.recent;
		pushTile(tiles, {
			kind: "recent",
			tone: "search",
			title: recent.track.title || "继续听",
			sub: artistLine(recent.track, "最近播放"),
			action: "Play",
			record: recent,
			coverUrl: recent.track.coverUrl,
		});
	}

	if (listenSummary?.topArtist?.name) {
		pushTile(tiles, {
			kind: "profile",
			tone: "local",
			title: listenSummary.topArtist.name,
			sub: `常听歌手 · ${listenSummary.topArtist.plays} 次`,
			action: "Search",
			query: listenSummary.topArtist.name,
			coverUrl: listenSummary.topArtist.coverUrl,
		});
	}

	if (!discover?.loggedIn) {
		playlists.forEach((playlist, index) => pushTile(tiles, {
			kind: "playlist",
			tone: "playlist",
			title: playlist.name || "推荐歌单",
			sub: playlist.trackCount ? `${playlist.trackCount} 首 · 公开推荐` : "公开推荐",
			action: "Open",
			index,
			coverUrl: playlist.coverUrl,
		}));
		weatherSongs.forEach((song, index) => pushTile(tiles, {
			kind: "weatherSong",
			tone: "daily",
			title: song.title || "天气电台歌曲",
			sub: artistLine(song, "天气电台"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		}));
		if (playlists.length || !weatherSongs.length) {
			STARTER_TILES.forEach((tile) => pushTile(tiles, tile));
		}
		return tiles.length ? tiles.slice(0, HOME_RAIL_MAX_TILES) : [...STARTER_TILES];
	}

	discover.dailySongs.slice(0, HOME_RAIL_PRIMARY_SONG_COUNT).forEach((song, index) => {
		pushTile(tiles, {
			kind: "song",
			tone: index % 2 ? "search" : "daily",
			title: song.title || "今日歌曲",
			sub: artistLine(song, "今日歌曲"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		});
	});

	playlists.forEach((playlist, index) => {
		pushTile(tiles, {
			kind: "playlist",
			tone: "playlist",
			title: playlist.name || "推荐歌单",
			sub: playlist.trackCount ? `${playlist.trackCount} 首` : "Playlist",
			action: "Open",
			index,
			coverUrl: playlist.coverUrl,
		});
	});

	podcasts.forEach((podcast, index) => {
		pushTile(tiles, {
			kind: "podcast",
			tone: "podcast",
			title: podcast.name || "热门播客",
			sub: podcastSub(podcast),
			action: "Podcast",
			index,
			coverUrl: podcast.coverUrl,
		});
	});

	weatherSongs.forEach((song, index) => {
		pushTile(tiles, {
			kind: "weatherSong",
			tone: "daily",
			title: song.title || "天气电台歌曲",
			sub: artistLine(song, "天气电台"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		});
	});

	return tiles.length ? tiles.slice(0, HOME_RAIL_MAX_TILES) : [...STARTER_TILES];
}

function homeTileCover(tile: HomeTile): string | undefined {
	return "coverUrl" in tile ? tile.coverUrl : undefined;
}

function homeTileKey(tile: HomeTile, index: number): string {
	if (tile.kind === "song" || tile.kind === "playlist" || tile.kind === "podcast" || tile.kind === "weatherSong") {
		return `${tile.kind}:${tile.index}:${tile.title}`;
	}
	if (tile.kind === "recent") return `${tile.kind}:${tile.record.track.provider}:${tile.record.track.id}`;
	if (tile.kind === "profile") return `${tile.kind}:${tile.query}`;
	return `${tile.kind}:${index}:${tile.title}`;
}

function handleTileAction(props: EmptyHomeHostProps, tile: HomeTile): void {
	if (tile.kind === "login") props.onOpenLogin?.();
	else if (tile.kind === "search") props.onSearchQuery?.(tile.query ?? "") ?? props.onSearchFocus?.();
	else if (tile.kind === "local") props.onUpload?.();
	else if (tile.kind === "podcastSearch") props.onOpenPodcastSearch?.();
	else if (tile.kind === "guide") props.onGuide?.();
	else if (tile.kind === "recent") props.onPlayRecent?.();
	else if (tile.kind === "profile") props.onOpenInsight?.();
	else if (tile.kind === "song") props.onPlaySong?.(tile.index);
	else if (tile.kind === "playlist") props.onOpenPlaylist?.(tile.index);
	else if (tile.kind === "podcast") props.onOpenPodcast?.(tile.index);
	else if (tile.kind === "weatherSong") props.onPlayWeatherSong?.(tile.index);
}

export function EmptyHomeHost(props: EmptyHomeHostProps): ReactElement {
	const discover = props.discover ?? null;
	const loggedOut = !discover?.loggedIn;
	const hasWeatherSongs = !!props.weatherRadio?.radio.songs.length;
	const daily = discover?.dailySongs[0] ?? null;
	const privateSong = discover?.dailySongs[1] ?? null;
	const thirdSong = discover?.dailySongs[2] ?? null;
	const firstPlaylist = discover?.playlists[0] ?? null;
	const firstPodcast = discover?.podcasts[0] ?? null;
	const listenSummary = props.listenSummary ?? null;
	const tiles = buildHomeTiles(discover, props.weatherRadio, listenSummary);
	const loading = props.loading === true;
	const hasPublicRecommendations = loggedOut && (discover?.playlists.length ?? 0) > 0;
	const libraryCover = firstPlaylist?.coverUrl || daily?.coverUrl;
	const dailyCover = daily?.coverUrl;
	const privateCover = privateSong?.coverUrl || daily?.coverUrl || firstPlaylist?.coverUrl;
	const recentTrack = listenSummary?.recent?.track ?? null;
	const topSong = listenSummary?.topSong?.track ?? null;
	const topArtist = listenSummary?.topArtist ?? null;
	const continueCover = recentTrack?.coverUrl || firstPlaylist?.coverUrl;
	const profileCover = topSong?.coverUrl || topArtist?.coverUrl || firstPodcast?.coverUrl;
	const moreCover = thirdSong?.coverUrl || topSong?.coverUrl || recentTrack?.coverUrl || firstPodcast?.coverUrl;

	return (
		<section id="empty-home" aria-label="Mineradio home">
			<div className="empty-home-shell">
				<div className="home-hero">
					<div className="home-hero-inner home-construction-inner">
						<div className="home-title home-construction-title">🚧此处施工，敬请期待🚧</div>
						<button className="home-chip home-console-chip" data-home-chip="console" type="button" onClick={props.onOpenConsole}>
							展开播放器控制台
						</button>
					</div>
				</div>

				<div className="home-grid">
					<button className="home-card" data-home-card="library" data-home-tone="library" type="button" onClick={props.onOpenLibrary}>
						<div className="home-card-label">Library</div>
						<div className="home-card-title" id="home-weather-card-title">我的歌单</div>
						<div className="home-card-sub" id="home-weather-card-sub">{playlistSub(firstPlaylist)}</div>
						<div className={cardCoverClass(libraryCover)} id="home-weather-art" style={coverStyle(libraryCover)} />
					</button>
					<button className="home-card" data-home-card="daily" data-home-tone="mix" type="button" onClick={props.onPlayDaily}>
						<div className="home-card-label">Daily</div>
						<div className="home-card-title" id="home-daily-title">{loggedOut ? "每日推荐" : (daily?.title || "每日推荐")}</div>
						<div className="home-card-sub" id="home-daily-sub">{loggedOut ? "登录后同步你的今日歌曲" : (daily ? `${artistLine(daily, "今日歌曲")} · 点击播放今日队列` : "同步你的今日歌曲")}</div>
						<div className={cardCoverClass(dailyCover)} id="home-daily-art" style={coverStyle(dailyCover)} />
					</button>
					<button
						className="home-card"
						data-home-card="private"
						data-home-tone="playlist"
						type="button"
						onClick={props.onPlayPrivate}
					>
						<div className="home-card-label">Song</div>
						<div className="home-card-title" id="home-private-title">{loggedOut ? "推荐歌曲" : (privateSong?.title || "私人雷达")}</div>
						<div className="home-card-sub" id="home-private-sub">{loggedOut ? "登录后同步更多歌曲" : (privateSong ? artistLine(privateSong) : `${discover?.dailySongs.length ?? 0} 首 · 根据今日推荐与常听偏好`)}</div>
						<div className={cardCoverClass(privateCover)} id="home-private-art" style={coverStyle(privateCover)} />
					</button>
					<button className="home-card" data-home-card="continue" data-home-tone="mix" type="button" onClick={props.onPlayRecent}>
						<div className="home-card-label">Continue</div>
						<div className="home-card-title" id="home-continue-title">{recentTrack?.title || "继续听"}</div>
						<div className="home-card-sub" id="home-continue-sub">{recentTrack ? artistLine(recentTrack, "最近播放") : "最近播放会出现在这里"}</div>
						<div className={cardCoverClass(continueCover)} id="home-continue-art" style={coverStyle(continueCover)} />
					</button>
					<button className="home-card" data-home-card="profile" data-home-tone="local" type="button" onClick={props.onOpenInsight}>
						<div className="home-card-label">Profile</div>
						<div className="home-card-title" id="home-profile-title">{topArtist?.name || topSong?.title || "听歌画像"}</div>
						<div className="home-card-sub" id="home-profile-sub">{topArtist ? `常听歌手 · ${topArtist.plays} 次` : (listenSummary?.totalPlays ? `${listenSummary.totalPlays} 次有效播放` : "播放几首后生成偏好")}</div>
						<div className={cardCoverClass(profileCover)} id="home-profile-art" style={coverStyle(profileCover)} />
					</button>
					<button className="home-card" data-home-card="more" data-home-tone="local" type="button" onClick={() => props.onPlaySong?.(2)}>
						<div className="home-card-label">Song</div>
						<div className="home-card-title" id="home-library-title">{loggedOut ? "更多歌曲" : (thirdSong?.title || topArtist?.name || "更多歌曲")}</div>
						<div className="home-card-sub" id="home-library-sub">{loggedOut ? "播放后会继续补全推荐" : (thirdSong ? artistLine(thirdSong) : (topArtist ? `歌手偏好 · ${topArtist.plays} 次` : "播放几首后生成你的偏好"))}</div>
						<div className={cardCoverClass(moreCover)} id="home-library-art" style={coverStyle(moreCover)} />
					</button>
				</div>

				<div className="home-rail">
					<div className="home-section-head">
						<div className="home-section-title" id="home-rail-title">{loggedOut ? (hasPublicRecommendations ? "推荐歌单与开始探索" : "先从这里开始") : "你的歌单与推荐"}</div>
						<div className="home-section-note" id="home-rail-note">{loggedOut && !hasWeatherSongs && !hasPublicRecommendations ? "正在等待推荐源" : "刚刚更新 · 点击即可播放"}</div>
					</div>
					<div id="home-tile-row" className="home-tile-row">
						{tiles.map((tile, index) => (
							<button
								className={`home-tile${!homeTileCover(tile) && loading ? " home-skeleton" : ""}`}
								data-home-tone={tile.tone}
								type="button"
								aria-label={`${tile.title} ${tile.action}`}
								title={tile.action}
								onClick={() => handleTileAction(props, tile)}
								key={homeTileKey(tile, index)}
							>
								<div className={`home-tile-cover${"coverUrl" in tile && tile.coverUrl ? " has-cover" : ""}`} style={"coverUrl" in tile ? coverStyle(tile.coverUrl) : undefined} />
								<div className="home-tile-title">{tile.title}</div>
								<div className="home-tile-sub">{tile.sub}</div>
							</button>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

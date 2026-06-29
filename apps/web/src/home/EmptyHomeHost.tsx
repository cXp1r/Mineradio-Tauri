import type { CSSProperties, ReactElement } from "react";
import type { DiscoverHomeResponse, PlaylistSummary, PodcastRadio, Track, WeatherRadioResponse } from "@mineradio/shared";

export interface EmptyHomeHostProps {
	discover?: DiscoverHomeResponse | null;
	weatherRadio?: WeatherRadioResponse | null;
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

const STARTER_TILES = [
	{ kind: "login", tone: "library", title: "登录同步歌单", sub: "网易云 / QQ 音乐", action: "Login" },
	{ kind: "search", tone: "search", title: "搜索一首歌", sub: "原唱优先", action: "Search", query: "" },
	{ kind: "local", tone: "local", title: "导入本地音乐", sub: "本地文件也能可视化", action: "Import" },
	{ kind: "podcastSearch", tone: "podcast", title: "搜索播客", sub: "长内容 / 电台", action: "Podcast" },
	{ kind: "guide", tone: "guide", title: "看看视觉舞台", sub: "粒子 / 歌词 / 封面", action: "Visual" },
] as const;

type HomeTile =
	| (typeof STARTER_TILES)[number]
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

function playlistSub(playlist: PlaylistSummary | null | undefined): string {
	if (!playlist) return "打开左侧歌单库";
	return `${playlist.trackCount ? `${playlist.trackCount} 首 · ` : ""}打开左侧歌单库`;
}

function podcastSub(podcast: PodcastRadio | null | undefined): string {
	if (!podcast) return "长内容 / 电台";
	return podcast.djName || podcast.category || "Podcast";
}

function buildHomeTiles(
	discover: DiscoverHomeResponse | null | undefined,
	weatherRadio: WeatherRadioResponse | null | undefined,
): HomeTile[] {
	const weatherSongs = weatherRadio?.radio.songs ?? [];
	if (!discover?.loggedIn && weatherSongs.length) {
		return weatherSongs.slice(0, 5).map((song, index) => ({
			kind: "weatherSong",
			tone: "daily",
			title: song.title || "天气电台歌曲",
			sub: artistLine(song, "天气电台"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		}));
	}
	if (!discover?.loggedIn) return [...STARTER_TILES];
	const tiles: HomeTile[] = [];
	discover.dailySongs.slice(0, 4).forEach((song, index) => {
		tiles.push({
			kind: "song",
			tone: index % 2 ? "search" : "daily",
			title: song.title || "今日歌曲",
			sub: artistLine(song, "今日歌曲"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		});
	});
	discover.playlists.slice(0, Math.max(0, 5 - tiles.length)).forEach((playlist, index) => {
		tiles.push({
			kind: "playlist",
			tone: "playlist",
			title: playlist.name || "推荐歌单",
			sub: playlist.trackCount ? `${playlist.trackCount} 首` : "Playlist",
			action: "Open",
			index,
			coverUrl: playlist.coverUrl,
		});
	});
	discover.podcasts.slice(0, Math.max(0, 5 - tiles.length)).forEach((podcast, index) => {
		tiles.push({
			kind: "podcast",
			tone: "podcast",
			title: podcast.name || "热门播客",
			sub: podcastSub(podcast),
			action: "Podcast",
			index,
			coverUrl: podcast.coverUrl,
		});
	});
	weatherSongs.slice(0, Math.max(0, 5 - tiles.length)).forEach((song, index) => {
		tiles.push({
			kind: "weatherSong",
			tone: "daily",
			title: song.title || "天气电台歌曲",
			sub: artistLine(song, "天气电台"),
			action: "Play",
			index,
			coverUrl: song.coverUrl,
		});
	});
	return tiles.length ? tiles.slice(0, 5) : [...STARTER_TILES];
}

function handleTileAction(props: EmptyHomeHostProps, tile: HomeTile): void {
	if (tile.kind === "login") props.onOpenLogin?.();
	else if (tile.kind === "search") props.onSearchQuery?.(tile.query ?? "") ?? props.onSearchFocus?.();
	else if (tile.kind === "local") props.onUpload?.();
	else if (tile.kind === "podcastSearch") props.onOpenPodcastSearch?.();
	else if (tile.kind === "guide") props.onGuide?.();
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
	const tiles = buildHomeTiles(discover, props.weatherRadio);

	return (
		<section id="empty-home" aria-label="Mineradio home">
			<div className="empty-home-shell">
				<div className="home-hero">
					<div className="home-hero-inner home-construction-inner">
						<div className="home-title home-construction-title">🚧此处施工，敬请期待🚧</div>
						<button className="home-chip home-console-chip" type="button" onClick={props.onOpenConsole}>
							展开播放器控制台
						</button>
					</div>
				</div>

				<div className="home-grid">
					<button className="home-card" data-home-card="library" data-home-tone="library" type="button" onClick={props.onOpenLibrary}>
						<div className="home-card-label">Library</div>
						<div className="home-card-title" id="home-weather-card-title">我的歌单</div>
						<div className="home-card-sub" id="home-weather-card-sub">{playlistSub(firstPlaylist)}</div>
						<div className="home-card-art" id="home-weather-art" style={coverStyle(firstPlaylist?.coverUrl || daily?.coverUrl)} />
					</button>
					<button className="home-card" data-home-card="daily" data-home-tone="mix" type="button" onClick={props.onPlayDaily}>
						<div className="home-card-label">Daily</div>
						<div className="home-card-title" id="home-daily-title">{loggedOut ? "每日推荐" : (daily?.title || "每日推荐")}</div>
						<div className="home-card-sub" id="home-daily-sub">{loggedOut ? "登录后同步你的今日歌曲" : (daily ? `${artistLine(daily, "今日歌曲")} · 点击播放今日队列` : "同步你的今日歌曲")}</div>
						<div className="home-card-art" id="home-daily-art" style={coverStyle(daily?.coverUrl)} />
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
						<div className="home-card-art" id="home-private-art" style={coverStyle(privateSong?.coverUrl || daily?.coverUrl || firstPlaylist?.coverUrl)} />
					</button>
					<button className="home-card" data-home-card="continue" data-home-tone="mix" type="button" onClick={props.onPlayRecent}>
						<div className="home-card-label">Continue</div>
						<div className="home-card-title" id="home-continue-title">继续听</div>
						<div className="home-card-sub" id="home-continue-sub">最近播放会出现在这里</div>
						<div className="home-card-art" id="home-continue-art" style={coverStyle(firstPlaylist?.coverUrl)} />
					</button>
					<button className="home-card" data-home-card="profile" data-home-tone="local" type="button" onClick={props.onOpenInsight}>
						<div className="home-card-label">Profile</div>
						<div className="home-card-title" id="home-profile-title">听歌画像</div>
						<div className="home-card-sub" id="home-profile-sub">播放几首后生成偏好</div>
						<div className="home-card-art" id="home-profile-art" style={coverStyle(firstPodcast?.coverUrl)} />
					</button>
					<button className="home-card" data-home-card="more" data-home-tone="local" type="button" onClick={() => props.onPlaySong?.(2)}>
						<div className="home-card-label">Song</div>
						<div className="home-card-title" id="home-library-title">{loggedOut ? "更多歌曲" : (thirdSong?.title || "更多歌曲")}</div>
						<div className="home-card-sub" id="home-library-sub">{loggedOut ? "播放后会继续补全推荐" : (thirdSong ? artistLine(thirdSong) : "播放几首后生成你的偏好")}</div>
						<div className="home-card-art" id="home-library-art" style={coverStyle(thirdSong?.coverUrl || firstPodcast?.coverUrl)} />
					</button>
				</div>

				<div className="home-rail">
					<div className="home-section-head">
						<div className="home-section-title" id="home-rail-title">{loggedOut ? "先从这里开始" : "你的歌单与推荐"}</div>
						<div className="home-section-note" id="home-rail-note">{loggedOut && !hasWeatherSongs ? "不会自动拉取外部推荐" : "刚刚更新 · 点击即可播放"}</div>
					</div>
					<div id="home-tile-row" className="home-tile-row">
						{tiles.map((tile) => (
							<button
								className="home-tile"
								data-home-tone={tile.tone}
								type="button"
								onClick={() => handleTileAction(props, tile)}
								key={tile.title}
							>
								<div className={`home-tile-cover${"coverUrl" in tile && tile.coverUrl ? " has-cover" : ""}`} style={"coverUrl" in tile ? coverStyle(tile.coverUrl) : undefined} />
								<div className="home-tile-title">{tile.title}</div>
								<div className="home-tile-sub">{tile.sub}</div>
								<div className="home-tile-action">{tile.action}</div>
							</button>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

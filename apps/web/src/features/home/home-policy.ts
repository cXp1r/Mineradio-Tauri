import type { DiscoverHomeResponse, Track } from "@mineradio/shared";
import type { HomeListenRecord, HomeListenSummary } from "../../home/EmptyHomeHost";
import { trackLikeKey } from "../likes/likes-policy";

export interface HomeListenHistoryRecord extends HomeListenRecord {
	lastPlayedAt: number;
	listenMs: number;
	completed: number;
}

export interface HomeListenSession {
	key: string;
	track: Track;
	startedAt: number;
	lastWallAt: number;
	lastPositionMs: number;
	listenMs: number;
	maxProgress: number;
}

export function shouldUseCachedHomeDiscoverPlaylist(
	discover: DiscoverHomeResponse | null | undefined,
	hasProviderLogin: boolean,
): boolean {
	return (
		!!discover?.loggedIn ||
		(!hasProviderLogin && (discover?.playlists.length ?? 0) > 0)
	);
}

export function updateHomeListenHistory(
	history: HomeListenHistoryRecord[],
	track: Track | null,
	now: number,
	listenMs = 0,
	completed = false,
): HomeListenHistoryRecord[] {
	if (!track?.id || !track.title) return history;
	const key =
		trackLikeKey(track) || `${track.provider}:${track.sourceId || track.title}`;
	const existing = history.find((record) => {
		const recordKey =
			trackLikeKey(record.track) ||
			`${record.track.provider}:${record.track.sourceId || record.track.title}`;
		return recordKey === key;
	});
	const nextRecord: HomeListenHistoryRecord = {
		track,
		plays: (existing?.plays ?? 0) + 1,
		lastPlayedAt: now,
		listenMs: (existing?.listenMs ?? 0) + Math.round(listenMs),
		completed: (existing?.completed ?? 0) + (completed ? 1 : 0),
	};
	return [nextRecord, ...history.filter((record) => record !== existing)].slice(
		0,
		24,
	);
}

export function beginHomeListenSession(
	track: Track | null,
	now: number,
	positionMs = 0,
): HomeListenSession | null {
	const key = trackLikeKey(track);
	if (!track || !key) return null;
	return {
		key,
		track,
		startedAt: now,
		lastWallAt: now,
		lastPositionMs: positionMs,
		listenMs: 0,
		maxProgress: 0,
	};
}

export function updateHomeListenSession(
	session: HomeListenSession | null,
	positionMs: number,
	durationMs: number | null,
	now: number,
	force = false,
): HomeListenSession | null {
	if (!session) return null;
	const deltaByAudio = Math.max(0, positionMs - session.lastPositionMs);
	const deltaByWall = Math.max(0, now - session.lastWallAt);
	let delta =
		deltaByAudio > 0
			? Math.min(deltaByAudio, deltaByWall || deltaByAudio, 4200)
			: 0;
	if (force && delta <= 0) delta = Math.min(deltaByWall, 1500);
	return {
		...session,
		listenMs:
			delta > 0 && delta < 8000 ? session.listenMs + delta : session.listenMs,
		lastWallAt: now,
		lastPositionMs: positionMs,
		maxProgress:
			durationMs && durationMs > 0
				? Math.max(session.maxProgress, positionMs / durationMs)
				: session.maxProgress,
	};
}

export function isEffectiveHomeListenSession(
	session: HomeListenSession,
	completed: boolean,
	durationMs: number | null,
): boolean {
	return (
		completed ||
		session.listenMs >= 45_000 ||
		session.maxProgress >= 0.5 ||
		(!durationMs && session.listenMs >= 30_000)
	);
}

export function buildHomeListenSummary(
	history: HomeListenHistoryRecord[],
): HomeListenSummary | null {
	if (!history.length) return null;
	const recent =
		[...history].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)[0] ?? null;
	const topSong =
		[...history].sort(
			(a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt,
		)[0] ?? null;
	const artistCounts = new Map<
		string,
		{ plays: number; coverUrl?: string; lastPlayedAt: number }
	>();
	for (const record of history) {
		for (const artist of record.track.artists ?? []) {
			if (!artist) continue;
			const current = artistCounts.get(artist) ?? {
				plays: 0,
				coverUrl: record.track.coverUrl,
				lastPlayedAt: 0,
			};
			current.plays += record.plays;
			if (!current.coverUrl) current.coverUrl = record.track.coverUrl;
			current.lastPlayedAt = Math.max(
				current.lastPlayedAt,
				record.lastPlayedAt,
			);
			artistCounts.set(artist, current);
		}
	}
	const topArtistEntry = [...artistCounts.entries()].sort(
		(a, b) => b[1].plays - a[1].plays || b[1].lastPlayedAt - a[1].lastPlayedAt,
	)[0];
	return {
		recent,
		topSong,
		topArtist: topArtistEntry
			? {
					name: topArtistEntry[0],
					plays: topArtistEntry[1].plays,
					coverUrl: topArtistEntry[1].coverUrl,
				}
			: null,
		totalPlays: history.reduce((sum, record) => sum + record.plays, 0),
	};
}

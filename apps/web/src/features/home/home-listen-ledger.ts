import type { Track } from "@mineradio/shared";
import { trackLikeKey } from "../likes/likes-policy";

export const HOME_LISTEN_LEDGER_VERSION = 2 as const;
export const HOME_LISTEN_RECENT_LIMIT = 24;
export const HOME_LISTEN_DAILY_RETENTION_DAYS = 120;
// 仅最新活跃日保留精确指纹；4096 首高于有效会话一天内的物理播放上限。
export const HOME_LISTEN_DAILY_TRACK_KEY_LIMIT = 4_096;
export const HOME_LISTEN_ARTIST_LIMIT = 48;
export const HOME_LISTEN_TRACK_ARTIST_LIMIT = 8;
export const HOME_LISTEN_TRACK_QUALITY_HINT_LIMIT = 8;
export const HOME_LISTEN_TRACK_ID_LIMIT = 256;
export const HOME_LISTEN_TRACK_TEXT_LIMIT = 256;
export const HOME_LISTEN_ARTIST_NAME_LIMIT = 128;
export const HOME_LISTEN_TRACK_URL_LIMIT = 2_048;
export const HOME_LISTEN_LEDGER_TARGET_BYTES = 192 * 1024 - 1;

const HOME_LISTEN_SESSION_ID_LIMIT = 256;
const HOME_LISTEN_QUALITY_HINT_TEXT_LIMIT = 128;
const HOME_LISTEN_PROVIDER_ID_LIMIT = 32;
const HOME_LISTEN_EMERGENCY_ID_LIMIT = 64;
const HOME_LISTEN_EMERGENCY_TEXT_LIMIT = 96;
const HOME_LISTEN_EMERGENCY_ARTIST_NAME_LIMIT = 48;

export interface HomeListenRecord {
	track: Track;
	plays: number;
}

export interface HomeListenLifetimeRecord extends HomeListenRecord {
	lastPlayedAt: number;
	listenMs: number;
	completed: number;
}

export interface HomeListenRecentSession {
	id: string;
	track: Track;
	startedAt: number;
	endedAt: number;
	listenMs: number;
	completed: boolean;
	migrated?: boolean;
}

export interface HomeListenArtistAggregate {
	name: string;
	plays: number;
	listenMs: number;
	lastPlayedAt: number;
	coverUrl?: string;
}

export interface HomeListenDailyRollup {
	date: string;
	listenMs: number;
	trackKeys: string[];
	uniqueTracks: number;
	sessions: number;
	completed: number;
}

export interface HomeListenStreakCarry {
	/** 被保留窗口最老日期的前一天。 */
	endDate: string;
	/** 截断窗口外、截至 endDate 的连续活跃天数。 */
	days: number;
}

export interface HomeListenLedgerV2 {
	version: typeof HOME_LISTEN_LEDGER_VERSION;
	recent: HomeListenRecentSession[];
	songs: HomeListenLifetimeRecord[];
	artists: HomeListenArtistAggregate[];
	daily: HomeListenDailyRollup[];
	streakCarry: HomeListenStreakCarry | null;
	updatedAt: number;
}

export interface HomeListenSummary {
	recent?: HomeListenRecord | null;
	topSong?: HomeListenRecord | null;
	topArtist?: { name: string; plays: number; coverUrl?: string } | null;
	totalPlays?: number;
	lifetimeListenMs?: number;
	todayListenMs?: number;
	todayUniqueSongs?: number;
	streakDays?: number;
}

export interface CompletedHomeListenSession {
	id?: string;
	track: Track;
	startedAt: number;
	endedAt: number;
	listenMs: number;
	completed: boolean;
}

function finiteNonNegative(value: unknown): number {
	const normalized = Number(value);
	return Number.isFinite(normalized) ? Math.max(0, normalized) : 0;
}

function positiveInteger(value: unknown, fallback = 0): number {
	const normalized = Math.floor(finiteNonNegative(value));
	return normalized > 0 ? normalized : fallback;
}

function isTrack(value: unknown): value is Track {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<Track>;
	return (
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.title === "string" &&
		candidate.title.length > 0 &&
		typeof candidate.provider === "string" &&
		Array.isArray(candidate.artists)
	);
}

function boundedText(value: unknown, limit: number): string {
	return typeof value === "string" ? value.slice(0, limit) : "";
}

function compactStoredIdentity(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const suffix = compactDailyTrackKey(value).slice(2);
	return `${value.slice(0, Math.max(1, limit - suffix.length - 1))}:${suffix}`;
}

function boundedUrl(value: unknown): string {
	if (typeof value !== "string") return "";
	// URL 截断后不可用；超限时舍弃可重建的封面，而不是保存坏链接。
	return value.length <= HOME_LISTEN_TRACK_URL_LIMIT ? value : "";
}

function normalizeTrack(value: unknown): Track | null {
	if (!isTrack(value) || value.provider.length > HOME_LISTEN_PROVIDER_ID_LIMIT) {
		return null;
	}
	const sourceId =
		typeof value.sourceId === "string" && value.sourceId
			? value.sourceId
			: value.id;
	const artists = [...new Set(
		value.artists
			.filter((artist): artist is string => typeof artist === "string")
			.map((artist) => boundedText(artist.trim(), HOME_LISTEN_ARTIST_NAME_LIMIT))
			.filter(Boolean),
	)].slice(0, HOME_LISTEN_TRACK_ARTIST_LIMIT);
	const qualityHints = [...new Set(
		(Array.isArray(value.qualityHints) ? value.qualityHints : [])
			.filter((hint): hint is string => typeof hint === "string")
			.map((hint) => boundedText(hint, HOME_LISTEN_QUALITY_HINT_TEXT_LIMIT))
			.filter(Boolean),
	)].slice(0, HOME_LISTEN_TRACK_QUALITY_HINT_LIMIT);
	const durationMs = finiteNonNegative(value.durationMs);
	const playableState = [
		"unknown",
		"playable",
		"login_required",
		"vip_required",
		"paid_required",
		"copyright_unavailable",
		"trial_only",
		"unavailable",
	].includes(value.playableState)
		? value.playableState
		: "unknown";
	return {
		provider: value.provider,
		id: compactStoredIdentity(value.id, HOME_LISTEN_TRACK_ID_LIMIT),
		sourceId: compactStoredIdentity(sourceId, HOME_LISTEN_TRACK_ID_LIMIT),
		...(typeof value.mediaMid === "string" && value.mediaMid
			? {
					mediaMid: compactStoredIdentity(
						value.mediaMid,
						HOME_LISTEN_TRACK_ID_LIMIT,
					),
				}
			: {}),
		title: boundedText(value.title, HOME_LISTEN_TRACK_TEXT_LIMIT),
		artists,
		album: boundedText(value.album, HOME_LISTEN_TRACK_TEXT_LIMIT),
		coverUrl: boundedUrl(value.coverUrl),
		...(durationMs > 0 ? { durationMs: Math.round(durationMs) } : {}),
		qualityHints,
		playableState,
	};
}

function trackKey(track: Track): string {
	return (
		trackLikeKey(track) ||
		`${track.provider}:${track.sourceId || track.id || track.title}`
	);
}

function compactDailyTrackKey(value: string): string {
	if (/^h:[0-9a-f]{16}$/.test(value)) return value;
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= BigInt(value.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return `h:${hash.toString(16).padStart(16, "0")}`;
}

function normalizeLifetimeRecord(value: unknown): HomeListenLifetimeRecord | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const track = normalizeTrack(candidate.track);
	if (!track) return null;
	return {
		track,
		plays: positiveInteger(candidate.plays, 1),
		lastPlayedAt: finiteNonNegative(candidate.lastPlayedAt),
		listenMs: Math.round(finiteNonNegative(candidate.listenMs)),
		completed: positiveInteger(candidate.completed),
	};
}

function normalizeRecentSession(value: unknown): HomeListenRecentSession | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const track = normalizeTrack(candidate.track);
	if (!track) return null;
	const endedAt = finiteNonNegative(candidate.endedAt ?? candidate.lastPlayedAt);
	const startedAt = Math.min(
		endedAt,
		finiteNonNegative(candidate.startedAt) || endedAt,
	);
	return {
		id:
			typeof candidate.id === "string" && candidate.id
				? compactStoredIdentity(candidate.id, HOME_LISTEN_SESSION_ID_LIMIT)
				: compactStoredIdentity(
						`${trackKey(track)}:${endedAt}`,
						HOME_LISTEN_SESSION_ID_LIMIT,
					),
		track,
		startedAt,
		endedAt,
		listenMs: Math.round(finiteNonNegative(candidate.listenMs)),
		completed: candidate.completed === true,
		...(candidate.migrated === true ? { migrated: true } : {}),
	};
}

function normalizeArtist(value: unknown): HomeListenArtistAggregate | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const name = boundedText(
		typeof candidate.name === "string" ? candidate.name.trim() : "",
		HOME_LISTEN_ARTIST_NAME_LIMIT,
	);
	if (!name) return null;
	return {
		name,
		plays: positiveInteger(candidate.plays),
		listenMs: Math.round(finiteNonNegative(candidate.listenMs)),
		lastPlayedAt: finiteNonNegative(candidate.lastPlayedAt),
		...(boundedUrl(candidate.coverUrl)
			? { coverUrl: boundedUrl(candidate.coverUrl) }
			: {}),
	};
}

function normalizeDaily(value: unknown): HomeListenDailyRollup | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const date = typeof candidate.date === "string" ? candidate.date : "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const allTrackKeys = Array.isArray(candidate.trackKeys)
		? [...new Set(
			candidate.trackKeys
				.slice(0, HOME_LISTEN_DAILY_TRACK_KEY_LIMIT)
				.filter((key): key is string => typeof key === "string" && !!key)
				.map(compactDailyTrackKey),
		)]
		: [];
	return {
		date,
		listenMs: Math.round(finiteNonNegative(candidate.listenMs)),
		trackKeys: allTrackKeys.slice(0, HOME_LISTEN_DAILY_TRACK_KEY_LIMIT),
		uniqueTracks: Math.max(
			allTrackKeys.length,
			positiveInteger(candidate.uniqueTracks),
		),
		sessions: positiveInteger(candidate.sessions),
		completed: positiveInteger(candidate.completed),
	};
}

function normalizeStreakCarry(value: unknown): HomeListenStreakCarry | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const endDate = typeof candidate.endDate === "string" ? candidate.endDate : "";
	const days = positiveInteger(candidate.days);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || days <= 0) return null;
	return { endDate, days };
}

function aggregateArtists(
	records: HomeListenLifetimeRecord[],
): HomeListenArtistAggregate[] {
	const byName = new Map<string, HomeListenArtistAggregate>();
	for (const record of records) {
		for (const rawArtist of record.track.artists) {
			const name = rawArtist.trim();
			if (!name) continue;
			const current = byName.get(name) ?? {
				name,
				plays: 0,
				listenMs: 0,
				lastPlayedAt: 0,
			};
			current.plays += record.plays;
			current.listenMs += record.listenMs;
			current.lastPlayedAt = Math.max(current.lastPlayedAt, record.lastPlayedAt);
			if (!current.coverUrl && record.track.coverUrl) {
				current.coverUrl = record.track.coverUrl;
			}
			byName.set(name, current);
		}
	}
	return [...byName.values()]
		.sort((a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt)
		.slice(0, HOME_LISTEN_ARTIST_LIMIT);
}

function ledgerByteLength(value: HomeListenLedgerV2): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function compactTrackForLedgerBudget(
	track: Track,
	artistLimit: number,
	keepMediaMid: boolean,
): Track {
	return {
		provider: track.provider,
		id: track.id,
		sourceId: track.sourceId,
		...(keepMediaMid && track.mediaMid ? { mediaMid: track.mediaMid } : {}),
		title: track.title,
		artists: track.artists.slice(0, artistLimit),
		album: "",
		coverUrl: "",
		...(track.durationMs ? { durationMs: track.durationMs } : {}),
		qualityHints: [],
		playableState: track.playableState,
	};
}

function compactTrackForEmergencyBudget(track: Track): Track {
	return {
		provider: track.provider,
		id: compactStoredIdentity(track.id, HOME_LISTEN_EMERGENCY_ID_LIMIT),
		sourceId: compactStoredIdentity(
			track.sourceId,
			HOME_LISTEN_EMERGENCY_ID_LIMIT,
		),
		...(track.mediaMid
			? {
					mediaMid: compactStoredIdentity(
						track.mediaMid,
						HOME_LISTEN_EMERGENCY_ID_LIMIT,
					),
				}
			: {}),
		title: boundedText(track.title, HOME_LISTEN_EMERGENCY_TEXT_LIMIT),
		artists: track.artists
			.slice(0, 2)
			.map((artist) =>
				boundedText(artist, HOME_LISTEN_EMERGENCY_ARTIST_NAME_LIMIT),
			),
		album: "",
		coverUrl: "",
		...(track.durationMs ? { durationMs: track.durationMs } : {}),
		qualityHints: [],
		playableState: track.playableState,
	};
}

function enforceLedgerByteBudget(
	ledger: HomeListenLedgerV2,
): HomeListenLedgerV2 {
	if (ledgerByteLength(ledger) <= HOME_LISTEN_LEDGER_TARGET_BYTES) return ledger;

	// recent 只承担排序和定位；播放数据可由 songs 中的同一歌曲恢复。
	let compacted: HomeListenLedgerV2 = {
		...ledger,
		recent: ledger.recent.map((session) => ({
			...session,
			track: compactTrackForLedgerBudget(session.track, 2, false),
		})),
		artists: ledger.artists.map(({ coverUrl: _coverUrl, ...artist }) => artist),
	};
	if (ledgerByteLength(compacted) <= HOME_LISTEN_LEDGER_TARGET_BYTES) {
		return compacted;
	}

	// 只有异常膨胀时才舍弃可重建的展示字段，保留歌曲身份和播放所需 mediaMid。
	const songs = compacted.songs.map((record) => ({
		...record,
		track: compactTrackForLedgerBudget(record.track, 4, true),
	}));
	compacted = {
		...compacted,
		songs,
		artists: aggregateArtists(songs),
	};
	if (ledgerByteLength(compacted) <= HOME_LISTEN_LEDGER_TARGET_BYTES) {
		return compacted;
	}

	const emergencySongs = compacted.songs.map((record) => ({
		...record,
		track: compactTrackForEmergencyBudget(record.track),
	}));
	compacted = {
		...compacted,
		songs: emergencySongs,
		recent: compacted.recent.map((session) => ({
			...session,
			id: compactStoredIdentity(
				session.id,
				HOME_LISTEN_EMERGENCY_ID_LIMIT,
			),
			track: compactTrackForEmergencyBudget(session.track),
		})),
		artists: aggregateArtists(emergencySongs),
	};
	if (ledgerByteLength(compacted) <= HOME_LISTEN_LEDGER_TARGET_BYTES) {
		return compacted;
	}

	// 最新日的精确集合不能为满足预算而截断；历史日已在 retention 阶段清空。
	return compacted;
}

export function createEmptyHomeListenLedger(): HomeListenLedgerV2 {
	return {
		version: HOME_LISTEN_LEDGER_VERSION,
		recent: [],
		songs: [],
		artists: [],
		daily: [],
		streakCarry: null,
		updatedAt: 0,
	};
}

function migrateV1History(rawHistory: unknown[]): HomeListenLedgerV2 {
	const songs = rawHistory
		.map(normalizeLifetimeRecord)
		.filter((record): record is HomeListenLifetimeRecord => record !== null)
		.slice(0, HOME_LISTEN_RECENT_LIMIT);
	const recent = [...songs]
		.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
		.map((record, index) => ({
			id: `migrated:${trackKey(record.track)}:${record.lastPlayedAt}:${index}`,
			track: record.track,
			startedAt: record.lastPlayedAt,
			endedAt: record.lastPlayedAt,
			listenMs: 0,
			completed: false,
			migrated: true,
		}));
	return enforceLedgerByteBudget({
		version: HOME_LISTEN_LEDGER_VERSION,
		recent,
		songs,
		artists: aggregateArtists(songs),
		// v1 没有按日证据，不能把 lifetime 统计伪造到最后播放日。
		daily: [],
		streakCarry: null,
		updatedAt: songs.reduce(
			(latest, record) => Math.max(latest, record.lastPlayedAt),
			0,
		),
	});
}

function retainDailyRollups(
	daily: HomeListenDailyRollup[],
	previousCarry: HomeListenStreakCarry | null,
): { daily: HomeListenDailyRollup[]; streakCarry: HomeListenStreakCarry | null } {
	const byDate = new Map<string, HomeListenDailyRollup>();
	for (const day of daily) {
		if (!byDate.has(day.date)) byDate.set(day.date, day);
	}
	const ordered = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
	const retained = ordered
		.slice(0, HOME_LISTEN_DAILY_RETENTION_DAYS)
		.map((day, index) =>
			index === 0 ? day : { ...day, trackKeys: [] },
		);
	const removed = ordered.slice(HOME_LISTEN_DAILY_RETENTION_DAYS);
	const oldestRetained = retained.at(-1);
	if (!oldestRetained) return { daily: retained, streakCarry: null };

	const carryEndDate = previousLocalDateKey(oldestRetained.date);
	let expected = carryEndDate;
	let days = 0;
	for (const day of removed) {
		if (day.date !== expected || day.sessions <= 0) break;
		days += 1;
		expected = previousLocalDateKey(expected);
	}
	if (previousCarry?.endDate === expected) days += previousCarry.days;
	return {
		daily: retained,
		streakCarry: days > 0 ? { endDate: carryEndDate, days } : null,
	};
}

export function migrateHomeListenLedger(value: unknown): HomeListenLedgerV2 {
	if (Array.isArray(value)) return migrateV1History(value);
	if (!value || typeof value !== "object") return createEmptyHomeListenLedger();
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== HOME_LISTEN_LEDGER_VERSION) {
		return migrateV1History(
			Array.isArray(candidate.history) ? candidate.history : [],
		);
	}

	const songs = (Array.isArray(candidate.songs) ? candidate.songs : [])
		.map(normalizeLifetimeRecord)
		.filter((record): record is HomeListenLifetimeRecord => record !== null)
		.slice(0, HOME_LISTEN_RECENT_LIMIT);
	const recent = (Array.isArray(candidate.recent) ? candidate.recent : [])
		.map(normalizeRecentSession)
		.filter((record): record is HomeListenRecentSession => record !== null)
		.sort((a, b) => b.endedAt - a.endedAt)
		.slice(0, HOME_LISTEN_RECENT_LIMIT);
	const artists = (Array.isArray(candidate.artists) ? candidate.artists : [])
		.map(normalizeArtist)
		.filter((record): record is HomeListenArtistAggregate => record !== null)
		.slice(0, HOME_LISTEN_ARTIST_LIMIT);
	const normalizedDaily = (Array.isArray(candidate.daily) ? candidate.daily : [])
		.map(normalizeDaily)
		.filter((record): record is HomeListenDailyRollup => record !== null)
		.sort((a, b) => b.date.localeCompare(a.date));
	const { daily, streakCarry } = retainDailyRollups(
		normalizedDaily,
		normalizeStreakCarry(candidate.streakCarry),
	);
	return enforceLedgerByteBudget({
		version: HOME_LISTEN_LEDGER_VERSION,
		recent,
		songs,
		artists: artists.length ? artists : aggregateArtists(songs),
		daily,
		streakCarry,
		updatedAt: finiteNonNegative(candidate.updatedAt),
	});
}

export function localHomeDateKey(timestamp: number): string {
	const date = new Date(timestamp);
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function previousLocalDateKey(dateKey: string): string {
	const [year, month, day] = dateKey.split("-").map(Number);
	return localHomeDateKey(new Date(year, month - 1, day - 1, 12).getTime());
}

export function recordHomeListenSession(
	current: HomeListenLedgerV2,
	session: CompletedHomeListenSession,
): HomeListenLedgerV2 {
	const ledger = migrateHomeListenLedger(current);
	const normalizedTrack = normalizeTrack(session.track);
	if (!normalizedTrack) return ledger;
	const key = trackKey(normalizedTrack);
	const dailyKey = compactDailyTrackKey(key);
	const endedAt = finiteNonNegative(session.endedAt);
	const startedAt = Math.min(endedAt, finiteNonNegative(session.startedAt));
	const listenMs = Math.round(finiteNonNegative(session.listenMs));
	const existingSong = ledger.songs.find(
		(record) => trackKey(record.track) === key,
	);
	const nextSong: HomeListenLifetimeRecord = {
		track: normalizedTrack,
		plays: (existingSong?.plays ?? 0) + 1,
		lastPlayedAt: endedAt,
		listenMs: (existingSong?.listenMs ?? 0) + listenMs,
		completed:
			(existingSong?.completed ?? 0) + (session.completed ? 1 : 0),
	};
	const songs = [
		nextSong,
		...ledger.songs.filter((record) => trackKey(record.track) !== key),
	].slice(0, HOME_LISTEN_RECENT_LIMIT);
	const recentSession: HomeListenRecentSession = {
		id:
			session.id ??
			compactStoredIdentity(
				`${key}:${startedAt}:${endedAt}:${listenMs}:${session.completed ? 1 : 0}`,
				HOME_LISTEN_SESSION_ID_LIMIT,
			),
		track: normalizedTrack,
		startedAt,
		endedAt,
		listenMs,
		completed: session.completed,
	};
	const recent = [
		recentSession,
		...ledger.recent.filter((record) => record.id !== recentSession.id),
	].slice(0, HOME_LISTEN_RECENT_LIMIT);
	const date = localHomeDateKey(endedAt);
	const existingDay = ledger.daily.find((record) => record.date === date);
	const existingTrackKeys = existingDay?.trackKeys ?? [];
	const dailyKeyKnown = existingTrackKeys.includes(dailyKey);
	const existingUniqueTracks =
		existingDay?.uniqueTracks ?? existingTrackKeys.length;
	const hasExactTrackSet = existingUniqueTracks === existingTrackKeys.length;
	const canRememberDailyKey =
		existingTrackKeys.length < HOME_LISTEN_DAILY_TRACK_KEY_LIMIT;
	// 旧版已逐出过 key 或达到上限时进入饱和态，避免把重播误计为新歌曲。
	const shouldAddDailyKey =
		!dailyKeyKnown && hasExactTrackSet && canRememberDailyKey;
	const nextDay: HomeListenDailyRollup = {
		date,
		listenMs: (existingDay?.listenMs ?? 0) + listenMs,
		trackKeys: shouldAddDailyKey
			? [dailyKey, ...existingTrackKeys].slice(
					0,
					HOME_LISTEN_DAILY_TRACK_KEY_LIMIT,
				)
			: existingTrackKeys,
		uniqueTracks: existingUniqueTracks + (shouldAddDailyKey ? 1 : 0),
		sessions: (existingDay?.sessions ?? 0) + 1,
		completed:
			(existingDay?.completed ?? 0) + (session.completed ? 1 : 0),
	};
	return migrateHomeListenLedger({
		version: HOME_LISTEN_LEDGER_VERSION,
		recent,
		songs,
		artists: aggregateArtists(songs),
		daily: [
			nextDay,
			...ledger.daily.filter((record) => record.date !== date),
		].sort((a, b) => b.date.localeCompare(a.date)),
		streakCarry: ledger.streakCarry,
		updatedAt: Math.max(ledger.updatedAt, endedAt),
	});
}

export function buildHomeListenSummary(
	value: HomeListenLedgerV2,
	now = Date.now(),
): HomeListenSummary | null {
	const ledger = migrateHomeListenLedger(value);
	if (!ledger.songs.length && !ledger.daily.length) return null;
	const recentSession = ledger.recent[0] ?? null;
	const recentSong = recentSession
		? ledger.songs.find(
				(record) => trackKey(record.track) === trackKey(recentSession.track),
			) ?? null
		: [...ledger.songs].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)[0] ?? null;
	const topSong = [...ledger.songs].sort(
		(a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt,
	)[0] ?? null;
	const topArtist = [...ledger.artists].sort(
		(a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt,
	)[0] ?? null;
	const todayKey = localHomeDateKey(now);
	const today = ledger.daily.find((record) => record.date === todayKey);
	const activeDates = new Set(ledger.daily.filter((day) => day.sessions > 0).map((day) => day.date));
	let cursor = activeDates.has(todayKey) ? todayKey : previousLocalDateKey(todayKey);
	let streakDays = 0;
	while (activeDates.has(cursor)) {
		streakDays += 1;
		cursor = previousLocalDateKey(cursor);
	}
	if (ledger.streakCarry?.endDate === cursor) {
		streakDays += ledger.streakCarry.days;
	}
	return {
		recent: recentSong
			? { track: recentSong.track, plays: recentSong.plays }
			: null,
		topSong: topSong ? { track: topSong.track, plays: topSong.plays } : null,
		topArtist: topArtist
			? {
					name: topArtist.name,
					plays: topArtist.plays,
					...(topArtist.coverUrl ? { coverUrl: topArtist.coverUrl } : {}),
				}
			: null,
		totalPlays: ledger.songs.reduce((sum, record) => sum + record.plays, 0),
		lifetimeListenMs: ledger.songs.reduce(
			(sum, record) => sum + record.listenMs,
			0,
		),
		todayListenMs: today?.listenMs ?? 0,
		todayUniqueSongs: today?.uniqueTracks ?? today?.trackKeys.length ?? 0,
		streakDays,
	};
}

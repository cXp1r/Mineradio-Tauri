import {
	parseCustomLyricText,
	resolvePreferredLyricPayload,
	type LyricPayload,
	type LyricLine,
	type LyricSourcePreference,
	type Track,
} from "@mineradio/shared";

export const CUSTOM_LYRIC_STORE_KEY = "mineradio-custom-lyrics-v1";
export const CUSTOM_LYRIC_PREF_STORE_KEY = "mineradio-custom-lyric-prefs-v1";

export interface CustomLyricEntry {
	text: string;
	updatedAt: number;
}

export type CustomLyricStore = Record<string, CustomLyricEntry>;
export type CustomLyricPrefs = Record<string, LyricSourcePreference>;

function storage(): Storage | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage;
}

export function trackCustomLyricKey(track: Track | null | undefined): string {
	if (!track) return "";
	const legacy = track as Track & {
		customCoverKey?: unknown;
		localKey?: unknown;
		programId?: unknown;
		mid?: unknown;
		songmid?: unknown;
		name?: unknown;
		artist?: unknown;
		source?: unknown;
		type?: unknown;
	};
	if (legacy.customCoverKey) return String(legacy.customCoverKey);
	if (legacy.provider === "qq" || legacy.source === "qq" || legacy.type === "qq") {
		const qqId = legacy.mid || legacy.songmid || track.sourceId || track.id || `${legacy.name ?? track.title}|${legacy.artist ?? track.artists.join(" / ")}`;
		return `qq:${qqId}`;
	}
	if (legacy.localKey) return `local:${legacy.localKey}`;
	if (legacy.type === "podcast" && legacy.programId) return `podcast:${legacy.programId}`;
	if (track.id) return `id:${track.id}`;
	const title = String(legacy.name ?? track.title ?? "").trim();
	const artist = String(legacy.artist ?? track.artists.join(" / ") ?? "").trim();
	return title || artist ? `meta:${`${title}|${artist}`.slice(0, 220)}` : "";
}

export function readCustomLyricStore(): CustomLyricStore {
	const s = storage();
	if (!s) return {};
	try {
		const raw = JSON.parse(s.getItem(CUSTOM_LYRIC_STORE_KEY) || "{}") as Record<string, unknown>;
		const out: CustomLyricStore = {};
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value === "string") {
				out[key] = { text: value, updatedAt: 0 };
			} else if (value && typeof value === "object") {
				const item = value as { text?: unknown; updatedAt?: unknown };
				if (typeof item.text === "string") {
					out[key] = {
						text: item.text,
						updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
					};
				}
			}
		}
		return out;
	} catch {
		return {};
	}
}

export function readCustomLyricPrefs(): CustomLyricPrefs {
	const s = storage();
	if (!s) return {};
	try {
		const raw = JSON.parse(s.getItem(CUSTOM_LYRIC_PREF_STORE_KEY) || "{}") as Record<string, unknown>;
		const out: CustomLyricPrefs = {};
		for (const [key, value] of Object.entries(raw)) {
			if (value === "custom" || value === "original") out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function writeJsonStorage(key: string, value: unknown): boolean {
	const s = storage();
	if (!s) return false;
	try {
		s.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}

export function saveCustomLyricForTrack(track: Track, text: string, now = Date.now()): { saved: boolean; lines: LyricLine[] } {
	const key = trackCustomLyricKey(track);
	const lines = parseCustomLyricText(text, { durationMs: track.durationMs });
	if (!key || lines.length === 0) return { saved: false, lines };
	const store = readCustomLyricStore();
	const prefs = readCustomLyricPrefs();
	store[key] = { text, updatedAt: now };
	prefs[key] = "custom";
	const savedStore = writeJsonStorage(CUSTOM_LYRIC_STORE_KEY, store);
	const savedPrefs = writeJsonStorage(CUSTOM_LYRIC_PREF_STORE_KEY, prefs);
	return { saved: savedStore && savedPrefs, lines };
}

export function deleteCustomLyricForTrack(track: Track): boolean {
	const key = trackCustomLyricKey(track);
	if (!key) return false;
	const store = readCustomLyricStore();
	const prefs = readCustomLyricPrefs();
	const existed = Object.prototype.hasOwnProperty.call(store, key);
	delete store[key];
	delete prefs[key];
	writeJsonStorage(CUSTOM_LYRIC_STORE_KEY, store);
	writeJsonStorage(CUSTOM_LYRIC_PREF_STORE_KEY, prefs);
	return existed;
}

export function setCustomLyricPreferenceForTrack(track: Track, preference: LyricSourcePreference): boolean {
	const key = trackCustomLyricKey(track);
	if (!key) return false;
	const prefs = readCustomLyricPrefs();
	prefs[key] = preference;
	return writeJsonStorage(CUSTOM_LYRIC_PREF_STORE_KEY, prefs);
}

export function getCustomLyricTextForTrack(track: Track | null | undefined): string | null {
	const key = trackCustomLyricKey(track);
	if (!key) return null;
	const entry = readCustomLyricStore()[key];
	const text = entry?.text.trim() ?? "";
	return text ? text : null;
}

export function getCustomLyricPreferenceForTrack(track: Track | null | undefined): LyricSourcePreference | null {
	const key = trackCustomLyricKey(track);
	if (!key) return null;
	return readCustomLyricPrefs()[key] ?? null;
}

export function resolveLyricsForTrack(input: {
	track: Track;
	original: LyricPayload;
	durationMs?: number | null;
}): { payload: LyricPayload; source: LyricSourcePreference } {
	return resolvePreferredLyricPayload({
		original: input.original,
		customText: getCustomLyricTextForTrack(input.track),
		preference: getCustomLyricPreferenceForTrack(input.track),
		durationMs: input.durationMs ?? undefined,
	});
}

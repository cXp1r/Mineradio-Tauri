import {
	createJsonPreferenceKey,
	type JsonValue,
	type PreferenceKey,
} from "../ports/preferences-repository";

export type JsonObject = { [key: string]: JsonValue };

function parseBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function collectSearchHistoryCandidates(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return value;
	if (value === null || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.items)) return record.items;
	if (
		record.modes !== null &&
		typeof record.modes === "object" &&
		!Array.isArray(record.modes)
	) {
		return collectSearchHistoryCandidates(record.modes);
	}
	const modeEntries = Object.values(record).filter(Array.isArray);
	return modeEntries.length > 0 ? modeEntries.flat() : undefined;
}

export function normalizeSearchHistory(value: unknown): string[] | undefined {
	const candidates = collectSearchHistoryCandidates(value);
	if (!candidates) return undefined;
	const result: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const query = candidate.trim();
		if (!query) continue;
		const identity = query.toLocaleLowerCase();
		if (seen.has(identity)) continue;
		seen.add(identity);
		result.push(query);
		if (result.length >= 10) break;
	}
	return result;
}

export const PLAYBACK_QUALITY_PREFERENCE = createJsonPreferenceKey({
	name: "playback.quality",
	schemaVersion: 1,
	defaultValue: "hires",
	parse(value): string | undefined {
		if (typeof value !== "string") return undefined;
		const quality = value.trim();
		if (!quality) return undefined;
		return quality.toLowerCase() === "hi-res" ? "hires" : quality;
	},
});

export const CAPSULE_AUTO_HIDE_PREFERENCE = createJsonPreferenceKey({
	name: "shell.capsuleAutoHide",
	schemaVersion: 1,
	defaultValue: false,
	parse: parseBoolean,
});

export const PLAYLIST_PANEL_PINNED_PREFERENCE = createJsonPreferenceKey({
	name: "shell.playlistPanelPinned",
	schemaVersion: 1,
	defaultValue: false,
	parse: parseBoolean,
});

export const DIY_MODE_PREFERENCE = createJsonPreferenceKey({
	name: "shell.diyMode",
	schemaVersion: 1,
	defaultValue: false,
	parse: parseBoolean,
});

export const VISUAL_GUIDE_SEEN_PREFERENCE = createJsonPreferenceKey({
	name: "shell.visualGuideSeen",
	schemaVersion: 1,
	defaultValue: false,
	parse: parseBoolean,
});

export const SHELF_PREFERENCE = createJsonPreferenceKey({
	name: "visual.shelf",
	schemaVersion: 1,
	defaultValue: (): JsonObject => ({}),
	parse: parseObject,
});

export const VISUAL_FX_PREFERENCE = createJsonPreferenceKey({
	name: "visual.fx",
	schemaVersion: 1,
	defaultValue: (): JsonObject => ({}),
	parse: parseObject,
});

export const SETTINGS_FAB_AUTO_HIDE_PREFERENCE = createJsonPreferenceKey({
	name: "settings.fabAutoHide",
	schemaVersion: 1,
	defaultValue: false,
	parse: parseBoolean,
});

export const WALLPAPER_SELECTION_PREFERENCE = createJsonPreferenceKey({
	name: "desktop.wallpaperSelection",
	schemaVersion: 1,
	defaultValue: null as string | null,
	parse(value): string | null | undefined {
		if (value === null) return null;
		if (typeof value !== "string") return undefined;
		const selection = value.trim();
		return selection || null;
	},
});

export const HOME_LISTEN_LEDGER_PREFERENCE = createJsonPreferenceKey({
	name: "home.listenLedger.v2",
	schemaVersion: 2,
	defaultValue: (): JsonObject => ({
		version: 2,
		recent: [],
		songs: [],
		artists: [],
		daily: [],
		updatedAt: 0,
	}),
	parse(value): JsonObject | undefined {
		const parsed = parseObject(value);
		return parsed?.version === 2 ? parsed : undefined;
	},
});

export const SEARCH_HISTORY_PREFERENCE = createJsonPreferenceKey({
	name: "search.history",
	schemaVersion: 1,
	defaultValue: (): string[] => [],
	parse: normalizeSearchHistory,
});

export const M8_PREFERENCE_KEYS: readonly PreferenceKey<unknown>[] = Object.freeze([
	PLAYBACK_QUALITY_PREFERENCE,
	CAPSULE_AUTO_HIDE_PREFERENCE,
	PLAYLIST_PANEL_PINNED_PREFERENCE,
	DIY_MODE_PREFERENCE,
	VISUAL_GUIDE_SEEN_PREFERENCE,
	SHELF_PREFERENCE,
	VISUAL_FX_PREFERENCE,
	SETTINGS_FAB_AUTO_HIDE_PREFERENCE,
	WALLPAPER_SELECTION_PREFERENCE,
	HOME_LISTEN_LEDGER_PREFERENCE,
	SEARCH_HISTORY_PREFERENCE,
]);

export const M8_PREFERENCE_KEY_BY_NAME: ReadonlyMap<string, PreferenceKey<unknown>> =
	new Map(M8_PREFERENCE_KEYS.map((key) => [key.name, key]));

import type { SharedPlaylistImportResult, SharedPlaylistInfo, Track } from "@mineradio/shared";

export const IMPORTED_PLAYLISTS_STORE_KEY = "mineradio.importedPlaylists.v1";

export interface ImportedPlaylistRecord {
	key: string;
	provider: SharedPlaylistImportResult["provider"];
	playlist: SharedPlaylistInfo;
	tracks: Track[];
	trackCount: number;
	loadedCount: number;
	partial: boolean;
	partialReason: string;
	importedAt: number;
	updatedAt: number;
}

export function buildImportedPlaylistKey(provider: string, playlistId: string): string {
	return `${provider}:${playlistId}`;
}

export function isSharedPlaylistCandidateText(value: string): boolean {
	return /https?:\/\/[^\s"'<>]+/i.test(value) &&
		/(music\.163\.com|y\.music\.163\.com|y\.qq\.com|music\.apple\.com|itunes\.apple\.com|qishui\.douyin\.com|music\.douyin\.com|kugou\.com)/i.test(value);
}

export function importedPlaylistFromResult(
	result: SharedPlaylistImportResult,
	now = Date.now(),
	previous?: ImportedPlaylistRecord,
): ImportedPlaylistRecord {
	const key = buildImportedPlaylistKey(result.provider, result.playlist.id);
	return {
		key,
		provider: result.provider,
		playlist: result.playlist,
		tracks: result.tracks,
		trackCount: result.trackCount,
		loadedCount: result.loadedCount,
		partial: result.partial,
		partialReason: result.partialReason,
		importedAt: previous?.importedAt ?? now,
		updatedAt: now,
	};
}

export function upsertImportedPlaylist(
	list: ImportedPlaylistRecord[],
	record: ImportedPlaylistRecord,
): ImportedPlaylistRecord[] {
	const existingIndex = list.findIndex((item) => item.key === record.key);
	if (existingIndex < 0) return [record, ...list];
	const next = [...list];
	next.splice(existingIndex, 1);
	return [record, ...next];
}

export function readImportedPlaylistsFromStorage(storage: Storage | undefined = globalLocalStorage()): ImportedPlaylistRecord[] {
	if (!storage) return [];
	try {
		const raw = storage.getItem(IMPORTED_PLAYLISTS_STORE_KEY);
		const parsed = JSON.parse(raw || "[]") as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap(normalizeImportedPlaylistRecord).slice(0, 80);
	} catch {
		return [];
	}
}

export function saveImportedPlaylistsToStorage(
	list: ImportedPlaylistRecord[],
	storage: Storage | undefined = globalLocalStorage(),
): void {
	if (!storage) return;
	try {
		storage.setItem(IMPORTED_PLAYLISTS_STORE_KEY, JSON.stringify(list.slice(0, 80)));
	} catch {
	}
}

function globalLocalStorage(): Storage | undefined {
	return typeof localStorage === "undefined" ? undefined : localStorage;
}

function normalizeImportedPlaylistRecord(item: unknown): ImportedPlaylistRecord[] {
	if (!item || typeof item !== "object") return [];
	const record = item as Partial<ImportedPlaylistRecord>;
	const playlist = record.playlist;
	if (!playlist || typeof playlist !== "object" || !playlist.id || !playlist.name || !record.provider) return [];
	const tracks = Array.isArray(record.tracks) ? record.tracks : [];
	return [{
		key: record.key || buildImportedPlaylistKey(record.provider, playlist.id),
		provider: record.provider,
		playlist,
		tracks,
		trackCount: Math.max(0, Number(record.trackCount ?? playlist.trackCount ?? tracks.length) || 0),
		loadedCount: Math.max(0, Number(record.loadedCount ?? tracks.length) || 0),
		partial: record.partial === true,
		partialReason: String(record.partialReason ?? ""),
		importedAt: Math.max(0, Number(record.importedAt) || Date.now()),
		updatedAt: Math.max(0, Number(record.updatedAt) || Date.now()),
	}];
}

import type { Track } from "@mineradio/shared";
import { trackCustomLyricKey } from "../lyrics/custom-lyrics";

export const CUSTOM_COVER_STORE_KEY = "mineradio-custom-covers";
export const CUSTOM_COVER_MAX_DATA_URL_CHARS = 900_000;
export const CUSTOM_COVER_STORE_MAX_CHARS = 2_000_000;

type RuntimeCoverTrack = Track & {
	customCover?: string;
	defaultCoverUrl?: string;
};

function storage(): Storage | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage;
}

function readCustomCoverStore(): Record<string, string> {
	const s = storage();
	if (!s) return {};
	try {
		const parsed = JSON.parse(s.getItem(CUSTOM_COVER_STORE_KEY) || "{}") as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (isPersistableCustomCover(value)) out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function isCustomCoverDataUrl(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("data:image/");
}

function isPersistableCustomCover(value: unknown): value is string {
	return isCustomCoverDataUrl(value) && value.length <= CUSTOM_COVER_MAX_DATA_URL_CHARS;
}

function customCoverStoreEntrySize(key: string, value: string, hasPrevious: boolean): number {
	return JSON.stringify(key).length + 1 + JSON.stringify(value).length + (hasPrevious ? 1 : 0);
}

function pruneCustomCoverStore(store: Record<string, string>): Record<string, string> {
	const entries = Object.entries(store).filter(([, value]) => isPersistableCustomCover(value));
	const kept: Array<[string, string]> = [];
	let remaining = CUSTOM_COVER_STORE_MAX_CHARS - 2;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const [key, value] = entries[i];
		const size = customCoverStoreEntrySize(key, value, kept.length > 0);
		if (size > remaining) continue;
		kept.push([key, value]);
		remaining -= size;
	}
	kept.reverse();
	return Object.fromEntries(kept);
}

function writeCustomCoverStore(store: Record<string, string>): boolean {
	const s = storage();
	if (!s) return false;
	try {
		s.setItem(CUSTOM_COVER_STORE_KEY, JSON.stringify(store));
		return true;
	} catch {
		return false;
	}
}

function defaultCoverUrl(track: RuntimeCoverTrack): string {
	return track.defaultCoverUrl ?? (track.customCover ? "" : track.coverUrl ?? "");
}

export function customCoverKeyForTrack(track: Track | null | undefined): string {
	return trackCustomLyricKey(track);
}

export function getCustomCoverForTrack(track: Track | null | undefined): string {
	if (!track) return "";
	const runtime = track as RuntimeCoverTrack;
	if (isCustomCoverDataUrl(runtime.customCover)) return runtime.customCover;
	const key = customCoverKeyForTrack(track);
	return key ? readCustomCoverStore()[key] ?? "" : "";
}

export function hasCustomCoverForTrack(track: Track | null | undefined): boolean {
	return !!getCustomCoverForTrack(track);
}

export function withStoredCustomCover(track: Track): Track {
	const custom = getCustomCoverForTrack(track);
	if (!custom) return track;
	const runtime = track as RuntimeCoverTrack;
	return {
		...track,
		coverUrl: custom,
		customCover: custom,
		defaultCoverUrl: defaultCoverUrl(runtime),
	} as Track;
}

export function saveCustomCoverForTrack(track: Track, dataUrl: string): { track: Track; saved: boolean } {
	const key = customCoverKeyForTrack(track);
	const runtime = track as RuntimeCoverTrack;
	let saved = false;
	if (key && isPersistableCustomCover(dataUrl)) {
		const store = readCustomCoverStore();
		delete store[key];
		store[key] = dataUrl;
		const pruned = pruneCustomCoverStore(store);
		saved = pruned[key] === dataUrl && writeCustomCoverStore(pruned);
	}
	return {
		saved,
		track: {
			...track,
			coverUrl: dataUrl,
			customCover: dataUrl,
			defaultCoverUrl: defaultCoverUrl(runtime),
		} as Track,
	};
}

export function clearCustomCoverForTrack(track: Track): { track: Track; existed: boolean } {
	const key = customCoverKeyForTrack(track);
	const custom = getCustomCoverForTrack(track);
	const runtime = track as RuntimeCoverTrack;
	if (key) {
		const store = readCustomCoverStore();
		if (Object.prototype.hasOwnProperty.call(store, key)) {
			delete store[key];
			writeCustomCoverStore(store);
		}
	}
	const restored: RuntimeCoverTrack = {
		...track,
		coverUrl: defaultCoverUrl(runtime),
	};
	delete restored.customCover;
	delete restored.defaultCoverUrl;
	return { track: restored as Track, existed: !!custom };
}

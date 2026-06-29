import type { Track } from "@mineradio/shared";
import { trackCustomLyricKey } from "../lyrics/custom-lyrics";

export const CUSTOM_COVER_STORE_KEY = "mineradio-custom-covers";

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
			if (typeof value === "string" && value.startsWith("data:image/")) out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
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
	if (runtime.customCover?.startsWith("data:image/")) return runtime.customCover;
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
	if (key && dataUrl.startsWith("data:image/")) {
		const store = readCustomCoverStore();
		store[key] = dataUrl;
		saved = writeCustomCoverStore(store);
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

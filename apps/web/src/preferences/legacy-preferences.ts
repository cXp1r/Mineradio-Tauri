import {
	CAPSULE_AUTO_HIDE_PREFERENCE,
	DIY_MODE_PREFERENCE,
	PLAYBACK_QUALITY_PREFERENCE,
	PLAYLIST_PANEL_PINNED_PREFERENCE,
	SEARCH_HISTORY_PREFERENCE,
	SETTINGS_FAB_AUTO_HIDE_PREFERENCE,
	SHELF_PREFERENCE,
	VISUAL_FX_PREFERENCE,
	VISUAL_GUIDE_SEEN_PREFERENCE,
	WALLPAPER_SELECTION_PREFERENCE,
} from "./keys";
import type { PreferenceKey } from "../ports/preferences-repository";

export interface LegacyPreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface LegacyPreferenceMapping<T> {
	readonly legacyKey: string;
	readonly preferenceKey: PreferenceKey<T>;
	decode(raw: string): T | undefined;
	encode(value: T): string;
}

export function defineLegacyPreferenceMapping<T>(
	mapping: LegacyPreferenceMapping<T>,
): LegacyPreferenceMapping<T> {
	return Object.freeze(mapping);
}

function booleanMapping(
	legacyKey: string,
	preferenceKey: PreferenceKey<boolean>,
): LegacyPreferenceMapping<boolean> {
	return {
		legacyKey,
		preferenceKey,
		decode(raw) {
			if (raw === "1" || raw === "true") return true;
			if (raw === "0" || raw === "false") return false;
			return undefined;
		},
		encode: (value) => (value ? "1" : "0"),
	};
}

function jsonMapping<T>(
	legacyKey: string,
	preferenceKey: PreferenceKey<T>,
): LegacyPreferenceMapping<T> {
	return {
		legacyKey,
		preferenceKey,
		decode(raw) {
			try {
				return preferenceKey.parse(JSON.parse(raw));
			} catch {
				return undefined;
			}
		},
		encode: (value) => JSON.stringify(value),
	};
}

export const DEFAULT_LEGACY_PREFERENCE_MAPPINGS: readonly LegacyPreferenceMapping<unknown>[] =
	Object.freeze([
		{
			legacyKey: "mineradio-playback-quality-v1",
			preferenceKey: PLAYBACK_QUALITY_PREFERENCE,
			decode: (raw: string) => PLAYBACK_QUALITY_PREFERENCE.parse(raw),
			encode: (value: string) => value,
		},
		booleanMapping(
			"mineradio-user-capsule-auto-hide-v1",
			CAPSULE_AUTO_HIDE_PREFERENCE,
		),
		booleanMapping(
			"mineradio-playlist-panel-pinned-v1",
			PLAYLIST_PANEL_PINNED_PREFERENCE,
		),
		booleanMapping("mineradio-diy-player-mode-v1", DIY_MODE_PREFERENCE),
		booleanMapping(
			"mineradio-visual-guide-seen-v2",
			VISUAL_GUIDE_SEEN_PREFERENCE,
		),
		jsonMapping("mineradio-tauri-shelf-settings-v1", SHELF_PREFERENCE),
		jsonMapping("mineradio-tauri-visual-settings-v1", VISUAL_FX_PREFERENCE),
		booleanMapping(
			"mineradio-fx-fab-auto-hide-v1",
			SETTINGS_FAB_AUTO_HIDE_PREFERENCE,
		),
		{
			legacyKey: "mineradio.wallpaper-engine.selection.v1",
			preferenceKey: WALLPAPER_SELECTION_PREFERENCE,
			decode: (raw: string) => WALLPAPER_SELECTION_PREFERENCE.parse(raw),
			encode: (value: string | null) => value ?? "",
		},
		{
			legacyKey: "mineradio-search-history",
			preferenceKey: SEARCH_HISTORY_PREFERENCE,
			decode(raw: string) {
				try {
					return SEARCH_HISTORY_PREFERENCE.parse(JSON.parse(raw));
				} catch {
					return undefined;
				}
			},
			encode: (value: string[]) => JSON.stringify({ version: 3, items: value }),
		},
	]) as readonly LegacyPreferenceMapping<unknown>[];

export function mappingByPreferenceName(
	mappings: readonly LegacyPreferenceMapping<unknown>[],
): ReadonlyMap<string, LegacyPreferenceMapping<unknown>> {
	return new Map(mappings.map((mapping) => [mapping.preferenceKey.name, mapping]));
}

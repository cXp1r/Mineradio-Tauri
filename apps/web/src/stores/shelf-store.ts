import { create } from "zustand";

export const SHELF_SETTINGS_STORE_KEY = "mineradio-tauri-shelf-settings-v1";

export type ShelfMode = "off" | "side" | "stage";
export type ShelfCameraMode = "static" | "dynamic";
export type ShelfPresence = "always" | "auto";

export interface ShelfSettings {
	version: 1;
	mode: ShelfMode;
	cameraMode: ShelfCameraMode;
	presence: ShelfPresence;
	showPodcasts: boolean;
	mergeCollections: boolean;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function normalizeShelfMode(value: unknown): ShelfMode {
	return value === "off" || value === "side" || value === "stage" ? value : "side";
}

export function normalizeShelfCameraMode(value: unknown): ShelfCameraMode {
	return value === "dynamic" || value === "static" ? value : "dynamic";
}

export function normalizeShelfPresence(value: unknown): ShelfPresence {
	return value === "auto" || value === "always" ? value : "always";
}

export function normalizeShelfSettings(
	value?: unknown,
): ShelfSettings {
	const record =
		value !== null && typeof value === "object"
			? (value as Partial<ShelfSettings>)
			: undefined;
	return {
		version: 1,
		mode: normalizeShelfMode(record?.mode),
		cameraMode: normalizeShelfCameraMode(record?.cameraMode),
		presence: normalizeShelfPresence(record?.presence),
		showPodcasts: record?.showPodcasts !== false,
		mergeCollections: record?.mergeCollections === true,
	};
}

export function mergeShelfSettings(
	base: ShelfSettings,
	patch: Partial<ShelfSettings>,
): ShelfSettings {
	return normalizeShelfSettings({ ...base, ...patch, version: 1 });
}

export function serializeShelfSettings(state: Pick<ShelfState, "mode" | "cameraMode" | "presence" | "showPodcasts" | "mergeCollections">): ShelfSettings {
	return {
		version: 1,
		mode: normalizeShelfMode(state.mode),
		cameraMode: normalizeShelfCameraMode(state.cameraMode),
		presence: normalizeShelfPresence(state.presence),
		showPodcasts: state.showPodcasts !== false,
		mergeCollections: state.mergeCollections === true,
	};
}

function storageOrNull(storage?: StorageLike): StorageLike | null {
	if (storage) return storage;
	if (typeof localStorage === "undefined") return null;
	return localStorage;
}

export function loadShelfSettingsFromStorage(storage?: StorageLike): ShelfSettings | null {
	const target = storageOrNull(storage);
	if (!target) return null;
	let parsed: unknown;
	try {
		const raw = target.getItem(SHELF_SETTINGS_STORE_KEY);
		if (!raw) return null;
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	return normalizeShelfSettings(parsed as Partial<ShelfSettings>);
}

export function saveShelfSettingsToStorage(storage?: StorageLike): void {
	const target = storageOrNull(storage);
	if (!target) return;
	try {
		target.setItem(SHELF_SETTINGS_STORE_KEY, JSON.stringify(serializeShelfSettings(useShelfStore.getState())));
	} catch {
	}
}

export interface ShelfState {
	mode: ShelfMode;
	cameraMode: ShelfCameraMode;
	presence: ShelfPresence;
	showPodcasts: boolean;
	mergeCollections: boolean;
	open: boolean;
	selectedPlaylistId: string | null;
	setMode: (mode: ShelfMode) => void;
	setCameraMode: (mode: ShelfCameraMode) => void;
	setPresence: (presence: ShelfPresence) => void;
	setShowPodcasts: (show: boolean) => void;
	setMergeCollections: (merge: boolean) => void;
	applySettings: (settings: Partial<Pick<ShelfState, "mode" | "cameraMode" | "presence" | "showPodcasts" | "mergeCollections">>) => void;
	openShelf: () => void;
	closeShelf: () => void;
	toggleShelf: () => void;
	selectPlaylist: (id: string | null) => void;
}

export const useShelfStore = create<ShelfState>()((set, get) => ({
	mode: "side",
	cameraMode: "dynamic",
	presence: "always",
	showPodcasts: true,
	mergeCollections: false,
	open: false,
	selectedPlaylistId: null,
	setMode: (mode) => set({ mode: normalizeShelfMode(mode) }),
	setCameraMode: (cameraMode) => set({ cameraMode: normalizeShelfCameraMode(cameraMode) }),
	setPresence: (presence) => set({ presence: normalizeShelfPresence(presence) }),
	setShowPodcasts: (showPodcasts) => set({ showPodcasts: showPodcasts !== false }),
	setMergeCollections: (mergeCollections) => set({ mergeCollections: mergeCollections === true }),
	applySettings: (settings) => set((state) => ({
		mode: settings.mode === undefined ? state.mode : normalizeShelfMode(settings.mode),
		cameraMode: settings.cameraMode === undefined ? state.cameraMode : normalizeShelfCameraMode(settings.cameraMode),
		presence: settings.presence === undefined ? state.presence : normalizeShelfPresence(settings.presence),
		showPodcasts: settings.showPodcasts === undefined ? state.showPodcasts : settings.showPodcasts !== false,
		mergeCollections: settings.mergeCollections === undefined ? state.mergeCollections : settings.mergeCollections === true,
	})),
	openShelf: () => set({ open: true }),
	closeShelf: () => set({ open: false }),
	toggleShelf: () => set({ open: !get().open }),
	selectPlaylist: (id) => set({ selectedPlaylistId: id }),
}));

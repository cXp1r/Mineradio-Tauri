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
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function normalizeShelfMode(value: unknown): ShelfMode {
	return value === "off" || value === "side" || value === "stage" ? value : "side";
}

export function normalizeShelfCameraMode(value: unknown): ShelfCameraMode {
	return value === "dynamic" || value === "static" ? value : "static";
}

export function normalizeShelfPresence(value: unknown): ShelfPresence {
	return value === "auto" || value === "always" ? value : "always";
}

function serializeShelfSettings(state: Pick<ShelfState, "mode" | "cameraMode" | "presence">): ShelfSettings {
	return {
		version: 1,
		mode: normalizeShelfMode(state.mode),
		cameraMode: normalizeShelfCameraMode(state.cameraMode),
		presence: normalizeShelfPresence(state.presence),
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
	const record = parsed as Record<string, unknown>;
	return {
		version: 1,
		mode: normalizeShelfMode(record.mode),
		cameraMode: normalizeShelfCameraMode(record.cameraMode),
		presence: normalizeShelfPresence(record.presence),
	};
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
	open: boolean;
	selectedPlaylistId: string | null;
	setMode: (mode: ShelfMode) => void;
	setCameraMode: (mode: ShelfCameraMode) => void;
	setPresence: (presence: ShelfPresence) => void;
	applySettings: (settings: Partial<Pick<ShelfState, "mode" | "cameraMode" | "presence">>) => void;
	openShelf: () => void;
	closeShelf: () => void;
	toggleShelf: () => void;
	selectPlaylist: (id: string | null) => void;
}

export const useShelfStore = create<ShelfState>()((set, get) => ({
	mode: "side",
	cameraMode: "static",
	presence: "always",
	open: false,
	selectedPlaylistId: null,
	setMode: (mode) => set({ mode: normalizeShelfMode(mode) }),
	setCameraMode: (cameraMode) => set({ cameraMode: normalizeShelfCameraMode(cameraMode) }),
	setPresence: (presence) => set({ presence: normalizeShelfPresence(presence) }),
	applySettings: (settings) => set((state) => ({
		mode: settings.mode === undefined ? state.mode : normalizeShelfMode(settings.mode),
		cameraMode: settings.cameraMode === undefined ? state.cameraMode : normalizeShelfCameraMode(settings.cameraMode),
		presence: settings.presence === undefined ? state.presence : normalizeShelfPresence(settings.presence),
	})),
	openShelf: () => set({ open: true }),
	closeShelf: () => set({ open: false }),
	toggleShelf: () => set({ open: !get().open }),
	selectPlaylist: (id) => set({ selectedPlaylistId: id }),
}));

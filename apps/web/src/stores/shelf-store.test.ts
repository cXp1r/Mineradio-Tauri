import { expect, test } from "bun:test";
import {
	SHELF_SETTINGS_STORE_KEY,
	loadShelfSettingsFromStorage,
	normalizeShelfCameraMode,
	normalizeShelfMode,
	normalizeShelfPresence,
	saveShelfSettingsToStorage,
	useShelfStore,
} from "./shelf-store";

test("openShelf sets open true, toggleShelf flips", () => {
	useShelfStore.setState({ open: false });
	useShelfStore.getState().openShelf();
	expect(useShelfStore.getState().open).toBe(true);
	useShelfStore.getState().toggleShelf();
	expect(useShelfStore.getState().open).toBe(false);
});

test("shelf mode helpers normalize baseline values", () => {
	expect(normalizeShelfMode("off")).toBe("off");
	expect(normalizeShelfMode("side")).toBe("side");
	expect(normalizeShelfMode("stage")).toBe("stage");
	expect(normalizeShelfMode("resident")).toBe("side");
	expect(normalizeShelfMode("dynamic")).toBe("side");
	expect(normalizeShelfMode(null)).toBe("side");
	expect(normalizeShelfCameraMode("dynamic")).toBe("dynamic");
	expect(normalizeShelfCameraMode("static")).toBe("static");
	expect(normalizeShelfCameraMode("stage")).toBe("static");
	expect(normalizeShelfPresence("auto")).toBe("auto");
	expect(normalizeShelfPresence("always")).toBe("always");
	expect(normalizeShelfPresence("resident")).toBe("always");
});

test("shelf store persists baseline shelf mode controls without legacy lyric layout key", () => {
	const storage = new Map<string, string>();
	const localStorageLike = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	};

	useShelfStore.setState({
		mode: "side",
		cameraMode: "static",
		presence: "always",
		open: false,
		selectedPlaylistId: null,
	});
	useShelfStore.getState().setMode("stage");
	useShelfStore.getState().setCameraMode("dynamic");
	useShelfStore.getState().setPresence("auto");
	saveShelfSettingsToStorage(localStorageLike);

	expect(storage.has(SHELF_SETTINGS_STORE_KEY)).toBe(true);
	expect(storage.has("mineradio-lyric-layout-v1")).toBe(false);
	expect(JSON.parse(storage.get(SHELF_SETTINGS_STORE_KEY) ?? "{}")).toEqual({
		version: 1,
		mode: "stage",
		cameraMode: "dynamic",
		presence: "auto",
	});
});

test("loadShelfSettingsFromStorage normalizes invalid stored values", () => {
	const localStorageLike = {
		getItem: (key: string) =>
			key === SHELF_SETTINGS_STORE_KEY
				? JSON.stringify({ version: 1, mode: "resident", cameraMode: "float", presence: "hidden" })
				: null,
		setItem: () => undefined,
	};

	const loaded = loadShelfSettingsFromStorage(localStorageLike);
	expect(loaded).toEqual({
		version: 1,
		mode: "side",
		cameraMode: "static",
		presence: "always",
	});
});

test("applySettings preserves unspecified shelf settings", () => {
	useShelfStore.setState({
		mode: "stage",
		cameraMode: "dynamic",
		presence: "auto",
		open: false,
		selectedPlaylistId: null,
	});
	useShelfStore.getState().applySettings({ mode: "off" });
	expect(useShelfStore.getState().mode).toBe("off");
	expect(useShelfStore.getState().cameraMode).toBe("dynamic");
	expect(useShelfStore.getState().presence).toBe("auto");
});

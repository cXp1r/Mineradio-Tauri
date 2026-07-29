import { afterEach, expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type {
	PreferenceKey,
	PreferencesRepository,
	PreferencesTransaction,
} from "../../ports/preferences-repository";
import { normalizeShelfSettings, useShelfStore } from "../../stores/shelf-store";
import { normalizeVisualFxState, useVisualStore } from "../../stores/visual-store";
import {
	applyHydratedShellPreferencesSnapshot,
	useShellPreferences,
	type HydratedShellPreferencesSnapshot,
	type ShellPreferencesResult,
} from "./useShellPreferences";

const reactTestEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

afterEach(() => {
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function snapshot(): HydratedShellPreferencesSnapshot {
	return {
		diyMode: false,
		playlistPanelPinned: false,
		userCapsuleAutoHide: false,
		visualGuideSeen: false,
		playbackQuality: "hires",
		settingsFabAutoHide: false,
		wallpaperSelection: null,
		shelf: normalizeShelfSettings(null),
		visualFx: normalizeVisualFxState(),
	};
}

test("hydrated visual and shelf snapshot can be applied before the first React render", () => {
	const originalShelf = useShelfStore.getState();
	const originalVisual = useVisualStore.getState();
	const hydratedPreferences = snapshot();
	hydratedPreferences.shelf = normalizeShelfSettings({ mode: "stage" });
	hydratedPreferences.visualFx = normalizeVisualFxState({ preset: 6 });

	applyHydratedShellPreferencesSnapshot(hydratedPreferences);

	expect(useShelfStore.getState().mode).toBe("stage");
	expect(useVisualStore.getState().preset).toBe(6);
	useShelfStore.setState(originalShelf, true);
	useVisualStore.setState(originalVisual, true);
});

test("canonical shell preference updates local state only after repository commit", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const originalShelf = useShelfStore.getState();
	const originalVisual = useVisualStore.getState();
	const committed = deferred<void>();
	const writes: string[] = [];
	const preferences: PreferencesRepository = {
		get: async <T,>(key: PreferenceKey<T>) => key.defaultValue(),
		set: async <T,>(key: PreferenceKey<T>) => {
			writes.push(key.name);
			await committed.promise;
		},
		remove: async () => undefined,
		transaction: async <T,>(work: (tx: PreferencesTransaction) => Promise<T>) =>
			work(preferences),
	};
	const hydratedPreferences = snapshot();
	let current: ShellPreferencesResult | null = null;
	function Harness() {
		current = useShellPreferences({
			showToast: () => undefined,
			onDesktopLyricsChange: () => undefined,
			preferences,
			hydratedPreferences,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	let pending!: Promise<void>;
	await act(async () => {
		pending = Promise.resolve(current!.setDiyMode(true));
		await Promise.resolve();
	});
	expect(writes).toEqual(["shell.diyMode"]);
	expect(current!.diyMode).toBe(false);

	committed.resolve();
	await act(async () => pending);
	expect(current!.diyMode).toBe(true);

	await act(async () => root.unmount());
	host.remove();
	useShelfStore.setState(originalShelf, true);
	useVisualStore.setState(originalVisual, true);
});

test("visual and shelf patch commits through one canonical transaction", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const originalShelf = useShelfStore.getState();
	const originalVisual = useVisualStore.getState();
	const hydratedPreferences = snapshot();
	let transactionCalls = 0;
	const writes: Array<{ key: string; value: unknown }> = [];
	const readCanonical = <T,>(key: PreferenceKey<T>): T => {
		if (key.name === "visual.fx") {
			return JSON.parse(JSON.stringify(hydratedPreferences.visualFx)) as T;
		}
		if (key.name === "visual.shelf") {
			return JSON.parse(JSON.stringify(hydratedPreferences.shelf)) as T;
		}
		return key.defaultValue();
	};
	const preferences: PreferencesRepository = {
		get: async <T,>(key: PreferenceKey<T>) => readCanonical(key),
		set: async () => undefined,
		remove: async () => undefined,
		transaction: async <T,>(work: (tx: PreferencesTransaction) => Promise<T>) => {
			transactionCalls += 1;
			return work({
				get: async <V,>(key: PreferenceKey<V>) => readCanonical(key),
				set: async <V,>(key: PreferenceKey<V>, value: V) => {
					writes.push({ key: key.name, value });
				},
				remove: async () => undefined,
			});
		},
	};
	let current: ShellPreferencesResult | null = null;
	function Harness() {
		current = useShellPreferences({
			showToast: () => undefined,
			onDesktopLyricsChange: () => undefined,
			preferences,
			hydratedPreferences,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => {
		await Promise.resolve(
			current!.applyVisualSettingsTransaction({ cinema: false, shelf: "stage" }),
		);
	});

	expect(transactionCalls).toBe(1);
	expect(writes.map((write) => write.key).sort()).toEqual([
		"visual.fx",
		"visual.shelf",
	]);
	expect(useVisualStore.getState().fx.cinema).toBe(false);
	expect(useShelfStore.getState().mode).toBe("stage");

	writes.length = 0;
	await act(async () => {
		await Promise.resolve(current!.updateShelfCameraMode("static"));
	});
	expect(transactionCalls).toBe(2);
	expect(writes.map((write) => write.key).sort()).toEqual([
		"visual.fx",
		"visual.shelf",
	]);
	expect(useShelfStore.getState().cameraMode).toBe("static");
	expect(useVisualStore.getState().fx.shelfCameraMode).toBe("static");

	await act(async () => root.unmount());
	host.remove();
	useShelfStore.setState(originalShelf, true);
	useVisualStore.setState(originalVisual, true);
});

test("failed canonical transaction rejects and leaves runtime state unchanged", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const originalShelf = useShelfStore.getState();
	const originalVisual = useVisualStore.getState();
	const hydratedPreferences = snapshot();
	hydratedPreferences.visualFx = normalizeVisualFxState({ cinema: true });
	hydratedPreferences.shelf = normalizeShelfSettings({ mode: "side" });
	const preferences: PreferencesRepository = {
		get: async <T,>(key: PreferenceKey<T>) => key.defaultValue(),
		set: async () => undefined,
		remove: async () => undefined,
		transaction: async () => {
			throw new Error("canonical commit failed");
		},
	};
	let desktopLyricsChanges = 0;
	let current: ShellPreferencesResult | null = null;
	function Harness() {
		current = useShellPreferences({
			showToast: () => undefined,
			onDesktopLyricsChange: () => {
				desktopLyricsChanges += 1;
			},
			preferences,
			hydratedPreferences,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	let message = "";
	await act(async () => {
		try {
			await Promise.resolve(
				current!.applyVisualSettingsTransaction({
					cinema: false,
					desktopLyrics: true,
					shelf: "stage",
				}),
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
	});

	expect(message).toBe("canonical commit failed");
	expect(useVisualStore.getState().fx.cinema).toBe(true);
	expect(useVisualStore.getState().fx.desktopLyrics).toBe(false);
	expect(useShelfStore.getState().mode).toBe("side");
	expect(desktopLyricsChanges).toBe(0);

	message = "";
	await act(async () => {
		try {
			await Promise.resolve(current!.updateShelfMode("stage"));
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
	});
	expect(message).toBe("canonical commit failed");
	expect(useShelfStore.getState().mode).toBe("side");
	expect(useVisualStore.getState().fx.shelf).toBe("side");

	await act(async () => root.unmount());
	host.remove();
	useShelfStore.setState(originalShelf, true);
	useVisualStore.setState(originalVisual, true);
});

import { create } from "zustand";
import {
	PersistedVisualState,
	PersistedVisualStateSchema,
} from "@mineradio/shared";
import { cloneFxState, type FxState } from "@mineradio/visual-engine";

export const VISUAL_SETTINGS_STORE_KEY = "mineradio-tauri-visual-settings-v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const LYRIC_FONT_KEYS = new Set([
	"sans",
	"hei",
	"song",
	"bold-song",
	"stone-song",
	"kai-song",
	"serif-en",
	"gothic",
	"editorial",
	"humanist",
	"mono",
	"display",
]);

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	return fallback;
}

function lyricFontValue(value: unknown, fallback: string): string {
	const key = typeof value === "string" ? value.trim().toLowerCase() : "";
	return LYRIC_FONT_KEYS.has(key) ? key : fallback;
}

export function normalizeVisualFxState(input?: Partial<FxState> | null): FxState {
	const fx = cloneFxState();
	if (!input) return fx;
	return {
		...fx,
		...input,
		preset: Math.round(clamp(input.preset, fx.preset, 0, 6)),
		intensity: clamp(input.intensity, fx.intensity, 0.2, 1.6),
		cinemaShake: clamp(input.cinemaShake, fx.cinemaShake, 0, 1.8),
		depth: clamp(input.depth, fx.depth, 0.2, 1.8),
		coverResolution: clamp(input.coverResolution, fx.coverResolution, 0.75, 1.55),
		lyricGlowStrength: clamp(input.lyricGlowStrength, fx.lyricGlowStrength, 0, 0.85),
		lyricScale: clamp(input.lyricScale, fx.lyricScale, 0.35, 1.65),
		lyricOffsetX: clamp(input.lyricOffsetX, fx.lyricOffsetX, -2, 2),
		lyricOffsetY: clamp(input.lyricOffsetY, fx.lyricOffsetY, -1.2, 1.35),
		lyricOffsetZ: clamp(input.lyricOffsetZ, fx.lyricOffsetZ, -1.6, 1.6),
		lyricTiltX: clamp(input.lyricTiltX, fx.lyricTiltX, -42, 42),
		lyricTiltY: clamp(input.lyricTiltY, fx.lyricTiltY, -42, 42),
		backgroundOpacity: clamp(input.backgroundOpacity, fx.backgroundOpacity, 0, 1),
		controlGlassChromaticOffset: clamp(input.controlGlassChromaticOffset, fx.controlGlassChromaticOffset, 0, 140),
		desktopLyrics: booleanValue(input.desktopLyrics, fx.desktopLyrics),
		desktopLyricsClickThrough: booleanValue(input.desktopLyricsClickThrough, fx.desktopLyricsClickThrough),
		desktopLyricsCinema: booleanValue(input.desktopLyricsCinema, fx.desktopLyricsCinema),
		desktopLyricsHighlight: booleanValue(input.desktopLyricsHighlight, fx.desktopLyricsHighlight),
		lyricFont: lyricFontValue(input.lyricFont, fx.lyricFont),
		wallpaperMode: false,
		floatLayer: false,
		cinema: booleanValue(input.cinema, fx.cinema),
		edge: booleanValue(input.edge, fx.edge),
		bloom: booleanValue(input.bloom, fx.bloom),
		lyricGlow: booleanValue(input.lyricGlow, fx.lyricGlow),
		lyricGlowBeat: booleanValue(input.lyricGlowBeat, fx.lyricGlowBeat),
		lyricGlowParticles: booleanValue(input.lyricGlowParticles, fx.lyricGlowParticles),
		lyricCameraLock: booleanValue(input.lyricCameraLock, fx.lyricCameraLock),
		liveBackgroundKeep: booleanValue(input.liveBackgroundKeep, fx.liveBackgroundKeep),
		mouseXy: { ...fx.mouseXy, ...(input.mouseXy ?? {}) },
	};
}

export interface VisualState {
	fx: FxState;
	preset: number;
	intensity: number;
	custom: Record<string, unknown>;
	setPreset: (preset: number) => void;
	setIntensity: (intensity: number) => void;
	setNumberSetting: (key: keyof FxState, value: number) => void;
	setBooleanSetting: (key: keyof FxState, value: boolean) => void;
	setStringSetting: (key: keyof FxState, value: string) => void;
	setFxPatch: (patch: Partial<FxState>) => void;
	setCustom: (key: string, value: unknown) => void;
	serialize: () => PersistedVisualState;
}

export function loadFromStorage(json: string): PersistedVisualState | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const result = PersistedVisualStateSchema.safeParse(parsed);
	return result.success ? result.data : null;
}

function storageOrNull(storage?: StorageLike): StorageLike | null {
	if (storage) return storage;
	if (typeof localStorage === "undefined") return null;
	return localStorage;
}

export function loadVisualFxFromStorage(storage?: StorageLike): FxState | null {
	const target = storageOrNull(storage);
	if (!target) return null;
	try {
		const raw = target.getItem(VISUAL_SETTINGS_STORE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<FxState>;
		return normalizeVisualFxState(parsed);
	} catch {
		return null;
	}
}

export function saveVisualFxToStorage(storage?: StorageLike): void {
	const target = storageOrNull(storage);
	if (!target) return;
	try {
		target.setItem(VISUAL_SETTINGS_STORE_KEY, JSON.stringify(useVisualStore.getState().fx));
	} catch {
	}
}

const initialFx = normalizeVisualFxState(loadVisualFxFromStorage());

export const useVisualStore = create<VisualState>()((set, get) => ({
	fx: initialFx,
	preset: initialFx.preset,
	intensity: initialFx.intensity,
	custom: {},
	setPreset: (preset) => set((state) => {
		const fx = normalizeVisualFxState({ ...state.fx, preset });
		return { fx, preset: fx.preset, intensity: fx.intensity };
	}),
	setIntensity: (intensity) => set((state) => {
		const fx = normalizeVisualFxState({ ...state.fx, intensity });
		return { fx, preset: fx.preset, intensity: fx.intensity };
	}),
	setNumberSetting: (key, value) => set((state) => {
		const fx = normalizeVisualFxState({ ...state.fx, [key]: value });
		return { fx, preset: fx.preset, intensity: fx.intensity };
	}),
	setBooleanSetting: (key, value) => set((state) => {
		const fx = normalizeVisualFxState({ ...state.fx, [key]: value });
		return { fx, preset: fx.preset, intensity: fx.intensity };
	}),
	setStringSetting: (key, value) => set((state) => {
		const fx = normalizeVisualFxState({ ...state.fx, [key]: value });
		return { fx, preset: fx.preset, intensity: fx.intensity };
	}),
	setFxPatch: (patch) => set((state) => {
		const fx = normalizeVisualFxState({ ...state.fx, ...patch });
		return { fx, preset: fx.preset, intensity: fx.intensity };
	}),
	setCustom: (key, value) =>
		set((s) => ({ custom: { ...s.custom, [key]: value } })),
	serialize: () => ({
		version: 1,
		preset: String(get().preset),
		intensity: get().intensity,
		custom: get().custom,
		updatedAt: Math.floor(Date.now() / 1000),
	}),
}));

import { create } from "zustand";
import {
  PersistedVisualState,
  PersistedVisualStateSchema,
} from "@mineradio/shared";
import {
  clampPreset,
  cloneFxState,
  migrateLegacyPreset,
  normalizeSonicWorkshopSettings,
  normalizeSonicTopographySettings,
  SONIC_WORKSHOP_PRESET_INDEX,
  normalizeStageLyricsSettings,
  type FxState,
  type FxStatePatch,
} from "@mineradio/visual-engine";
import {
  SONIC_WORKSHOP_ACTIVATION_ID,
  VISUAL_WORKSHOP_PREFERENCE,
  type VisualWorkshopPreference,
} from "../preferences/keys";

export const VISUAL_SETTINGS_STORE_KEY = "mineradio-tauri-visual-settings-v1";
export const VISUAL_WORKSHOP_SETTINGS_STORE_KEY =
  "mineradio-tauri-workshop-settings-v1";

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
const SHELF_VALUES = new Set(["off", "side", "stage"]);
const SHELF_CAMERA_VALUES = new Set(["dynamic", "static"]);
const SHELF_PRESENCE_VALUES = new Set(["auto", "always"]);
const PERFORMANCE_BACKGROUND_VALUES = new Set(["auto", "keep", "release"]);
const PERFORMANCE_QUALITY_VALUES = new Set([
  "eco",
  "balanced",
  "high",
  "ultra",
]);

function clamp(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
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
  if (/^custom:[a-z0-9_-]{6,64}$/.test(key)) return key;
  return LYRIC_FONT_KEYS.has(key) ? key : fallback;
}

function enumStringValue(
  value: unknown,
  fallback: string,
  allowed: Set<string>,
): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.has(key) ? key : fallback;
}

function hexColorValue(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : fallback;
}

function visualTintModeValue(value: unknown, fallback: string): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (key === "custom") return "custom";
  return fallback === "custom" ? "custom" : "auto";
}

function lyricColorModeValue(value: unknown, fallback: string): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (key === "custom") return "custom";
  return fallback === "custom" ? "custom" : "auto";
}

function desktopLyricsFpsValue(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n <= 26) return 24;
  if (n <= 45) return 30;
  if (n <= 90) return 60;
  return 120;
}

export function normalizeVisualFxState(
  input?: FxStatePatch | null,
): FxState {
  const fx = cloneFxState();
  if (!input) return fx;
  return {
    ...fx,
    ...input,
    preset: input.preset === undefined ? fx.preset : clampPreset(Number(input.preset)),
    intensity: clamp(input.intensity, fx.intensity, 0.2, 1.6),
    cinemaShake: clamp(input.cinemaShake, fx.cinemaShake, 0, 1.8),
    depth: clamp(input.depth, fx.depth, 0.2, 1.8),
    coverResolution: clamp(
      input.coverResolution,
      fx.coverResolution,
      0.75,
      1.55,
    ),
    lyricGlowStrength: clamp(
      input.lyricGlowStrength,
      fx.lyricGlowStrength,
      0,
      0.85,
    ),
    lyricScale: clamp(input.lyricScale, fx.lyricScale, 0.35, 1.65),
    lyricOffsetX: clamp(input.lyricOffsetX, fx.lyricOffsetX, -2, 2),
    lyricOffsetY: clamp(input.lyricOffsetY, fx.lyricOffsetY, -1.2, 1.35),
    lyricOffsetZ: clamp(input.lyricOffsetZ, fx.lyricOffsetZ, -1.6, 1.6),
    lyricTiltX: clamp(input.lyricTiltX, fx.lyricTiltX, -42, 42),
    lyricTiltY: clamp(input.lyricTiltY, fx.lyricTiltY, -42, 42),
    desktopLyricsSize: clamp(
      input.desktopLyricsSize,
      fx.desktopLyricsSize,
      0.72,
      1.55,
    ),
    desktopLyricsOpacity: clamp(
      input.desktopLyricsOpacity,
      fx.desktopLyricsOpacity,
      0.28,
      1,
    ),
    desktopLyricsY: clamp(input.desktopLyricsY, fx.desktopLyricsY, 0.08, 0.92),
    desktopLyricsFps: desktopLyricsFpsValue(
      input.desktopLyricsFps,
      fx.desktopLyricsFps,
    ),
    visualTintMode: visualTintModeValue(
      input.visualTintMode,
      fx.visualTintMode,
    ),
    visualTintColor: hexColorValue(
      input.visualTintColor,
      fx.visualTintColor,
    ),
    lyricColorMode: lyricColorModeValue(
      input.lyricColorMode,
      fx.lyricColorMode,
    ),
    lyricColor: hexColorValue(input.lyricColor, fx.lyricColor),
    lyricHighlightMode: lyricColorModeValue(
      input.lyricHighlightMode,
      fx.lyricHighlightMode,
    ),
    lyricHighlightColor: hexColorValue(
      input.lyricHighlightColor,
      fx.lyricHighlightColor,
    ),
    lyricGlowLinked: booleanValue(input.lyricGlowLinked, fx.lyricGlowLinked),
    lyricGlowColor: hexColorValue(input.lyricGlowColor, fx.lyricGlowColor),
    uiAccentColor: hexColorValue(input.uiAccentColor, fx.uiAccentColor),
    homeAccentColor: hexColorValue(
      input.homeAccentColor,
      fx.homeAccentColor,
    ),
    backgroundOpacity: clamp(
      input.backgroundOpacity,
      fx.backgroundOpacity,
      0,
      1,
    ),
    controlGlassChromaticOffset: clamp(
      input.controlGlassChromaticOffset,
      fx.controlGlassChromaticOffset,
      0,
      140,
    ),
    desktopLyrics: booleanValue(input.desktopLyrics, fx.desktopLyrics),
    desktopLyricsClickThrough: booleanValue(
      input.desktopLyricsClickThrough,
      fx.desktopLyricsClickThrough,
    ),
    desktopLyricsCinema: booleanValue(
      input.desktopLyricsCinema,
      fx.desktopLyricsCinema,
    ),
    desktopLyricsHighlight: booleanValue(
      input.desktopLyricsHighlight,
      fx.desktopLyricsHighlight,
    ),
    lyricFont: lyricFontValue(input.lyricFont, fx.lyricFont),
    wallpaperMode: false,
    floatLayer: false,
    cinema: booleanValue(input.cinema, fx.cinema),
    edge: booleanValue(input.edge, fx.edge),
    bloom: booleanValue(input.bloom, fx.bloom),
    lyricGlow: booleanValue(input.lyricGlow, fx.lyricGlow),
    lyricGlowBeat: booleanValue(input.lyricGlowBeat, fx.lyricGlowBeat),
    lyricGlowParticles: booleanValue(
      input.lyricGlowParticles,
      fx.lyricGlowParticles,
    ),
    lyricCameraLock: booleanValue(input.lyricCameraLock, fx.lyricCameraLock),
    liveBackgroundKeep: booleanValue(
      input.liveBackgroundKeep,
      fx.liveBackgroundKeep,
    ),
    shelf: enumStringValue(input.shelf, fx.shelf, SHELF_VALUES),
    shelfCameraMode: enumStringValue(
      input.shelfCameraMode,
      fx.shelfCameraMode,
      SHELF_CAMERA_VALUES,
    ),
    shelfPresence: enumStringValue(
      input.shelfPresence,
      fx.shelfPresence,
      SHELF_PRESENCE_VALUES,
    ),
    shelfShowPodcasts: booleanValue(
      input.shelfShowPodcasts,
      fx.shelfShowPodcasts,
    ),
    shelfMergeCollections: booleanValue(
      input.shelfMergeCollections,
      fx.shelfMergeCollections,
    ),
    performanceBackground: enumStringValue(
      input.performanceBackground,
      fx.performanceBackground,
      PERFORMANCE_BACKGROUND_VALUES,
    ),
    performanceQuality: enumStringValue(
      input.performanceQuality,
      fx.performanceQuality,
      PERFORMANCE_QUALITY_VALUES,
    ),
    // 视觉存储是 Web 设置恢复和更新的唯一归一化入口；运行时只消费此快照。
    stageLyrics: normalizeStageLyricsSettings(input.stageLyrics),
    sonic: normalizeSonicTopographySettings(input.sonic),
    workshop: normalizeSonicWorkshopSettings(input.workshop),
    mouseXy: { ...fx.mouseXy, ...(input.mouseXy ?? {}) },
  };
}

/** 旧 visual.fx 的 numeric 8 永远表示旧预设并迁往 Sonic 7。 */
export function decodeLegacyVisualFxState(
  input?: FxStatePatch | null,
): FxState {
  if (!input) return normalizeVisualFxState(input);
  const { workshop: _legacyWorkshop, ...legacyVisualFx } = input;
  if (legacyVisualFx.preset === undefined) {
    return normalizeVisualFxState(legacyVisualFx);
  }
  return normalizeVisualFxState({
    ...legacyVisualFx,
    preset: migrateLegacyPreset(Number(legacyVisualFx.preset)),
  });
}

/**
 * 嵌套视觉设置的 patch 必须以当前完整快照为基准合并，不能让缺失字段回落默认值。
 */
function mergeVisualFxPatch(base: FxState, patch: FxStatePatch): FxStatePatch {
  const sonicPatch = patch.sonic;
  const workshopPatch = patch.workshop;
  return {
    ...base,
    ...patch,
    stageLyrics: patch.stageLyrics
      ? { ...base.stageLyrics, ...patch.stageLyrics }
      : base.stageLyrics,
    sonic: sonicPatch
      ? {
          ...base.sonic,
          ...sonicPatch,
          terrain: { ...base.sonic.terrain, ...sonicPatch.terrain },
          eq: { ...base.sonic.eq, ...sonicPatch.eq },
          colors: { ...base.sonic.colors, ...sonicPatch.colors },
          floating: { ...base.sonic.floating, ...sonicPatch.floating },
          trigger: { ...base.sonic.trigger, ...sonicPatch.trigger },
        }
      : base.sonic,
    workshop: workshopPatch
      ? {
          ...base.workshop,
          ...workshopPatch,
          colors: { ...base.workshop.colors, ...workshopPatch.colors },
        }
      : base.workshop,
    mouseXy: { ...base.mouseXy, ...patch.mouseXy },
  };
}

export function mergeVisualFxState(
  base: FxState,
  patch: FxStatePatch,
): FxState {
  return normalizeVisualFxState(mergeVisualFxPatch(base, patch));
}

export type SerializedVisualFxState = Omit<FxState, "workshop">;

export function serializeVisualFxState(state: FxState): SerializedVisualFxState {
  const normalized = normalizeVisualFxState(state);
  const { workshop: _workshop, ...visualFx } = normalized;
  return {
    ...visualFx,
    // visual.fx 是 legacy-compatible 文档，绝不以 numeric 8 激活 Workshop。
    preset:
      normalized.preset === SONIC_WORKSHOP_PRESET_INDEX
        ? migrateLegacyPreset(SONIC_WORKSHOP_PRESET_INDEX)
        : normalized.preset,
  };
}

export function serializeVisualWorkshopPreference(
  state: FxState,
): VisualWorkshopPreference {
  const normalized = normalizeVisualFxState(state);
  const active =
    normalized.preset === SONIC_WORKSHOP_PRESET_INDEX &&
    normalized.workshop.active;
  return {
    version: 1,
    activationId: SONIC_WORKSHOP_ACTIVATION_ID,
    active,
    settings: normalizeSonicWorkshopSettings({
      ...normalized.workshop,
      active,
    }),
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
  setFxPatch: (patch: FxStatePatch) => void;
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
  let visual: FxState | null = null;
  try {
    const raw = target.getItem(VISUAL_SETTINGS_STORE_KEY);
    visual = raw
      ? decodeLegacyVisualFxState(JSON.parse(raw) as FxStatePatch)
      : null;
  } catch {
    visual = null;
  }
  try {
    const workshopRaw = target.getItem(VISUAL_WORKSHOP_SETTINGS_STORE_KEY);
    if (!workshopRaw) return visual;
    const workshop = VISUAL_WORKSHOP_PREFERENCE.parse(JSON.parse(workshopRaw));
    if (!workshop) return visual;
    return mergeVisualFxState(visual ?? normalizeVisualFxState(), {
      preset: workshop.active
        ? SONIC_WORKSHOP_PRESET_INDEX
        : (visual?.preset ?? 0),
      workshop: normalizeSonicWorkshopSettings({
        ...workshop.settings,
        active: workshop.active,
      }),
    });
  } catch {
    // Workshop fallback 单键损坏不能抹掉仍然有效的 legacy visual.fx。
    return visual;
  }
}

export function saveVisualFxToStorage(storage?: StorageLike): void {
  const target = storageOrNull(storage);
  if (!target) return;
  try {
    const fx = useVisualStore.getState().fx;
    // 先写独立 Workshop 关闭/激活状态，避免第二键失败时遗留旧 active=true
    // 反向覆盖新的普通 preset。真正的跨键原子提交由 PreferencesRepository 负责。
    target.setItem(
      VISUAL_WORKSHOP_SETTINGS_STORE_KEY,
      JSON.stringify(serializeVisualWorkshopPreference(fx)),
    );
    target.setItem(
      VISUAL_SETTINGS_STORE_KEY,
      JSON.stringify(serializeVisualFxState(fx)),
    );
  } catch {}
}

const initialFx = normalizeVisualFxState(loadVisualFxFromStorage());

export const useVisualStore = create<VisualState>()((set, get) => ({
  fx: initialFx,
  preset: initialFx.preset,
  intensity: initialFx.intensity,
  custom: {},
  setPreset: (preset) =>
    set((state) => {
      const fx = normalizeVisualFxState({
        ...state.fx,
        preset,
        workshop: { ...state.fx.workshop, active: false },
      });
      return { fx, preset: fx.preset, intensity: fx.intensity };
    }),
  setIntensity: (intensity) =>
    set((state) => {
      const fx = normalizeVisualFxState({ ...state.fx, intensity });
      return { fx, preset: fx.preset, intensity: fx.intensity };
    }),
  setNumberSetting: (key, value) =>
    set((state) => {
      const fx = normalizeVisualFxState({ ...state.fx, [key]: value });
      return { fx, preset: fx.preset, intensity: fx.intensity };
    }),
  setBooleanSetting: (key, value) =>
    set((state) => {
      const fx = normalizeVisualFxState({ ...state.fx, [key]: value });
      return { fx, preset: fx.preset, intensity: fx.intensity };
    }),
  setStringSetting: (key, value) =>
    set((state) => {
      const fx = normalizeVisualFxState({ ...state.fx, [key]: value });
      return { fx, preset: fx.preset, intensity: fx.intensity };
    }),
  setFxPatch: (patch) =>
    set((state) => {
      const fx = mergeVisualFxState(state.fx, patch);
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

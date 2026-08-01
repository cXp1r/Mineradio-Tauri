import { useCallback, useEffect, useState } from "react";
import type { PlaybackQualityRequest } from "@mineradio/shared";
import {
  SONIC_WORKSHOP_PRESET_INDEX,
  type FxState,
  type FxStatePatch,
} from "@mineradio/visual-engine";
import {
  loadShelfSettingsFromStorage,
  mergeShelfSettings,
  normalizeShelfSettings,
  saveShelfSettingsToStorage,
  serializeShelfSettings,
  useShelfStore,
  type ShelfCameraMode,
  type ShelfMode,
  type ShelfPresence,
  type ShelfSettings,
} from "../../stores/shelf-store";
import {
  mergeVisualFxState,
  decodeLegacyVisualFxState,
  normalizeVisualFxState,
  saveVisualFxToStorage,
  serializeVisualFxState,
  serializeVisualWorkshopPreference,
  useVisualStore,
} from "../../stores/visual-store";
import { VISUAL_GUIDE_SEEN_STORE_KEY } from "../../components/shell/VisualGuideHost";
import type {
  PreferencesRepository,
  PreferencesTransaction,
} from "../../ports/preferences-repository";
import {
  CAPSULE_AUTO_HIDE_PREFERENCE,
  DIY_MODE_PREFERENCE,
  PLAYBACK_QUALITY_PREFERENCE,
  PLAYLIST_PANEL_PINNED_PREFERENCE,
  SETTINGS_FAB_AUTO_HIDE_PREFERENCE,
  SHELF_PREFERENCE,
  VISUAL_FX_PREFERENCE,
  VISUAL_WORKSHOP_PREFERENCE,
  VISUAL_GUIDE_SEEN_PREFERENCE,
  WALLPAPER_SELECTION_PREFERENCE,
} from "../../preferences/keys";

export const PLAYBACK_QUALITY_STORE_KEY = "mineradio-playback-quality-v1";
export const USER_CAPSULE_AUTO_HIDE_STORE_KEY =
  "mineradio-user-capsule-auto-hide-v1";
export const PLAYLIST_PANEL_PIN_STORE_KEY =
  "mineradio-playlist-panel-pinned-v1";
export const DIY_MODE_STORE_KEY = "mineradio-diy-player-mode-v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function readBooleanPreference(
  key: string,
  fallback = false,
  storage?: StorageLike,
): boolean {
  const target = browserStorage(storage);
  if (!target) return fallback;
  try {
    const raw = target.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function saveBooleanPreference(
  key: string,
  value: boolean,
  storage?: StorageLike,
): void {
  const target = browserStorage(storage);
  if (!target) return;
  try {
    target.setItem(key, value ? "1" : "0");
  } catch {
    // 浏览器禁用存储时继续使用当前会话状态。
  }
}

export function normalizePlaybackQualityPreference(
  value: string,
): PlaybackQualityRequest {
  const text = value.trim();
  if (!text) return "hires";
  if (text.toLowerCase() === "hi-res") return "hires";
  return text;
}

export function readPlaybackQualityPreference(
  storage?: StorageLike,
): PlaybackQualityRequest {
  const target = browserStorage(storage);
  if (!target) return "hires";
  const raw = target.getItem(PLAYBACK_QUALITY_STORE_KEY);
  return raw ? normalizePlaybackQualityPreference(raw) : "hires";
}

export function savePlaybackQualityPreference(
  quality: PlaybackQualityRequest,
  storage?: StorageLike,
): void {
  const target = browserStorage(storage);
  if (!target) return;
  target.setItem(PLAYBACK_QUALITY_STORE_KEY, quality);
}

export interface HydratedShellPreferencesSnapshot {
  diyMode: boolean;
  playlistPanelPinned: boolean;
  userCapsuleAutoHide: boolean;
  visualGuideSeen: boolean;
  playbackQuality: PlaybackQualityRequest;
  settingsFabAutoHide: boolean;
  wallpaperSelection: string | null;
  shelf: ReturnType<typeof normalizeShelfSettings>;
  visualFx: FxState;
}

function visualFxFromCanonicalPreferences(
  visualFx: unknown,
  visualWorkshop: ReturnType<typeof VISUAL_WORKSHOP_PREFERENCE.defaultValue>,
): FxState {
  const legacySafeVisual = decodeLegacyVisualFxState(visualFx as FxStatePatch);
  return mergeVisualFxState(legacySafeVisual, {
    preset: visualWorkshop.active
      ? SONIC_WORKSHOP_PRESET_INDEX
      : legacySafeVisual.preset,
    workshop: {
      ...visualWorkshop.settings,
      active: visualWorkshop.active,
    },
  });
}

async function readCanonicalVisualFx(
  transaction: PreferencesTransaction,
): Promise<FxState> {
  const [visualFx, visualWorkshop] = await Promise.all([
    transaction.get(VISUAL_FX_PREFERENCE),
    transaction.get(VISUAL_WORKSHOP_PREFERENCE),
  ]);
  return visualFxFromCanonicalPreferences(visualFx, visualWorkshop);
}

export async function loadHydratedShellPreferencesSnapshot(
  preferences: PreferencesRepository,
): Promise<HydratedShellPreferencesSnapshot> {
  const [
    diyMode,
    playlistPanelPinned,
    userCapsuleAutoHide,
    visualGuideSeen,
    playbackQuality,
    settingsFabAutoHide,
    wallpaperSelection,
    shelf,
    visualFx,
	visualWorkshop,
  ] = await Promise.all([
    preferences.get(DIY_MODE_PREFERENCE),
    preferences.get(PLAYLIST_PANEL_PINNED_PREFERENCE),
    preferences.get(CAPSULE_AUTO_HIDE_PREFERENCE),
    preferences.get(VISUAL_GUIDE_SEEN_PREFERENCE),
    preferences.get(PLAYBACK_QUALITY_PREFERENCE),
    preferences.get(SETTINGS_FAB_AUTO_HIDE_PREFERENCE),
    preferences.get(WALLPAPER_SELECTION_PREFERENCE),
    preferences.get(SHELF_PREFERENCE),
    preferences.get(VISUAL_FX_PREFERENCE),
	preferences.get(VISUAL_WORKSHOP_PREFERENCE),
  ]);
  return {
    diyMode,
    playlistPanelPinned,
    userCapsuleAutoHide,
    visualGuideSeen,
    playbackQuality,
    settingsFabAutoHide,
    wallpaperSelection,
    shelf: normalizeShelfSettings(shelf),
    visualFx: visualFxFromCanonicalPreferences(visualFx, visualWorkshop),
  };
}

export function applyHydratedShellPreferencesSnapshot(
  snapshot: HydratedShellPreferencesSnapshot,
): void {
  useShelfStore.getState().applySettings(snapshot.shelf);
  useVisualStore.getState().setFxPatch(snapshot.visualFx);
}

export function shelfSettingsPatchFromVisualFx(
  patch: FxStatePatch,
): Partial<ShelfSettings> | null {
  const shelfPatch: Partial<ShelfSettings> = {};
  if (typeof patch.shelf === "string") {
    shelfPatch.mode = patch.shelf as ShelfMode;
  }
  if (typeof patch.shelfCameraMode === "string") {
    shelfPatch.cameraMode = patch.shelfCameraMode as ShelfCameraMode;
  }
  if (typeof patch.shelfPresence === "string") {
    shelfPatch.presence = patch.shelfPresence as ShelfPresence;
  }
  if (typeof patch.shelfShowPodcasts === "boolean") {
    shelfPatch.showPodcasts = patch.shelfShowPodcasts;
  }
  if (typeof patch.shelfMergeCollections === "boolean") {
    shelfPatch.mergeCollections = patch.shelfMergeCollections;
  }
  return Object.keys(shelfPatch).length > 0 ? shelfPatch : null;
}

export function visualFxPatchFromShelfSettings(
  patch: Partial<ShelfSettings>,
): FxStatePatch {
  return {
    ...(patch.mode === undefined ? {} : { shelf: patch.mode }),
    ...(patch.cameraMode === undefined
      ? {}
      : { shelfCameraMode: patch.cameraMode }),
    ...(patch.presence === undefined
      ? {}
      : { shelfPresence: patch.presence }),
    ...(patch.showPodcasts === undefined
      ? {}
      : { shelfShowPodcasts: patch.showPodcasts }),
    ...(patch.mergeCollections === undefined
      ? {}
      : { shelfMergeCollections: patch.mergeCollections }),
  };
}

function canonicalShelfValue(settings: ShelfSettings) {
  const value = SHELF_PREFERENCE.parse(serializeShelfSettings(settings));
  if (!value) throw new Error("SHELF_PREFERENCE_SERIALIZE_FAILED");
  return value;
}

function canonicalVisualValue(fx: FxState) {
  const value = VISUAL_FX_PREFERENCE.parse(serializeVisualFxState(fx));
  if (!value) throw new Error("VISUAL_PREFERENCE_SERIALIZE_FAILED");
  return value;
}

function canonicalWorkshopValue(fx: FxState) {
  const value = VISUAL_WORKSHOP_PREFERENCE.parse(
    serializeVisualWorkshopPreference(fx),
  );
  if (!value) throw new Error("WORKSHOP_PREFERENCE_SERIALIZE_FAILED");
  return value;
}

export interface ShellPreferencesOptions {
  showToast(message: string): void;
  onDesktopLyricsChange(enabled: boolean): void;
  storage?: StorageLike;
  /** Composition root 注入的已完成迁移/校验的 canonical repository。 */
  preferences?: PreferencesRepository;
  /** 与 repository 同批读取的同步启动快照，避免首次渲染回退旧存储。 */
  hydratedPreferences?: HydratedShellPreferencesSnapshot;
}

export interface ShellPreferencesResult {
  diyMode: boolean;
  playlistPanelPinned: boolean;
  userCapsuleAutoHide: boolean;
  shelfMode: ShelfMode;
  shelfCameraMode: ShelfCameraMode;
  shelfPresence: ShelfPresence;
  shelfShowPodcasts: boolean;
  shelfMergeCollections: boolean;
  visualFx: FxState;
  visualPreset: number;
  visualIntensity: number;
  setDiyMode(enabled: boolean): Promise<void> | void;
  setPlaylistPanelPinned(pinned: boolean): Promise<void> | void;
  setUserCapsuleAutoHide(enabled: boolean): Promise<void> | void;
  markVisualGuideSeen(): Promise<void> | void;
  setShelfModeTransient(mode: ShelfMode): void;
  updateShelfMode(mode: ShelfMode): Promise<void> | void;
  updateShelfCameraMode(mode: ShelfCameraMode): Promise<void> | void;
  updateShelfPresence(presence: ShelfPresence): Promise<void> | void;
  updateShelfShowPodcasts(show: boolean): Promise<void> | void;
  updateShelfMergeCollections(merge: boolean): Promise<void> | void;
  updateVisualPreset(preset: number): Promise<void> | void;
  updateVisualFxPatch(patch: FxStatePatch): Promise<void> | void;
  applyVisualSettingsTransaction(patch: FxStatePatch): Promise<void> | void;
  updateVisualNumberSetting(
    key: keyof FxState,
    value: number,
  ): Promise<void> | void;
  updateVisualBooleanSetting(
    key: keyof FxState,
    value: boolean,
  ): Promise<void> | void;
  updateVisualStringSetting(
    key: keyof FxState,
    value: string,
  ): Promise<void> | void;
}

export function useShellPreferences({
  showToast,
  onDesktopLyricsChange,
  storage,
  preferences,
  hydratedPreferences,
}: ShellPreferencesOptions): ShellPreferencesResult {
  const [diyMode, setDiyModeState] = useState(() =>
    hydratedPreferences?.diyMode ??
      readBooleanPreference(DIY_MODE_STORE_KEY, false, storage),
  );
  const [playlistPanelPinned, setPlaylistPanelPinnedState] = useState(() =>
    hydratedPreferences?.playlistPanelPinned ??
      readBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, false, storage),
  );
  const [userCapsuleAutoHide, setUserCapsuleAutoHideState] = useState(() =>
    hydratedPreferences?.userCapsuleAutoHide ??
      readBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, false, storage),
  );

  const shelfMode = useShelfStore((state) => state.mode);
  const shelfCameraMode = useShelfStore((state) => state.cameraMode);
  const shelfPresence = useShelfStore((state) => state.presence);
  const shelfShowPodcasts = useShelfStore((state) => state.showPodcasts);
  const shelfMergeCollections = useShelfStore((state) => state.mergeCollections);
  const setShelfMode = useShelfStore((state) => state.setMode);
  const setShelfCameraMode = useShelfStore((state) => state.setCameraMode);
  const setShelfPresence = useShelfStore((state) => state.setPresence);
  const setShelfShowPodcasts = useShelfStore((state) => state.setShowPodcasts);
  const setShelfMergeCollections = useShelfStore(
    (state) => state.setMergeCollections,
  );
  const applyShelfSettings = useShelfStore((state) => state.applySettings);

  const visualFx = useVisualStore((state) => state.fx);
  const visualPreset = useVisualStore((state) => state.preset);
  const visualIntensity = useVisualStore((state) => state.intensity);
  const setVisualPreset = useVisualStore((state) => state.setPreset);
  const setVisualNumberSetting = useVisualStore(
    (state) => state.setNumberSetting,
  );
  const setVisualBooleanSetting = useVisualStore(
    (state) => state.setBooleanSetting,
  );
  const setVisualStringSetting = useVisualStore(
    (state) => state.setStringSetting,
  );
  const setVisualFxPatch = useVisualStore((state) => state.setFxPatch);

  useEffect(() => {
    if (hydratedPreferences) {
      applyShelfSettings(hydratedPreferences.shelf);
      setVisualFxPatch(hydratedPreferences.visualFx);
      return;
    }
    const settings = loadShelfSettingsFromStorage(storage);
    if (settings) applyShelfSettings(settings);
  }, [
    applyShelfSettings,
    hydratedPreferences,
    setVisualFxPatch,
    storage,
  ]);

  const setDiyMode = useCallback(
    (enabled: boolean) => {
      if (preferences) {
        return preferences.set(DIY_MODE_PREFERENCE, enabled).then(() => {
          setDiyModeState(enabled);
        });
      }
      setDiyModeState(enabled);
      saveBooleanPreference(DIY_MODE_STORE_KEY, enabled, storage);
    },
    [preferences, storage],
  );

  const setPlaylistPanelPinned = useCallback(
    (pinned: boolean) => {
      if (preferences) {
        return preferences
          .set(PLAYLIST_PANEL_PINNED_PREFERENCE, pinned)
          .then(() => {
            setPlaylistPanelPinnedState(pinned);
          });
      }
      setPlaylistPanelPinnedState(pinned);
      saveBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, pinned, storage);
    },
    [preferences, storage],
  );

  const setUserCapsuleAutoHide = useCallback(
    (enabled: boolean) => {
      if (preferences) {
        return preferences
          .set(CAPSULE_AUTO_HIDE_PREFERENCE, enabled)
          .then(() => {
            setUserCapsuleAutoHideState(enabled);
          });
      }
      setUserCapsuleAutoHideState(enabled);
      saveBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, enabled, storage);
    },
    [preferences, storage],
  );

  const markVisualGuideSeen = useCallback(() => {
    if (preferences) {
      return preferences.set(VISUAL_GUIDE_SEEN_PREFERENCE, true);
    }
    saveBooleanPreference(VISUAL_GUIDE_SEEN_STORE_KEY, true, storage);
  }, [preferences, storage]);

  const persistShelf = useCallback(() => {
    saveShelfSettingsToStorage(storage);
  }, [storage]);

  const persistVisual = useCallback(() => {
    saveVisualFxToStorage(storage);
  }, [storage]);

  const commitCanonicalShelfPatch = useCallback(
    async (patch: Partial<ShelfSettings>) => {
      if (!preferences) throw new Error("PREFERENCES_REPOSITORY_REQUIRED");
      const committed = await preferences.transaction(async (transaction) => {
        const currentShelf = normalizeShelfSettings(
          await transaction.get(SHELF_PREFERENCE),
        );
        const nextShelf = mergeShelfSettings(currentShelf, patch);
        await transaction.set(
          SHELF_PREFERENCE,
          canonicalShelfValue(nextShelf),
        );

        const currentVisual = await readCanonicalVisualFx(transaction);
        const nextVisual = mergeVisualFxState(
          currentVisual,
          visualFxPatchFromShelfSettings(patch),
        );
        await transaction.set(
          VISUAL_FX_PREFERENCE,
          canonicalVisualValue(nextVisual),
        );
        await transaction.set(
          VISUAL_WORKSHOP_PREFERENCE,
          canonicalWorkshopValue(nextVisual),
        );
        return { shelf: nextShelf, visualFx: nextVisual };
      });
      // 两份 canonical 快照提交成功后再同时发布，避免 Shelf 与控制台分叉。
      applyShelfSettings(committed.shelf);
      setVisualFxPatch(committed.visualFx);
    },
    [applyShelfSettings, preferences, setVisualFxPatch],
  );

  const commitCanonicalVisualPatch = useCallback(
    async (patch: FxStatePatch) => {
      if (!preferences) throw new Error("PREFERENCES_REPOSITORY_REQUIRED");
      const shelfPatch = shelfSettingsPatchFromVisualFx(patch);
      const committed = await preferences.transaction(async (transaction) => {
        const currentVisual = await readCanonicalVisualFx(transaction);
        const nextVisual = mergeVisualFxState(currentVisual, patch);
        await transaction.set(
          VISUAL_FX_PREFERENCE,
          canonicalVisualValue(nextVisual),
        );
        await transaction.set(
          VISUAL_WORKSHOP_PREFERENCE,
          canonicalWorkshopValue(nextVisual),
        );
        if (!shelfPatch) return { visualFx: nextVisual, shelf: null };

        const currentShelf = normalizeShelfSettings(
          await transaction.get(SHELF_PREFERENCE),
        );
        const nextShelf = mergeShelfSettings(currentShelf, shelfPatch);
        await transaction.set(
          SHELF_PREFERENCE,
          canonicalShelfValue(nextShelf),
        );
        return { visualFx: nextVisual, shelf: nextShelf };
      });

      // canonical commit 完成后才发布到运行时，失败时 Zustand 保持原快照。
      setVisualFxPatch(committed.visualFx);
      if (committed.shelf) applyShelfSettings(committed.shelf);
    },
    [applyShelfSettings, preferences, setVisualFxPatch],
  );

  const updateShelfMode = useCallback(
    (mode: ShelfMode) => {
      if (preferences) {
        return commitCanonicalShelfPatch({ mode });
      }
      setShelfMode(mode);
      persistShelf();
    },
    [commitCanonicalShelfPatch, persistShelf, preferences, setShelfMode],
  );

  const updateShelfCameraMode = useCallback(
    (mode: ShelfCameraMode) => {
      if (preferences) {
        return commitCanonicalShelfPatch({ cameraMode: mode }).then(() => {
          showToast(
            mode === "static" ? "3D歌单架: 静态镜头" : "3D歌单架: 动态镜头",
          );
        });
      }
      setShelfCameraMode(mode);
      persistShelf();
      showToast(
        mode === "static" ? "3D歌单架: 静态镜头" : "3D歌单架: 动态镜头",
      );
    },
    [
      commitCanonicalShelfPatch,
      persistShelf,
      preferences,
      setShelfCameraMode,
      showToast,
    ],
  );

  const updateShelfPresence = useCallback(
    (presence: ShelfPresence) => {
      if (preferences) {
        return commitCanonicalShelfPatch({ presence }).then(() => {
          showToast(
            presence === "always" ? "3D歌单架: 常驻" : "3D歌单架: 自动隐藏",
          );
        });
      }
      setShelfPresence(presence);
      persistShelf();
      showToast(
        presence === "always" ? "3D歌单架: 常驻" : "3D歌单架: 自动隐藏",
      );
    },
    [
      commitCanonicalShelfPatch,
      persistShelf,
      preferences,
      setShelfPresence,
      showToast,
    ],
  );

  const updateShelfShowPodcasts = useCallback(
    (show: boolean) => {
      if (preferences) {
        return commitCanonicalShelfPatch({ showPodcasts: show }).then(() => {
          showToast(show ? "3D歌单架已显示播客歌单" : "3D歌单架已隐藏播客歌单");
        });
      }
      setShelfShowPodcasts(show);
      persistShelf();
      showToast(show ? "3D歌单架已显示播客歌单" : "3D歌单架已隐藏播客歌单");
    },
    [
      commitCanonicalShelfPatch,
      persistShelf,
      preferences,
      setShelfShowPodcasts,
      showToast,
    ],
  );

  const updateShelfMergeCollections = useCallback(
    (merge: boolean) => {
      if (preferences) {
        return commitCanonicalShelfPatch({ mergeCollections: merge }).then(() => {
          showToast(
            merge ? "我的歌单与收藏歌单已合并滚动" : "收藏歌单恢复滚到底切页",
          );
        });
      }
      setShelfMergeCollections(merge);
      persistShelf();
      showToast(
        merge ? "我的歌单与收藏歌单已合并滚动" : "收藏歌单恢复滚到底切页",
      );
    },
    [
      commitCanonicalShelfPatch,
      persistShelf,
      preferences,
      setShelfMergeCollections,
      showToast,
    ],
  );

  const updateVisualPreset = useCallback(
    (preset: number) => {
      if (preferences) {
        return commitCanonicalVisualPatch({
          preset,
          workshop: { active: false },
        });
      }
      setVisualPreset(preset);
      persistVisual();
    },
    [commitCanonicalVisualPatch, persistVisual, preferences, setVisualPreset],
  );

  const updateVisualFxPatch = useCallback(
    (patch: FxStatePatch) => {
      if (preferences) {
        return commitCanonicalVisualPatch(patch);
      }
      setVisualFxPatch(patch);
      persistVisual();
    },
    [commitCanonicalVisualPatch, persistVisual, preferences, setVisualFxPatch],
  );

  const applyVisualSettingsTransaction = useCallback(
    (patch: FxStatePatch) => {
      if (preferences) {
        return commitCanonicalVisualPatch(patch).then(() => {
          if (typeof patch.desktopLyrics === "boolean") {
            onDesktopLyricsChange(patch.desktopLyrics);
          }
          if (typeof patch.aiDepth === "boolean") {
            showToast(
              patch.aiDepth
                ? "已开启后台 AI 立体增强"
                : "已关闭 AI 立体增强, 使用轻量弧面",
            );
          }
        });
      }
      setVisualFxPatch(patch);
      let shelfChanged = false;
      if (typeof patch.shelf === "string") {
        setShelfMode(patch.shelf as ShelfMode);
        shelfChanged = true;
      }
      if (typeof patch.shelfCameraMode === "string") {
        setShelfCameraMode(patch.shelfCameraMode as ShelfCameraMode);
        shelfChanged = true;
      }
      if (typeof patch.shelfPresence === "string") {
        setShelfPresence(patch.shelfPresence as ShelfPresence);
        shelfChanged = true;
      }
      if (typeof patch.shelfShowPodcasts === "boolean") {
        setShelfShowPodcasts(patch.shelfShowPodcasts);
        shelfChanged = true;
      }
      if (typeof patch.shelfMergeCollections === "boolean") {
        setShelfMergeCollections(patch.shelfMergeCollections);
        shelfChanged = true;
      }
      if (typeof patch.desktopLyrics === "boolean") {
        onDesktopLyricsChange(patch.desktopLyrics);
      }
      if (typeof patch.aiDepth === "boolean") {
        showToast(
          patch.aiDepth
            ? "已开启后台 AI 立体增强"
            : "已关闭 AI 立体增强, 使用轻量弧面",
        );
      }
      persistVisual();
      if (shelfChanged) persistShelf();
    },
    [
      onDesktopLyricsChange,
      commitCanonicalVisualPatch,
      persistShelf,
      persistVisual,
      preferences,
      setShelfCameraMode,
      setShelfMergeCollections,
      setShelfMode,
      setShelfPresence,
      setShelfShowPodcasts,
      setVisualFxPatch,
      showToast,
    ],
  );

  const updateVisualNumberSetting = useCallback(
    (key: keyof FxState, value: number) => {
      if (preferences) {
        return commitCanonicalVisualPatch(
          key === "backgroundOpacity"
            ? {
                backgroundOpacity: value,
                backgroundColorMode: "custom",
                backgroundColorCustom: true,
              }
            : { [key]: value },
        );
      }
      if (key === "backgroundOpacity") {
        setVisualFxPatch({
          backgroundOpacity: value,
          backgroundColorMode: "custom",
          backgroundColorCustom: true,
        });
        persistVisual();
        return;
      }
      setVisualNumberSetting(key, value);
      persistVisual();
    },
    [
      commitCanonicalVisualPatch,
      persistVisual,
      preferences,
      setVisualFxPatch,
      setVisualNumberSetting,
    ],
  );

  const updateVisualBooleanSetting = useCallback(
    (key: keyof FxState, value: boolean) => {
      if (preferences) {
        return commitCanonicalVisualPatch({ [key]: value }).then(() => {
          if (key === "desktopLyrics") onDesktopLyricsChange(value);
          if (key === "aiDepth") {
            showToast(
              value
                ? "已开启后台 AI 立体增强"
                : "已关闭 AI 立体增强, 使用轻量弧面",
            );
          }
        });
      }
      setVisualBooleanSetting(key, value);
      if (key === "shelfShowPodcasts") setShelfShowPodcasts(value);
      if (key === "shelfMergeCollections") setShelfMergeCollections(value);
      persistVisual();
      if (key === "shelfShowPodcasts" || key === "shelfMergeCollections") {
        persistShelf();
      }
      if (key === "desktopLyrics") onDesktopLyricsChange(value);
      if (key === "aiDepth") {
        showToast(
          value
            ? "已开启后台 AI 立体增强"
            : "已关闭 AI 立体增强, 使用轻量弧面",
        );
      }
    },
    [
      onDesktopLyricsChange,
      commitCanonicalVisualPatch,
      persistShelf,
      persistVisual,
      preferences,
      setShelfMergeCollections,
      setShelfShowPodcasts,
      setVisualBooleanSetting,
      showToast,
    ],
  );

  const updateVisualStringSetting = useCallback(
    (key: keyof FxState, value: string) => {
      if (preferences) {
        return commitCanonicalVisualPatch({ [key]: value });
      }
      setVisualStringSetting(key, value);
      if (key === "shelf") setShelfMode(value as ShelfMode);
      if (key === "shelfCameraMode") {
        setShelfCameraMode(value as ShelfCameraMode);
      }
      if (key === "shelfPresence") {
        setShelfPresence(value as ShelfPresence);
      }
      persistVisual();
      if (
        key === "shelf" ||
        key === "shelfCameraMode" ||
        key === "shelfPresence"
      ) {
        persistShelf();
      }
    },
    [
      persistShelf,
      persistVisual,
      commitCanonicalVisualPatch,
      preferences,
      setShelfCameraMode,
      setShelfMode,
      setShelfPresence,
      setVisualStringSetting,
    ],
  );

  return {
    diyMode,
    playlistPanelPinned,
    userCapsuleAutoHide,
    shelfMode,
    shelfCameraMode,
    shelfPresence,
    shelfShowPodcasts,
    shelfMergeCollections,
    visualFx,
    visualPreset,
    visualIntensity,
    setDiyMode,
    setPlaylistPanelPinned,
    setUserCapsuleAutoHide,
    markVisualGuideSeen,
    setShelfModeTransient: setShelfMode,
    updateShelfMode,
    updateShelfCameraMode,
    updateShelfPresence,
    updateShelfShowPodcasts,
    updateShelfMergeCollections,
    updateVisualPreset,
    updateVisualFxPatch,
    applyVisualSettingsTransaction,
    updateVisualNumberSetting,
    updateVisualBooleanSetting,
    updateVisualStringSetting,
  };
}

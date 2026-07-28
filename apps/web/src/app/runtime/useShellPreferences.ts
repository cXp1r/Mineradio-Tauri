import { useCallback, useEffect, useState } from "react";
import type { PlaybackQualityRequest } from "@mineradio/shared";
import type { FxState, FxStatePatch } from "@mineradio/visual-engine";
import {
  loadShelfSettingsFromStorage,
  saveShelfSettingsToStorage,
  useShelfStore,
  type ShelfCameraMode,
  type ShelfMode,
  type ShelfPresence,
} from "../../stores/shelf-store";
import {
  saveVisualFxToStorage,
  useVisualStore,
} from "../../stores/visual-store";
import { VISUAL_GUIDE_SEEN_STORE_KEY } from "../../components/shell/VisualGuideHost";

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

export interface ShellPreferencesOptions {
  showToast(message: string): void;
  onDesktopLyricsChange(enabled: boolean): void;
  storage?: StorageLike;
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
  setDiyMode(enabled: boolean): void;
  setPlaylistPanelPinned(pinned: boolean): void;
  setUserCapsuleAutoHide(enabled: boolean): void;
  markVisualGuideSeen(): void;
  setShelfModeTransient(mode: ShelfMode): void;
  updateShelfMode(mode: ShelfMode): void;
  updateShelfCameraMode(mode: ShelfCameraMode): void;
  updateShelfPresence(presence: ShelfPresence): void;
  updateShelfShowPodcasts(show: boolean): void;
  updateShelfMergeCollections(merge: boolean): void;
  updateVisualPreset(preset: number): void;
  updateVisualFxPatch(patch: FxStatePatch): void;
  updateVisualNumberSetting(key: keyof FxState, value: number): void;
  updateVisualBooleanSetting(key: keyof FxState, value: boolean): void;
  updateVisualStringSetting(key: keyof FxState, value: string): void;
}

export function useShellPreferences({
  showToast,
  onDesktopLyricsChange,
  storage,
}: ShellPreferencesOptions): ShellPreferencesResult {
  const [diyMode, setDiyModeState] = useState(() =>
    readBooleanPreference(DIY_MODE_STORE_KEY, false, storage),
  );
  const [playlistPanelPinned, setPlaylistPanelPinnedState] = useState(() =>
    readBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, false, storage),
  );
  const [userCapsuleAutoHide, setUserCapsuleAutoHideState] = useState(() =>
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
    const settings = loadShelfSettingsFromStorage(storage);
    if (settings) applyShelfSettings(settings);
  }, [applyShelfSettings, storage]);

  const setDiyMode = useCallback(
    (enabled: boolean) => {
      setDiyModeState(enabled);
      saveBooleanPreference(DIY_MODE_STORE_KEY, enabled, storage);
    },
    [storage],
  );

  const setPlaylistPanelPinned = useCallback(
    (pinned: boolean) => {
      setPlaylistPanelPinnedState(pinned);
      saveBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, pinned, storage);
    },
    [storage],
  );

  const setUserCapsuleAutoHide = useCallback(
    (enabled: boolean) => {
      setUserCapsuleAutoHideState(enabled);
      saveBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, enabled, storage);
    },
    [storage],
  );

  const markVisualGuideSeen = useCallback(() => {
    saveBooleanPreference(VISUAL_GUIDE_SEEN_STORE_KEY, true, storage);
  }, [storage]);

  const persistShelf = useCallback(() => {
    saveShelfSettingsToStorage(storage);
  }, [storage]);

  const persistVisual = useCallback(() => {
    saveVisualFxToStorage(storage);
  }, [storage]);

  const updateShelfMode = useCallback(
    (mode: ShelfMode) => {
      setShelfMode(mode);
      persistShelf();
    },
    [persistShelf, setShelfMode],
  );

  const updateShelfCameraMode = useCallback(
    (mode: ShelfCameraMode) => {
      setShelfCameraMode(mode);
      persistShelf();
      showToast(
        mode === "static" ? "3D歌单架: 静态镜头" : "3D歌单架: 动态镜头",
      );
    },
    [persistShelf, setShelfCameraMode, showToast],
  );

  const updateShelfPresence = useCallback(
    (presence: ShelfPresence) => {
      setShelfPresence(presence);
      persistShelf();
      showToast(
        presence === "always" ? "3D歌单架: 常驻" : "3D歌单架: 自动隐藏",
      );
    },
    [persistShelf, setShelfPresence, showToast],
  );

  const updateShelfShowPodcasts = useCallback(
    (show: boolean) => {
      setShelfShowPodcasts(show);
      persistShelf();
      showToast(show ? "3D歌单架已显示播客歌单" : "3D歌单架已隐藏播客歌单");
    },
    [persistShelf, setShelfShowPodcasts, showToast],
  );

  const updateShelfMergeCollections = useCallback(
    (merge: boolean) => {
      setShelfMergeCollections(merge);
      persistShelf();
      showToast(
        merge ? "我的歌单与收藏歌单已合并滚动" : "收藏歌单恢复滚到底切页",
      );
    },
    [persistShelf, setShelfMergeCollections, showToast],
  );

  const updateVisualPreset = useCallback(
    (preset: number) => {
      setVisualPreset(preset);
      persistVisual();
    },
    [persistVisual, setVisualPreset],
  );

  const updateVisualFxPatch = useCallback(
    (patch: FxStatePatch) => {
      setVisualFxPatch(patch);
      persistVisual();
    },
    [persistVisual, setVisualFxPatch],
  );

  const updateVisualNumberSetting = useCallback(
    (key: keyof FxState, value: number) => {
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
    [persistVisual, setVisualFxPatch, setVisualNumberSetting],
  );

  const updateVisualBooleanSetting = useCallback(
    (key: keyof FxState, value: boolean) => {
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
      persistShelf,
      persistVisual,
      setShelfMergeCollections,
      setShelfShowPodcasts,
      setVisualBooleanSetting,
      showToast,
    ],
  );

  const updateVisualStringSetting = useCallback(
    (key: keyof FxState, value: string) => {
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
    updateVisualNumberSetting,
    updateVisualBooleanSetting,
    updateVisualStringSetting,
  };
}

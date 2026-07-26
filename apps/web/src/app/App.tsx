import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { AppRuntimeProvider } from "./AppRuntimeProvider";
import {
  createLegacyAppServices,
  type AppServices,
  type AppServicesFactory,
} from "./app-services";
export {
  deriveSidecarRecoveryNoticeState,
  nextSidecarStatusPollDelayMs,
} from "./runtime/sidecar-recovery-policy";
import {
  type SidecarRecoveryRuntimeProps,
  type SidecarRuntimeConnection,
} from "./runtime/SidecarRecoveryRuntime";
import { AppShell, type AppShellProps } from "./AppShell";
import {
  createDefaultSidecarClient,
  defaultDesktopRuntime,
} from "./runtime/default-runtime-dependencies";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { useProviderStore } from "../stores/provider-store";
import { useSearchStore } from "../stores/search-store";
import { useShelfStore } from "../stores/shelf-store";
import { useUiStore } from "../stores/ui-store";
import { useUpdateStore } from "../stores/update-store";
import { useVisualStore } from "../stores/visual-store";
import type {
  DesktopJsonValue,
  DesktopRuntimePort,
  DesktopWindowState,
} from "../ports/desktop-runtime-port";
import {
  usePlaybackSessionRuntime,
  type CurrentBeatMapState,
} from "../features/playback/usePlaybackSessionRuntime";
import {
  LOCAL_AUDIO_ACCEPT,
  usePlaybackUiController,
} from "../features/playback/usePlaybackUiController";
import type { PlaybackControllerRef } from "../features/playback/PlaybackSurface";
import { useTrackCustomizationController } from "../features/customization/useTrackCustomizationController";
import {
  LOGIN_QR_PROVIDERS,
  useLoginQrRuntime,
  type LoginModalMode,
  type LoginProviderId,
} from "../features/accounts/useLoginQrRuntime";
import { useAccountSessionController } from "../features/accounts/useAccountSessionController";
import { useDesktopRuntime } from "../features/desktop/useDesktopRuntime";
import { useUpdaterController } from "../features/updater/useUpdaterController";
import { useLikesController } from "../features/likes/useLikesController";
export { isNeteaseLikeSupported } from "../features/likes/likes-policy";
import {
  useLibraryController,
  type LibraryControllerResult,
} from "../features/library/useLibraryController";
export {
  isCollectSupportedTrack,
  mergeProviderPlaylists,
} from "../features/library/library-policy";
import {
  useHomeController,
  type HomeControllerResult,
} from "../features/home/useHomeController";
export { shouldUseCachedHomeDiscoverPlaylist } from "../features/home/home-policy";
import {
  buildDesktopLyricsPayloadPatch,
  desktopLyricsBeatMapContext,
  desktopLyricsBeatMapKey,
} from "../features/desktop/desktop-lyrics-payload";
export {
  buildDesktopLyricsPayloadPatch,
  desktopLyricsBeatMapKey,
} from "../features/desktop/desktop-lyrics-payload";
import type { PlaylistPanelTab } from "../components/shell/PlaylistPanelHost";
import type { SearchMode } from "../components/shell/SearchShell";
import { buildDesktopLyricSnapshot } from "../desktop-lyrics/desktop-lyrics-snapshot";
import type { SidecarRecoveryNoticeState } from "../components/shell/SidecarRecoveryNotice";
import type { VisualGuideStep } from "../components/shell/VisualGuideHost";
import { SplashHost, type SplashHostProps } from "../visual/SplashHost";
import {
  VisualEngineHost,
  type DesktopLyricsMotionSnapshot,
} from "../visual/VisualEngineHost";
import {
  createPodcastRadioDetailOpener,
  createShelfDetailContentLoader,
  handleShelfDetailRowAction,
  type ShelfDetailContentListController,
} from "../visual/shelf-detail-data";
import {
  type ProviderId,
  type ProviderLoginStatus,
  type Track,
} from "@mineradio/shared";
import {
  readPlaybackQualityPreference,
  savePlaybackQualityPreference,
  useShellPreferences,
} from "./runtime/useShellPreferences";
import { useGlobalShellRuntime } from "./runtime/GlobalShellRuntime";
export { isHomeBlankDismissElement } from "./runtime/GlobalShellRuntime";

const SHOW_SPLASH = import.meta.env.VITE_SPLASH !== "0";

function audioElementSupported(): boolean {
  return typeof window !== "undefined" && "HTMLAudioElement" in globalThis;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const LOGIN_PROVIDERS = LOGIN_QR_PROVIDERS;

function providerLabelText(provider: ProviderId): string {
  if (provider === "netease") return "网易云";
  if (provider === "qq") return "QQ 音乐";
  return "汽水音乐";
}


function trackTitle(track: Track | null | undefined): string {
  return track?.title || "MineRadio-Tauri";
}

function trackArtist(track: Track | null | undefined): string {
  return track?.artists?.join(" / ") || track?.album || "";
}

export interface EmptyHomeStateInput {
  splashActive: boolean;
  homeForcedOpen: boolean;
  homeSuppressed: boolean;
  hasCurrentTrack: boolean;
  queueLength: number;
  isPlaying: boolean;
  immersiveActive?: boolean;
  shelfDetailOpen?: boolean;
  shelfPinnedOpen?: boolean;
  shelfStageOpen?: boolean;
}

export function shouldShowEmptyHome(input: EmptyHomeStateInput): boolean {
  if (input.splashActive) return false;
  if (input.homeForcedOpen) return true;
  if (input.homeSuppressed) return false;
  if (input.immersiveActive) return false;
  if (input.shelfDetailOpen) return false;
  if (input.shelfPinnedOpen) return false;
  if (input.shelfStageOpen) return false;
  if (input.hasCurrentTrack) return false;
  if (input.queueLength > 0) return false;
  if (input.isPlaying) return false;
  return true;
}

export function isDesktopWindowFullscreen(state: DesktopWindowState): boolean {
  return !!(
    state.isFullScreen ||
    state.isNativeFullScreen ||
    state.isHtmlFullScreen ||
    state.isWindowFullScreen ||
    (typeof document !== "undefined" && document.fullscreenElement)
  );
}

function forceBottomControlsVisible(awakeDurationMs = 900): void {
  if (typeof document === "undefined") return;
  document.body.classList.remove("home-controls-locked");
  document.body.classList.add("controls-visible", "controls-handle-awake");
  const bar = document.getElementById("bottom-bar");
  if (bar) {
    bar.classList.add("visible");
    bar.classList.remove("soft-hidden");
    bar.style.pointerEvents = "";
  }
  document.getElementById("bottom-handle")?.classList.add("active");
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      document.body.classList.remove("controls-handle-awake");
    }, awakeDurationMs);
  }
}

export function applyDesktopWindowShellState(state: DesktopWindowState): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.add("desktop-shell-root");
  document.body.classList.add("desktop-shell");
  document.body.classList.toggle("desktop-maximized", !!state.isMaximized);
  document.body.classList.toggle(
    "desktop-fullscreen",
    isDesktopWindowFullscreen(state),
  );
}

export function shouldUseSecondaryLeftDisplaySeamGuard(
  state: DesktopWindowState | null,
): boolean {
  return state?.isPrimaryDisplay === false && state.hasDisplayOnLeft;
}

export type AppProps = {
  SplashComponent?: (props: SplashHostProps) => ReactElement | null;
  VisualComponent?: typeof VisualEngineHost;
  createSidecarClient?: SidecarRecoveryRuntimeProps["createSidecarClient"];
  servicesFactory?: AppServicesFactory;
  initialRuntimeConfig?: SidecarRuntimeConnection["config"] | null;
  desktopLyricsRuntime?: DesktopLyricsRuntime;
  desktopRuntime?: DesktopRuntimePort;
};

export type DesktopLyricsRuntime = {
  showWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  updatePayload: (payload: DesktopJsonValue) => Promise<void>;
};

export function App({
  SplashComponent = SplashHost,
  VisualComponent = VisualEngineHost,
  createSidecarClient = createDefaultSidecarClient,
  servicesFactory = createLegacyAppServices,
  initialRuntimeConfig = null,
  desktopLyricsRuntime,
  desktopRuntime = defaultDesktopRuntime,
}: AppProps = {}): ReactElement {
  const [sidecarClient, setSidecarClient] = useState<
    SidecarRuntimeConnection["client"] | null
  >(null);
  const [appServices, setAppServices] = useState<AppServices | null>(null);
  const resolvedDesktopRuntime = useMemo<DesktopRuntimePort>(() => {
    if (!desktopLyricsRuntime) return desktopRuntime;
    return {
      ...desktopRuntime,
      showDesktopLyricsWindow: desktopLyricsRuntime.showWindow,
      closeDesktopLyricsWindow: desktopLyricsRuntime.closeWindow,
      updateDesktopLyricsPayload: desktopLyricsRuntime.updatePayload,
    };
  }, [desktopLyricsRuntime, desktopRuntime]);
  const [sidecarBaseUrl, setSidecarBaseUrl] = useState("");
  const [splashActive, setSplashActive] = useState<boolean>(SHOW_SPLASH);
  const [searchModeRequest, setSearchModeRequest] = useState<SearchMode>("song");
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginModalMode, setLoginModalMode] = useState<LoginModalMode>("full");
  const [loginProvider, setLoginProvider] = useState<LoginProviderId>("netease");
  const [qqManualCookieOpen, setQqManualCookieOpen] = useState(false);
  const [shelfDetailOpen, setShelfDetailOpen] = useState(false);
  const [sidecarRecoveryState, setSidecarRecoveryState] =
    useState<SidecarRecoveryNoticeState | null>(null);
  const [visualGuideOpen, setVisualGuideOpen] = useState(false);
  const visualGuidePlaylistRestoreRef = useRef<{
    open: boolean;
    tab: PlaylistPanelTab;
  } | null>(null);
  const currentTrack = usePlaybackStore((s) => s.currentTrack);
  const queue = usePlaybackStore((s) => s.queue);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const positionMs = usePlaybackStore((s) => s.positionMs);
  const durationMs = usePlaybackStore((s) => s.durationMs);
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  const setMatrix = useProviderStore((s) => s.setMatrix);
  const shelfOpen = useShelfStore((s) => s.open);
  const closeShelf = useShelfStore((s) => s.closeShelf);
  const selectShelfPlaylist = useShelfStore((s) => s.selectPlaylist);
  const consoleVisible = useUiStore((s) => s.consoleVisible);
  const setConsole = useUiStore((s) => s.setConsole);
  const miniQueueOpen = useUiStore((s) => s.miniQueueOpen);
  const setMiniQueue = useUiStore((s) => s.setMiniQueue);
  const toggleMiniQueue = useUiStore((s) => s.toggleMiniQueue);
  const toast = useUiStore((s) => s.toast);
  const showToast = useUiStore((s) => s.showToast);
  const clearToast = useUiStore((s) => s.clearToast);
  const setDesktopLyricsWindowEnabledRef = useRef<
    (enabled: boolean) => Promise<void> | void
  >(() => {});
  const handleDesktopLyricsPreferenceChange = useCallback(
    (enabled: boolean) => {
      void setDesktopLyricsWindowEnabledRef.current(enabled);
    },
    [],
  );
  const {
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
    setPlaylistPanelPinned: persistPlaylistPanelPinned,
    setUserCapsuleAutoHide,
    markVisualGuideSeen,
    setShelfModeTransient,
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
  } = useShellPreferences({
    showToast,
    onDesktopLyricsChange: handleDesktopLyricsPreferenceChange,
  });
  const {
    modalOpen: updateModalOpen,
    setModalOpen: setUpdateModalOpen,
    refresh: refreshUpdateStatus,
    install: installAvailableUpdate,
  } = useUpdaterController({ showToast });
  const {
    isLiked: isTrackLiked,
    isBusy: isTrackLikeBusy,
    toggle: toggleLikeTrack,
  } = useLikesController({
    likes: appServices?.music.likes ?? null,
    currentTrack,
    showToast,
    openProviderLogin: () => setLoginModalOpen(true),
  });
  const updateState = useUpdateStore();

  const lyricsPayload = useLyricsStore((s) => s.payload);
  const setLyricsPayload = useLyricsStore((s) => s.setPayload);
  const setLyricsLoading = useLyricsStore((s) => s.setLoading);
  const setLyricsError = useLyricsStore((s) => s.setError);
  const setLyricsIndex = useLyricsStore((s) => s.setCurrentIndex);
  const lyricsReset = useLyricsStore((s) => s.reset);

  const togglePlay = usePlaybackStore((s) => s.togglePlay);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setPositionMs = usePlaybackStore((s) => s.setPosition);
  const setDurationMs = usePlaybackStore((s) => s.setDuration);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);
  const setPlaybackMode = usePlaybackStore((s) => s.setMode);
  const playbackMode = usePlaybackStore((s) => s.mode);
  const nextTrack = usePlaybackStore((s) => s.next);
  const previousTrack = usePlaybackStore((s) => s.previous);
  const playQueueAt = usePlaybackStore((s) => s.playAt);
  const removeQueueAt = usePlaybackStore((s) => s.removeAt);
  const insertQueueNext = usePlaybackStore((s) => s.insertNext);
  const setQueue = usePlaybackStore((s) => s.setQueue);
  const clearQueue = usePlaybackStore((s) => s.clearQueue);
  const searchKeyword = useSearchStore((s) => s.keyword);
  const searchDetailOpen = useSearchStore((s) => s.detailOpen);
  const setSearchKeyword = useSearchStore((s) => s.setKeyword);
  const setSearchError = useSearchStore((s) => s.setError);
  const libraryControllerRef = useRef<LibraryControllerResult | null>(null);
  const accountLoggedInRef = useRef(false);
  const homeControllerRef = useRef<HomeControllerResult | null>(null);
  const homeController = useHomeController({
    discover: appServices?.music.discover ?? null,
    library: appServices?.music.library ?? null,
    search: appServices?.music.search ?? null,
    currentTrack,
    positionMs,
    durationMs,
    providerLoggedIn: () => accountLoggedInRef.current,
    libraryPanelPinned: playlistPanelPinned,
    playback: {
      setQueue,
      playAt: (index) => usePlaybackStore.getState().playAt(index),
    },
    searchQuery: (query, mode = "song") => {
      homeControllerRef.current?.setSuppressed(false);
      setSearchModeRequest(mode);
      setSearchKeyword(query);
      const input = typeof document === "undefined" ? null : document.getElementById("search-input");
      if (input instanceof HTMLElement && input.tagName === "INPUT") input.focus();
    },
    openLogin: () => setLoginModalOpen(true),
    openLibrarySurface: () => {
      const library = libraryControllerRef.current;
      if (!library) return;
      void library.refresh();
      setConsole(false);
      setMiniQueue(false);
      closeShelf();
      selectShelfPlaylist(null);
      library.openPanelTab("playlists");
      showToast("已打开歌单库");
    },
    enterPlaybackSurface: () => {
      setConsole(true);
      setMiniQueue(false);
    },
    closeLibraryPanel: () => libraryControllerRef.current?.setPanelOpen(false),
    closeShelf,
    selectShelfPlaylist,
    setConsole,
    setMiniQueue,
    showToast,
  });
  homeControllerRef.current = homeController;
  const {
    discover: homeDiscover,
    weatherRadio: homeWeatherRadio,
    playlistDetail: homePlaylistDetail,
    discoverLoading: homeDiscoverLoading,
    weatherRadioLoading: homeWeatherRadioLoading,
    forcedOpen: homeForcedOpen,
    suppressed: homeSuppressed,
    listenSummary: homeListenSummary,
    setForcedOpen: setHomeForcedOpen,
    setSuppressed: setHomeSuppressed,
    refreshDiscover: refreshHomeDiscover,
    refreshWeatherRadio: refreshHomeWeatherRadio,
    recordListenPause: recordHomeListenPause,
    recordListenProgress: recordHomeListenProgress,
    finalizeListenSession: finalizeHomeListenSession,
    playDaily: playHomeDaily,
    playPrivate: playHomePrivate,
    playDiscoverSongs: playHomeDiscoverSongs,
    openPlaylist: openHomeDiscoverPlaylist,
    closePlaylistDetail: closeHomePlaylistDetail,
    playPlaylistDetail: playHomePlaylistDetail,
    searchPlaylistDetailArtist: searchHomePlaylistDetailArtist,
    openPodcast: openHomeDiscoverPodcast,
    openPodcastSearch: openHomePodcastSearch,
    playWeatherSong: playHomeWeatherSong,
    openInsight: openHomeInsight,
    playRecent: playHomeRecent,
    enterPlaybackSurface,
  } = homeController;

  // 首次渲染时同步创建 Audio，确保视觉引擎先绑定同一个媒体元素，
  // 随后再由播放 Runtime 接管控制器生命周期。
  const audioRef = useRef<HTMLAudioElement | null>(
    typeof Audio !== "undefined" && audioElementSupported() ? new Audio() : null,
  );
  const controllerRef = useRef<PlaybackControllerRef["current"]>(null);
  const neteaseCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const qqCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sodaCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const shelfContentListRef = useRef<ShelfDetailContentListController | null>(
    null,
  );
  const desktopLyricsBeatMapKeyRef = useRef("none");
  const desktopLyricsMotionRef = useRef<DesktopLyricsMotionSnapshot>({
    highBloom: 0,
    beatGlow: 0,
    beatPulse: 0,
    bass: 0,
  });
  const lyricsPayloadRef = useRef(lyricsPayload);
  lyricsPayloadRef.current = lyricsPayload;
  const clearCurrentBeatMapRef = useRef<() => void>(() => undefined);
  const toggleWindowFullscreenRef = useRef<() => Promise<void>>(async () => {});
  const applyCustomCoverImageRef = useRef<
    (file: Blob, track?: Track) => Promise<void>
  >(async () => undefined);
  const {
    fileInputRef,
    localAudioUrlsRef,
    openLocalFileImport,
    importLocalFiles,
    playMiniQueueIndex,
    insertMiniQueueNext,
    cyclePlaylistPanelMode,
    shufflePlaylistPanelQueue,
    clearPlaylistPanelQueue,
    seekPlayback,
    handleRuntimeTimeUpdate,
    handleRuntimeDurationChange,
    handleRuntimeEnded,
  } = usePlaybackUiController({
    controllerRef,
    lyricsPayloadRef,
    playbackMode,
    setPositionMs,
    setDurationMs,
    setLyricsIndex,
    setMiniQueue,
    insertQueueNext,
    setPlaybackMode,
    setQueue,
    clearQueue,
    recordListenProgress: recordHomeListenProgress,
    finalizeListenSession: finalizeHomeListenSession,
    enterPlaybackSurface,
    setHomeForcedOpen,
    setHomeSuppressed,
    clearCurrentBeatMap: () => clearCurrentBeatMapRef.current(),
    applyCustomCoverImage: (file, track) =>
      applyCustomCoverImageRef.current(file, track),
    showToast,
  });

  const getPlaybackSessionSnapshot = useCallback(() => {
    const state = usePlaybackStore.getState();
    return {
      currentTrack: state.currentTrack,
      positionMs: state.positionMs,
      durationMs: state.durationMs,
      isPlaying: state.isPlaying,
    };
  }, []);
  const {
    playbackQuality,
    trackQualityOptions,
    trialBanner,
    currentBeatMapState,
    originalLyricsPayloadRef,
    clearCurrentBeatMap,
    dismissTrialBanner,
    setPlaybackQuality,
    togglePlayback,
    handleRuntimePlay,
    handleRuntimePause,
    handleRuntimeError,
  } = usePlaybackSessionRuntime({
    appServices,
    controllerRef,
    localAudioUrlsRef,
    currentTrack,
    positionMs,
    getPlaybackSnapshot: getPlaybackSessionSnapshot,
    setPlaying,
    setPositionMs,
    togglePlayFallback: togglePlay,
    setSearchError,
    showToast,
    setHomeForcedOpen,
    setHomeSuppressed,
    setLyricsPayload,
    setLyricsLoading,
    setLyricsError,
    resetLyrics: lyricsReset,
    beatMapKeyForMap: desktopLyricsBeatMapKey,
    initialLyricsPayload: lyricsPayload,
    initialPlaybackQuality: readPlaybackQualityPreference(),
    persistPlaybackQuality: savePlaybackQualityPreference,
    onRuntimePause: recordHomeListenPause,
  });
  clearCurrentBeatMapRef.current = clearCurrentBeatMap;
  const {
    customLyricModalOpen,
    setCustomLyricModalOpen,
    customLyricText,
    setCustomLyricText,
    customLyricStatus,
    customLyricInputRef,
    currentLyricPreference,
    currentCustomLyricText,
    currentHasCustomCover,
    applyCustomCoverImage,
    clearCustomCoverImage,
    applyOriginalLyrics,
    openCustomLyricModal,
    chooseCustomLyrics,
    saveCustomLyric,
    deleteCustomLyric,
  } = useTrackCustomizationController({
    currentTrack,
    originalLyricsPayloadRef,
    setLyricsPayload,
    showToast,
  });
  applyCustomCoverImageRef.current = applyCustomCoverImage;

  const emptyHomeCoreAllowed = shouldShowEmptyHome({
    splashActive: false,
    homeForcedOpen: false,
    homeSuppressed: false,
    hasCurrentTrack: !!currentTrack,
    queueLength: queue.length,
    isPlaying,
    shelfDetailOpen,
    shelfPinnedOpen: shelfOpen,
    shelfStageOpen: shelfMode === "stage",
  });
  const emptyHomeActive = shouldShowEmptyHome({
    splashActive,
    homeForcedOpen,
    homeSuppressed,
    hasCurrentTrack: !!currentTrack,
    queueLength: queue.length,
    isPlaying,
    shelfDetailOpen,
    shelfPinnedOpen: shelfOpen,
    shelfStageOpen: shelfMode === "stage",
  });
  const homeControlsLocked =
    emptyHomeActive &&
    homeForcedOpen &&
    !consoleVisible &&
    emptyHomeCoreAllowed;
  const currentLiked = isTrackLiked(currentTrack);
  const currentLikeBusy = isTrackLikeBusy(currentTrack);

  const revealConsole = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(false);
    setConsole(true);
  }, [setConsole]);

  const openHomePlayerConsole = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(false);
    setConsole(true);
    setMiniQueue(false);
    forceBottomControlsVisible(2800);
    showToast("播放器控制台已展开");
  }, [setConsole, setMiniQueue, showToast]);

  const focusSearch = useCallback(() => {
    if (typeof document === "undefined") return;
    const input = document.getElementById("search-input");
    if (input instanceof HTMLElement && input.tagName === "INPUT") input.focus();
  }, []);

  const searchQuery = useCallback(
    (query: string, mode: SearchMode = "song") => {
      setHomeSuppressed(false);
      setSearchModeRequest(mode);
      setSearchKeyword(query);
      focusSearch();
    },
    [focusSearch, setSearchKeyword],
  );

  const libraryController = useLibraryController({
    library: appServices?.music.library ?? null,
    discover: appServices?.music.discover ?? null,
    getCurrentTrack: () => usePlaybackStore.getState().currentTrack,
    playback: {
      setQueue,
      playAt: (index) => usePlaybackStore.getState().playAt(index),
      enterPlaybackSurface,
    },
    searchQuery,
    openLogin: () => setLoginModalOpen(true),
    resetSearch: () => useSearchStore.getState().reset(),
    setSearchError,
    showToast,
  });
  const {
    playlists: shelfPlaylists,
    importedPlaylists,
    podcastCollections: shelfPodcastCollections,
    panelOpen: playlistPanelOpen,
    panelTab: playlistPanelTab,
    setPanelOpen: setPlaylistPanelOpen,
    setPanelTab: setPlaylistPanelTab,
    openPanelTab: openPlaylistPanelTab,
    refresh: refreshShelfPlaylists,
    refreshProvider: refreshProviderPlaylists,
    openCollectPicker,
    openCollectPickerForCurrent,
    importSharedPlaylist: importSharedPlaylistFromText,
    deleteImportedPlaylist,
    loadPlaylistDetail: loadPlaylistPanelDetail,
    playTracks: playPlaylistPanelTracks,
    openPodcastCollection: openPlaylistPanelPodcastCollection,
    playShelfPlaylist,
  } = libraryController;
  libraryControllerRef.current = libraryController;

  const toggleDiyMode = useCallback(() => {
    const next = !diyMode;
    setDiyMode(next);
    if (!next) {
      setPlaylistPanelOpen(false);
      setMiniQueue(false);
    }
    showToast(next ? "DIY 玩家模式已开启" : "已切回简约模式");
  }, [
    diyMode,
    setDiyMode,
    setMiniQueue,
    setPlaylistPanelOpen,
    showToast,
  ]);

  const showUnavailable = useCallback(
    (message: string) => {
      setSearchError(message);
      showToast(message);
      focusSearch();
    },
    [focusSearch, setSearchError, showToast],
  );

  const showNotice = useCallback(
    (message: string) => {
      showToast(message);
    },
    [showToast],
  );

  const restoreVisualGuidePlaylistPanel = useCallback(() => {
    const snapshot = visualGuidePlaylistRestoreRef.current;
    if (!snapshot) return;
    visualGuidePlaylistRestoreRef.current = null;
    setPlaylistPanelTab(snapshot.tab);
    if (!playlistPanelPinned) setPlaylistPanelOpen(snapshot.open);
  }, [playlistPanelPinned]);

  const toggleUserCapsuleAutoHide = useCallback(() => {
    const next = !userCapsuleAutoHide;
    setUserCapsuleAutoHide(next);
    showToast(next ? "账号胶囊已自动隐藏" : "账号胶囊已固定显示");
  }, [setUserCapsuleAutoHide, showToast, userCapsuleAutoHide]);

  const closeVisualGuide = useCallback((markSeen: boolean) => {
    if (markSeen) markVisualGuideSeen();
    restoreVisualGuidePlaylistPanel();
    setVisualGuideOpen(false);
  }, [markVisualGuideSeen, restoreVisualGuidePlaylistPanel]);

  const prepareVisualGuideStep = useCallback(
    (step: VisualGuideStep) => {
      if (step.selector === "#search-box") {
        setHomeSuppressed(false);
        focusSearch();
      }
      if (step.selector === "#playlist-panel") {
        if (!visualGuidePlaylistRestoreRef.current) {
          visualGuidePlaylistRestoreRef.current = {
            open: playlistPanelOpen || playlistPanelPinned,
            tab: playlistPanelTab,
          };
        }
        setPlaylistPanelTab("playlists");
        setPlaylistPanelOpen(true);
      } else {
        restoreVisualGuidePlaylistPanel();
      }
      if (step.selector === "#bottom-bar") revealConsole();
      if (step.selector === "#fx-fab") {
        const panel = typeof document === "undefined" ? null : document.getElementById("fx-panel");
        const button = typeof document === "undefined" ? null : document.getElementById("fx-fab");
        if (button && "click" in button && !panel?.classList.contains("show")) button.click();
      }
      if (step.target === "shelf") {
        setShelfModeTransient("side");
        useShelfStore.getState().openShelf();
      }
    },
    [
      focusSearch,
      playlistPanelOpen,
      playlistPanelPinned,
      playlistPanelTab,
      restoreVisualGuidePlaylistPanel,
      revealConsole,
      setShelfModeTransient,
    ],
  );

  const goHome = useCallback(() => {
    if (homeForcedOpen || emptyHomeActive) {
      closeHomePlaylistDetail();
      setHomeForcedOpen(false);
      setHomeSuppressed(true);
      setConsole(false);
      setMiniQueue(false);
      if (!playlistPanelPinned) setPlaylistPanelOpen(false);
      closeShelf();
      selectShelfPlaylist(null);
      showToast("已关闭 Home");
      return;
    }
    closeHomePlaylistDetail();
    setHomeSuppressed(false);
    setHomeForcedOpen(true);
    setConsole(false);
    setMiniQueue(false);
    if (!playlistPanelPinned) setPlaylistPanelOpen(false);
    closeShelf();
    selectShelfPlaylist(null);
    focusSearch();
    showToast("已回到 Home");
  }, [
    closeShelf,
    closeHomePlaylistDetail,
    emptyHomeActive,
    focusSearch,
    homeForcedOpen,
    playlistPanelPinned,
    selectShelfPlaylist,
    setConsole,
    setMiniQueue,
    showToast,
  ]);

  const providerLabel = useCallback(
    (provider: ProviderId) => providerLabelText(provider),
    [],
  );

  const handleSidecarConnection = useCallback(
    (connection: SidecarRuntimeConnection) => {
      setSidecarClient(connection.client);
      setAppServices(connection.services);
      setSidecarBaseUrl(connection.config.sidecarBaseUrl);
    },
    [],
  );

  const handleRuntimeLibraryRefresh = useCallback(
    (connection: SidecarRuntimeConnection) => {
      void refreshShelfPlaylists(
        connection.services.music.library,
        connection.services.music.discover,
      );
    },
    [refreshShelfPlaylists],
  );

  const handleRecoveryState = useCallback(
    (state: SidecarRecoveryNoticeState) => {
      setSidecarRecoveryState(state);
    },
    [],
  );

  const syncProviderLoginLibrary = useCallback(
    async (provider: LoginProviderId) => {
      if (!appServices?.music.library) return;
      await refreshProviderPlaylists(provider);
      await refreshHomeDiscover();
    },
    [appServices?.music.library, refreshHomeDiscover, refreshProviderPlaylists],
  );

  const syncAccountProviderPlaylists = useCallback(
    async (provider: LoginProviderId) => {
      if (!appServices?.music.library) return;
      await refreshProviderPlaylists(provider);
    },
    [appServices?.music.library, refreshProviderPlaylists],
  );

  const refreshAccountLibrary = useCallback(() => {
    void refreshShelfPlaylists();
  }, [refreshShelfPlaylists]);

  const {
    statusByProvider: accountStatusByProvider,
    acceptProviderStatus,
    refreshProviderStatus,
    importProviderCookie: importProviderSessionCookie,
    logoutProvider,
  } = useAccountSessionController({
    accounts: appServices?.music.accounts ?? null,
    syncProviderPlaylists: syncAccountProviderPlaylists,
    refreshHome: refreshHomeDiscover,
    refreshLibrary: refreshAccountLibrary,
    providerLabel,
    showToast,
  });
  const neteaseStatus = accountStatusByProvider.netease;
  const qqStatus = accountStatusByProvider.qq;
  const sodaStatus = accountStatusByProvider.soda;
  accountLoggedInRef.current = !!(
    neteaseStatus?.loggedIn ||
    qqStatus?.loggedIn ||
    sodaStatus?.loggedIn
  );

  const {
    qrByProvider: loginQrByProvider,
    statusByProvider: loginQrStatusByProvider,
    refreshProviderLoginQr,
    resetProviderLoginQr,
  } = useLoginQrRuntime({
    accounts: appServices?.music.accounts ?? null,
    modalOpen: loginModalOpen,
    modalMode: loginModalMode,
    provider: loginProvider,
    onProviderStatus: acceptProviderStatus,
    syncProviderLibrary: syncProviderLoginLibrary,
    refreshLibraryAfterLoggedOut: refreshAccountLibrary,
    providerLabel,
    showToast,
  });

  const openLoginModal = useCallback(() => {
    const statusByProvider: Partial<Record<ProviderId, ProviderLoginStatus | null>> = {
      netease: neteaseStatus,
      qq: qqStatus,
      soda: sodaStatus,
    };
    const loggedProviderCount = LOGIN_PROVIDERS.filter(
      (provider) => statusByProvider[provider]?.loggedIn,
    ).length;
    const firstMissingProvider =
      LOGIN_PROVIDERS.find((provider) => !statusByProvider[provider]?.loggedIn) ?? "netease";
    setAccountDropdownOpen(false);
    resetProviderLoginQr();
    setLoginModalOpen(true);
    if (loggedProviderCount > 0) {
      setLoginModalMode("add-account");
      setLoginProvider(firstMissingProvider);
    } else {
      setLoginModalMode("full");
      setLoginProvider("netease");
    }
    setQqManualCookieOpen(false);
    for (const provider of LOGIN_PROVIDERS) void refreshProviderStatus(provider);
  }, [
    neteaseStatus?.loggedIn,
    qqStatus?.loggedIn,
    sodaStatus?.loggedIn,
    refreshProviderStatus,
    resetProviderLoginQr,
  ]);

  const openSingleProviderLogin = useCallback((provider: ProviderId) => {
    setAccountDropdownOpen(false);
    resetProviderLoginQr();
    setLoginModalOpen(true);
    setLoginProvider(provider);
    setLoginModalMode("single-provider");
    setQqManualCookieOpen(false);
  }, [resetProviderLoginQr]);

  const handleAccountButtonClick = useCallback(() => {
    if (neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn) {
      setAccountDropdownOpen((open) => !open);
      return;
    }
    openLoginModal();
  }, [neteaseStatus?.loggedIn, openLoginModal, qqStatus?.loggedIn, sodaStatus?.loggedIn]);

  const openHomeProductGuide = useCallback(() => {
    setHomeSuppressed(false);
    setVisualGuideOpen(true);
  }, []);

  const setPlaylistPanelPinned = useCallback((pinned: boolean) => {
    persistPlaylistPanelPinned(pinned);
    if (pinned) setPlaylistPanelOpen(true);
  }, [persistPlaylistPanelPinned, setPlaylistPanelOpen]);

  const togglePlaylistPanelPinned = useCallback(() => {
    setPlaylistPanelPinned(!playlistPanelPinned);
    showToast(playlistPanelPinned ? "左侧歌单已恢复自动隐藏" : "左侧歌单已常开");
  }, [playlistPanelPinned, setPlaylistPanelPinned, showToast]);

  const openHomeLibrary = useCallback(() => {
    closeHomePlaylistDetail();
    if (homeDiscover?.loggedIn || neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn) {
      void refreshShelfPlaylists();
      setHomeForcedOpen(false);
      setHomeSuppressed(true);
      setConsole(false);
      setMiniQueue(false);
      closeShelf();
      selectShelfPlaylist(null);
      openPlaylistPanelTab("playlists");
      showToast("已打开歌单库");
      return;
    }
    openHomeProductGuide();
  }, [
    homeDiscover?.loggedIn,
    neteaseStatus?.loggedIn,
    openHomeProductGuide,
    closeShelf,
    openPlaylistPanelTab,
    qqStatus?.loggedIn,
    sodaStatus?.loggedIn,
    refreshShelfPlaylists,
    selectShelfPlaylist,
    setConsole,
    setMiniQueue,
    showToast,
  ]);

  const toggleLikeCurrent = useCallback(async () => {
    await toggleLikeTrack(usePlaybackStore.getState().currentTrack);
  }, [toggleLikeTrack]);

  const closeLoginModal = useCallback(() => {
    setLoginModalOpen(false);
    setLoginModalMode("full");
    setQqManualCookieOpen(false);
    resetProviderLoginQr();
    if (neteaseCookieInputRef.current) neteaseCookieInputRef.current.value = "";
    if (qqCookieInputRef.current) qqCookieInputRef.current.value = "";
    if (sodaCookieInputRef.current) sodaCookieInputRef.current.value = "";
  }, [resetProviderLoginQr]);

  const importProviderCookie = useCallback(
    async (provider: LoginProviderId) => {
      const input =
        provider === "netease"
          ? neteaseCookieInputRef.current
          : provider === "soda"
            ? sodaCookieInputRef.current
            : qqCookieInputRef.current;
      const cookie = input?.value.trim() ?? "";
      await importProviderSessionCookie(provider, cookie, {
        onStored: () => setQqManualCookieOpen(false),
        onFinished: () => {
          if (input) input.value = "";
        },
      });
    },
    [importProviderSessionCookie],
  );

  const toggleLikeQueueIndex = useCallback(
    (index: number) => {
      void toggleLikeTrack(usePlaybackStore.getState().queue[index]);
    },
    [toggleLikeTrack],
  );

  const collectQueueIndex = useCallback(
    (index: number) => {
      const track = usePlaybackStore.getState().queue[index];
      if (track) openCollectPicker(track);
    },
    [openCollectPicker],
  );

  const insertSearchResultNext = useCallback(
    (track: Track) => {
      insertQueueNext(track);
      showToast(`已设为下一首: ${track.title}`);
    },
    [insertQueueNext, showToast],
  );

  const appendSearchResult = useCallback(
    (track: Track) => {
      usePlaybackStore.getState().enqueue(track);
      showToast(`已加入播放队列: ${track.title}`);
    },
    [showToast],
  );

  const playSearchDetailTracks = useCallback(
    (tracks: Track[], index: number) => {
      if (!tracks.length) {
        showToast("没有可播放的搜索结果");
        return;
      }
      const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
      setQueue(tracks);
      usePlaybackStore.getState().playAt(safeIndex);
      useSearchStore.getState().closeDetail();
      enterPlaybackSurface();
      showToast(tracks[safeIndex]?.title ?? "已开始播放");
    },
    [enterPlaybackSurface, setQueue, showToast],
  );

  const searchArtistFromResult = useCallback(
    (artist: string) => {
      searchQuery(artist, "song");
    },
    [searchQuery],
  );

  const currentDesktopLyricSnapshot = useCallback(() => {
    const payload = useLyricsStore.getState().payload;
    const playback = usePlaybackStore.getState();
    const fallback = playback.currentTrack
      ? `${trackTitle(playback.currentTrack)} - ${trackArtist(playback.currentTrack)}`
      : "";
    return buildDesktopLyricSnapshot(payload, playback.positionMs, fallback);
  }, []);

  const buildDesktopRuntimeLyricsPayload = useCallback((force: boolean) => {
    const playback = usePlaybackStore.getState();
    const duration = playback.durationMs ?? 0;
    const snapshot = currentDesktopLyricSnapshot();
    const motion = desktopLyricsMotionRef.current;
    const beatMapContext = desktopLyricsBeatMapContext(
      currentBeatMapState,
      force,
      desktopLyricsBeatMapKeyRef,
    );
    return buildDesktopLyricsPayloadPatch(
      useVisualStore.getState().fx,
      snapshot.text,
      snapshot.progress,
      {
        title: trackTitle(playback.currentTrack),
        artist: trackArtist(playback.currentTrack),
        playing: playback.isPlaying,
        progressSpan: snapshot.progressSpan,
        positionMs: playback.positionMs,
        durationMs: duration,
        playbackRate: audioRef.current?.playbackRate,
        highBloom: motion.highBloom,
        beatGlow: motion.beatGlow,
        beatPulse: motion.beatPulse,
        bass: motion.bass,
        stageLyricPalette: motion.palette,
        ...beatMapContext,
      },
    );
  }, [currentBeatMapState, currentDesktopLyricSnapshot]);

  const desktopHotkeyActions = useMemo(() => ({
    togglePlay: togglePlayback,
    prevTrack: previousTrack,
    nextTrack,
    volumeUp: () => setVolume(usePlaybackStore.getState().volume + 0.05),
    volumeDown: () => setVolume(usePlaybackStore.getState().volume - 0.05),
    toggleFullscreen: () => {
      void toggleWindowFullscreenRef.current();
    },
  }), [nextTrack, previousTrack, setVolume, togglePlayback]);

  const clearDesktopWindowShell = useCallback(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("desktop-shell-root");
      document.body.classList.remove(
        "desktop-shell",
        "desktop-maximized",
        "desktop-fullscreen",
      );
    }
  }, []);

  const desktopLyricsPayloadVersion = useMemo(() => ({
    currentTrack,
    isPlaying,
    positionMs,
    durationMs,
    lyricsPayload,
    currentBeatMapState,
    visualFx,
  }), [
    currentBeatMapState,
    currentTrack,
    durationMs,
    isPlaying,
    lyricsPayload,
    positionMs,
    visualFx,
  ]);

  const {
    desktopWindowState,
    toggleDesktopLyrics,
    setDesktopLyricsEnabled: setDesktopLyricsWindowEnabled,
    minimizeWindow,
    toggleWindowMaximize,
    toggleWindowFullscreen,
    closeWindow,
  } = useDesktopRuntime({
    desktop: resolvedDesktopRuntime,
    buildLyricsPayload: buildDesktopRuntimeLyricsPayload,
    lyricsPayloadVersion: desktopLyricsPayloadVersion,
    hotkeyActions: desktopHotkeyActions,
    onWindowState: applyDesktopWindowShellState,
    onWindowCleanup: clearDesktopWindowShell,
  });
  setDesktopLyricsWindowEnabledRef.current = setDesktopLyricsWindowEnabled;
  toggleWindowFullscreenRef.current = toggleWindowFullscreen;
  const dismissEmptyHome = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(true);
    setConsole(false);
    setMiniQueue(false);
  }, [setConsole, setHomeForcedOpen, setHomeSuppressed, setMiniQueue]);
  const { aiDepthChip } = useGlobalShellRuntime({
    diyMode,
    splashActive,
    emptyHomeActive,
    consoleVisible,
    homeControlsLocked,
    userCapsuleAutoHide,
    visualGuideOpen,
    searchDetailOpen,
    shelfMode,
    visualFx,
    toast,
    miniQueueOpen,
    accountDropdownOpen,
    accountLoggedIn: Boolean(
      neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn,
    ),
    clearToast,
    setMiniQueue,
    setAccountDropdownOpen,
    dismissEmptyHome,
    showToast,
  });

  const shellProps: AppShellProps = {
    sidecarRuntimeProps: {
      initialRuntimeConfig,
      createSidecarClient,
      servicesFactory,
      loginProviders: LOGIN_PROVIDERS,
      onConnection: handleSidecarConnection,
      onCapabilities: setMatrix,
      onProviderStatus: acceptProviderStatus,
      onRefreshLibrary: handleRuntimeLibraryRefresh,
      onRecoveryState: handleRecoveryState,
    },
    fileInputRef,
    localAudioAccept: LOCAL_AUDIO_ACCEPT,
    onImportLocalFiles: importLocalFiles,
    titlebar: {
      maximized: desktopWindowState?.isMaximized,
      onGuide: openHomeProductGuide,
      onDiy: toggleDiyMode,
      diyActive: diyMode,
      onMinimize: () => void minimizeWindow(),
      onToggleMaximize: () => void toggleWindowMaximize(),
      onClose: () => void closeWindow(),
      updateProps: {
        state: updateState,
        open: updateModalOpen,
        onOpen: () => setUpdateModalOpen(true),
        onClose: () => setUpdateModalOpen(false),
        onCheck: () => void refreshUpdateStatus(true),
        onInstall: () => void installAvailableUpdate(),
      },
    },
    SplashComponent,
    splashVisible: SHOW_SPLASH && splashActive,
    onSplashDismissed: () => setSplashActive(false),
    visual: {
      VisualComponent,
      engineProps: {
        audioElementRef: audioRef,
        controllerRef,
        lyricsPayload,
        positionMs,
        durationMs,
        isPlaying,
        queue,
        playlists: shelfPlaylists,
        podcastCollections: shelfPodcastCollections,
        currentTrack,
        currentCoverUrl: currentTrack?.coverUrl,
        beatMapKey: currentBeatMapState?.key,
        beatMap: currentBeatMapState?.map,
        sidecarBaseUrl,
        coverResolution: visualFx.coverResolution,
        fxState: visualFx,
        shelfSettings: {
          mode: shelfMode,
          cameraMode: shelfCameraMode,
          presence: shelfPresence,
          showPodcasts: shelfShowPodcasts,
          mergeCollections: shelfMergeCollections,
        },
        splashActive,
        homeActive: emptyHomeActive,
        secondaryLeftDisplaySeamGuardActive:
          shouldUseSecondaryLeftDisplaySeamGuard(desktopWindowState),
        onShelfModeChange: updateShelfMode,
        onShelfPlayQueueIndex: (index) =>
          usePlaybackStore.getState().playAt(index),
        onShelfPlayPlaylist: (payload) => void playShelfPlaylist(payload),
        onShelfDetailRowClick: (payload) => {
          void handleShelfDetailRowAction({
            ...payload,
            client: sidecarClient,
            isLiked: () => false,
            onResult: showToast,
            onOpenCollect: openCollectPicker,
            onOpenPodcastRadio: (radioId, title) => {
              const loader = createShelfDetailContentLoader({
                client: sidecarClient,
                getContentList: () => shelfContentListRef.current,
              });
              createPodcastRadioDetailOpener({
                getContentList: () => shelfContentListRef.current,
                load: loader,
              })(radioId, title);
            },
          });
        },
        onShelfOpenDetailContent: (payload, contentList) => {
          shelfContentListRef.current = contentList;
          const loader = createShelfDetailContentLoader({
            client: sidecarClient,
            getContentList: () => contentList,
          });
          void loader(payload);
        },
        onShelfOpenContentChange: setShelfDetailOpen,
        desktopLyricsMotionRef,
      },
      controlPanelProps: {
        preset: visualPreset,
        intensity: visualIntensity,
        settings: {
          ...visualFx,
          shelf: shelfMode,
          shelfCameraMode,
          shelfPresence,
          shelfShowPodcasts,
          shelfMergeCollections,
        },
        onPresetChange: updateVisualPreset,
        onNumberSettingChange: updateVisualNumberSetting,
        onBooleanSettingChange: updateVisualBooleanSetting,
        onStringSettingChange: updateVisualStringSetting,
        onFxPatchChange: updateVisualFxPatch,
        onNotice: showNotice,
      },
      aiDepthChip,
    },
    home: {
      homeProps: {
        discover: homeDiscover,
        weatherRadio: homeWeatherRadio,
        listenSummary: homeListenSummary,
        playlistDetail: homePlaylistDetail,
        active: emptyHomeActive,
        loading: homeDiscoverLoading || homeWeatherRadioLoading,
        isPlaying,
        positionMs,
        durationMs,
        onSearchFocus: focusSearch,
        onOpenLibrary: openHomeLibrary,
        onOpenConsole: openHomePlayerConsole,
        onSearchQuery: searchQuery,
        onUpload: openLocalFileImport,
        onGuide: openHomeProductGuide,
        onOpenLogin: openLoginModal,
        onPlayDaily: playHomeDaily,
        onPlayPrivate: () => void playHomePrivate(),
        onPlaySong: (index) => void playHomeDiscoverSongs(index),
        onOpenPlaylist: (index) => void openHomeDiscoverPlaylist(index),
        onOpenPodcast: (index) => void openHomeDiscoverPodcast(index),
        onOpenPodcastSearch: openHomePodcastSearch,
        onOpenInsight: openHomeInsight,
        onPlayRecent: playHomeRecent,
        onPlayWeatherSong: (index) => void playHomeWeatherSong(index),
        onClosePlaylistDetail: closeHomePlaylistDetail,
        onPlayPlaylistDetail: playHomePlaylistDetail,
        onPlaylistDetailArtist: searchHomePlaylistDetailArtist,
      },
      searchProps: {
        client: appServices?.music.search ?? null,
        onFocus: focusSearch,
        onUpload: openLocalFileImport,
        onClearCustomCover: clearCustomCoverImage,
        onResultPlay: enterPlaybackSurface,
        onResultNext: insertSearchResultNext,
        onResultLike: (track) => void toggleLikeTrack(track),
        onResultCollect: openCollectPicker,
        onSharedPlaylistImport: importSharedPlaylistFromText,
        onArtistSearch: searchArtistFromResult,
        isResultLiked: isTrackLiked,
        isResultLikeBusy: isTrackLikeBusy,
        hasCustomCover: currentHasCustomCover,
        peek: emptyHomeActive || searchKeyword.trim().length > 0,
        requestedMode: searchModeRequest,
      },
      searchDetailProps: {
        client: sidecarClient,
        onClose: focusSearch,
        onPlayResults: playSearchDetailTracks,
        onAppendQueue: appendSearchResult,
        onResultNext: insertSearchResultNext,
        onResultLike: (track) => void toggleLikeTrack(track),
        onResultCollect: openCollectPicker,
        onArtistSearch: searchArtistFromResult,
        isResultLiked: isTrackLiked,
        isResultLikeBusy: isTrackLikeBusy,
      },
    },
    account: {
      statuses: accountStatusByProvider,
      dropdownOpen: accountDropdownOpen,
      capsuleAutoHide: userCapsuleAutoHide,
      onHome: goHome,
      onAccountClick: handleAccountButtonClick,
      onHideCapsule: toggleUserCapsuleAutoHide,
      onRefreshStatus: (provider) => void refreshProviderStatus(provider),
      onLogout: (provider) => void logoutProvider(provider),
      onOpenSingleProvider: openSingleProviderLogin,
    },
    guide: {
      open: visualGuideOpen,
      onClose: closeVisualGuide,
      onPrepareStep: prepareVisualGuideStep,
    },
    library: {
      panelProps: {
        open: playlistPanelOpen || playlistPanelPinned,
        pinned: playlistPanelPinned,
        tab: playlistPanelTab,
        queue,
        currentTrack,
        mode: playbackMode,
        playlists: shelfPlaylists,
        importedPlaylists,
        podcastCollections: shelfPodcastCollections,
        onTabChange: openPlaylistPanelTab,
        onPinToggle: togglePlaylistPanelPinned,
        onShuffle: shufflePlaylistPanelQueue,
        onCycleMode: cyclePlaylistPanelMode,
        onClearQueue: clearPlaylistPanelQueue,
        onRefresh: () => void refreshShelfPlaylists(),
        onPlayQueueIndex: playQueueAt,
        onQueueArtist: (artist) => searchQuery(artist, "song"),
        onLikeQueueIndex: toggleLikeQueueIndex,
        onCollectQueueIndex: collectQueueIndex,
        onInsertQueueNext: insertMiniQueueNext,
        onRemoveQueueIndex: removeQueueAt,
        onLoadPlaylistDetail: loadPlaylistPanelDetail,
        onPlayTracks: playPlaylistPanelTracks,
        onDeleteImportedPlaylist: deleteImportedPlaylist,
        onPodcastCollectionOpen: (collection) =>
          void openPlaylistPanelPodcastCollection(collection),
      },
      collect: libraryController,
    },
    playback: {
      controlsProps: {
        visible: consoleVisible,
        onReveal: revealConsole,
        onTogglePlay: togglePlayback,
        onPrevious: previousTrack,
        onNext: nextTrack,
        onModeChange: setPlaybackMode,
        onQueue: toggleMiniQueue,
        onLyrics: () =>
          showNotice(
            lyricsPayload ? "歌词已载入舞台层" : "播放歌曲后会自动加载歌词",
          ),
        onLyricSourceChange: (mode) => {
          if (mode === "custom") chooseCustomLyrics();
          else applyOriginalLyrics();
        },
        onOpenCustomLyrics: openCustomLyricModal,
        onCollectCurrent: openCollectPickerForCurrent,
        onToggleLikeCurrent: toggleLikeCurrent,
        onClose: () => {
          setConsole(false);
          setMiniQueue(false);
        },
        onNotice: showNotice,
        onSeek: seekPlayback,
        onVolumeChange: setVolume,
        onToggleMute: toggleMute,
        onQualityChange: setPlaybackQuality,
        onShelfModeChange: updateShelfMode,
        onShelfCameraModeChange: updateShelfCameraMode,
        onShelfPresenceChange: updateShelfPresence,
        onShelfShowPodcastsChange: updateShelfShowPodcasts,
        onShelfMergeCollectionsChange: updateShelfMergeCollections,
        deps: { isHomeControlsLocked: () => homeControlsLocked },
        onPlayQueueIndex: playMiniQueueIndex,
        onRemoveQueueIndex: removeQueueAt,
        onInsertQueueNext: insertMiniQueueNext,
        onMinimize: () => void minimizeWindow(),
        onToggleMaximize: () => void toggleWindowMaximize(),
        onToggleFullscreen: () => void toggleWindowFullscreen(),
        mode: playbackMode,
        isPlaying,
        currentTitle: currentTrack?.title,
        currentArtist: currentTrack?.artists.join(" / "),
        currentCoverUrl: currentTrack?.coverUrl,
        currentLiked,
        currentLikeBusy,
        queue,
        currentTrack,
        miniQueueOpen,
        positionMs,
        durationMs,
        volume,
        muted,
        playbackQuality,
        qualityOptions: trackQualityOptions,
        shelfMode,
        shelfCameraMode,
        shelfPresence,
        shelfShowPodcasts,
        shelfMergeCollections,
        lyricSourceMode:
          currentLyricPreference === "custom" ? "custom" : "original",
        hasCustomLyric: Boolean(currentCustomLyricText),
      },
      recoveryState: sidecarRecoveryState,
    },
    playbackCustomization: {
      customization: {
        customLyricModalOpen,
        setCustomLyricModalOpen,
        customLyricText,
        setCustomLyricText,
        customLyricStatus,
        customLyricInputRef,
        currentCustomLyricText,
        saveCustomLyric,
        deleteCustomLyric,
      },
      currentTrack,
    },
    libraryOverlay: { collect: libraryController },
    accountOverlay: {
      statuses: accountStatusByProvider,
      modalOpen: loginModalOpen,
      modalMode: loginModalMode,
      provider: loginProvider,
      manualCookieOpen: qqManualCookieOpen,
      qrByProvider: loginQrByProvider,
      qrStatusByProvider: loginQrStatusByProvider,
      cookieInputRefs: {
        netease: neteaseCookieInputRef,
        qq: qqCookieInputRef,
        soda: sodaCookieInputRef,
      },
      onClose: closeLoginModal,
      onProviderChange: (provider) => {
        setLoginProvider(provider);
        setQqManualCookieOpen(false);
      },
      onManualCookieToggle: () => setQqManualCookieOpen((open) => !open),
      onRefreshQr: (provider) => void refreshProviderLoginQr(provider),
      onRefreshStatus: (provider) => void refreshProviderStatus(provider),
      onImportCookie: (provider) => void importProviderCookie(provider),
      onLogout: (provider) => void logoutProvider(provider),
      onOpenSingleProvider: openSingleProviderLogin,
    },
    playbackNotices: {
      trialBanner,
      dismissTrialBanner,
      toast,
      onOpenLogin: openLoginModal,
    },
    playbackRuntime: {
      runtimeProps: {
        audioElementRef: audioRef,
        controllerRef,
        volume,
        muted,
        onTimeUpdate: handleRuntimeTimeUpdate,
        onDurationChange: handleRuntimeDurationChange,
        onPlay: handleRuntimePlay,
        onPause: handleRuntimePause,
        onEnded: handleRuntimeEnded,
        onError: handleRuntimeError,
      },
    },
  };

  return (
    <AppRuntimeProvider services={appServices}>
      <AppShell {...shellProps} />
    </AppRuntimeProvider>
  );
}

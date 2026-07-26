import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { SidecarClient } from "../api/sidecar-client";
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
  SidecarRecoveryRuntime,
  type SidecarRuntimeConnection,
} from "./runtime/SidecarRecoveryRuntime";
import { PlayerController } from "../audio/player-controller";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { useProviderStore } from "../stores/provider-store";
import { useSearchStore } from "../stores/search-store";
import {
  loadShelfSettingsFromStorage,
  saveShelfSettingsToStorage,
  useShelfStore,
  type ShelfCameraMode,
  type ShelfMode,
  type ShelfPresence,
} from "../stores/shelf-store";
import { useUiStore } from "../stores/ui-store";
import { useUpdateStore } from "../stores/update-store";
import { saveVisualFxToStorage, useVisualStore } from "../stores/visual-store";
import type { JsonValue, RuntimeConfig, WindowState } from "../tauri/runtime";
import { createTauriDesktopRuntime } from "../adapters/tauri/tauri-desktop-runtime";
import type { DesktopRuntimePort } from "../ports/desktop-runtime-port";
import { PlaybackRuntimeHost } from "../features/playback/PlaybackRuntimeHost";
import {
  usePlaybackSessionRuntime,
  type CurrentBeatMapState,
} from "../features/playback/usePlaybackSessionRuntime";
import {
  LOCAL_AUDIO_ACCEPT,
  usePlaybackUiController,
} from "../features/playback/usePlaybackUiController";
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
import { BottomControlsHost } from "../components/shell/BottomControlsHost";
import { GuideParticlesHost } from "../components/shell/GuideParticlesHost";
import { PlaylistPanelHost, type PlaylistPanelTab } from "../components/shell/PlaylistPanelHost";
import { SearchDetailPage } from "../components/shell/SearchDetailPage";
import { SearchShell, type SearchMode } from "../components/shell/SearchShell";
import { buildDesktopLyricSnapshot } from "../desktop-lyrics/desktop-lyrics-snapshot";
import {
  SidecarRecoveryNotice,
  type SidecarRecoveryNoticeState,
} from "../components/shell/SidecarRecoveryNotice";
import { TopRightControls, VipBadge } from "../components/shell/TopRightControls";
import {
  VISUAL_GUIDE_SEEN_STORE_KEY,
  VisualGuideHost,
  type VisualGuideStep,
} from "../components/shell/VisualGuideHost";
import { UpdateHost } from "../components/shell/UpdateHost";
import { EmptyHomeHost } from "../home/EmptyHomeHost";
import { SplashHost, type SplashHostProps } from "../visual/SplashHost";
import {
  AI_DEPTH_STATUS_EVENT,
  type AiDepthStatusDetail,
} from "../visual/ai-depth-estimator";
import { applyVisualThemeToRoot } from "../visual/visual-theme";
import { VisualControlPanelHost } from "../visual/VisualControlPanelHost";
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
  type PlaybackQualityRequest,
  type ProviderId,
  type ProviderLoginStatus,
  type ProviderVipIcon,
  type Track,
} from "@mineradio/shared";
import type { FxState } from "@mineradio/visual-engine";

const SHOW_SPLASH = import.meta.env.VITE_SPLASH !== "0";
const PLAYBACK_QUALITY_STORE_KEY = "mineradio-playback-quality-v1";
const USER_CAPSULE_AUTO_HIDE_STORE_KEY = "mineradio-user-capsule-auto-hide-v1";
const PLAYLIST_PANEL_PIN_STORE_KEY = "mineradio-playlist-panel-pinned-v1";
const DIY_MODE_STORE_KEY = "mineradio-diy-player-mode-v1";
type AccountVipBadge = {
  text: string;
  icon?: ProviderVipIcon;
  iconUrl?: string;
};

function accountVipBadge(status: ProviderLoginStatus | null | undefined): AccountVipBadge | null {
  if (!status?.loggedIn) return null;
  const text =
    status.vipLabel?.trim() ||
    (status.vipLevel === "svip"
      ? "SVIP"
      : status.vipLevel === "vip"
        ? "VIP"
        : "");
  if (!text) return null;
  return {
    text,
    icon: status.vipIcon,
    iconUrl: status.vipIconUrl,
  };
}

function audioElementSupported(): boolean {
  return typeof window !== "undefined" && "HTMLAudioElement" in globalThis;
}

function normalizePlaybackQualityPreference(value: string): PlaybackQualityRequest {
  const text = value.trim();
  if (!text) return "hires";
  if (text.toLowerCase() === "hi-res") return "hires";
  return text;
}

function readPlaybackQualityPreference(): PlaybackQualityRequest {
  if (typeof localStorage === "undefined") return "hires";
  const raw = localStorage.getItem(PLAYBACK_QUALITY_STORE_KEY);
  return raw ? normalizePlaybackQualityPreference(raw) : "hires";
}

function savePlaybackQualityPreference(quality: PlaybackQualityRequest): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PLAYBACK_QUALITY_STORE_KEY, quality);
}

function readBooleanPreference(key: string, fallback = false): boolean {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function saveBooleanPreference(key: string, value: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
  }
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

function loginTitleForProvider(provider: ProviderId): string {
  if (provider === "netease") return "扫码登录网易云音乐";
  if (provider === "qq") return "扫码登录 QQ 音乐";
  return "扫码登录汽水音乐";
}

function loginDescriptionForProvider(provider: ProviderId): string {
  if (provider === "netease") return "使用网易云音乐 App 扫码，可同步歌单、红心与播客。";
  if (provider === "qq") return "使用 QQ 音乐 App 扫码，可同步歌单和播放授权。";
  return "使用汽水音乐 App 扫码，可同步歌单、收藏与播放授权。";
}

function qrLoadingMarkForProvider(provider: ProviderId): string {
  if (provider === "netease") return "NE";
  if (provider === "qq") return "QQ";
  return "SD";
}

function cookiePlaceholderForProvider(provider: ProviderId): string {
  if (provider === "netease") return "MUSIC_U=...; __csrf=...";
  if (provider === "qq") return "uin=...; qm_keyst=...; qqmusic_key=...";
  return "sid_tt=...; sessionid=...";
}

function trackTitle(track: Track | null | undefined): string {
  return track?.title || "MineRadio-Tauri";
}

function trackArtist(track: Track | null | undefined): string {
  return track?.artists?.join(" / ") || track?.album || "";
}

export function isHomeBlankDismissElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const home = target.closest("#empty-home");
  if (!home) return false;
  return !target.closest(
    [
      ".home-card",
      ".home-tile",
      ".home-chip",
      "button",
      "a",
      "input",
      "textarea",
      "select",
      '[contenteditable="true"]',
      "#desktop-titlebar",
      "#search-area",
      "#top-right",
      "#bottom-bar",
      "#bottom-handle",
      "#fx-fab",
      "#fx-fab-hide-btn",
      "#fx-panel",
      "#playlist-panel",
      "#mini-queue-popover",
      "#visual-guide",
      "#upload-tip",
      "#toast",
      "#trial-banner",
      "#source-fallback-notice",
      "#ai-depth-chip",
      "#beat-chip",
      "#drop-overlay",
      ".modal-mask",
      ".modal",
      "#login-modal",
      ".track-detail-modal",
      ".cover-color-pop",
      ".color-lab-pop",
      ".quality-popover",
      ".volume-popover",
    ].join(","),
  );
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

export function isDesktopWindowFullscreen(state: WindowState): boolean {
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

export function applyDesktopWindowShellState(state: WindowState): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.add("desktop-shell-root");
  document.body.classList.add("desktop-shell");
  document.body.classList.toggle("desktop-maximized", !!state.isMaximized);
  document.body.classList.toggle(
    "desktop-fullscreen",
    isDesktopWindowFullscreen(state),
  );
}

function DesktopTitlebar({
  maximized,
  updateSlot,
  onGuide,
  onDiy,
  diyActive,
  onMinimize,
  onToggleMaximize,
  onClose,
}: {
  maximized?: boolean;
  updateSlot: ReactElement | null;
  onGuide: () => void;
  onDiy: () => void;
  diyActive: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div id="desktop-titlebar" aria-label="window controls" data-tauri-drag-region="true">
      <div className="desktop-drag-region" data-tauri-drag-region="true">
        <div className="desktop-app-mark" aria-hidden="true" />
        <div className="desktop-app-title" aria-hidden="true" />
      </div>
      <div className="desktop-window-controls">
        <button
          id="visual-guide-btn"
          className="icon-btn"
          type="button"
          onClick={onGuide}
          title="查看使用引导"
          aria-label="查看使用引导"
        >
          ?
        </button>
        {updateSlot}
        <button
          id="diy-mode-btn"
          className={`desktop-mode-btn${diyActive ? " on" : ""}`}
          type="button"
          onClick={onDiy}
          title={diyActive ? "关闭 DIY 玩家模式" : "开启 DIY 玩家模式"}
          aria-label={diyActive ? "关闭 DIY 玩家模式" : "开启 DIY 玩家模式"}
          aria-pressed={diyActive}
        >
          DIY
        </button>
        <button
          className="desktop-window-btn"
          type="button"
          onClick={onMinimize}
          title="最小化"
          aria-label="最小化"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8h10" />
          </svg>
        </button>
        <button
          className="desktop-window-btn"
          type="button"
          onClick={onToggleMaximize}
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
        >
          {maximized ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3h8v8" />
              <path d="M3 5h8v8H3z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
            </svg>
          )}
        </button>
        <button
          className="desktop-window-btn close"
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function shouldUseSecondaryLeftDisplaySeamGuard(
  state: WindowState | null,
): boolean {
  return state?.isPrimaryDisplay === false && state.hasDisplayOnLeft;
}

export type AppProps = {
  SplashComponent?: (props: SplashHostProps) => ReactElement | null;
  VisualComponent?: typeof VisualEngineHost;
  createSidecarClient?: (cfg: RuntimeConfig) => SidecarClient;
  servicesFactory?: AppServicesFactory;
  initialRuntimeConfig?: RuntimeConfig | null;
  desktopLyricsRuntime?: DesktopLyricsRuntime;
  desktopRuntime?: DesktopRuntimePort;
};

export type DesktopLyricsRuntime = {
  showWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  updatePayload: (payload: JsonValue) => Promise<void>;
};

const defaultDesktopRuntime = createTauriDesktopRuntime();

function createDefaultSidecarClient(cfg: RuntimeConfig): SidecarClient {
  return new SidecarClient(cfg.sidecarBaseUrl);
}

export function App({
  SplashComponent = SplashHost,
  VisualComponent = VisualEngineHost,
  createSidecarClient = createDefaultSidecarClient,
  servicesFactory = createLegacyAppServices,
  initialRuntimeConfig = null,
  desktopLyricsRuntime,
  desktopRuntime = defaultDesktopRuntime,
}: AppProps = {}): ReactElement {
  const [sidecarClient, setSidecarClient] = useState<SidecarClient | null>(
    null,
  );
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
  const [diyMode, setDiyMode] = useState(() =>
    readBooleanPreference(DIY_MODE_STORE_KEY, false),
  );
  const [playlistPanelPinned, setPlaylistPanelPinnedState] = useState(() =>
    readBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, false),
  );
  const [shelfDetailOpen, setShelfDetailOpen] = useState(false);
  const [sidecarRecoveryState, setSidecarRecoveryState] =
    useState<SidecarRecoveryNoticeState | null>(null);
  const [userCapsuleAutoHide, setUserCapsuleAutoHide] = useState(() =>
    readBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, false),
  );
  const [userCapsulePeek, setUserCapsulePeek] = useState(false);
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
  const shelfMode = useShelfStore((s) => s.mode);
  const shelfCameraMode = useShelfStore((s) => s.cameraMode);
  const shelfPresence = useShelfStore((s) => s.presence);
  const shelfShowPodcasts = useShelfStore((s) => s.showPodcasts);
  const shelfMergeCollections = useShelfStore((s) => s.mergeCollections);
  const shelfOpen = useShelfStore((s) => s.open);
  const setShelfMode = useShelfStore((s) => s.setMode);
  const setShelfCameraMode = useShelfStore((s) => s.setCameraMode);
  const setShelfPresence = useShelfStore((s) => s.setPresence);
  const setShelfShowPodcasts = useShelfStore((s) => s.setShowPodcasts);
  const setShelfMergeCollections = useShelfStore((s) => s.setMergeCollections);
  const applyShelfSettings = useShelfStore((s) => s.applySettings);
  const closeShelf = useShelfStore((s) => s.closeShelf);
  const selectShelfPlaylist = useShelfStore((s) => s.selectPlaylist);
  const visualFx = useVisualStore((s) => s.fx);
  const visualPreset = useVisualStore((s) => s.preset);
  const visualIntensity = useVisualStore((s) => s.intensity);
  const setVisualPreset = useVisualStore((s) => s.setPreset);
  const setVisualNumberSetting = useVisualStore((s) => s.setNumberSetting);
  const setVisualBooleanSetting = useVisualStore((s) => s.setBooleanSetting);
  const setVisualStringSetting = useVisualStore((s) => s.setStringSetting);
  const setVisualFxPatch = useVisualStore((s) => s.setFxPatch);
  const consoleVisible = useUiStore((s) => s.consoleVisible);
  const setConsole = useUiStore((s) => s.setConsole);
  const miniQueueOpen = useUiStore((s) => s.miniQueueOpen);
  const setMiniQueue = useUiStore((s) => s.setMiniQueue);
  const toggleMiniQueue = useUiStore((s) => s.toggleMiniQueue);
  const toast = useUiStore((s) => s.toast);
  const showToast = useUiStore((s) => s.showToast);
  const clearToast = useUiStore((s) => s.clearToast);
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
  const [aiDepthChip, setAiDepthChip] = useState({
    visible: false,
    text: "AI 深度估计…",
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
  // 随后再由 PlaybackRuntimeHost 接管 PlayerController 生命周期。
  const audioRef = useRef<HTMLAudioElement | null>(
    typeof Audio !== "undefined" && audioElementSupported() ? new Audio() : null,
  );
  const controllerRef = useRef<PlayerController | null>(null);
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

  const {
    playlists: shelfPlaylists,
    importedPlaylists,
    podcastCollections: shelfPodcastCollections,
    panelOpen: playlistPanelOpen,
    panelTab: playlistPanelTab,
    setPanelOpen: setPlaylistPanelOpen,
    setPanelTab: setPlaylistPanelTab,
    openPanelTab: openPlaylistPanelTab,
    collectTarget,
    collectBusyPlaylistId,
    writableCollectPlaylists,
    refresh: refreshShelfPlaylists,
    refreshProvider: refreshProviderPlaylists,
    openCollectPicker,
    openCollectPickerForCurrent,
    closeCollectPicker,
    collectToPlaylist: addCollectTargetToPlaylist,
    importSharedPlaylist: importSharedPlaylistFromText,
    deleteImportedPlaylist,
    loadPlaylistDetail: loadPlaylistPanelDetail,
    playTracks: playPlaylistPanelTracks,
    openPodcastCollection: openPlaylistPanelPodcastCollection,
    playShelfPlaylist,
  } = useLibraryController({
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
  libraryControllerRef.current = {
    playlists: shelfPlaylists,
    importedPlaylists,
    podcastCollections: shelfPodcastCollections,
    panelOpen: playlistPanelOpen,
    panelTab: playlistPanelTab,
    setPanelOpen: setPlaylistPanelOpen,
    setPanelTab: setPlaylistPanelTab,
    openPanelTab: openPlaylistPanelTab,
    collectTarget,
    collectBusyPlaylistId,
    writableCollectPlaylists,
    refresh: refreshShelfPlaylists,
    refreshProvider: refreshProviderPlaylists,
    openCollectPicker,
    openCollectPickerForCurrent,
    closeCollectPicker,
    collectToPlaylist: addCollectTargetToPlaylist,
    importSharedPlaylist: importSharedPlaylistFromText,
    deleteImportedPlaylist,
    loadPlaylistDetail: loadPlaylistPanelDetail,
    playTracks: playPlaylistPanelTracks,
    openPodcastCollection: openPlaylistPanelPodcastCollection,
    playShelfPlaylist,
  };

  const toggleDiyMode = useCallback(() => {
    setDiyMode((on) => {
      const next = !on;
      saveBooleanPreference(DIY_MODE_STORE_KEY, next);
      if (!next) {
        setPlaylistPanelOpen(false);
        setMiniQueue(false);
      }
      showToast(next ? "DIY 玩家模式已开启" : "已切回简约模式");
      return next;
    });
  }, [setMiniQueue, setPlaylistPanelOpen, showToast]);

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
    saveBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, next);
    setUserCapsuleAutoHide(next);
    if (!next) setUserCapsulePeek(false);
    showToast(next ? "账号胶囊已自动隐藏" : "账号胶囊已固定显示");
  }, [showToast, userCapsuleAutoHide]);

  const closeVisualGuide = useCallback((markSeen: boolean) => {
    if (markSeen) saveBooleanPreference(VISUAL_GUIDE_SEEN_STORE_KEY, true);
    restoreVisualGuidePlaylistPanel();
    setVisualGuideOpen(false);
  }, [restoreVisualGuidePlaylistPanel]);

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
        setShelfMode("side");
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
      setShelfMode,
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

  useEffect(() => {
    if (neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn) return;
    setAccountDropdownOpen(false);
  }, [neteaseStatus?.loggedIn, qqStatus?.loggedIn, sodaStatus?.loggedIn]);

  useEffect(() => {
    if (!accountDropdownOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const dropdown = document.getElementById("account-dropdown");
      const topRight = document.getElementById("top-right");
      if (dropdown?.contains(target) || topRight?.contains(target)) return;
      setAccountDropdownOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
  }, [accountDropdownOpen]);

  const openHomeProductGuide = useCallback(() => {
    setHomeSuppressed(false);
    setVisualGuideOpen(true);
  }, []);

  const setPlaylistPanelPinned = useCallback((pinned: boolean) => {
    setPlaylistPanelPinnedState(pinned);
    saveBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, pinned);
    if (pinned) setPlaylistPanelOpen(true);
  }, []);

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

  const updateShelfMode = useCallback(
    (mode: ShelfMode) => {
      setShelfMode(mode);
      saveShelfSettingsToStorage();
    },
    [setShelfMode],
  );

  const updateShelfCameraMode = useCallback(
    (mode: ShelfCameraMode) => {
      setShelfCameraMode(mode);
      saveShelfSettingsToStorage();
      showToast(
        mode === "static" ? "3D歌单架: 静态镜头" : "3D歌单架: 动态镜头",
      );
    },
    [setShelfCameraMode, showToast],
  );

  const updateShelfPresence = useCallback(
    (presence: ShelfPresence) => {
      setShelfPresence(presence);
      saveShelfSettingsToStorage();
      showToast(
        presence === "always" ? "3D歌单架: 常驻" : "3D歌单架: 自动隐藏",
      );
    },
    [setShelfPresence, showToast],
  );

  const updateShelfShowPodcasts = useCallback(
    (show: boolean) => {
      setShelfShowPodcasts(show);
      saveShelfSettingsToStorage();
      showToast(show ? "3D歌单架已显示播客歌单" : "3D歌单架已隐藏播客歌单");
    },
    [setShelfShowPodcasts, showToast],
  );

  const updateShelfMergeCollections = useCallback(
    (merge: boolean) => {
      setShelfMergeCollections(merge);
      saveShelfSettingsToStorage();
      showToast(
        merge ? "我的歌单与收藏歌单已合并滚动" : "收藏歌单恢复滚到底切页",
      );
    },
    [setShelfMergeCollections, showToast],
  );

  const setDesktopLyricsWindowEnabledRef = useRef<
    (enabled: boolean) => Promise<void> | void
  >(() => {});

  const updateVisualPreset = useCallback(
    (preset: number) => {
      setVisualPreset(preset);
      saveVisualFxToStorage();
    },
    [setVisualPreset],
  );

  const updateVisualFxPatch = useCallback(
    (patch: Partial<FxState>) => {
      setVisualFxPatch(patch);
      saveVisualFxToStorage();
    },
    [setVisualFxPatch],
  );

  const updateVisualNumberSetting = useCallback(
    (key: keyof typeof visualFx, value: number) => {
      if (key === "backgroundOpacity") {
        setVisualFxPatch({
          backgroundOpacity: value,
          backgroundColorMode: "custom",
          backgroundColorCustom: true,
        });
        saveVisualFxToStorage();
        return;
      }
      setVisualNumberSetting(key, value);
      saveVisualFxToStorage();
    },
    [setVisualFxPatch, setVisualNumberSetting],
  );

  const updateVisualBooleanSetting = useCallback(
    (key: keyof typeof visualFx, value: boolean) => {
      setVisualBooleanSetting(key, value);
      if (key === "shelfShowPodcasts") setShelfShowPodcasts(value);
      if (key === "shelfMergeCollections") setShelfMergeCollections(value);
      saveVisualFxToStorage();
      if (key === "shelfShowPodcasts" || key === "shelfMergeCollections")
        saveShelfSettingsToStorage();
      if (key === "desktopLyrics") {
        void setDesktopLyricsWindowEnabledRef.current(value);
      }
      if (key === "aiDepth") {
        showToast(
          value
            ? "已开启后台 AI 立体增强"
            : "已关闭 AI 立体增强, 使用轻量弧面",
        );
      }
    },
    [
      setShelfMergeCollections,
      setShelfShowPodcasts,
      setVisualBooleanSetting,
      showToast,
    ],
  );

  useEffect(() => {
    const handleAiDepthStatus = (event: Event) => {
      const detail = (event as CustomEvent<AiDepthStatusDetail>).detail;
      if (!detail) return;
      if (detail.toast) showToast(detail.toast);
      setAiDepthChip((current) => ({
        visible: detail.visible,
        text: detail.text || current.text || "AI 深度估计…",
      }));
    };
    window.addEventListener(AI_DEPTH_STATUS_EVENT, handleAiDepthStatus);
    return () =>
      window.removeEventListener(AI_DEPTH_STATUS_EVENT, handleAiDepthStatus);
  }, [showToast]);

  const updateVisualStringSetting = useCallback(
    (key: keyof typeof visualFx, value: string) => {
      setVisualStringSetting(key, value);
      if (key === "shelf") setShelfMode(value as ShelfMode);
      if (key === "shelfCameraMode")
        setShelfCameraMode(value as ShelfCameraMode);
      if (key === "shelfPresence") setShelfPresence(value as ShelfPresence);
      saveVisualFxToStorage();
      if (
        key === "shelf" ||
        key === "shelfCameraMode" ||
        key === "shelfPresence"
      )
        saveShelfSettingsToStorage();
    },
    [
      setShelfCameraMode,
      setShelfMode,
      setShelfPresence,
      setVisualStringSetting,
    ],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    applyVisualThemeToRoot(document.documentElement, visualFx);
  }, [visualFx]);

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
      void resolvedDesktopRuntime.toggleWindowFullscreen();
    },
  }), [nextTrack, previousTrack, resolvedDesktopRuntime, setVolume, togglePlayback]);

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
    desktopLyricsEnabled,
    desktopWindowState,
    toggleDesktopLyrics,
    setDesktopLyricsEnabled: setDesktopLyricsWindowEnabled,
  } = useDesktopRuntime({
    desktop: resolvedDesktopRuntime,
    buildLyricsPayload: buildDesktopRuntimeLyricsPayload,
    lyricsPayloadVersion: desktopLyricsPayloadVersion,
    hotkeyActions: desktopHotkeyActions,
    onWindowState: applyDesktopWindowShellState,
    onWindowCleanup: clearDesktopWindowShell,
  });
  setDesktopLyricsWindowEnabledRef.current = setDesktopLyricsWindowEnabled;

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("diy-mode-preload", diyMode);
    document.documentElement.classList.toggle("simple-mode-preload", !diyMode);
    document.body.classList.toggle("diy-mode", diyMode);
    document.body.classList.toggle("simple-mode", !diyMode);
    return () => {
      document.documentElement.classList.remove("diy-mode-preload", "simple-mode-preload");
      document.body.classList.remove("diy-mode", "simple-mode");
    };
  }, [diyMode]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("splash-active", splashActive);
    document.body.classList.toggle("empty-home-active", emptyHomeActive);
    document.body.classList.toggle("controls-visible", consoleVisible);
    document.body.classList.toggle("home-wallpaper-preview", emptyHomeActive);
    document.body.classList.toggle("home-controls-locked", homeControlsLocked);
    document.body.classList.toggle("user-capsule-auto-hide", userCapsuleAutoHide);
    document.body.classList.toggle("user-capsule-peek", userCapsuleAutoHide && userCapsulePeek);
    document.body.classList.toggle("visual-guide-active", visualGuideOpen);
    document.body.classList.toggle("search-detail-open", searchDetailOpen);
    return () => {
      document.body.classList.remove(
        "splash-active",
        "empty-home-active",
        "controls-visible",
        "home-wallpaper-preview",
        "home-controls-locked",
        "user-capsule-auto-hide",
        "user-capsule-peek",
        "visual-guide-active",
        "search-detail-open",
      );
    };
  }, [
    consoleVisible,
    emptyHomeActive,
    homeControlsLocked,
    searchDetailOpen,
    splashActive,
    userCapsuleAutoHide,
    userCapsulePeek,
    visualGuideOpen,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!userCapsuleAutoHide) {
      setUserCapsulePeek(false);
      return;
    }
    const updateFromPointer = (event: MouseEvent) => {
      setUserCapsulePeek(event.clientX > window.innerWidth - 112 && event.clientY < 126);
    };
    const clearPeek = () => setUserCapsulePeek(false);
    window.addEventListener("mousemove", updateFromPointer);
    window.addEventListener("mouseleave", clearPeek);
    return () => {
      window.removeEventListener("mousemove", updateFromPointer);
      window.removeEventListener("mouseleave", clearPeek);
    };
  }, [userCapsuleAutoHide]);

  useEffect(() => {
    const settings = loadShelfSettingsFromStorage();
    if (settings) applyShelfSettings(settings);
  }, [applyShelfSettings]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const stageMode = shelfMode === "stage";
    document
      .getElementById("search-area")
      ?.classList.toggle("stage-mode", stageMode);
    document
      .getElementById("bottom-bar")
      ?.classList.toggle("stage-mode", stageMode);
  }, [shelfMode]);

  useEffect(() => {
    if (!emptyHomeActive || typeof document === "undefined") return;
    const onBlankClick = (event: MouseEvent) => {
      if (!isHomeBlankDismissElement(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setHomeForcedOpen(false);
      setHomeSuppressed(true);
      setConsole(false);
      setMiniQueue(false);
    };
    document.addEventListener("click", onBlankClick, true);
    return () => document.removeEventListener("click", onBlankClick, true);
  }, [emptyHomeActive, setConsole, setMiniQueue]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => clearToast(), 2600);
    return () => clearTimeout(timer);
  }, [clearToast, toast]);

  useEffect(() => {
    if (!miniQueueOpen || typeof document === "undefined") return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("#bottom-bar")) return;
      setMiniQueue(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () =>
      document.removeEventListener("pointerdown", closeOnPointerDown);
  }, [miniQueueOpen, setMiniQueue]);

  const providerStatuses: Partial<Record<ProviderId, ProviderLoginStatus | null>> = {
    netease: neteaseStatus,
    qq: qqStatus,
    soda: sodaStatus,
  };
  const missingLoginProviders = LOGIN_PROVIDERS.filter(
    (provider) => !providerStatuses[provider]?.loggedIn,
  );
  const loggedProviderStatuses = LOGIN_PROVIDERS
    .map((provider) => {
      const status = providerStatuses[provider];
      return { provider, status };
    })
    .filter(
      (entry): entry is { provider: (typeof LOGIN_PROVIDERS)[number]; status: ProviderLoginStatus } =>
        entry.status?.loggedIn === true,
    );
  const loggedAccountSummaries = loggedProviderStatuses.map(
    ({ provider, status }) =>
      `${providerLabel(provider)} ${status.nickname ?? status.userId ?? "已登录"}`,
  );
  const providerLoginHint = (provider: ProviderId, fallback: string) => {
    const status = providerStatuses[provider];
    return status?.loggedIn === false ? "登录已失效" : fallback;
  };
  const topAccountStatus = neteaseStatus?.loggedIn
    ? neteaseStatus
    : qqStatus?.loggedIn
      ? qqStatus
      : sodaStatus?.loggedIn
        ? sodaStatus
        : null;
  const topVipBadge = accountVipBadge(topAccountStatus);
  const activeLoginQr = loginQrByProvider[loginProvider];
  const activeLoginQrStatus = loginQrStatusByProvider[loginProvider];
  const activeLoginStatus = providerStatuses[loginProvider] ?? null;
  const activeCookieInputRef =
    loginProvider === "netease"
      ? neteaseCookieInputRef
      : loginProvider === "soda"
        ? sodaCookieInputRef
        : qqCookieInputRef;

  return (
    <AppRuntimeProvider services={appServices}>
    <SidecarRecoveryRuntime
      initialRuntimeConfig={initialRuntimeConfig}
      createSidecarClient={createSidecarClient}
      servicesFactory={servicesFactory}
      loginProviders={LOGIN_PROVIDERS}
      onConnection={handleSidecarConnection}
      onCapabilities={setMatrix}
      onProviderStatus={acceptProviderStatus}
      onRefreshLibrary={handleRuntimeLibraryRefresh}
      onRecoveryState={handleRecoveryState}
    />
    <div id="desktop-window-shell">
      <input
        ref={fileInputRef}
        type="file"
        id="file-input"
        accept={LOCAL_AUDIO_ACCEPT}
        multiple
        style={{ display: "none" }}
        onChange={(event) => {
          importLocalFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <DesktopTitlebar
        maximized={desktopWindowState?.isMaximized}
        onGuide={openHomeProductGuide}
        onDiy={toggleDiyMode}
        diyActive={diyMode}
        onMinimize={() => void resolvedDesktopRuntime.minimizeWindow()}
        onToggleMaximize={() => void resolvedDesktopRuntime.toggleWindowMaximize()}
        onClose={() => void resolvedDesktopRuntime.closeWindow()}
        updateSlot={
          <UpdateHost
            state={updateState}
            open={updateModalOpen}
            onOpen={() => setUpdateModalOpen(true)}
            onClose={() => setUpdateModalOpen(false)}
            onCheck={() => void refreshUpdateStatus(true)}
            onInstall={() => void installAvailableUpdate()}
          />
        }
      />
      {SHOW_SPLASH && splashActive && (
        <SplashComponent onDismissed={() => setSplashActive(false)} />
      )}
      <VisualComponent
        audioElementRef={audioRef}
        controllerRef={controllerRef}
        lyricsPayload={lyricsPayload}
        positionMs={positionMs}
        durationMs={durationMs}
        isPlaying={isPlaying}
        queue={queue}
        playlists={shelfPlaylists}
        podcastCollections={shelfPodcastCollections}
        currentTrack={currentTrack}
        currentCoverUrl={currentTrack?.coverUrl}
        beatMapKey={currentBeatMapState?.key}
        beatMap={currentBeatMapState?.map}
        sidecarBaseUrl={sidecarBaseUrl}
        coverResolution={visualFx.coverResolution}
        fxState={visualFx}
        shelfSettings={{
          mode: shelfMode,
          cameraMode: shelfCameraMode,
          presence: shelfPresence,
          showPodcasts: shelfShowPodcasts,
          mergeCollections: shelfMergeCollections,
        }}
        splashActive={splashActive}
        homeActive={emptyHomeActive}
        secondaryLeftDisplaySeamGuardActive={shouldUseSecondaryLeftDisplaySeamGuard(
          desktopWindowState,
        )}
        onShelfModeChange={updateShelfMode}
        onShelfPlayQueueIndex={(index) =>
          usePlaybackStore.getState().playAt(index)
        }
        onShelfPlayPlaylist={(payload) => void playShelfPlaylist(payload)}
        onShelfDetailRowClick={(payload) => {
          void handleShelfDetailRowAction({
            ...payload,
            client: sidecarClient,
            isLiked: () => false,
            onResult: (message) => showToast(message),
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
        }}
        onShelfOpenDetailContent={(payload, contentList) => {
          shelfContentListRef.current = contentList;
          const loader = createShelfDetailContentLoader({
            client: sidecarClient,
            getContentList: () => contentList,
          });
          void loader(payload);
        }}
        onShelfOpenContentChange={setShelfDetailOpen}
        desktopLyricsMotionRef={desktopLyricsMotionRef}
      />
      <GuideParticlesHost />
      <div id="ai-depth-chip" className={aiDepthChip.visible ? "show" : ""}>
        <div className="mini-spin" />
        <span id="ai-depth-text">{aiDepthChip.text}</span>
      </div>
      <VisualControlPanelHost
        preset={visualPreset}
        intensity={visualIntensity}
        settings={{
          ...visualFx,
          shelf: shelfMode,
          shelfCameraMode,
          shelfPresence,
          shelfShowPodcasts,
          shelfMergeCollections,
        }}
        onPresetChange={updateVisualPreset}
        onNumberSettingChange={updateVisualNumberSetting}
        onBooleanSettingChange={updateVisualBooleanSetting}
        onStringSettingChange={updateVisualStringSetting}
        onFxPatchChange={updateVisualFxPatch}
        onNotice={showNotice}
      />
      <EmptyHomeHost
        discover={homeDiscover}
        weatherRadio={homeWeatherRadio}
        listenSummary={homeListenSummary}
        playlistDetail={homePlaylistDetail}
        active={emptyHomeActive}
        loading={homeDiscoverLoading || homeWeatherRadioLoading}
        isPlaying={isPlaying}
        positionMs={positionMs}
        durationMs={durationMs}
        onSearchFocus={focusSearch}
        onOpenLibrary={openHomeLibrary}
        onOpenConsole={openHomePlayerConsole}
        onSearchQuery={searchQuery}
        onUpload={openLocalFileImport}
        onGuide={openHomeProductGuide}
        onOpenLogin={openLoginModal}
        onPlayDaily={playHomeDaily}
        onPlayPrivate={() => void playHomePrivate()}
        onPlaySong={(index) => void playHomeDiscoverSongs(index)}
        onOpenPlaylist={(index) => void openHomeDiscoverPlaylist(index)}
        onOpenPodcast={(index) => void openHomeDiscoverPodcast(index)}
        onOpenPodcastSearch={openHomePodcastSearch}
        onOpenInsight={openHomeInsight}
        onPlayRecent={playHomeRecent}
        onPlayWeatherSong={(index) => void playHomeWeatherSong(index)}
        onClosePlaylistDetail={closeHomePlaylistDetail}
        onPlayPlaylistDetail={playHomePlaylistDetail}
        onPlaylistDetailArtist={searchHomePlaylistDetailArtist}
      />
      <SearchShell
        client={appServices?.music.search ?? null}
        onFocus={focusSearch}
        onUpload={openLocalFileImport}
        onClearCustomCover={clearCustomCoverImage}
        onResultPlay={enterPlaybackSurface}
        onResultNext={insertSearchResultNext}
        onResultLike={(track) => void toggleLikeTrack(track)}
        onResultCollect={openCollectPicker}
        onSharedPlaylistImport={importSharedPlaylistFromText}
        onArtistSearch={searchArtistFromResult}
        isResultLiked={isTrackLiked}
        isResultLikeBusy={isTrackLikeBusy}
        hasCustomCover={currentHasCustomCover}
        peek={emptyHomeActive || searchKeyword.trim().length > 0}
        requestedMode={searchModeRequest}
      />
      <SearchDetailPage
        client={sidecarClient}
        onClose={focusSearch}
        onPlayResults={playSearchDetailTracks}
        onAppendQueue={appendSearchResult}
        onResultNext={insertSearchResultNext}
        onResultLike={(track) => void toggleLikeTrack(track)}
        onResultCollect={openCollectPicker}
        onArtistSearch={searchArtistFromResult}
        isResultLiked={isTrackLiked}
        isResultLikeBusy={isTrackLikeBusy}
      />
      <TopRightControls
        onHome={goHome}
        onLogin={handleAccountButtonClick}
        onHideCapsule={toggleUserCapsuleAutoHide}
        capsuleAutoHide={userCapsuleAutoHide}
        loggedIn={topAccountStatus !== null}
        accountLabel={
          topAccountStatus?.nickname ??
          topAccountStatus?.userId ??
          undefined
        }
        accountAvatarUrl={topAccountStatus?.avatarUrl}
        accountVipLevel={topAccountStatus?.vipLevel}
        accountVipLabel={topVipBadge?.text}
        accountVipIcon={topVipBadge?.icon}
        accountVipIconUrl={topVipBadge?.iconUrl}
      />
      {accountDropdownOpen && loggedProviderStatuses.length > 0 ? (
        <div
          id="account-dropdown"
          className="account-dropdown"
          role="menu"
          aria-label="账号信息"
        >
          <div className="account-dropdown-title">账号信息</div>
          <div className="account-dropdown-list">
            {loggedProviderStatuses.map(({ provider, status }) => {
              const displayName = status.nickname ?? status.userId ?? "已登录";
              const vipBadge = accountVipBadge(status);
              return (
                <div
                  key={provider}
                  id={`account-dropdown-provider-${provider}`}
                  className={`account-dropdown-row account-pill ${provider}`}
                >
                  {status.avatarUrl ? (
                    <img
                      className="account-dropdown-avatar"
                      src={status.avatarUrl}
                      alt=""
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="account-dropdown-avatar fallback" aria-hidden="true">
                      {displayName.trim().slice(0, 1) || "账"}
                    </span>
                  )}
                  <div className="account-dropdown-main">
                    <div className="account-dropdown-provider">
                      {providerLabel(provider)}
                      {vipBadge ? (
                        <VipBadge text={vipBadge.text} icon={vipBadge.icon} iconUrl={vipBadge.iconUrl} />
                      ) : null}
                    </div>
                    <div className="account-dropdown-name">{displayName}</div>
                  </div>
                  <div className="account-dropdown-actions">
                    <button
                      type="button"
                      onClick={() => void refreshProviderStatus(provider)}
                    >
                      刷新
                    </button>
                    <button
                      type="button"
                      onClick={() => void logoutProvider(provider)}
                    >
                      退出
                    </button>
                  </div>
                </div>
              );
            })}
            {missingLoginProviders.length > 0 ? (
              <div className="account-dropdown-divider" />
            ) : null}
            {missingLoginProviders.map((provider) => (
              <button
                key={provider}
                id={`account-add-provider-${provider}`}
                className={`account-dropdown-add ${provider}`}
                type="button"
                onClick={() => openSingleProviderLogin(provider)}
              >
                <span>添加 {providerLabel(provider)}</span>
                <span>{providerLoginHint(provider, "扫码登录")}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <VisualGuideHost
        open={visualGuideOpen}
        onClose={closeVisualGuide}
        onPrepareStep={prepareVisualGuideStep}
      />
      <PlaylistPanelHost
        open={playlistPanelOpen || playlistPanelPinned}
        pinned={playlistPanelPinned}
        tab={playlistPanelTab}
        queue={queue}
        currentTrack={currentTrack}
        mode={playbackMode}
        playlists={shelfPlaylists}
        importedPlaylists={importedPlaylists}
        podcastCollections={shelfPodcastCollections}
        onTabChange={openPlaylistPanelTab}
        onPinToggle={togglePlaylistPanelPinned}
        onShuffle={shufflePlaylistPanelQueue}
        onCycleMode={cyclePlaylistPanelMode}
        onClearQueue={clearPlaylistPanelQueue}
        onRefresh={() => void refreshShelfPlaylists()}
        onPlayQueueIndex={playQueueAt}
        onQueueArtist={(artist) => searchQuery(artist, "song")}
        onLikeQueueIndex={toggleLikeQueueIndex}
        onCollectQueueIndex={collectQueueIndex}
        onInsertQueueNext={insertMiniQueueNext}
        onRemoveQueueIndex={removeQueueAt}
        onLoadPlaylistDetail={loadPlaylistPanelDetail}
        onPlayTracks={playPlaylistPanelTracks}
        onDeleteImportedPlaylist={deleteImportedPlaylist}
        onPodcastCollectionOpen={(collection) => void openPlaylistPanelPodcastCollection(collection)}
      />
      <BottomControlsHost
        visible={consoleVisible}
        onReveal={revealConsole}
        onTogglePlay={togglePlayback}
        onPrevious={previousTrack}
        onNext={nextTrack}
        onModeChange={setPlaybackMode}
        onQueue={toggleMiniQueue}
        onLyrics={() =>
          showNotice(
            lyricsPayload ? "歌词已载入舞台层" : "播放歌曲后会自动加载歌词",
          )
        }
        onLyricSourceChange={(mode) => {
          if (mode === "custom") chooseCustomLyrics();
          else applyOriginalLyrics();
        }}
        onOpenCustomLyrics={openCustomLyricModal}
        onCollectCurrent={openCollectPickerForCurrent}
        onToggleLikeCurrent={toggleLikeCurrent}
        onClose={() => {
          setConsole(false);
          setMiniQueue(false);
        }}
        onNotice={showNotice}
        onSeek={seekPlayback}
        onVolumeChange={setVolume}
        onToggleMute={toggleMute}
        onQualityChange={setPlaybackQuality}
        onShelfModeChange={updateShelfMode}
        onShelfCameraModeChange={updateShelfCameraMode}
        onShelfPresenceChange={updateShelfPresence}
        onShelfShowPodcastsChange={updateShelfShowPodcasts}
        onShelfMergeCollectionsChange={updateShelfMergeCollections}
        deps={{
          isHomeControlsLocked: () => homeControlsLocked,
        }}
        onPlayQueueIndex={playMiniQueueIndex}
        onRemoveQueueIndex={removeQueueAt}
        onInsertQueueNext={insertMiniQueueNext}
        onMinimize={() => void resolvedDesktopRuntime.minimizeWindow()}
        onToggleMaximize={() => void resolvedDesktopRuntime.toggleWindowMaximize()}
        onToggleFullscreen={() => void resolvedDesktopRuntime.toggleWindowFullscreen()}
        mode={playbackMode}
        isPlaying={isPlaying}
        currentTitle={currentTrack?.title}
        currentArtist={currentTrack?.artists.join(" / ")}
        currentCoverUrl={currentTrack?.coverUrl}
        currentLiked={currentLiked}
        currentLikeBusy={currentLikeBusy}
        queue={queue}
        currentTrack={currentTrack}
        miniQueueOpen={miniQueueOpen}
        positionMs={positionMs}
        durationMs={durationMs}
        volume={volume}
        muted={muted}
        playbackQuality={playbackQuality}
        qualityOptions={trackQualityOptions}
        shelfMode={shelfMode}
        shelfCameraMode={shelfCameraMode}
        shelfPresence={shelfPresence}
        shelfShowPodcasts={shelfShowPodcasts}
        shelfMergeCollections={shelfMergeCollections}
        lyricSourceMode={
          currentLyricPreference === "custom" ? "custom" : "original"
        }
        hasCustomLyric={!!currentCustomLyricText}
      />
      {sidecarRecoveryState ? (
        <SidecarRecoveryNotice state={sidecarRecoveryState} />
      ) : null}
      {customLyricModalOpen ? (
        <div
          id="custom-lyric-modal"
          className="modal-mask show"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget)
              setCustomLyricModalOpen(false);
          }}
        >
          <div
            className="modal custom-lyric-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-lyric-heading"
          >
            <h2 id="custom-lyric-heading">自定义歌词</h2>
            <div className="custom-lyric-track">
              <div id="custom-lyric-title" className="custom-lyric-title">
                {currentTrack?.title ?? "当前歌曲"}
              </div>
              <div id="custom-lyric-sub" className="custom-lyric-sub">
                {(currentTrack?.artists.join(" / ") || "") +
                  (currentCustomLyricText
                    ? " · 已保存自定义歌词"
                    : " · 可粘贴 LRC 或逐行输入")}
              </div>
            </div>
            <textarea
              ref={customLyricInputRef}
              id="custom-lyric-input"
              className="custom-lyric-input"
              spellCheck={false}
              defaultValue={customLyricText}
              placeholder={
                "[00:12.00] 第一行歌词\n[00:16.50] 第二行歌词\n\n没有时间轴也可以，每一行会按歌曲时长自动铺开"
              }
              onChange={(event) =>
                setCustomLyricText(event.currentTarget.value)
              }
            />
            <div
              id="custom-lyric-status"
              className={`custom-lyric-status ${customLyricStatus.tone ?? ""}`.trim()}
            >
              {customLyricStatus.text}
            </div>
            <div className="btn-row">
              <button
                className="modal-btn"
                type="button"
                onClick={deleteCustomLyric}
              >
                删除
              </button>
              <button
                className="modal-btn"
                type="button"
                onClick={() => setCustomLyricModalOpen(false)}
              >
                关闭
              </button>
              <button
                id="custom-lyric-save"
                className="modal-btn primary"
                type="button"
                onClick={saveCustomLyric}
              >
                保存使用
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {collectTarget ? (
        <div
          id="collect-modal"
          className="modal-mask show"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeCollectPicker();
          }}
        >
          <div
            className="modal collect-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="collect-modal-title"
          >
            <h2 id="collect-modal-title">收藏到歌单</h2>
            <div id="collect-current" className="collect-current">
              {collectTarget.coverUrl ? (
                <img src={collectTarget.coverUrl} alt="" />
              ) : (
                <div className="cover-placeholder" />
              )}
              <div className="collect-current-meta">
                <div className="collect-title">{collectTarget.title}</div>
                <div className="collect-sub">
                  {collectTarget.artists.join(" / ")}
                </div>
              </div>
            </div>
            <div id="collect-list" className="collect-list">
              {writableCollectPlaylists.length > 0 ? (
                writableCollectPlaylists.map((playlist) => (
                  <button
                    key={`${playlist.provider}:${playlist.id}`}
                    type="button"
                    className={
                      collectBusyPlaylistId === playlist.id
                        ? "collect-item busy"
                        : "collect-item"
                    }
                    data-collect-pid={playlist.id}
                    onClick={() => void addCollectTargetToPlaylist(playlist.id)}
                  >
                    {playlist.coverUrl ? (
                      <img src={playlist.coverUrl} alt="" />
                    ) : (
                      <div className="cover-placeholder" />
                    )}
                    <div className="collect-current-meta">
                      <div className="collect-title">{playlist.name}</div>
                      <div className="collect-sub">
                        {playlist.trackCount ?? 0} 首
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <div className="collect-empty">还没有可写入的歌单</div>
              )}
            </div>
            <div className="btn-row">
              <button
                className="modal-btn"
                type="button"
                onClick={closeCollectPicker}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {loginModalOpen ? (
        <div
          id="login-modal"
          className="modal-mask show"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeLoginModal();
          }}
        >
          <div
            className={`modal dual-login-modal${loginModalMode === "add-account" ? " add-account-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-modal-title"
          >
            {loginModalMode === "full" ? (
              <div className="login-platform-tabs" id="login-platform-tabs">
                {LOGIN_PROVIDERS.map((provider) => (
                  <button
                    key={provider}
                    id={`login-provider-${provider}`}
                    className={`${provider}${loginProvider === provider ? " active" : ""}`}
                    type="button"
                    onClick={() => {
                      setLoginProvider(provider);
                      setQqManualCookieOpen(false);
                    }}
                    aria-selected={loginProvider === provider}
                  >
                    {providerLabel(provider)}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="login-intro">
              <div className="login-intro-kicker">Mineradio</div>
              <div className="login-intro-title">音乐播放器，也是一座视觉舞台</div>
              <div className="login-intro-body">
                搜索或导入一首歌即可播放；登录后会同步歌单、红心和播客，登录态会保存在本机 sidecar 数据目录。
              </div>
            </div>
            {loginModalMode === "add-account" ? (
              <>
                <h2 id="login-modal-title">
                  {missingLoginProviders.length > 0 ? "添加账号" : "账号信息"}
                </h2>
                <div id="login-modal-desc" className="desc">
                  {missingLoginProviders.length > 0
                    ? `当前已登录 ${loggedAccountSummaries.join("、") || "一个音乐平台"}，选择要添加的平台。`
                    : `当前已登录 ${loggedAccountSummaries.join("、") || "全部音乐平台"}，可刷新状态或退出账号。`}
                </div>
                <div id="login-add-account-panel" className="login-add-account-panel">
                  {loggedProviderStatuses.map(({ provider, status }) => (
                    <div
                      key={provider}
                      id={`logged-login-provider-${provider}`}
                      className={`login-account-card ${provider}`}
                    >
                      <div className="login-account-card-main">
                        <span className="login-add-provider-name">{providerLabel(provider)}</span>
                        <span className="login-add-provider-meta">
                          {status.nickname ?? status.userId ?? "已登录"}
                        </span>
                      </div>
                      <div className="login-account-actions">
                        <button
                          className="modal-btn"
                          type="button"
                          onClick={() => void refreshProviderStatus(provider)}
                        >
                          刷新
                        </button>
                        <button
                          className="modal-btn"
                          type="button"
                          onClick={() => void logoutProvider(provider)}
                        >
                          退出
                        </button>
                      </div>
                    </div>
                  ))}
                  {missingLoginProviders.map((provider) => (
                    <button
                      key={provider}
                      id={`add-login-provider-${provider}`}
                      className={`login-add-provider-card ${provider}`}
                      type="button"
                      onClick={() => openSingleProviderLogin(provider)}
                    >
                      <span className="login-add-provider-name">{providerLabel(provider)}</span>
                      <span className="login-add-provider-meta">{providerLoginHint(provider, "扫码添加这个账号")}</span>
                    </button>
                  ))}
                </div>
                <div className="btn-row">
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={closeLoginModal}
                  >
                    关闭
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="login-modal-title">
                  {loginTitleForProvider(loginProvider)}
                </h2>
                <div id="login-modal-desc" className="desc">
                  {loginDescriptionForProvider(loginProvider)}
                </div>
                <div id="qr-shell" className="qr-shell">
                  {activeLoginQr?.img ? (
                    <img id="qr-img" src={activeLoginQr.img} alt={`${providerLabel(loginProvider)}登录二维码`} />
                  ) : (
                    <div className="qr-loading-mark" aria-hidden="true">
                      {qrLoadingMarkForProvider(loginProvider)}
                    </div>
                  )}
                </div>
                <div id="qr-status" className={activeLoginQrStatus.tone}>
                  {activeLoginQrStatus.text}
                </div>
                <div className="account-status-line">
                  {activeLoginStatus?.loggedIn
                    ? `已登录 ${activeLoginStatus.nickname ?? activeLoginStatus.userId ?? ""}`
                    : "未确认登录"}
                </div>
                <div
                  id="qq-cookie-panel"
                  className={`qq-cookie-panel${qqManualCookieOpen ? " show" : ""}`}
                >
                  <textarea
                    ref={activeCookieInputRef}
                    id={`${loginProvider}-cookie-input`}
                    className="qq-cookie-input"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={cookiePlaceholderForProvider(loginProvider)}
                  />
                  <div className="qq-cookie-actions">
                    <div className="qq-cookie-note">
                      手动导入只会写入本机 sidecar 会话。
                    </div>
                    <button
                      className="modal-btn primary"
                      type="button"
                      onClick={() => void importProviderCookie(loginProvider)}
                    >
                      保存
                    </button>
                  </div>
                </div>
                <div className="btn-row">
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={closeLoginModal}
                  >
                    关闭
                  </button>
                  <button
                    id="refresh-qr-btn"
                    className="modal-btn primary"
                    type="button"
                    onClick={() => void refreshProviderLoginQr(loginProvider)}
                  >
                    刷新二维码
                  </button>
                  <button
                    id="qq-cookie-toggle-btn"
                    className="modal-btn show"
                    type="button"
                    onClick={() => setQqManualCookieOpen((open) => !open)}
                  >
                    手动导入
                  </button>
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={() => void refreshProviderStatus(loginProvider)}
                  >
                    刷新状态
                  </button>
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={() => void logoutProvider(loginProvider)}
                  >
                    退出
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      <div
        id="trial-banner"
        className={trialBanner ? "show" : ""}
        data-provider={trialBanner?.provider ?? ""}
      >
        <svg
          className="ic"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span id="trial-text">{trialBanner?.text ?? "仅播放试听片段"}</span>
        <button
          id="trial-login-btn"
          className="login-link"
          type="button"
          style={{ display: trialBanner?.showLogin ? "" : "none" }}
          onClick={openLoginModal}
        >
          扫码登录
        </button>
        <button
          className="close"
          type="button"
          aria-label="关闭试听提醒"
          onClick={dismissTrialBanner}
        >
          ×
        </button>
      </div>
      <div
        id="toast"
        className={toast ? "show" : ""}
        role="status"
        aria-live="polite"
      >
        {toast ?? ""}
      </div>
    </div>
    <PlaybackRuntimeHost
      audioElementRef={audioRef}
      controllerRef={controllerRef}
      volume={volume}
      muted={muted}
      onTimeUpdate={handleRuntimeTimeUpdate}
      onDurationChange={handleRuntimeDurationChange}
      onPlay={handleRuntimePlay}
      onPause={handleRuntimePause}
      onEnded={handleRuntimeEnded}
      onError={handleRuntimeError}
    />
    </AppRuntimeProvider>
  );
}

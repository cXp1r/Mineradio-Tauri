import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { SidecarClient, SidecarClientError } from "../api/sidecar-client";
import { PlayerController } from "../audio/player-controller";
import {
  deleteCustomLyricForTrack,
  getCustomLyricPreferenceForTrack,
  getCustomLyricTextForTrack,
  resolveLyricsForTrack,
  saveCustomLyricForTrack,
  setCustomLyricPreferenceForTrack,
} from "../lyrics/custom-lyrics";
import { selectCurrentIndex } from "../lyrics/select-current-index";
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
import {
  closeDesktopLyricsWindow,
  configureGlobalHotkeys,
  getRuntimeConfig,
  getSidecarStatus,
  getWindowState,
  importJsonFile,
  listenWindowState,
  listenGlobalHotkey,
  minimizeWindow,
  openProviderLoginWindow,
  showDesktopLyricsWindow,
  toggleWindowMaximize,
  toggleWindowFullscreen,
  updateDesktopLyricsPayload,
  type GlobalHotkeyBinding,
  type JsonValue,
  type RuntimeConfig,
  type SidecarStatus,
  type WindowState,
} from "../tauri/runtime";
import { checkForUpdate, getUpdaterStatus } from "../tauri/updater";
import { BottomControlsHost } from "../components/shell/BottomControlsHost";
import { SearchShell } from "../components/shell/SearchShell";
import {
  createDesktopLyricsPushState,
  shouldPushDesktopLyricsPayload,
} from "../desktop-lyrics/desktop-lyrics-push";
import { buildDesktopLyricSnapshot } from "../desktop-lyrics/desktop-lyrics-snapshot";
import {
  SidecarRecoveryNotice,
  type SidecarRecoveryNoticeState,
} from "../components/shell/SidecarRecoveryNotice";
import { TopRightControls } from "../components/shell/TopRightControls";
import { UpdateHost } from "../components/shell/UpdateHost";
import { EmptyHomeHost } from "../home/EmptyHomeHost";
import { SplashHost, type SplashHostProps } from "../visual/SplashHost";
import {
  AI_DEPTH_STATUS_EVENT,
  type AiDepthStatusDetail,
} from "../visual/ai-depth-estimator";
import { VisualControlPanelHost } from "../visual/VisualControlPanelHost";
import {
  VisualEngineHost,
  type DesktopLyricsMotionSnapshot,
} from "../visual/VisualEngineHost";
import {
  createPodcastRadioDetailOpener,
  createShelfDetailContentLoader,
  handleShelfDetailRowAction,
  mapShelfDetailRowToTrack,
  type ShelfDetailContentListController,
} from "../visual/shelf-detail-data";
import {
  ensureLyricFallbackPayload,
  type PlaybackQuality,
  type PlaylistSummary,
  type PodcastCollection,
  type ProviderId,
  type ProviderLoginStatus,
  type SongUrlResult,
  type Track,
} from "@mineradio/shared";
import type { FxState } from "@mineradio/visual-engine";

const SHOW_SPLASH = import.meta.env.VITE_SPLASH !== "0";
const SIDECAR_STATUS_POLL_MS = 1500;
const SIDECAR_RECOVERED_NOTICE_MS = 2600;
const PLAYBACK_QUALITY_STORE_KEY = "mineradio-playback-quality-v1";
const DEFAULT_GLOBAL_HOTKEYS: GlobalHotkeyBinding[] = [
  { action: "togglePlay", accelerator: "Control+Alt+Space" },
  { action: "prevTrack", accelerator: "Control+Alt+ArrowLeft" },
  { action: "nextTrack", accelerator: "Control+Alt+ArrowRight" },
  { action: "volumeUp", accelerator: "Control+Alt+ArrowUp" },
  { action: "volumeDown", accelerator: "Control+Alt+ArrowDown" },
  { action: "toggleFullscreen", accelerator: "Control+Alt+KeyF" },
  { action: "toggleDesktopLyrics", accelerator: "Control+Alt+KeyL" },
];

function placeholderRuntimeConfig(): RuntimeConfig {
  return {
    sidecarBaseUrl: "",
    appDataDir: "",
    appVersion: "0.0.0-dev",
    schemaVersion: "0.1.0",
    updaterPublicKeyConfigured: false,
  };
}

function audioElementSupported(): boolean {
  return typeof window !== "undefined" && "HTMLAudioElement" in globalThis;
}

function buildTrackLyricFallback(track: Track) {
  return ensureLyricFallbackPayload({
    provider: track.provider,
    trackId: track.id,
    lines: [],
    hasTranslation: false,
    isWordByWord: false,
  }, track);
}

function readPlaybackQualityPreference(): PlaybackQuality {
  if (typeof localStorage === "undefined") return "hires";
  const raw = localStorage.getItem(PLAYBACK_QUALITY_STORE_KEY);
  if (
    raw === "jymaster" ||
    raw === "hires" ||
    raw === "lossless" ||
    raw === "exhigh" ||
    raw === "standard"
  )
    return raw;
  return "hires";
}

function savePlaybackQualityPreference(quality: PlaybackQuality): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PLAYBACK_QUALITY_STORE_KEY, quality);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export interface DesktopLyricsPayloadContext {
  title?: string;
  artist?: string;
  playing?: boolean;
  progressSpan?: number;
  positionMs?: number;
  durationMs?: number | null;
  playbackRate?: number;
  highBloom?: number;
  beatGlow?: number;
  beatPulse?: number;
  bass?: number;
  hasNativeKaraoke?: boolean;
  beatMapKey?: string;
  beatMap?: JsonValue | null;
}

interface CurrentBeatMapState {
  key: string;
  map: JsonValue;
}

interface TrialBannerState {
  text: string;
  provider: ProviderId;
  showLogin: boolean;
}

const DESKTOP_LYRIC_FONT_STACKS: Record<string, string> = {
  sans: 'Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",Arial,sans-serif',
  hei: '"Noto Sans SC","Microsoft YaHei",SimHei,"PingFang SC",sans-serif',
  song: '"Noto Serif SC","Source Han Serif SC",SimSun,"Songti SC",serif',
  "bold-song":
    '"Source Han Serif SC Heavy","Source Han Serif SC","Noto Serif SC Black","Noto Serif SC","STZhongsong","SimSun",serif',
  "stone-song":
    '"FZYaSongS-B-GB","FZCuSong-B09S","Source Han Serif SC Heavy","Noto Serif SC Black","STZhongsong","SimSun",serif',
  "kai-song":
    '"Kaiti SC","STKaiti","KaiTi","Source Han Serif SC","Noto Serif SC",serif',
  "serif-en": 'Georgia,"Times New Roman","Noto Serif SC","Source Han Serif SC",serif',
  gothic:
    '"UnifrakturCook","UnifrakturMaguntia","Old English Text MT","Blackletter","Cinzel Decorative","Noto Serif SC",serif',
  editorial:
    '"Didot","Bodoni 72","Libre Baskerville",Georgia,"Noto Serif SC",serif',
  humanist:
    '"Avenir Next","Segoe UI","Inter","Noto Sans SC","PingFang SC",sans-serif',
  round:
    '"HarmonyOS Sans SC","Microsoft YaHei UI","PingFang SC","Noto Sans SC",sans-serif',
  mono: '"JetBrains Mono",Consolas,"Noto Sans SC","Microsoft YaHei",monospace',
  display: '"Alibaba PuHuiTi","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
};

function normalizeDesktopLyricFontKey(key: unknown): string {
  const value = String(key || "sans").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DESKTOP_LYRIC_FONT_STACKS, value)
    ? value
    : "sans";
}

function desktopLyricFontStackForKey(key: unknown): string {
  return DESKTOP_LYRIC_FONT_STACKS[normalizeDesktopLyricFontKey(key)];
}

function desktopLyricFontWeightValue(fx: FxState): number {
  if (normalizeDesktopLyricFontKey(fx.lyricFont) === "stone-song") return 900;
  return Math.round(
    clampNumber(Number(fx.lyricWeight) || 900, 500, 900) / 50,
  ) * 50;
}

function desktopOverlayColorValue(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  if (/^#[0-9a-f]{3}$/i.test(raw) || /^#[0-9a-f]{6}$/i.test(raw)) {
    return raw;
  }
  if (/^rgba?\(/i.test(raw) || /^hsla?\(/i.test(raw)) return raw;
  return fallback;
}

function trackTitle(track: Track | null | undefined): string {
  return track?.title || "Mineradio";
}

function trackArtist(track: Track | null | undefined): string {
  return track?.artists?.join(" / ") || track?.album || "";
}

function trackLikeKey(track: Track | null | undefined): string {
  return track?.provider && track.id ? `${track.provider}:${track.id}` : "";
}

function isNeteaseLikeSupported(track: Track | null | undefined): track is Track {
  if (!track?.id) return false;
  const record = track as unknown as Record<string, unknown>;
  if (record.type === "local" || record.source === "local") return false;
  if (record.type === "podcast" || record.source === "podcast") return false;
  return track.provider === "netease";
}

function likeUnsupportedMessage(track: Track | null | undefined): string {
  const record = track as unknown as Record<string, unknown> | null | undefined;
  if (
    track?.provider === "qq" ||
    record?.provider === "qq" ||
    record?.source === "qq" ||
    record?.type === "qq"
  ) {
    return "QQ 音乐红心同步待登录接口接入";
  }
  return "本地文件暂不支持红心同步";
}

function isLoginRequiredError(error: unknown): boolean {
  return (
    error instanceof SidecarClientError ||
    (typeof error === "object" && error !== null && "code" in error)
  ) && (error as { code?: unknown }).code === "LOGIN_REQUIRED";
}

function trialBannerText(result: SongUrlResult): string {
  if (result.message?.trim()) return result.message.trim();
  if (result.loggedIn && result.vipLevel === "svip")
    return "此歌曲需要单曲、专辑购买或更高权限";
  if (result.loggedIn && result.vipLevel === "vip")
    return "此歌曲需要 SVIP 或购买 · 当前仅播放试听片段";
  if (result.loggedIn) return "此歌曲需 VIP · 当前仅播放试听片段";
  return "当前未登录 · 仅播放试听片段";
}

function toJsonValue(value: unknown): JsonValue | null {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

function isPodcastTrack(track: Track | null | undefined): boolean {
  const record = track as unknown as Record<string, unknown> | null | undefined;
  return record?.type === "podcast" || record?.source === "podcast";
}

function beatMapArrayLength(map: Record<string, JsonValue>, key: string): number {
  const value = map[key];
  return Array.isArray(value) ? value.length : 0;
}

function beatMapNumber(map: Record<string, JsonValue>, key: string): number {
  const value = map[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function beatMapString(map: Record<string, JsonValue>, key: string, fallback: string): string {
  const value = map[key];
  return typeof value === "string" && value ? value : fallback;
}

export function desktopLyricsBeatMapKey(map: JsonValue | null, source = "mr"): string {
  if (!map || typeof map !== "object" || Array.isArray(map)) return "none";
  const record = map as Record<string, JsonValue>;
  const cameraCount =
    beatMapArrayLength(record, "cameraBeats") ||
    beatMapArrayLength(record, "beats") ||
    beatMapArrayLength(record, "kicks");
  const pulseCount =
    beatMapArrayLength(record, "pulseBeats") ||
    beatMapArrayLength(record, "kicks");
  const duration = beatMapNumber(record, "duration");
  const partialUntil = beatMapNumber(record, "partialUntilSec");
  return [
    source,
    beatMapNumber(record, "analyzedAt"),
    cameraCount,
    pulseCount,
    Math.round(duration * 10),
    Math.round(partialUntil * 10),
    beatMapString(record, "tempoSource", "local"),
  ].join("|");
}

function desktopLyricsBeatMapContext(
  state: CurrentBeatMapState | null,
  force: boolean,
  lastKeyRef: { current: string },
): Pick<DesktopLyricsPayloadContext, "beatMapKey" | "beatMap"> {
  const key = state?.key ?? "none";
  const shouldSendMap = force || key !== lastKeyRef.current;
  lastKeyRef.current = key;
  return {
    beatMapKey: key,
    ...(shouldSendMap ? { beatMap: state?.map ?? null } : {}),
  };
}

export function buildDesktopLyricsPayloadPatch(
  fx: FxState,
  text: string,
  progress: number,
  context: DesktopLyricsPayloadContext = {},
) {
  const size = clampNumber(fx.desktopLyricsSize, 0.72, 1.55);
  const yRatio = clampNumber(fx.desktopLyricsY, 0.08, 0.92);
  const durationSeconds = Math.max(0, Number(context.durationMs ?? 0) / 1000);
  const timeSeconds = Math.max(0, Number(context.positionMs ?? 0) / 1000);
  const fps =
    fx.desktopLyricsFps === 24 ||
    fx.desktopLyricsFps === 30 ||
    fx.desktopLyricsFps === 60 ||
    fx.desktopLyricsFps === 120
      ? fx.desktopLyricsFps
      : 60;
  return {
    enabled: true,
    text,
    progress: clampNumber(progress, 0, 1),
    progressSpan: clampNumber(Number(context.progressSpan ?? 4.8), 0, 60),
    title: context.title || "Mineradio",
    artist: context.artist || "",
    playing: context.playing === true,
    size,
    y: yRatio,
    frameRate: fps,
    opacity: clampNumber(fx.desktopLyricsOpacity, 0.28, 1),
    position: { x: 80, y: Math.round(yRatio * 1000) },
    clickThrough: fx.desktopLyricsClickThrough,
    lyricGlowParticles: fx.lyricGlowParticles,
    cinema: fx.desktopLyricsCinema !== false,
    highlightFollow: fx.desktopLyricsHighlight === true,
    fontFamily: desktopLyricFontStackForKey(fx.lyricFont),
    fontWeight: desktopLyricFontWeightValue(fx),
    letterSpacing: clampNumber(Number(fx.lyricLetterSpacing) || 0, -0.04, 0.18),
    lineHeight: clampNumber(Number(fx.lyricLineHeight) || 1, 0.86, 1.35),
    lyricScale: clampNumber(Number(fx.lyricScale) || 1, 0.35, 1.65),
    feather: context.hasNativeKaraoke ? 0.03 : 0.055,
    beatMapKey: context.beatMapKey || "",
    ...(Object.prototype.hasOwnProperty.call(context, "beatMap")
      ? { beatMap: context.beatMap ?? null }
      : {}),
    colors: {
      primary: desktopOverlayColorValue(fx.lyricColor, "#d6f8ff"),
      secondary: desktopOverlayColorValue(fx.visualTintColor, "#9cffdf"),
      background: "rgba(0, 0, 0, 0.22)",
      highlight: desktopOverlayColorValue(fx.lyricHighlightColor, "#fff0b8"),
      glow: desktopOverlayColorValue(fx.lyricGlowColor, "#9cffdf"),
    },
    font: {
      family: desktopLyricFontStackForKey(fx.lyricFont),
      weight: desktopLyricFontWeightValue(fx),
      fit: {
        minPx: Math.round(18 * size),
        maxPx: Math.round(64 * size),
        stepPx: 1,
        maxLines: 1,
      },
    },
    motion: {
      fps,
      reduceMotion: false,
      smoothingMs: 120,
      lyricGlow: fx.lyricGlow,
      lyricGlowBeat: fx.lyricGlowBeat,
      lyricGlowStrength: fx.lyricGlow
        ? clampNumber(Number(fx.lyricGlowStrength) || 0, 0, 0.85)
        : 0,
      highBloom: clampNumber(Number(context.highBloom ?? 0), 0, 1.45),
      beatGlow: clampNumber(Number(context.beatGlow ?? 0), 0, 1.7),
      beatPulse: clampNumber(Number(context.beatPulse ?? 0), 0, 1.4),
      bass: clampNumber(Number(context.bass ?? 0), 0, 1.2),
    },
    playback: {
      time: timeSeconds,
      duration: durationSeconds,
      rate: clampNumber(Number(context.playbackRate ?? 1), 0.25, 4),
    },
  };
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
      "input",
      "textarea",
      "#search-area",
      "#top-right",
      "#bottom-bar",
      "#bottom-handle",
      ".modal",
      "#login-modal",
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
}

export function shouldShowEmptyHome(input: EmptyHomeStateInput): boolean {
  if (input.splashActive) return false;
  if (input.homeForcedOpen) return true;
  if (input.homeSuppressed) return false;
  if (input.immersiveActive) return false;
  if (input.shelfDetailOpen) return false;
  if (input.shelfPinnedOpen) return false;
  if (input.hasCurrentTrack) return false;
  if (input.queueLength > 0) return false;
  if (input.isPlaying) return false;
  return true;
}

export function deriveSidecarRecoveryNoticeState(
  status: SidecarStatus,
  previous: SidecarRecoveryNoticeState | null,
): SidecarRecoveryNoticeState {
  const recovered =
    status.phase === "ready" &&
    !!previous &&
    (previous.phase === "recovering" ||
      previous.phase === "stopped" ||
      previous.phase === "error" ||
      status.restarts > previous.restarts);
  return {
    phase: status.phase,
    restarts: status.restarts,
    lastError: status.lastError,
    recovered,
  };
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

export function shouldUseSecondaryLeftDisplaySeamGuard(
  state: WindowState | null,
): boolean {
  return state?.isPrimaryDisplay === false && state.hasDisplayOnLeft;
}

export type AppProps = {
  SplashComponent?: (props: SplashHostProps) => ReactElement | null;
  VisualComponent?: typeof VisualEngineHost;
  createSidecarClient?: (cfg: RuntimeConfig) => SidecarClient;
  initialRuntimeConfig?: RuntimeConfig | null;
};

export function App({
  SplashComponent = SplashHost,
  VisualComponent = VisualEngineHost,
  createSidecarClient = (cfg) => new SidecarClient(cfg.sidecarBaseUrl),
  initialRuntimeConfig = null,
}: AppProps = {}): ReactElement {
  const [sidecarClient, setSidecarClient] = useState<SidecarClient | null>(
    null,
  );
  const [currentBeatMapState, setCurrentBeatMapState] =
    useState<CurrentBeatMapState | null>(null);
  const [trialBanner, setTrialBanner] = useState<TrialBannerState | null>(null);
  const [sidecarBaseUrl, setSidecarBaseUrl] = useState("");
  const [splashActive, setSplashActive] = useState<boolean>(SHOW_SPLASH);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [neteaseStatus, setNeteaseStatus] =
    useState<ProviderLoginStatus | null>(null);
  const [qqStatus, setQqStatus] = useState<ProviderLoginStatus | null>(null);
  const [shelfPlaylists, setShelfPlaylists] = useState<PlaylistSummary[]>([]);
  const [shelfPodcastCollections, setShelfPodcastCollections] = useState<
    PodcastCollection[]
  >([]);
  const [homeForcedOpen, setHomeForcedOpen] = useState(false);
  const [homeSuppressed, setHomeSuppressed] = useState(false);
  const [sidecarRecoveryState, setSidecarRecoveryState] =
    useState<SidecarRecoveryNoticeState | null>(null);
  const [playbackQuality, setPlaybackQualityState] = useState<PlaybackQuality>(
    readPlaybackQualityPreference,
  );
  const [playbackQualityReloadSeq, setPlaybackQualityReloadSeq] = useState(0);
  const [customLyricModalOpen, setCustomLyricModalOpen] = useState(false);
  const [customLyricText, setCustomLyricText] = useState("");
  const [customLyricStatus, setCustomLyricStatus] = useState<{
    text: string;
    tone?: "good" | "fail";
  }>({ text: "" });
  const [customLyricVersion, setCustomLyricVersion] = useState(0);
  const [desktopLyricsEnabled, setDesktopLyricsEnabled] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [collectTarget, setCollectTarget] = useState<Track | null>(null);
  const [collectBusyPlaylistId, setCollectBusyPlaylistId] = useState<
    string | null
  >(null);
  const [likedSongMap, setLikedSongMap] = useState<Record<string, boolean>>({});
  const [likeBusyMap, setLikeBusyMap] = useState<Record<string, boolean>>({});
  const [desktopWindowState, setDesktopWindowState] =
    useState<WindowState | null>(null);

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
  const setShelfMode = useShelfStore((s) => s.setMode);
  const setShelfCameraMode = useShelfStore((s) => s.setCameraMode);
  const setShelfPresence = useShelfStore((s) => s.setPresence);
  const setShelfShowPodcasts = useShelfStore((s) => s.setShowPodcasts);
  const setShelfMergeCollections = useShelfStore((s) => s.setMergeCollections);
  const applyShelfSettings = useShelfStore((s) => s.applySettings);
  const visualFx = useVisualStore((s) => s.fx);
  const visualPreset = useVisualStore((s) => s.preset);
  const visualIntensity = useVisualStore((s) => s.intensity);
  const setVisualPreset = useVisualStore((s) => s.setPreset);
  const setVisualNumberSetting = useVisualStore((s) => s.setNumberSetting);
  const setVisualBooleanSetting = useVisualStore((s) => s.setBooleanSetting);
  const setVisualStringSetting = useVisualStore((s) => s.setStringSetting);
  const consoleVisible = useUiStore((s) => s.consoleVisible);
  const setConsole = useUiStore((s) => s.setConsole);
  const miniQueueOpen = useUiStore((s) => s.miniQueueOpen);
  const setMiniQueue = useUiStore((s) => s.setMiniQueue);
  const toggleMiniQueue = useUiStore((s) => s.toggleMiniQueue);
  const toast = useUiStore((s) => s.toast);
  const showToast = useUiStore((s) => s.showToast);
  const clearToast = useUiStore((s) => s.clearToast);
  const [aiDepthChip, setAiDepthChip] = useState({
    visible: false,
    text: "AI 深度估计…",
  });
  const updateState = useUpdateStore();
  const applyUpdateCheckResult = useUpdateStore((s) => s.applyCheckResult);
  const setUpdateStatus = useUpdateStore((s) => s.setStatus);

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
  const setSearchKeyword = useSearchStore((s) => s.setKeyword);
  const setSearchError = useSearchStore((s) => s.setError);

  const cancelledRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const controllerRef = useRef<PlayerController | null>(null);
  const lastLoadedKeyRef = useRef<string>("");
  const playbackRequestSeqRef = useRef(0);
  const neteaseCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const qqCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const customLyricInputRef = useRef<HTMLTextAreaElement | null>(null);
  const shelfContentListRef = useRef<ShelfDetailContentListController | null>(
    null,
  );
  const desktopLyricsPushStateRef = useRef(createDesktopLyricsPushState());
  const desktopLyricsBeatMapKeyRef = useRef("none");
  const desktopLyricsMotionRef = useRef<DesktopLyricsMotionSnapshot>({
    highBloom: 0,
    beatGlow: 0,
    beatPulse: 0,
    bass: 0,
  });
  const likedSongMapRef = useRef(likedSongMap);
  likedSongMapRef.current = likedSongMap;
  const likeBusyMapRef = useRef(likeBusyMap);
  likeBusyMapRef.current = likeBusyMap;
  const likeStatusRequestSeqRef = useRef(0);

  const positionRef = useRef(positionMs);
  positionRef.current = positionMs;
  const lyricsPayloadRef = useRef(lyricsPayload);
  lyricsPayloadRef.current = lyricsPayload;
  const originalLyricsPayloadRef = useRef(lyricsPayload);

  const initSidecar = useCallback(
    (cfg: RuntimeConfig) => {
      const client = createSidecarClient(cfg);
      setSidecarClient(client);
      setSidecarBaseUrl(cfg.sidecarBaseUrl);
      return client;
    },
    [createSidecarClient],
  );

  const emptyHomeCoreAllowed = shouldShowEmptyHome({
    splashActive: false,
    homeForcedOpen: false,
    homeSuppressed: false,
    hasCurrentTrack: !!currentTrack,
    queueLength: queue.length,
    isPlaying,
  });
  const emptyHomeActive = shouldShowEmptyHome({
    splashActive,
    homeForcedOpen,
    homeSuppressed,
    hasCurrentTrack: !!currentTrack,
    queueLength: queue.length,
    isPlaying,
  });
  const homeControlsLocked =
    emptyHomeActive &&
    homeForcedOpen &&
    !consoleVisible &&
    emptyHomeCoreAllowed;
  const currentLyricPreference = getCustomLyricPreferenceForTrack(currentTrack);
  const currentCustomLyricText = getCustomLyricTextForTrack(currentTrack);
  const currentLikeKey = trackLikeKey(currentTrack);
  const currentLiked = currentLikeKey ? likedSongMap[currentLikeKey] === true : false;
  const currentLikeBusy = currentLikeKey ? likeBusyMap[currentLikeKey] === true : false;
  void customLyricVersion;

  const revealConsole = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(false);
    setConsole(true);
  }, [setConsole]);

  const focusSearch = useCallback(() => {
    if (typeof document === "undefined") return;
    const input = document.getElementById("search-input");
    if (input instanceof HTMLInputElement) input.focus();
  }, []);

  const searchQuery = useCallback(
    (query: string) => {
      setHomeSuppressed(false);
      setSearchKeyword(query);
      focusSearch();
    },
    [focusSearch, setSearchKeyword],
  );

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

  const applyOriginalLyrics = useCallback(() => {
    const track = usePlaybackStore.getState().currentTrack;
    if (track) setCustomLyricPreferenceForTrack(track, "original");
    const original = originalLyricsPayloadRef.current;
    if (original) setLyricsPayload(original);
    setCustomLyricVersion((version) => version + 1);
    showToast("已切换到原歌词");
  }, [setLyricsPayload, showToast]);

  const applyCustomLyrics = useCallback(
    (track = usePlaybackStore.getState().currentTrack) => {
      const currentPayload = useLyricsStore.getState().payload;
      const text = getCustomLyricTextForTrack(track);
      if (!track || !currentPayload || !text?.trim()) return false;
      const resolved = resolveLyricsForTrack({
        track,
        original: currentPayload,
        durationMs: usePlaybackStore.getState().durationMs ?? track.durationMs,
      });
      if (resolved.source !== "custom") return false;
      setLyricsPayload(resolved.payload);
      setCustomLyricVersion((version) => version + 1);
      return true;
    },
    [setLyricsPayload],
  );

  const openCustomLyricModal = useCallback(() => {
    const track = usePlaybackStore.getState().currentTrack;
    if (!track) {
      showToast("先播放或选择一首歌");
      return;
    }
    const text = getCustomLyricTextForTrack(track) ?? "";
    setCustomLyricText(text);
    setCustomLyricStatus({
      text: text
        ? "已读取本地自定义歌词"
        : "提示：带 [00:12.00] 时间轴会更精准；纯文本会自动铺开",
      tone: text ? "good" : undefined,
    });
    setCustomLyricModalOpen(true);
  }, [showToast]);

  const chooseCustomLyrics = useCallback(() => {
    const track = usePlaybackStore.getState().currentTrack;
    if (!track) {
      showToast("先播放或选择一首歌");
      return;
    }
    setCustomLyricPreferenceForTrack(track, "custom");
    setCustomLyricVersion((version) => version + 1);
    if (!applyCustomLyrics(track)) openCustomLyricModal();
    else {
      showToast("已切换到自定义歌词");
      openCustomLyricModal();
    }
  }, [applyCustomLyrics, openCustomLyricModal, showToast]);

  const saveCustomLyric = useCallback(() => {
    const track = usePlaybackStore.getState().currentTrack;
    const text = (customLyricInputRef.current?.value ?? customLyricText).trim();
    if (!track) {
      setCustomLyricStatus({ text: "请先播放或选择一首歌", tone: "fail" });
      showToast("先播放或选择一首歌");
      return;
    }
    if (!text) {
      setCustomLyricStatus({ text: "请输入歌词内容", tone: "fail" });
      return;
    }
    const result = saveCustomLyricForTrack(track, text);
    if (result.lines.length === 0) {
      setCustomLyricStatus({ text: "没有识别到可显示的歌词行", tone: "fail" });
      return;
    }
    applyCustomLyrics(track);
    setCustomLyricText(text);
    setCustomLyricStatus({
      text: result.saved
        ? `已保存 ${result.lines.length} 行，并切换为自定义歌词`
        : "已应用，但本地存储空间不足",
      tone: result.saved ? "good" : "fail",
    });
    showToast(result.saved ? "自定义歌词已保存" : "自定义歌词已应用");
    setCustomLyricModalOpen(false);
  }, [applyCustomLyrics, customLyricText, showToast]);

  const deleteCustomLyric = useCallback(() => {
    const track = usePlaybackStore.getState().currentTrack;
    if (!track) {
      setCustomLyricStatus({ text: "请先播放或选择一首歌", tone: "fail" });
      return;
    }
    if (!deleteCustomLyricForTrack(track)) {
      setCustomLyricStatus({ text: "当前歌曲没有自定义歌词", tone: "fail" });
      return;
    }
    setCustomLyricText("");
    setCustomLyricStatus({ text: "已删除，恢复原歌词", tone: "good" });
    setCustomLyricVersion((version) => version + 1);
    showToast("已恢复原歌词");
  }, [showToast]);

  const enterPlaybackSurface = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(true);
    setConsole(true);
    setMiniQueue(false);
  }, [setConsole, setMiniQueue]);

  const goHome = useCallback(() => {
    if (homeForcedOpen || emptyHomeActive) {
      setHomeForcedOpen(false);
      setHomeSuppressed(true);
      setConsole(false);
      setMiniQueue(false);
      showToast("已关闭 Home");
      return;
    }
    setHomeSuppressed(false);
    setHomeForcedOpen(true);
    setConsole(false);
    setMiniQueue(false);
    focusSearch();
    showToast("已回到 Home");
  }, [
    emptyHomeActive,
    focusSearch,
    homeForcedOpen,
    setConsole,
    setMiniQueue,
    showToast,
  ]);

  const importLocalJson = useCallback(async () => {
    try {
      const result = await importJsonFile();
      if (result.cancelled) {
        showToast("本地导入需要在 Tauri 窗口中选择文件");
        return;
      }
      showToast(result.path ? `已读取 ${result.path}` : "已读取导入文件");
    } catch (e) {
      const message = e instanceof Error ? e.message : "本地导入失败";
      showToast(message);
    }
  }, [showToast]);

  const refreshUpdateStatus = useCallback(
    async (manual = false) => {
      try {
        if (manual) setUpdateStatus("checking");
        const result = manual
          ? await checkForUpdate()
          : await getUpdaterStatus();
        applyUpdateCheckResult(result);
        if (manual) {
          if (result.error) showToast(result.message || result.error);
          else if (result.available)
            showToast(
              result.signatureGate
                ? "发现新版本，签名密钥未配置"
                : `发现新版本 v${result.version ?? ""}`,
            );
          else showToast("当前已是最新版本");
        }
      } catch (e) {
        setUpdateStatus("error");
        showToast(e instanceof Error ? e.message : "更新检测失败");
      }
    },
    [applyUpdateCheckResult, setUpdateStatus, showToast],
  );

  const setProviderStatus = useCallback((status: ProviderLoginStatus) => {
    if (status.provider === "netease") setNeteaseStatus(status);
    else setQqStatus(status);
  }, []);

  const providerLabel = useCallback(
    (provider: ProviderId) => (provider === "netease" ? "网易云" : "QQ 音乐"),
    [],
  );

  const writableCollectPlaylists = collectTarget
    ? shelfPlaylists.filter(
        (playlist) =>
          playlist.provider === collectTarget.provider &&
          playlist.subscribed !== true,
      )
    : [];

  const refreshShelfPlaylists = useCallback(
    async (client: SidecarClient | null) => {
      if (!client) {
        setShelfPlaylists([]);
        setShelfPodcastCollections([]);
        return;
      }
      const podcastMy = (client as { podcastMy?: SidecarClient["podcastMy"] })
        .podcastMy;
      const results = await Promise.allSettled([
        client.playlistList("netease"),
        client.playlistList("qq"),
        typeof podcastMy === "function"
          ? podcastMy.call(client)
          : Promise.resolve(null),
      ]);
      setShelfPlaylists(
        results
          .slice(0, 2)
          .flatMap((result) =>
            result.status === "fulfilled"
              ? (result.value as PlaylistSummary[])
              : [],
          ),
      );
      const podcastResult = results[2];
      setShelfPodcastCollections(
        podcastResult?.status === "fulfilled" && podcastResult.value?.loggedIn
          ? podcastResult.value.collections
          : [],
      );
    },
    [],
  );

  const refreshProviderStatus = useCallback(
    async (provider: ProviderId) => {
      const client = sidecarClient;
      if (!client) {
        showToast("sidecar 未连接，稍后再试");
        return;
      }
      try {
        const status = await client.loginStatus(provider);
        setProviderStatus(status);
        void refreshShelfPlaylists(client);
        const label = providerLabel(provider);
        showToast(
          status.loggedIn
            ? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}`
            : `${label}未登录`,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : "登录状态读取失败";
        showToast(message);
      }
    },
    [
      providerLabel,
      refreshShelfPlaylists,
      setProviderStatus,
      showToast,
      sidecarClient,
    ],
  );

  const openLoginModal = useCallback(() => {
    setLoginModalOpen(true);
    void refreshProviderStatus("netease");
    void refreshProviderStatus("qq");
  }, [refreshProviderStatus]);

  const openHomeLibrary = useCallback(() => {
    if (neteaseStatus?.loggedIn || qqStatus?.loggedIn) {
      searchQuery("我的歌单");
      showToast("正在用账号歌单关键词打开搜索入口");
      return;
    }
    openLoginModal();
    showToast("登录后同步歌单库");
  }, [
    neteaseStatus?.loggedIn,
    openLoginModal,
    qqStatus?.loggedIn,
    searchQuery,
    showToast,
  ]);

  const startWeatherRadio = useCallback(async () => {
    const client = sidecarClient;
    if (!client) {
      searchQuery("雨天 R&B");
      showToast("天气队列暂时为空，先打开搜索");
      return;
    }
    showToast("正在生成天气电台");
    try {
      const result = await client.weatherRadio({
        city: "上海",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "auto",
      });
      const songs = result.radio.songs;
      if (!songs.length) {
        searchQuery(result.radio.seedQueries[0] || "雨天 R&B");
        showToast("天气队列暂时为空，先打开搜索");
        return;
      }
      usePlaybackStore.getState().setQueue(songs);
      usePlaybackStore.getState().playAt(0);
      enterPlaybackSurface();
      showToast(`${result.radio.title || "天气电台"} · ${songs.length} 首`);
    } catch {
      searchQuery("雨天 R&B");
      showToast("天气队列暂时为空，先打开搜索");
    }
  }, [enterPlaybackSurface, searchQuery, showToast, sidecarClient]);

  const openCollectPicker = useCallback(
    (track: Track) => {
      if (track.provider !== "netease" && track.provider !== "qq") {
        showToast("当前来源暂不支持收藏到歌单");
        return;
      }
      if (!sidecarClient) {
        showToast("sidecar 未连接，稍后再试");
        return;
      }
      setCollectTarget(track);
      setCollectBusyPlaylistId(null);
      void refreshShelfPlaylists(sidecarClient);
    },
    [refreshShelfPlaylists, showToast, sidecarClient],
  );

  const openCollectPickerForCurrent = useCallback(() => {
    const track = usePlaybackStore.getState().currentTrack;
    if (!track) {
      showToast("先播放或选择一首歌");
      return;
    }
    openCollectPicker(track);
  }, [openCollectPicker, showToast]);

  const closeCollectPicker = useCallback(() => {
    if (collectBusyPlaylistId) return;
    setCollectTarget(null);
  }, [collectBusyPlaylistId]);

  const addCollectTargetToPlaylist = useCallback(
    async (playlistId: string) => {
      const client = sidecarClient;
      const track = collectTarget;
      if (!client || !track || !playlistId || collectBusyPlaylistId) return;
      setCollectBusyPlaylistId(playlistId);
      showToast("正在收藏到歌单...");
      try {
        await client.addSongToPlaylist(track.provider, playlistId, track.id);
        showToast("已收藏到歌单");
        setCollectTarget(null);
        void refreshShelfPlaylists(client);
      } catch (e) {
        const message =
          e instanceof SidecarClientError && e.code === "LOGIN_REQUIRED"
            ? `登录后可同步到${track.provider === "qq" ? "QQ 音乐" : "网易云"}`
            : e instanceof Error
              ? e.message
              : "收藏失败";
        showToast(message);
      } finally {
        setCollectBusyPlaylistId(null);
      }
    },
    [
      collectBusyPlaylistId,
      collectTarget,
      refreshShelfPlaylists,
      showToast,
      sidecarClient,
    ],
  );

  const toggleLikeTrack = useCallback(async (track: Track | null | undefined) => {
    if (!isNeteaseLikeSupported(track)) {
      showToast(likeUnsupportedMessage(track));
      return;
    }
    const client = sidecarClient;
    const key = trackLikeKey(track);
    if (!client || !key || likeBusyMapRef.current[key]) {
      if (!client) showToast("红心操作失败");
      return;
    }

    const previous = likedSongMapRef.current[key] === true;
    const next = !previous;
    setLikeBusyMap((map) => ({ ...map, [key]: true }));
    setLikedSongMap((map) => ({ ...map, [key]: next }));
    try {
      const ack = await client.likeSong(track.provider, track.id, next);
      setLikedSongMap((map) => ({
        ...map,
        [key]: ack.liked === true,
      }));
      showToast(next ? "已加入红心喜欢" : "已取消红心");
    } catch (e) {
      setLikedSongMap((map) => ({ ...map, [key]: previous }));
      if (isLoginRequiredError(e)) {
        showToast("登录后可同步到网易云");
        setLoginModalOpen(true);
      } else {
        showToast("红心操作失败");
      }
    } finally {
      setLikeBusyMap((map) => {
        const nextMap = { ...map };
        delete nextMap[key];
        return nextMap;
      });
    }
  }, [showToast, sidecarClient]);

  const toggleLikeCurrent = useCallback(async () => {
    await toggleLikeTrack(usePlaybackStore.getState().currentTrack);
  }, [toggleLikeTrack]);

  const closeLoginModal = useCallback(() => {
    setLoginModalOpen(false);
    if (neteaseCookieInputRef.current) neteaseCookieInputRef.current.value = "";
    if (qqCookieInputRef.current) qqCookieInputRef.current.value = "";
  }, []);

  const importProviderCookie = useCallback(
    async (provider: ProviderId) => {
      const client = sidecarClient;
      const input =
        provider === "netease"
          ? neteaseCookieInputRef.current
          : qqCookieInputRef.current;
      const cookie = input?.value.trim() ?? "";
      const label = providerLabel(provider);
      if (!client) {
        showToast("sidecar 未连接，稍后再试");
        return;
      }
      if (!cookie) {
        showToast(`请粘贴${label} cookie`);
        return;
      }
      try {
        await client.setProviderSessionCookie(provider, cookie);
        if (input) input.value = "";
        const status = await client.loginStatus(provider);
        setProviderStatus(status);
        void refreshShelfPlaylists(client);
        showToast(
          status.loggedIn
            ? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}`
            : `${label}会话已保存，但账号态未确认`,
        );
      } catch (e) {
        if (input) input.value = "";
        const message = e instanceof Error ? e.message : "手动导入失败";
        showToast(message);
      }
    },
    [
      providerLabel,
      refreshShelfPlaylists,
      setProviderStatus,
      showToast,
      sidecarClient,
    ],
  );

  const openProviderWebLogin = useCallback(
    async (provider: ProviderId) => {
      const client = sidecarClient;
      const label = providerLabel(provider);
      if (!client) {
        showToast("sidecar 未连接，稍后再试");
        return;
      }
      try {
        const result = await openProviderLoginWindow(provider);
        if (!result.stored) {
          showToast(`${label}登录未完成`);
          return;
        }
        const status = await client.loginStatus(provider);
        setProviderStatus(status);
        void refreshShelfPlaylists(client);
        const suffix =
          provider === "qq" && result.partial
            ? "，播放授权不完整，部分歌曲会自动换源"
            : "";
        showToast(
          status.loggedIn
            ? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}${suffix}`
            : `${label}会话已保存，但账号态未确认`,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : `${label}登录失败`;
        showToast(message);
      }
    },
    [
      providerLabel,
      refreshShelfPlaylists,
      setProviderStatus,
      showToast,
      sidecarClient,
    ],
  );

  const logoutProvider = useCallback(
    async (provider: ProviderId) => {
      const client = sidecarClient;
      const label = providerLabel(provider);
      if (!client) {
        showToast("sidecar 未连接，稍后再试");
        return;
      }
      try {
        await client.logout(provider);
        setProviderStatus({ provider, loggedIn: false });
        void refreshShelfPlaylists(client);
        showToast(`${label}会话已清除`);
      } catch (e) {
        const message = e instanceof Error ? e.message : "退出登录失败";
        showToast(message);
      }
    },
    [
      providerLabel,
      refreshShelfPlaylists,
      setProviderStatus,
      showToast,
      sidecarClient,
    ],
  );

  const togglePlayback = useCallback(() => {
    if (!usePlaybackStore.getState().currentTrack) {
      showToast("先搜索或打开歌单选择一首歌");
      return;
    }
    const controller = controllerRef.current;
    if (!controller) {
      togglePlay();
      return;
    }
    if (usePlaybackStore.getState().isPlaying) controller.pause();
    else void controller.play();
  }, [showToast, togglePlay]);

  const playMiniQueueIndex = useCallback(
    (index: number) => {
      playQueueAt(index);
      setMiniQueue(false);
    },
    [playQueueAt, setMiniQueue],
  );

  const insertMiniQueueNext = useCallback(
    (index: number) => {
      const track = usePlaybackStore.getState().queue[index];
      if (!track) return;
      insertQueueNext(track);
      showToast(`已设为下一首: ${track.title}`);
    },
    [insertQueueNext, showToast],
  );

  const seekPlayback = useCallback(
    (position: number) => {
      controllerRef.current?.seek(position);
      setPositionMs(position);
    },
    [setPositionMs],
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

  const updateVisualPreset = useCallback(
    (preset: number) => {
      setVisualPreset(preset);
      saveVisualFxToStorage();
    },
    [setVisualPreset],
  );

  const updateVisualNumberSetting = useCallback(
    (key: keyof typeof visualFx, value: number) => {
      setVisualNumberSetting(key, value);
      saveVisualFxToStorage();
    },
    [setVisualNumberSetting],
  );

  const updateVisualBooleanSetting = useCallback(
    (key: keyof typeof visualFx, value: boolean) => {
      setVisualBooleanSetting(key, value);
      if (key === "shelfShowPodcasts") setShelfShowPodcasts(value);
      if (key === "shelfMergeCollections") setShelfMergeCollections(value);
      saveVisualFxToStorage();
      if (key === "shelfShowPodcasts" || key === "shelfMergeCollections")
        saveShelfSettingsToStorage();
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

  const setPlaybackQuality = useCallback(
    (quality: PlaybackQuality) => {
      setPlaybackQualityState(quality);
      savePlaybackQualityPreference(quality);
      if (!usePlaybackStore.getState().currentTrack) {
        showToast("音质偏好已保存，下次播放生效");
        return;
      }
      const resumeAt = controllerRef.current
        ? usePlaybackStore.getState().positionMs
        : 0;
      if (resumeAt > 0) controllerRef.current?.pause();
      lastLoadedKeyRef.current = "";
      playbackRequestSeqRef.current += 1;
      setPositionMs(resumeAt);
      setPlaybackQualityReloadSeq((seq) => seq + 1);
      showToast("正在切换音质");
    },
    [setPositionMs, showToast],
  );

  const currentDesktopLyricSnapshot = useCallback(() => {
    const payload = useLyricsStore.getState().payload;
    const playback = usePlaybackStore.getState();
    const fallback = playback.currentTrack
      ? `${trackTitle(playback.currentTrack)} - ${trackArtist(playback.currentTrack)}`
      : "";
    return buildDesktopLyricSnapshot(payload, playback.positionMs, fallback);
  }, []);

  const toggleDesktopLyrics = useCallback(async () => {
    if (desktopLyricsEnabled) {
      await closeDesktopLyricsWindow();
      setDesktopLyricsEnabled(false);
      return;
    }
    const playback = usePlaybackStore.getState();
    const duration = playback.durationMs ?? 0;
    const snapshot = currentDesktopLyricSnapshot();
    const motion = desktopLyricsMotionRef.current;
    const beatMapContext = desktopLyricsBeatMapContext(
      currentBeatMapState,
      true,
      desktopLyricsBeatMapKeyRef,
    );
    const payload = buildDesktopLyricsPayloadPatch(
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
        ...beatMapContext,
      },
    );
    if (
      shouldPushDesktopLyricsPayload(
        desktopLyricsPushStateRef.current,
        payload,
        performance.now(),
        true,
      )
    ) {
      await updateDesktopLyricsPayload(payload);
    }
    await showDesktopLyricsWindow();
    setDesktopLyricsEnabled(true);
  }, [currentBeatMapState, currentDesktopLyricSnapshot, desktopLyricsEnabled]);

  const executeGlobalHotkeyAction = useCallback(
    (action: string) => {
      switch (action) {
        case "togglePlay":
          togglePlayback();
          break;
        case "prevTrack":
          previousTrack();
          break;
        case "nextTrack":
          nextTrack();
          break;
        case "volumeUp":
          setVolume(usePlaybackStore.getState().volume + 0.05);
          break;
        case "volumeDown":
          setVolume(usePlaybackStore.getState().volume - 0.05);
          break;
        case "toggleFullscreen":
          void toggleWindowFullscreen();
          break;
        case "toggleDesktopLyrics":
          void toggleDesktopLyrics();
          break;
        default:
          break;
      }
    },
    [nextTrack, previousTrack, setVolume, toggleDesktopLyrics, togglePlayback],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void configureGlobalHotkeys(DEFAULT_GLOBAL_HOTKEYS);
    void listenGlobalHotkey((payload) => {
      if (!disposed && payload?.action)
        executeGlobalHotkeyAction(payload.action);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
      void configureGlobalHotkeys([]);
    };
  }, [executeGlobalHotkeyAction]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getWindowState().then((state) => {
      if (!disposed) {
        setDesktopWindowState(state);
        applyDesktopWindowShellState(state);
      }
    });
    void listenWindowState((state) => {
      if (!disposed) {
        setDesktopWindowState(state);
        applyDesktopWindowShellState(state);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
      if (typeof document !== "undefined") {
        document.documentElement.classList.remove("desktop-shell-root");
        document.body.classList.remove(
          "desktop-shell",
          "desktop-maximized",
          "desktop-fullscreen",
        );
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("splash-active", splashActive);
    document.body.classList.toggle("empty-home-active", emptyHomeActive);
    document.body.classList.toggle("controls-visible", consoleVisible);
    document.body.classList.toggle("home-wallpaper-preview", emptyHomeActive);
    document.body.classList.toggle("home-controls-locked", homeControlsLocked);
    return () => {
      document.body.classList.remove(
        "splash-active",
        "empty-home-active",
        "controls-visible",
        "home-wallpaper-preview",
        "home-controls-locked",
      );
    };
  }, [consoleVisible, emptyHomeActive, homeControlsLocked, splashActive]);

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
    void refreshUpdateStatus(false);
  }, [refreshUpdateStatus]);

  useEffect(() => {
    if (!desktopLyricsEnabled) return;
    const snapshot = currentDesktopLyricSnapshot();
    const motion = desktopLyricsMotionRef.current;
    const beatMapContext = desktopLyricsBeatMapContext(
      currentBeatMapState,
      false,
      desktopLyricsBeatMapKeyRef,
    );
    const payload = buildDesktopLyricsPayloadPatch(
      visualFx,
      snapshot.text,
      snapshot.progress,
      {
        title: trackTitle(currentTrack),
        artist: trackArtist(currentTrack),
        playing: isPlaying,
        progressSpan: snapshot.progressSpan,
        positionMs,
        durationMs,
        playbackRate: audioRef.current?.playbackRate,
        highBloom: motion.highBloom,
        beatGlow: motion.beatGlow,
        beatPulse: motion.beatPulse,
        bass: motion.bass,
        ...beatMapContext,
      },
    );
    if (
      !shouldPushDesktopLyricsPayload(
        desktopLyricsPushStateRef.current,
        payload,
        performance.now(),
        false,
      )
    ) {
      return;
    }
    void updateDesktopLyricsPayload(payload);
  }, [
    currentDesktopLyricSnapshot,
    desktopLyricsEnabled,
    durationMs,
    currentTrack,
    isPlaying,
    lyricsPayload,
    positionMs,
    currentBeatMapState,
    visualFx,
  ]);

  useEffect(() => {
    if (!sidecarBaseUrl) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let clearRecoveredTimer: ReturnType<typeof setTimeout> | null = null;

    async function pollStatus(): Promise<void> {
      try {
        const status = await getSidecarStatus();
        if (cancelled) return;
        setSidecarRecoveryState((previous) => {
          const next = deriveSidecarRecoveryNoticeState(status, previous);
          if (next.recovered) {
            if (clearRecoveredTimer) clearTimeout(clearRecoveredTimer);
            clearRecoveredTimer = setTimeout(() => {
              setSidecarRecoveryState((current) =>
                current?.recovered ? { ...current, recovered: false } : current,
              );
            }, SIDECAR_RECOVERED_NOTICE_MS);
          }
          return next;
        });
      } finally {
        if (!cancelled) {
          pollTimer = setTimeout(() => {
            void pollStatus();
          }, SIDECAR_STATUS_POLL_MS);
        }
      }
    }

    void pollStatus();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (clearRecoveredTimer) clearTimeout(clearRecoveredTimer);
    };
  }, [sidecarBaseUrl]);

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

  useEffect(() => {
    controllerRef.current?.setVolume(muted ? 0 : volume);
  }, [muted, volume]);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function boot(): Promise<void> {
      let cfg: RuntimeConfig;
      if (initialRuntimeConfig) cfg = initialRuntimeConfig;
      else {
        try {
          cfg = await getRuntimeConfig();
        } catch {
          cfg = placeholderRuntimeConfig();
        }
      }
      if (cancelledRef.current) return;

      if (!cfg.sidecarBaseUrl) {
        console.warn("sidecar base url not configured", {
          code: "NO_RUNTIME",
          message: "sidecar base url not configured",
        });
        return;
      }

      const client = initSidecar(cfg);
      let attempts = 0;

      async function poll(): Promise<void> {
        try {
          await client.health();
          if (cancelledRef.current) return;
          try {
            const caps = await client.capabilities();
            if (!cancelledRef.current) setMatrix(caps);
          } catch {
            // 能力矩阵仅用于运行期同步，失败不阻断视觉宿主。
          }
          if (!cancelledRef.current) void refreshShelfPlaylists(client);
        } catch (e) {
          if (cancelledRef.current) return;
          attempts += 1;
          if (e instanceof SidecarClientError) {
            console.warn("sidecar health failed", {
              code: e.code,
              message: e.message,
            });
          } else {
            console.warn("sidecar health failed", {
              code: "UNKNOWN",
              message: "unknown error",
            });
          }
          if (attempts < 5) {
            timer = setTimeout(() => {
              void poll();
            }, 800);
          }
        }
      }

      void poll();
    }

    void boot();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [initSidecar, initialRuntimeConfig, refreshShelfPlaylists, setMatrix]);

  useEffect(() => {
    if (!audioElementSupported()) return;
    if (controllerRef.current) return;
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;
    const controller = new PlayerController(audio);
    const playback = usePlaybackStore.getState();
    controller.setVolume(playback.muted ? 0 : playback.volume);
    controllerRef.current = controller;

    let lastDuration: number | null = null;

    controller.on("timeupdate", (payload) => {
      setPositionMs(payload.positionMs);
      if (payload.durationMs !== null && payload.durationMs !== lastDuration) {
        lastDuration = payload.durationMs;
        setDurationMs(payload.durationMs);
      }
      const idx = selectCurrentIndex(
        payload.positionMs,
        lyricsPayloadRef.current,
      );
      setLyricsIndex(idx);
    });
    controller.on("durationchange", (payload) => {
      if (payload.durationMs !== null) {
        setDurationMs(payload.durationMs);
      }
    });
    controller.on("play", () => {
      setPlaying(true);
    });
    controller.on("pause", () => {
      setPlaying(false);
    });
    controller.on("ended", () => {
      setPositionMs(0);
      usePlaybackStore.getState().ended();
      if (
        usePlaybackStore.getState().mode === "single" &&
        controllerRef.current
      ) {
        controllerRef.current.seek(0);
        void controllerRef.current.play();
      }
    });
    controller.on("error", (payload) => {
      const message = payload.message || "音频播放失败";
      setTrialBanner(null);
      setSearchError(message);
      showToast(message);
      console.warn("audio playback failed", {
        code: `AUDIO_${payload.code}`,
        message,
      });
    });
    return () => {
      controllerRef.current = null;
      audioRef.current = null;
    };
  }, [
    setDurationMs,
    setLyricsIndex,
    setPlaying,
    setPositionMs,
    setSearchError,
    showToast,
  ]);

  useEffect(() => {
    const track = currentTrack;
    const client = sidecarClient;
    if (!client || !isNeteaseLikeSupported(track)) return;
    const checkSongLikes = (client as { checkSongLikes?: SidecarClient["checkSongLikes"] }).checkSongLikes;
    if (typeof checkSongLikes !== "function") return;
    const key = trackLikeKey(track);
    if (!key) return;
    const token = ++likeStatusRequestSeqRef.current;
    void checkSongLikes.call(client, track.provider, [track.id]).then((ack) => {
      if (token !== likeStatusRequestSeqRef.current) return;
      setLikedSongMap((map) => ({
        ...map,
        [key]: ack.liked[track.id] === true,
      }));
    }).catch(() => {
      // 红心状态只影响按钮高亮，失败不能阻断播放 UI。
    });
  }, [currentTrack, sidecarClient]);

  useEffect(() => {
    const controller = controllerRef.current;
    const client = sidecarClient;
    if (!controller || !client) return;
    if (!currentTrack) {
      lastLoadedKeyRef.current = "";
      playbackRequestSeqRef.current += 1;
      setCurrentBeatMapState(null);
      setTrialBanner(null);
      controller.pause();
      lyricsReset();
      return;
    }
    const key = `${currentTrack.provider}:${currentTrack.id}`;
    if (key === lastLoadedKeyRef.current) return;
    lastLoadedKeyRef.current = key;
    const seq = playbackRequestSeqRef.current + 1;
    playbackRequestSeqRef.current = seq;
    setCurrentBeatMapState(null);
    setTrialBanner(null);
    const fallbackLyric = buildTrackLyricFallback(currentTrack);
    originalLyricsPayloadRef.current = fallbackLyric;
    const resolvedFallbackLyric = resolveLyricsForTrack({
      track: currentTrack,
      original: fallbackLyric,
      durationMs:
        usePlaybackStore.getState().durationMs ?? currentTrack.durationMs,
    });
    setLyricsPayload(resolvedFallbackLyric.payload);

    void (async () => {
      try {
        const result = await client.resolveSongUrl(
          currentTrack,
          playbackQuality,
        );
        if (playbackRequestSeqRef.current !== seq) return;
        if (!result.url) {
          throw new Error(result.message || "播放地址不可用");
        }
        const audioUrl = result.proxied
          ? result.url
          : client.audioProxyUrl(result.url);
        if (result.trial) {
          setTrialBanner({
            text: trialBannerText(result),
            provider: currentTrack.provider,
            showLogin: !result.loggedIn,
          });
        } else {
          setTrialBanner(null);
        }
        controller.load(audioUrl);
        const beatmapResolver = client.podcastDjBeatmap?.bind(client);
        if (beatmapResolver && isPodcastTrack(currentTrack)) {
          void beatmapResolver(
            result.url,
            Math.max(
              0,
              Number(
                currentTrack.durationMs ??
                  usePlaybackStore.getState().durationMs ??
                  0,
              ) / 1000,
            ),
            0,
          ).then((beatmap) => {
            if (playbackRequestSeqRef.current !== seq) return;
            const map = toJsonValue(beatmap.map);
            setCurrentBeatMapState(map ? {
              key: desktopLyricsBeatMapKey(map, "dj"),
              map,
            } : null);
          }).catch(() => {
            if (playbackRequestSeqRef.current === seq) {
              setCurrentBeatMapState(null);
            }
          });
        }
        if (positionRef.current > 0) controller.seek(positionRef.current);
        await controller.play();
        if (playbackRequestSeqRef.current !== seq) return;
        setHomeForcedOpen(false);
        setHomeSuppressed(true);
      } catch (e) {
        if (playbackRequestSeqRef.current !== seq) return;
        const code = e instanceof SidecarClientError ? e.code : "AUDIO_UNKNOWN";
        const message = e instanceof Error ? e.message : "playback error";
        setTrialBanner(null);
        setPlaying(false);
        setSearchError(message);
        showToast(message);
        console.warn("playback load failed", { code, message });
      }
      try {
        setLyricsLoading(true);
        const lyric = ensureLyricFallbackPayload(await client.lyric(currentTrack), currentTrack);
        if (playbackRequestSeqRef.current !== seq) return;
        originalLyricsPayloadRef.current = lyric;
        const resolvedLyric = resolveLyricsForTrack({
          track: currentTrack,
          original: lyric,
          durationMs:
            usePlaybackStore.getState().durationMs ?? currentTrack.durationMs,
        });
        setLyricsPayload(resolvedLyric.payload);
      } catch (e) {
        if (playbackRequestSeqRef.current !== seq) return;
        const message = e instanceof Error ? e.message : "lyrics failed";
        const fallbackLyric = buildTrackLyricFallback(currentTrack);
        originalLyricsPayloadRef.current = fallbackLyric;
        const resolvedLyric = resolveLyricsForTrack({
          track: currentTrack,
          original: fallbackLyric,
          durationMs:
            usePlaybackStore.getState().durationMs ?? currentTrack.durationMs,
        });
        setLyricsPayload(resolvedLyric.payload);
        setLyricsError(message);
      }
    })();
  }, [
    currentTrack,
    playbackQuality,
    playbackQualityReloadSeq,
    sidecarClient,
    setLyricsError,
    setLyricsLoading,
    setLyricsPayload,
    setPlaying,
    setSearchError,
    showToast,
    lyricsReset,
  ]);

  return (
    <>
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
        onShelfDetailRowClick={(payload) => {
          if (payload.action === "collect") {
            const track = mapShelfDetailRowToTrack(payload.row);
            if (track) openCollectPicker(track);
            return;
          }
          void handleShelfDetailRowAction({
            ...payload,
            client: sidecarClient,
            isLiked: () => false,
            onResult: (message) => showToast(message),
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
        desktopLyricsMotionRef={desktopLyricsMotionRef}
      />
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
      />
      <EmptyHomeHost
        onSearchFocus={focusSearch}
        onOpenLibrary={openHomeLibrary}
        onOpenConsole={revealConsole}
        onSearchQuery={searchQuery}
        onUpload={() => void importLocalJson()}
        onGuide={() => {
          revealConsole();
          showToast("视觉引导已打开播放器控制台，播放后会进入粒子与歌词舞台");
        }}
        onStartWeatherRadio={() => void startWeatherRadio()}
      />
      <SearchShell
        client={sidecarClient}
        onFocus={focusSearch}
        onUpload={() => void importLocalJson()}
        onResultPlay={enterPlaybackSurface}
        onResultLike={(track) => void toggleLikeTrack(track)}
        onResultCollect={openCollectPicker}
        isResultLiked={(track) => {
          const key = trackLikeKey(track);
          return key ? likedSongMap[key] === true : false;
        }}
        isResultLikeBusy={(track) => {
          const key = trackLikeKey(track);
          return key ? likeBusyMap[key] === true : false;
        }}
      />
      <TopRightControls
        onHome={goHome}
        onLogin={openLoginModal}
        onHideCapsule={() =>
          showUnavailable("账号胶囊自动隐藏已记录，登录完成后生效")
        }
        loggedIn={!!neteaseStatus?.loggedIn || !!qqStatus?.loggedIn}
        accountLabel={
          neteaseStatus?.nickname ??
          qqStatus?.nickname ??
          neteaseStatus?.userId ??
          qqStatus?.userId ??
          undefined
        }
        updateSlot={
          <div id="update-shell">
            <UpdateHost
              state={updateState}
              open={updateModalOpen}
              onOpen={() => setUpdateModalOpen(true)}
              onClose={() => setUpdateModalOpen(false)}
              onCheck={() => void refreshUpdateStatus(true)}
            />
          </div>
        }
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
        onPlayQueueIndex={playMiniQueueIndex}
        onRemoveQueueIndex={removeQueueAt}
        onInsertQueueNext={insertMiniQueueNext}
        onMinimize={() => void minimizeWindow()}
        onToggleMaximize={() => void toggleWindowMaximize()}
        onToggleFullscreen={() => void toggleWindowFullscreen()}
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
            className="modal dual-login-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-modal-title"
          >
            <h2 id="login-modal-title">音乐账号</h2>
            <div id="login-modal-desc" className="desc">
              手动导入 cookie 只会发送到本机 sidecar
              运行时会话，不会写入前端状态、仓库或 diagnostics。
            </div>
            <div className="manual-cookie-grid">
              <div className="manual-cookie-panel">
                <div className="manual-cookie-title">网易云</div>
                <textarea
                  ref={neteaseCookieInputRef}
                  id="netease-cookie-input"
                  className="manual-cookie-input"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="MUSIC_U=...; __csrf=..."
                />
                <div className="account-status-line">
                  {neteaseStatus?.loggedIn
                    ? `已登录 ${neteaseStatus.nickname ?? neteaseStatus.userId ?? ""}`
                    : "未确认登录"}
                </div>
                <div className="account-mini-actions">
                  <button
                    className="modal-btn primary"
                    type="button"
                    onClick={() => void openProviderWebLogin("netease")}
                  >
                    网页登录
                  </button>
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={() => void refreshProviderStatus("netease")}
                  >
                    刷新
                  </button>
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={() => void logoutProvider("netease")}
                  >
                    退出
                  </button>
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={() => void importProviderCookie("netease")}
                  >
                    导入
                  </button>
                </div>
              </div>
              <div className="manual-cookie-panel">
                <div className="manual-cookie-title">QQ 音乐</div>
                <textarea
                  ref={qqCookieInputRef}
                  id="qq-cookie-input"
                  className="manual-cookie-input"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="uin=...; qm_keyst=...; qqmusic_key=..."
                />
                <div className="account-status-line">
                  {qqStatus?.loggedIn
                    ? `已登录 ${qqStatus.nickname ?? qqStatus.userId ?? ""}`
                    : "未确认登录"}
                </div>
                <div className="account-mini-actions">
                  <button
                    className="modal-btn primary"
                    type="button"
                    onClick={() => void openProviderWebLogin("qq")}
                  >
                    扫码登录
                  </button>
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={() => void refreshProviderStatus("qq")}
                  >
                    刷新
                  </button>
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={() => void logoutProvider("qq")}
                  >
                    退出
                  </button>
                  <button
                    className="modal-btn"
                    type="button"
                    onClick={() => void importProviderCookie("qq")}
                  >
                    导入
                  </button>
                </div>
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
            </div>
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
          onClick={() => setTrialBanner(null)}
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
    </>
  );
}

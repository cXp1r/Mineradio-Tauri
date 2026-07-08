import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { SidecarClient, SidecarClientError } from "../api/sidecar-client";
import {
  LOCAL_AUDIO_ACCEPT,
  createLocalAudioTrack,
  firstLocalAudioFile,
  firstLocalCoverFile,
  readLocalFileAsDataUrl,
} from "../audio/local-audio-import";
import { PlayerController, type ErrorPayload } from "../audio/player-controller";
import {
  clearCustomCoverForTrack,
  customCoverKeyForTrack,
  hasCustomCoverForTrack,
  saveCustomCoverForTrack,
  withStoredCustomCover,
} from "../cover/custom-cover";
import {
  deleteCustomLyricForTrack,
  getCustomLyricPreferenceForTrack,
  getCustomLyricTextForTrack,
  resolveLyricsForTrack,
  saveCustomLyricForTrack,
  setCustomLyricPreferenceForTrack,
} from "../lyrics/custom-lyrics";
import {
  importedPlaylistFromResult,
  readImportedPlaylistsFromStorage,
  saveImportedPlaylistsToStorage,
  upsertImportedPlaylist,
} from "../shared-playlist/imported-playlists";
import { isImportOnlyTrack } from "../shared-playlist/import-only-track";
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
  listenWindowState,
  listenGlobalHotkey,
  closeWindow,
  minimizeWindow,
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
import { checkForUpdate, getUpdaterStatus, installUpdate, shouldOpenDevUpdatePreview } from "../tauri/updater";
import { BottomControlsHost } from "../components/shell/BottomControlsHost";
import { GuideParticlesHost } from "../components/shell/GuideParticlesHost";
import { PlaylistPanelHost, type PlaylistPanelTab } from "../components/shell/PlaylistPanelHost";
import { SearchShell, type SearchMode } from "../components/shell/SearchShell";
import {
  createDesktopLyricsPushState,
  shouldPushDesktopLyricsPayload,
} from "../desktop-lyrics/desktop-lyrics-push";
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
import { EmptyHomeHost, type HomeListenRecord, type HomeListenSummary, type HomePlaylistDetailView } from "../home/EmptyHomeHost";
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
  mapPodcastItemsToShelfRows,
  mapShelfDetailRowToTrack,
  type ShelfDetailContentListController,
} from "../visual/shelf-detail-data";
import type { ShelfPlayPlaylistPayload } from "../visual/shelf-pointer-interactions";
import { isPlayable } from "../components/search/play-search-result";
import {
  ensureLyricFallbackPayload,
  ProviderIdSchema,
  type DiscoverHomeResponse,
  type PlaybackQualityRequest,
  type PlaylistDetail,
  type PlaylistSummary,
  type PodcastCollection,
  type PodcastMyResponse,
  type ProviderId,
  type ProviderLoginStatus,
  type ProviderVipIcon,
  type SongUrlResult,
  type Track,
  type TrackQualityOption,
  type WeatherRadioResponse,
} from "@mineradio/shared";
import type { FxState, LyricPalette } from "@mineradio/visual-engine";

const SHOW_SPLASH = import.meta.env.VITE_SPLASH !== "0";
const SIDECAR_STATUS_POLL_MS = 1500;
const SIDECAR_STATUS_READY_MAX_POLL_MS = 12000;
const SIDECAR_STATUS_HIDDEN_MAX_POLL_MS = 60000;
const SIDECAR_RECOVERED_NOTICE_MS = 2600;
const PLAYBACK_QUALITY_STORE_KEY = "mineradio-playback-quality-v1";
const LONG_PAUSE_PLAYBACK_URL_REFRESH_MS = 10 * 60 * 1000;
const PLAYBACK_URL_MAX_AGE_MS = 20 * 60 * 1000;
const HOME_LISTEN_STATS_STORE_KEY = "mineradio-listen-stats-v1";
const USER_CAPSULE_AUTO_HIDE_STORE_KEY = "mineradio-user-capsule-auto-hide-v1";
const PLAYLIST_PANEL_PIN_STORE_KEY = "mineradio-playlist-panel-pinned-v1";
const DIY_MODE_STORE_KEY = "mineradio-diy-player-mode-v1";
const DEFAULT_GLOBAL_HOTKEYS: GlobalHotkeyBinding[] = [
  { action: "togglePlay", accelerator: "Control+Alt+Space" },
  { action: "prevTrack", accelerator: "Control+Alt+ArrowLeft" },
  { action: "nextTrack", accelerator: "Control+Alt+ArrowRight" },
  { action: "volumeUp", accelerator: "Control+Alt+ArrowUp" },
  { action: "volumeDown", accelerator: "Control+Alt+ArrowDown" },
  { action: "toggleFullscreen", accelerator: "Control+Alt+KeyF" },
  { action: "toggleDesktopLyrics", accelerator: "Control+Alt+KeyL" },
];

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

export function mergeProviderPlaylists(
  current: PlaylistSummary[],
  provider: ProviderId,
  next: PlaylistSummary[],
): PlaylistSummary[] {
  const merged = current.filter((playlist) => playlist.provider !== provider);
  const seen = new Set(merged.map((playlist) => `${playlist.provider}:${playlist.id}`));
  for (const playlist of next) {
    if (playlist.provider !== provider) continue;
    const key = `${playlist.provider}:${playlist.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(playlist);
  }
  return merged;
}

export function shouldUseCachedHomeDiscoverPlaylist(
  discover: DiscoverHomeResponse | null | undefined,
  hasProviderLogin: boolean,
): boolean {
  return !!discover?.loggedIn || (!hasProviderLogin && (discover?.playlists.length ?? 0) > 0);
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

function playbackKeyForTrack(track: Track | null | undefined): string {
  return track ? `${track.provider}:${track.id}` : "";
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
  stageLyricPalette?: LyricPalette;
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

type PlaybackReloadReason = "long-pause" | "url-age" | "media-error";

interface LoadedPlaybackUrlState {
  trackKey: string;
  quality: PlaybackQualityRequest;
  resolvedAtMs: number;
  audioUrl: string;
  rawUrl: string;
  local: boolean;
  trial: boolean;
}

interface PlaybackReloadOptions {
  preservePosition: boolean;
  reason: PlaybackReloadReason;
}

interface LoginQrState {
  key: string;
  img: string;
  completed: boolean;
}

type LoginQrTone = "idle" | "scan" | "fail" | "success" | "preview";

interface LoginQrStatusState {
  text: string;
  tone: LoginQrTone;
}

type LoginModalMode = "full" | "add-account" | "single-provider";

const LOGIN_PROVIDERS = ["netease", "qq", "soda"] as const satisfies readonly ProviderId[];

const INITIAL_NETEASE_QR_STATUS: LoginQrStatusState = {
  text: "正在生成二维码...",
  tone: "idle",
};

const INITIAL_QQ_QR_STATUS: LoginQrStatusState = {
  text: "正在生成二维码...",
  tone: "idle",
};

const INITIAL_SODA_QR_STATUS: LoginQrStatusState = {
  text: "正在生成二维码...",
  tone: "idle",
};

function initialQrStatusForProvider(provider: ProviderId): LoginQrStatusState {
  if (provider === "qq") return INITIAL_QQ_QR_STATUS;
  if (provider === "soda") return INITIAL_SODA_QR_STATUS;
  return INITIAL_NETEASE_QR_STATUS;
}

function providerLabelText(provider: ProviderId): string {
  if (provider === "netease") return "网易云";
  if (provider === "qq") return "QQ 音乐";
  return "汽水音乐";
}

function qrInstructionForProvider(provider: ProviderId): string {
  if (provider === "qq") return "使用 QQ 音乐 App 扫码，然后在手机上确认登录";
  if (provider === "soda") return "使用汽水音乐 App 扫码，然后在手机上确认登录";
  return "使用网易云音乐 App 扫码，然后在手机上确认登录";
}

function qrScannedTextForProvider(provider: ProviderId): string {
  if (provider === "qq") return "已扫码，请在 QQ 音乐 App 上确认登录";
  if (provider === "soda") return "已扫码，请在汽水音乐 App 上确认登录";
  return "已扫码，请在手机上确认登录";
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

interface HomeListenHistoryRecord extends HomeListenRecord {
  lastPlayedAt: number;
  listenMs: number;
  completed: number;
}

interface HomeListenSession {
  key: string;
  track: Track;
  startedAt: number;
  lastWallAt: number;
  lastPositionMs: number;
  listenMs: number;
  maxProgress: number;
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
  return track?.title || "MineRadio-Tauri";
}

function trackArtist(track: Track | null | undefined): string {
  return track?.artists?.join(" / ") || track?.album || "";
}

function trackLikeKey(track: Track | null | undefined): string {
  const id = track?.sourceId || track?.id || "";
  return track?.provider && id ? `${track.provider}:${id}` : "";
}

function trackProviderLikeId(track: Track | null | undefined): string {
  return String(track?.sourceId || track?.id || "").trim();
}

function updateHomeListenHistory(
  history: HomeListenHistoryRecord[],
  track: Track | null,
  now: number,
  listenMs = 0,
  completed = false,
): HomeListenHistoryRecord[] {
  if (!track?.id || !track.title) return history;
  const key = trackLikeKey(track) || `${track.provider}:${track.sourceId || track.title}`;
  const existing = history.find((record) => {
    const recordKey = trackLikeKey(record.track) || `${record.track.provider}:${record.track.sourceId || record.track.title}`;
    return recordKey === key;
  });
  const nextRecord: HomeListenHistoryRecord = {
    track,
    plays: (existing?.plays ?? 0) + 1,
    lastPlayedAt: now,
    listenMs: (existing?.listenMs ?? 0) + Math.round(listenMs),
    completed: (existing?.completed ?? 0) + (completed ? 1 : 0),
  };
  return [nextRecord, ...history.filter((record) => record !== existing)].slice(0, 24);
}

function readHomeListenHistory(): HomeListenHistoryRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_LISTEN_STATS_STORE_KEY) || "{}") as { history?: unknown };
    const rawHistory = Array.isArray(parsed.history) ? parsed.history : [];
    return rawHistory.slice(0, 24).flatMap((item): HomeListenHistoryRecord[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const track = record.track as Track | undefined;
      if (!track?.id || !track.title) return [];
      return [{
        track,
        plays: Math.max(1, Number(record.plays) || 1),
        lastPlayedAt: Math.max(0, Number(record.lastPlayedAt) || 0),
        listenMs: Math.max(0, Number(record.listenMs) || 0),
        completed: Math.max(0, Number(record.completed) || 0),
      }];
    });
  } catch {
    return [];
  }
}

function writeHomeListenHistory(history: HomeListenHistoryRecord[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(HOME_LISTEN_STATS_STORE_KEY, JSON.stringify({
      history: history.slice(0, 24),
      updatedAt: Date.now(),
    }));
  } catch {
  }
}

function beginHomeListenSession(track: Track | null, now: number, positionMs = 0): HomeListenSession | null {
  const key = trackLikeKey(track);
  if (!track || !key) return null;
  return {
    key,
    track,
    startedAt: now,
    lastWallAt: now,
    lastPositionMs: positionMs,
    listenMs: 0,
    maxProgress: 0,
  };
}

function updateHomeListenSession(
  session: HomeListenSession | null,
  positionMs: number,
  durationMs: number | null,
  now: number,
  force = false,
): HomeListenSession | null {
  if (!session) return null;
  const deltaByAudio = Math.max(0, positionMs - session.lastPositionMs);
  const deltaByWall = Math.max(0, now - session.lastWallAt);
  let delta = deltaByAudio > 0 ? Math.min(deltaByAudio, deltaByWall || deltaByAudio, 4200) : 0;
  if (force && delta <= 0) delta = Math.min(deltaByWall, 1500);
  return {
    ...session,
    listenMs: delta > 0 && delta < 8000 ? session.listenMs + delta : session.listenMs,
    lastWallAt: now,
    lastPositionMs: positionMs,
    maxProgress: durationMs && durationMs > 0
      ? Math.max(session.maxProgress, positionMs / durationMs)
      : session.maxProgress,
  };
}

function isEffectiveHomeListenSession(
  session: HomeListenSession,
  completed: boolean,
  durationMs: number | null,
): boolean {
  return completed || session.listenMs >= 45000 || session.maxProgress >= 0.5 || (!durationMs && session.listenMs >= 30000);
}

function buildHomeListenSummary(history: HomeListenHistoryRecord[]): HomeListenSummary | null {
  if (!history.length) return null;
  const recent = [...history].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)[0] ?? null;
  const topSong = [...history].sort((a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt)[0] ?? null;
  const artistCounts = new Map<string, { plays: number; coverUrl?: string; lastPlayedAt: number }>();
  for (const record of history) {
    for (const artist of record.track.artists ?? []) {
      if (!artist) continue;
      const current = artistCounts.get(artist) ?? { plays: 0, coverUrl: record.track.coverUrl, lastPlayedAt: 0 };
      current.plays += record.plays;
      if (!current.coverUrl) current.coverUrl = record.track.coverUrl;
      current.lastPlayedAt = Math.max(current.lastPlayedAt, record.lastPlayedAt);
      artistCounts.set(artist, current);
    }
  }
  const topArtistEntry = [...artistCounts.entries()]
    .sort((a, b) => b[1].plays - a[1].plays || b[1].lastPlayedAt - a[1].lastPlayedAt)[0];
  const totalPlays = history.reduce((sum, record) => sum + record.plays, 0);
  return {
    recent,
    topSong,
    topArtist: topArtistEntry
      ? { name: topArtistEntry[0], plays: topArtistEntry[1].plays, coverUrl: topArtistEntry[1].coverUrl }
      : null,
    totalPlays,
  };
}

function isProviderLikeSupported(track: Track | null | undefined): track is Track {
  if (!track || !trackProviderLikeId(track)) return false;
  const record = track as unknown as Record<string, unknown>;
  if (isImportOnlyTrack(track)) return false;
  if (track.id.startsWith("local:")) return false;
  if (record.type === "local" || record.source === "local") return false;
  if (record.type === "podcast" || record.source === "podcast") return false;
  return track.provider === "netease" || track.provider === "soda";
}

export function isNeteaseLikeSupported(track: Track | null | undefined): track is Track {
  return isProviderLikeSupported(track) && track.provider === "netease";
}

export function isCollectSupportedTrack(track: Track | null | undefined): track is Track {
  if (!track?.id) return false;
  const record = track as unknown as Record<string, unknown>;
  if (isImportOnlyTrack(track)) return false;
  if (track.id.startsWith("local:")) return false;
  if (record.type === "local" || record.source === "local") return false;
  if (record.type === "podcast" || record.source === "podcast") return false;
  return track.provider === "netease" || track.provider === "qq";
}

function likeUnsupportedMessage(track: Track | null | undefined): string {
  const record = track as unknown as Record<string, unknown> | null | undefined;
  if (isImportOnlyTrack(track)) {
    return "导入曲目暂不支持红心同步";
  }
  if (
    track?.provider === "qq" ||
    record?.provider === "qq" ||
    record?.source === "qq" ||
    record?.type === "qq"
  ) {
    return "QQ 音乐红心同步待登录接口接入";
  }
  if (track?.provider === "soda") return "汽水音乐红心同步暂不可用";
  return "本地文件暂不支持红心同步";
}

function collectUnsupportedMessage(track: Track | null | undefined): string {
  if (isImportOnlyTrack(track)) {
    return "导入曲目暂不支持收藏到歌单";
  }
  return "当前来源暂不支持收藏到歌单";
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
    title: context.title || "MineRadio-Tauri",
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
      primary: desktopOverlayColorValue(context.stageLyricPalette?.primary ?? fx.lyricColor, "#d6f8ff"),
      secondary: desktopOverlayColorValue(context.stageLyricPalette?.secondary ?? fx.visualTintColor, "#9cffdf"),
      background: "rgba(0, 0, 0, 0.22)",
      highlight: desktopOverlayColorValue(context.stageLyricPalette?.highlight ?? fx.lyricHighlightColor, "#fff0b8"),
      glow: desktopOverlayColorValue(context.stageLyricPalette?.glowColor ?? fx.lyricGlowColor, "#9cffdf"),
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

export function nextSidecarStatusPollDelayMs(input: {
  status: SidecarStatus;
  consecutiveReadyPolls: number;
  documentHidden?: boolean;
}): number {
  if (input.status.phase !== "ready") return SIDECAR_STATUS_POLL_MS;
  const readySteps = Math.max(0, Math.min(3, Math.floor(input.consecutiveReadyPolls)));
  const foregroundDelay = Math.min(
    SIDECAR_STATUS_READY_MAX_POLL_MS,
    SIDECAR_STATUS_POLL_MS * 2 ** readySteps,
  );
  if (!input.documentHidden) return foregroundDelay;
  if (readySteps >= 3) return SIDECAR_STATUS_HIDDEN_MAX_POLL_MS;
  return Math.min(SIDECAR_STATUS_HIDDEN_MAX_POLL_MS, foregroundDelay * 2);
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
  initialRuntimeConfig?: RuntimeConfig | null;
  desktopLyricsRuntime?: DesktopLyricsRuntime;
};

export type DesktopLyricsRuntime = {
  showWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  updatePayload: (payload: JsonValue) => Promise<void>;
};

const defaultDesktopLyricsRuntime: DesktopLyricsRuntime = {
  showWindow: showDesktopLyricsWindow,
  closeWindow: closeDesktopLyricsWindow,
  updatePayload: updateDesktopLyricsPayload,
};

function createDefaultSidecarClient(cfg: RuntimeConfig): SidecarClient {
  return new SidecarClient(cfg.sidecarBaseUrl);
}

export function App({
  SplashComponent = SplashHost,
  VisualComponent = VisualEngineHost,
  createSidecarClient = createDefaultSidecarClient,
  initialRuntimeConfig = null,
  desktopLyricsRuntime = defaultDesktopLyricsRuntime,
}: AppProps = {}): ReactElement {
  const [sidecarClient, setSidecarClient] = useState<SidecarClient | null>(
    null,
  );
  const [currentBeatMapState, setCurrentBeatMapState] =
    useState<CurrentBeatMapState | null>(null);
  const [trialBanner, setTrialBanner] = useState<TrialBannerState | null>(null);
  const [sidecarBaseUrl, setSidecarBaseUrl] = useState("");
  const [splashActive, setSplashActive] = useState<boolean>(SHOW_SPLASH);
  const [searchModeRequest, setSearchModeRequest] = useState<SearchMode>("song");
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginModalMode, setLoginModalMode] = useState<LoginModalMode>("full");
  const [loginProvider, setLoginProvider] = useState<ProviderId>("netease");
  const [neteaseQr, setNeteaseQr] = useState<LoginQrState | null>(null);
  const [neteaseQrStatus, setNeteaseQrStatus] = useState<LoginQrStatusState>(
    INITIAL_NETEASE_QR_STATUS,
  );
  const [qqQr, setQqQr] = useState<LoginQrState | null>(null);
  const [qqQrStatus, setQqQrStatus] = useState<LoginQrStatusState>(
    INITIAL_QQ_QR_STATUS,
  );
  const [sodaQr, setSodaQr] = useState<LoginQrState | null>(null);
  const [sodaQrStatus, setSodaQrStatus] = useState<LoginQrStatusState>(
    INITIAL_SODA_QR_STATUS,
  );
  const [qqManualCookieOpen, setQqManualCookieOpen] = useState(false);
  const [neteaseStatus, setNeteaseStatus] =
    useState<ProviderLoginStatus | null>(null);
  const [qqStatus, setQqStatus] = useState<ProviderLoginStatus | null>(null);
  const [sodaStatus, setSodaStatus] = useState<ProviderLoginStatus | null>(null);
  const [shelfPlaylists, setShelfPlaylists] = useState<PlaylistSummary[]>([]);
  const [importedPlaylists, setImportedPlaylists] = useState(
    readImportedPlaylistsFromStorage,
  );
  const [shelfPodcastCollections, setShelfPodcastCollections] = useState<
    PodcastCollection[]
  >([]);
  const [homeForcedOpen, setHomeForcedOpen] = useState(false);
  const [homeSuppressed, setHomeSuppressed] = useState(false);
  const [diyMode, setDiyMode] = useState(() =>
    readBooleanPreference(DIY_MODE_STORE_KEY, false),
  );
  const [playlistPanelOpen, setPlaylistPanelOpen] = useState(false);
  const [playlistPanelTab, setPlaylistPanelTab] = useState<PlaylistPanelTab>("queue");
  const [playlistPanelPinned, setPlaylistPanelPinnedState] = useState(() =>
    readBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, false),
  );
  const [shelfDetailOpen, setShelfDetailOpen] = useState(false);
  const [sidecarRecoveryState, setSidecarRecoveryState] =
    useState<SidecarRecoveryNoticeState | null>(null);
  const [playbackQuality, setPlaybackQualityState] = useState<PlaybackQualityRequest>(
    readPlaybackQualityPreference,
  );
  const [trackQualityOptions, setTrackQualityOptions] = useState<TrackQualityOption[]>([]);
  const [userCapsuleAutoHide, setUserCapsuleAutoHide] = useState(() =>
    readBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, false),
  );
  const [userCapsulePeek, setUserCapsulePeek] = useState(false);
  const [visualGuideOpen, setVisualGuideOpen] = useState(false);
  const visualGuidePlaylistRestoreRef = useRef<{
    open: boolean;
    tab: PlaylistPanelTab;
  } | null>(null);
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
  const [homeDiscover, setHomeDiscover] =
    useState<DiscoverHomeResponse | null>(null);
  const [homeWeatherRadio, setHomeWeatherRadio] =
    useState<WeatherRadioResponse | null>(null);
  const [homePlaylistDetail, setHomePlaylistDetail] =
    useState<HomePlaylistDetailView | null>(null);
  const [homeDiscoverLoading, setHomeDiscoverLoading] = useState(false);
  const [homeWeatherRadioLoading, setHomeWeatherRadioLoading] = useState(false);
  const [homeListenHistory, setHomeListenHistory] = useState<
    HomeListenHistoryRecord[]
  >(readHomeListenHistory);

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
  const setQueue = usePlaybackStore((s) => s.setQueue);
  const clearQueue = usePlaybackStore((s) => s.clearQueue);
  const searchKeyword = useSearchStore((s) => s.keyword);
  const setSearchKeyword = useSearchStore((s) => s.setKeyword);
  const setSearchError = useSearchStore((s) => s.setError);

  const cancelledRef = useRef(false);
  // Create the audio element synchronously on first render so child effects
  // (e.g. useVisualEngine's initAudioSource) can attach a MediaElementSource
  // before the App-level PlayerController effect runs. The element is only
  // created when the DOM supports it; otherwise we keep the ref null.
  const audioRef = useRef<HTMLAudioElement | null>(
    typeof Audio !== "undefined" && audioElementSupported() ? new Audio() : null,
  );
  const controllerRef = useRef<PlayerController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const localAudioUrlsRef = useRef(new Map<string, string>());
  const lastLoadedKeyRef = useRef<string>("");
  const loadedPlaybackUrlRef = useRef<LoadedPlaybackUrlState | null>(null);
  const pausedAtMsRef = useRef<number | null>(null);
  const mediaErrorRecoveryTrackKeyRef = useRef("");
  const playbackRequestSeqRef = useRef(0);
  const lyricRequestSeqRef = useRef(0);
  const reloadCurrentTrackAndPlayRef = useRef<
    (options: PlaybackReloadOptions) => Promise<boolean>
  >(async () => false);
  const handlePlaybackErrorRef = useRef<(payload: ErrorPayload) => void>(() => {});
  const loginQrRequestSeqRef = useRef(0);
  const neteaseCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const qqCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sodaCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
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
  const homeDiscoverRequestSeqRef = useRef(0);
  const homeWeatherRadioRequestSeqRef = useRef(0);
  const lastHomeListenKeyRef = useRef("");
  const homeListenSessionRef = useRef<HomeListenSession | null>(null);

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
  const currentLyricPreference = getCustomLyricPreferenceForTrack(currentTrack);
  const currentCustomLyricText = getCustomLyricTextForTrack(currentTrack);
  const currentLikeKey = trackLikeKey(currentTrack);
  const currentLiked = currentLikeKey ? likedSongMap[currentLikeKey] === true : false;
  const currentLikeBusy = currentLikeKey ? likeBusyMap[currentLikeKey] === true : false;
  const currentHasCustomCover = hasCustomCoverForTrack(currentTrack);
  const homeListenSummary = useMemo(
    () => buildHomeListenSummary(homeListenHistory),
    [homeListenHistory],
  );
  void customLyricVersion;

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
  }, [showToast]);

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

  const patchCustomCoverTrack = useCallback((target: Track, nextTrack: Track) => {
    const key = customCoverKeyForTrack(target);
    if (!key) return;
    const runtime = nextTrack as Track & {
      customCover?: string;
      defaultCoverUrl?: string;
    };
    const merge = (track: Track): Track => {
      if (customCoverKeyForTrack(track) !== key) return track;
      const patched = {
        ...track,
        coverUrl: nextTrack.coverUrl,
      } as Track & { customCover?: string; defaultCoverUrl?: string };
      if (runtime.customCover) patched.customCover = runtime.customCover;
      else delete patched.customCover;
      if (runtime.defaultCoverUrl) patched.defaultCoverUrl = runtime.defaultCoverUrl;
      else delete patched.defaultCoverUrl;
      return patched as Track;
    };
    usePlaybackStore.setState((state) => ({
      currentTrack: state.currentTrack ? merge(state.currentTrack) : state.currentTrack,
      queue: state.queue.map(merge),
    }));
  }, []);

  const applyCustomCoverImage = useCallback(
    async (file: Blob, explicitTrack?: Track) => {
      const target = explicitTrack ?? usePlaybackStore.getState().currentTrack;
      if (!target) {
        showToast("先播放或选择一首歌");
        return;
      }
      try {
        const dataUrl = await readLocalFileAsDataUrl(file);
        const result = saveCustomCoverForTrack(target, dataUrl);
        patchCustomCoverTrack(target, result.track);
        showToast(result.saved ? "封面已保存" : "封面已应用，存储空间不足");
      } catch {
        showToast("封面读取失败");
      }
    },
    [patchCustomCoverTrack, showToast],
  );

  const clearCustomCoverImage = useCallback(() => {
    const target = usePlaybackStore.getState().currentTrack;
    if (!target) {
      showToast("先播放或选择一首歌");
      return;
    }
    const result = clearCustomCoverForTrack(target);
    if (!result.existed) {
      showToast("当前没有自定义封面");
      return;
    }
    patchCustomCoverTrack(target, result.track);
    showToast("已恢复默认封面");
  }, [patchCustomCoverTrack, showToast]);

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
    setHomePlaylistDetail(null);
    setHomeForcedOpen(false);
    setHomeSuppressed(true);
    setConsole(true);
    setMiniQueue(false);
  }, [setConsole, setMiniQueue]);

  const goHome = useCallback(() => {
    if (homeForcedOpen || emptyHomeActive) {
      setHomePlaylistDetail(null);
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
    setHomePlaylistDetail(null);
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
    emptyHomeActive,
    focusSearch,
    homeForcedOpen,
    playlistPanelPinned,
    selectShelfPlaylist,
    setConsole,
    setMiniQueue,
    showToast,
  ]);

  const openLocalFileImport = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(false);
    fileInputRef.current?.click();
  }, []);

  const importLocalFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const file = firstLocalAudioFile(files);
    const coverFile = firstLocalCoverFile(files);
    if (!file && !coverFile) {
      showToast("请选择音频或图片文件");
      return;
    }
    if (file) {
      const url = URL.createObjectURL(file);
      const track = withStoredCustomCover(createLocalAudioTrack(file));
      const key = `${track.provider}:${track.id}`;
      const previousUrl = localAudioUrlsRef.current.get(key);
      if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
      localAudioUrlsRef.current.set(key, url);
      usePlaybackStore.getState().setQueue([track]);
      usePlaybackStore.getState().playAt(0);
      enterPlaybackSurface();
      setCurrentBeatMapState(null);
      showToast(track.title);
      if (coverFile) void applyCustomCoverImage(coverFile, track);
      return;
    }
    if (coverFile) void applyCustomCoverImage(coverFile);
  }, [applyCustomCoverImage, enterPlaybackSurface, showToast]);

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

  const installAvailableUpdate = useCallback(async () => {
    try {
      setUpdateStatus("downloading");
      showToast("开始下载更新");
      setUpdateStatus("installing");
      const result = await installUpdate();
      applyUpdateCheckResult(result);
      if (result.error) {
        setUpdateStatus("error");
        showToast(result.message || result.error);
        return;
      }
      showToast("更新安装程序已启动");
    } catch (e) {
      setUpdateStatus("error");
      showToast(e instanceof Error ? e.message : "更新安装失败");
    }
  }, [applyUpdateCheckResult, setUpdateStatus, showToast]);

  const setProviderStatus = useCallback((status: ProviderLoginStatus) => {
    if (status.provider === "netease") setNeteaseStatus(status);
    else if (status.provider === "qq") setQqStatus(status);
    else setSodaStatus(status);
  }, []);

  const providerLabel = useCallback(
    (provider: ProviderId) => providerLabelText(provider),
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
        ...LOGIN_PROVIDERS.map((provider) => client.playlistList(provider)),
        typeof podcastMy === "function"
          ? podcastMy.call(client)
          : Promise.resolve(null),
      ]);
      setShelfPlaylists(
        results
          .slice(0, LOGIN_PROVIDERS.length)
          .flatMap((result) =>
            result.status === "fulfilled"
              ? (result.value as PlaylistSummary[])
              : [],
          ),
      );
      const podcastResult = results[LOGIN_PROVIDERS.length];
      const podcastValue =
        podcastResult?.status === "fulfilled"
          ? (podcastResult.value as PodcastMyResponse | null)
          : null;
      setShelfPodcastCollections(
        podcastValue?.loggedIn
          ? podcastValue.collections
          : [],
      );
    },
    [],
  );

  const refreshProviderPlaylists = useCallback(
    async (client: SidecarClient, provider: ProviderId) => {
      const playlists = await client.playlistList(provider);
      setShelfPlaylists((current) => mergeProviderPlaylists(current, provider, playlists));
      return playlists;
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
        if (status.loggedIn) void refreshProviderPlaylists(client, provider);
        else void refreshShelfPlaylists(client);
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
      refreshProviderPlaylists,
      refreshShelfPlaylists,
      setProviderStatus,
      showToast,
      sidecarClient,
    ],
  );

  const refreshProviderLoginQr = useCallback(async (provider: ProviderId) => {
    const client = sidecarClient;
    const seq = ++loginQrRequestSeqRef.current;
    const setQr = provider === "qq" ? setQqQr : provider === "soda" ? setSodaQr : setNeteaseQr;
    const setQrStatus =
      provider === "qq"
        ? setQqQrStatus
        : provider === "soda"
          ? setSodaQrStatus
          : setNeteaseQrStatus;
    setQr(null);
    setQrStatus(initialQrStatusForProvider(provider));
    if (!client) {
      setQrStatus({ text: "sidecar 未连接，稍后再试", tone: "fail" });
      return;
    }
    try {
      const key = await client.createProviderLoginQrKey(provider);
      const image = await client.createProviderLoginQrImage(provider, key.key);
      if (seq !== loginQrRequestSeqRef.current) return;
      setQr({ key: image.key || key.key, img: image.img, completed: false });
      setQrStatus({
        text: qrInstructionForProvider(provider),
        tone: "idle",
      });
    } catch (e) {
      if (seq !== loginQrRequestSeqRef.current) return;
      const message = e instanceof Error ? e.message : "二维码生成失败";
      setQrStatus({ text: message, tone: "fail" });
    }
  }, [sidecarClient]);

  const resetProviderLoginQr = useCallback(() => {
    loginQrRequestSeqRef.current += 1;
    setNeteaseQr(null);
    setQqQr(null);
    setSodaQr(null);
    setNeteaseQrStatus(INITIAL_NETEASE_QR_STATUS);
    setQqQrStatus(INITIAL_QQ_QR_STATUS);
    setSodaQrStatus(INITIAL_SODA_QR_STATUS);
  }, []);

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

  useEffect(() => {
    if (!loginModalOpen) return;
    if (loginModalMode === "add-account") return;
    void refreshProviderLoginQr(loginProvider);
  }, [loginModalMode, loginModalOpen, loginProvider, refreshProviderLoginQr]);

  const refreshHomeDiscover = useCallback(async () => {
    const client = sidecarClient;
    if (!client) {
      setHomeDiscover(null);
      setHomeDiscoverLoading(false);
      return null;
    }
    const seq = ++homeDiscoverRequestSeqRef.current;
    setHomeDiscoverLoading(true);
    try {
      const next = await client.discoverHome();
      if (seq === homeDiscoverRequestSeqRef.current) setHomeDiscover(next);
      return next;
    } catch {
      const fallback: DiscoverHomeResponse = {
        loggedIn: false,
        user: null,
        dailySongs: [],
        playlists: [],
        podcasts: [],
        mode: "starter",
        updatedAt: Date.now(),
      };
      if (seq === homeDiscoverRequestSeqRef.current) setHomeDiscover(fallback);
      return fallback;
    } finally {
      if (seq === homeDiscoverRequestSeqRef.current) setHomeDiscoverLoading(false);
    }
  }, [sidecarClient]);

  useEffect(() => {
    const activeQr =
      loginProvider === "qq" ? qqQr : loginProvider === "soda" ? sodaQr : neteaseQr;
    if (
      !loginModalOpen ||
      loginModalMode === "add-account" ||
      !activeQr?.key ||
      activeQr.completed ||
      !sidecarClient
    ) {
      return;
    }

    let cancelled = false;
    let checkInFlight = false;
    const provider = loginProvider;
    const setQr = provider === "qq" ? setQqQr : provider === "soda" ? setSodaQr : setNeteaseQr;
    const setQrStatus =
      provider === "qq"
        ? setQqQrStatus
        : provider === "soda"
          ? setSodaQrStatus
          : setNeteaseQrStatus;
    const check = async () => {
      if (checkInFlight) return;
      checkInFlight = true;
      try {
        const result = await sidecarClient.checkProviderLoginQr(provider, activeQr.key);
        if (cancelled) return;
        if (result.stored || result.loggedIn) {
          setQrStatus({ text: "登录成功，正在同步账号状态", tone: "success" });
          let status: ProviderLoginStatus | null = null;
          try {
            status = await sidecarClient.loginStatus(provider);
          } catch {
            status = null;
          }
          if (cancelled) return;
          const label = providerLabel(provider);
          let providerPlaylistSyncFailed = false;
          if (status) {
            setProviderStatus(status);
            if (status.loggedIn) {
              setQrStatus({ text: "登录成功，正在同步歌单", tone: "success" });
              try {
                await refreshProviderPlaylists(sidecarClient, provider);
                await refreshHomeDiscover();
              } catch {
                if (cancelled) return;
                providerPlaylistSyncFailed = true;
                setQrStatus({ text: "登录成功，歌单同步失败，可稍后刷新", tone: "success" });
              }
            } else {
              void refreshShelfPlaylists(sidecarClient);
            }
          }
          if (cancelled) return;
          setQr((current) =>
            current?.key === activeQr.key ? { ...current, completed: true } : current,
          );
          if (status?.loggedIn) {
            setQrStatus({
              text: providerPlaylistSyncFailed ? "登录成功，歌单同步失败，可稍后刷新" : "登录成功，歌单已同步",
              tone: "success",
            });
            showToast(`${label}已登录: ${status.nickname ?? status.userId ?? "账号"}`);
          } else {
            setQrStatus({ text: "登录成功，会话已保存，可刷新状态", tone: "success" });
            showToast(`${label}会话已保存`);
          }
          return;
        }
        if (result.expired || result.code === 800 || result.code === 65) {
          setQr((current) =>
            current?.key === activeQr.key ? { ...current, completed: true } : current,
          );
          setQrStatus({ text: "二维码已过期，请刷新", tone: "fail" });
          return;
        }
        if (result.scanned || result.code === 802 || result.code === 67) {
          setQrStatus({ text: qrScannedTextForProvider(provider), tone: "scan" });
          return;
        }
        setQrStatus({
          text: qrInstructionForProvider(provider),
          tone: "idle",
        });
      } catch {
        if (!cancelled) setQrStatus({ text: "扫码状态读取失败", tone: "fail" });
      } finally {
        checkInFlight = false;
      }
    };
    const timer = window.setInterval(() => {
      void check();
    }, 1800);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    loginModalMode,
    loginModalOpen,
    loginProvider,
    neteaseQr?.completed,
    neteaseQr?.key,
    providerLabel,
    qqQr?.completed,
    qqQr?.key,
    sodaQr?.completed,
    sodaQr?.key,
    refreshHomeDiscover,
    refreshProviderPlaylists,
    refreshShelfPlaylists,
    setProviderStatus,
    showToast,
    sidecarClient,
  ]);

  const refreshHomeWeatherRadio = useCallback(async () => {
    const client = sidecarClient;
    const weatherRadio = client?.weatherRadio;
    if (!client || typeof weatherRadio !== "function") {
      setHomeWeatherRadio(null);
      setHomeWeatherRadioLoading(false);
      return null;
    }
    const seq = ++homeWeatherRadioRequestSeqRef.current;
    setHomeWeatherRadioLoading(true);
    try {
      const next = await weatherRadio.call(client, {
        city: "上海",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "auto",
      });
      if (seq === homeWeatherRadioRequestSeqRef.current) setHomeWeatherRadio(next);
      return next;
    } catch {
      if (seq === homeWeatherRadioRequestSeqRef.current) setHomeWeatherRadio(null);
      return null;
    } finally {
      if (seq === homeWeatherRadioRequestSeqRef.current) setHomeWeatherRadioLoading(false);
    }
  }, [sidecarClient]);

  useEffect(() => {
    if (!sidecarClient) {
      setHomeDiscover(null);
      setHomeWeatherRadio(null);
      setHomeDiscoverLoading(false);
      setHomeWeatherRadioLoading(false);
      return;
    }
    void refreshHomeDiscover();
    void refreshHomeWeatherRadio();
  }, [
    neteaseStatus?.loggedIn,
    qqStatus?.loggedIn,
    sodaStatus?.loggedIn,
    refreshHomeDiscover,
    refreshHomeWeatherRadio,
    sidecarClient,
  ]);

  const finalizeHomeListenSession = useCallback((completed = false) => {
    const session = updateHomeListenSession(
      homeListenSessionRef.current,
      usePlaybackStore.getState().positionMs,
      usePlaybackStore.getState().durationMs,
      Date.now(),
      true,
    );
    homeListenSessionRef.current = null;
    if (!session || !isEffectiveHomeListenSession(session, completed, usePlaybackStore.getState().durationMs)) return;
    setHomeListenHistory((history) => {
      const next = updateHomeListenHistory(history, session.track, Date.now(), session.listenMs, completed);
      writeHomeListenHistory(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const key = trackLikeKey(currentTrack);
    if (!currentTrack || !key) {
      finalizeHomeListenSession(false);
      lastHomeListenKeyRef.current = "";
      return;
    }
    if (key === lastHomeListenKeyRef.current) return;
    finalizeHomeListenSession(false);
    lastHomeListenKeyRef.current = key;
    homeListenSessionRef.current = beginHomeListenSession(currentTrack, Date.now(), positionMs);
  }, [currentTrack, finalizeHomeListenSession, positionMs]);

  const openHomeProductGuide = useCallback(() => {
    setHomeSuppressed(false);
    setVisualGuideOpen(true);
  }, []);

  const openPlaylistPanelTab = useCallback(
    (tab: PlaylistPanelTab) => {
      setPlaylistPanelTab(tab);
      setPlaylistPanelOpen(true);
      if ((tab === "playlists" || tab === "podcasts") && sidecarClient) {
        void refreshShelfPlaylists(sidecarClient);
      }
    },
    [refreshShelfPlaylists, sidecarClient],
  );

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
    setHomePlaylistDetail(null);
    if (homeDiscover?.loggedIn || neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn) {
      if (sidecarClient) void refreshShelfPlaylists(sidecarClient);
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
    sidecarClient,
  ]);

  const homeHasLogin = useCallback(
    () => !!(homeDiscover?.loggedIn || neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn),
    [homeDiscover?.loggedIn, neteaseStatus?.loggedIn, qqStatus?.loggedIn, sodaStatus?.loggedIn],
  );

  const playHomeDiscoverSongs = useCallback(
    async (index: number) => {
      const discover = homeDiscover?.loggedIn ? homeDiscover : await refreshHomeDiscover();
      if (!homeHasLogin() && !discover?.loggedIn) {
        openLoginModal();
        showToast("登录后同步你的今日歌曲");
        return;
      }
      const songs = discover?.dailySongs ?? [];
      const targetIndex = Math.max(0, Math.min(index, songs.length - 1));
      if (!songs.length || !songs[targetIndex]) {
        searchQuery(index > 0 ? "私人雷达" : "每日推荐", "song");
        return;
      }
      usePlaybackStore.getState().setQueue(songs);
      usePlaybackStore.getState().playAt(targetIndex);
      enterPlaybackSurface();
    },
    [
      enterPlaybackSurface,
      homeDiscover,
      homeHasLogin,
      openLoginModal,
      refreshHomeDiscover,
      searchQuery,
      showToast,
    ],
  );

  const playHomeDaily = useCallback(() => {
    void playHomeDiscoverSongs(0);
  }, [playHomeDiscoverSongs]);

  const openHomeDiscoverPlaylist = useCallback(
    async (index: number) => {
      const useCachedDiscover = shouldUseCachedHomeDiscoverPlaylist(homeDiscover, homeHasLogin());
      const discover = useCachedDiscover ? homeDiscover : await refreshHomeDiscover();
      const item = discover?.playlists[index];
      if (!item) {
        if (!homeHasLogin() && !discover?.loggedIn) searchQuery("", "song");
        else openHomeLibrary();
        return;
      }
      if (!sidecarClient) {
        showToast("sidecar 未连接，稍后再试");
        return;
      }
      const key = `${item.provider}:${item.id}`;
      setHomePlaylistDetail({ key, playlist: item, tracks: [], loading: true });
      setHomeSuppressed(false);
      setHomeForcedOpen(true);
      setConsole(false);
      setMiniQueue(false);
      if (!playlistPanelPinned) setPlaylistPanelOpen(false);
      closeShelf();
      selectShelfPlaylist(null);
      try {
        const detail = await sidecarClient.playlistDetail(item.provider, item.id);
        setHomePlaylistDetail((current) =>
          current?.key === key
            ? { key, playlist: detail, tracks: detail.tracks, loading: false }
            : current,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : "歌单载入失败";
        setHomePlaylistDetail((current) =>
          current?.key === key
            ? { ...current, loading: false, error: message, tracks: [] }
            : current,
        );
        showToast(message);
      }
    },
    [
      closeShelf,
      homeDiscover,
      homeHasLogin,
      openHomeLibrary,
      playlistPanelPinned,
      refreshHomeDiscover,
      searchQuery,
      selectShelfPlaylist,
      setConsole,
      setMiniQueue,
      showToast,
      sidecarClient,
    ],
  );

  const closeHomePlaylistDetail = useCallback(() => {
    setHomePlaylistDetail(null);
  }, []);

  const playHomePlaylistDetail = useCallback(
    (index: number) => {
      const detail = homePlaylistDetail;
      const tracks = detail?.tracks ?? [];
      if (!detail || detail.loading) {
        showToast("歌单仍在载入");
        return;
      }
      if (!tracks.length) {
        showToast("歌单暂时没有可播放歌曲");
        return;
      }
      const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
      usePlaybackStore.getState().setQueue(tracks);
      usePlaybackStore.getState().playAt(safeIndex);
      const title = detail.playlist.name || "歌单";
      setHomePlaylistDetail(null);
      enterPlaybackSurface();
      showToast(title);
    },
    [enterPlaybackSurface, homePlaylistDetail, showToast],
  );

  const searchHomePlaylistDetailArtist = useCallback(
    (artist: string) => {
      const keyword = artist.trim();
      if (!keyword) return;
      setHomePlaylistDetail(null);
      searchQuery(keyword, "song");
    },
    [searchQuery],
  );

  const playShelfPlaylist = useCallback(
    async (payload: ShelfPlayPlaylistPayload) => {
      if (!sidecarClient) {
        showToast("sidecar 未连接，稍后再试");
        return;
      }
      const playlistId = String(payload.playlistId || "").trim();
      if (!playlistId) {
        showToast("歌单信息不完整");
        return;
      }

      try {
        let tracks: Track[] = [];
        let toastTitle = payload.title || "歌单";
        if (playlistId.startsWith("podcast:")) {
          const key = playlistId.slice("podcast:".length);
          if (!key) {
            showToast("播客信息不完整");
            return;
          }
          const detail = await sidecarClient.podcastMyItems(key, 36, 0);
          tracks = mapPodcastItemsToShelfRows(detail)
            .map((row) => mapShelfDetailRowToTrack(row))
            .filter((track): track is Track => !!track && isPlayable(track.playableState));
          toastTitle = detail.title || payload.title || "播客";
        } else {
          const parsedProvider = ProviderIdSchema.safeParse(payload.provider);
          if (!parsedProvider.success) {
            showToast("歌单信息不完整");
            return;
          }
          const detail = await sidecarClient.playlistDetail(parsedProvider.data, playlistId);
          tracks = detail.tracks;
          toastTitle = detail.name || payload.title || "歌单";
        }

        if (!tracks.length) {
          showToast("歌单暂时没有可播放歌曲");
          return;
        }
        usePlaybackStore.getState().setQueue(tracks);
        usePlaybackStore.getState().playAt(0);
        enterPlaybackSurface();
        showToast(toastTitle);
      } catch (e) {
        const message = e instanceof Error ? e.message : "歌单载入失败";
        showToast(message);
      }
    },
    [enterPlaybackSurface, showToast, sidecarClient],
  );

  const playHomePrivate = useCallback(async () => {
    const discover = homeDiscover?.loggedIn ? homeDiscover : await refreshHomeDiscover();
    if (!homeHasLogin() && !discover?.loggedIn) {
      openLoginModal();
      showToast("登录后同步更多歌曲");
      return;
    }
    if (discover?.dailySongs.length) {
      await playHomeDiscoverSongs(0);
      return;
    }
    if (discover?.playlists.length) {
      await openHomeDiscoverPlaylist(0);
      return;
    }
    openHomeLibrary();
  }, [
    homeDiscover,
    homeHasLogin,
    openHomeDiscoverPlaylist,
    openHomeLibrary,
    openLoginModal,
    playHomeDiscoverSongs,
    refreshHomeDiscover,
    showToast,
  ]);

  const playPodcastRadio = useCallback(
    async (id: string, title = "播客") => {
      if (!id || !sidecarClient) {
        searchQuery(title || "播客", "podcast");
        return;
      }
      try {
        const detail = await sidecarClient.podcastPrograms(id, 30, 0);
        if (!detail.programs.length) {
          searchQuery(title || "播客", "podcast");
          return;
        }
        usePlaybackStore.getState().setQueue(detail.programs);
        usePlaybackStore.getState().playAt(0);
        enterPlaybackSurface();
        showToast(title || "播客");
      } catch (e) {
        const message = e instanceof Error ? e.message : "播客载入失败";
        showToast(message);
      }
    },
    [enterPlaybackSurface, searchQuery, showToast, sidecarClient],
  );

  const openHomeDiscoverPodcast = useCallback(
    async (index: number) => {
      const discover = homeDiscover?.loggedIn ? homeDiscover : await refreshHomeDiscover();
      const item = discover?.podcasts[index];
      if (!item) {
        searchQuery("", "podcast");
        return;
      }
      await playPodcastRadio(item.id, item.name || "播客");
    },
    [
      homeDiscover,
      playPodcastRadio,
      refreshHomeDiscover,
      searchQuery,
    ],
  );

  const playHomeWeatherSong = useCallback(
    async (index: number) => {
      let radio = homeWeatherRadio;
      if (!radio?.radio.songs.length) {
        showToast("正在生成天气电台");
        radio = await refreshHomeWeatherRadio();
      }
      const songs = radio?.radio.songs ?? [];
      if (!songs.length) {
        const seed = radio?.radio.seedQueries[0] || "雨天 R&B";
        showToast("天气队列暂时为空，先打开搜索");
        searchQuery(seed, "song");
        return;
      }
      const targetIndex = Math.max(0, Math.min(index, songs.length - 1));
      usePlaybackStore.getState().setQueue(songs);
      usePlaybackStore.getState().playAt(targetIndex);
      enterPlaybackSurface();
      showToast(`${radio?.radio.title || "天气电台"} · ${songs.length} 首`);
    },
    [
      enterPlaybackSurface,
      homeWeatherRadio,
      refreshHomeWeatherRadio,
      searchQuery,
      showToast,
    ],
  );

  const openHomePodcastSearch = useCallback(() => {
    searchQuery("", "podcast");
  }, [searchQuery]);

  const openHomeInsight = useCallback(() => {
    const artist = homeListenSummary?.topArtist?.name;
    if (artist) {
      searchQuery(artist);
      return;
    }
    const song = homeListenSummary?.topSong?.track.title;
    if (song) {
      searchQuery(song);
      return;
    }
    showToast("播放几首歌后会生成听歌画像");
  }, [homeListenSummary, searchQuery, showToast]);

  const playHomeRecent = useCallback(() => {
    const track = homeListenSummary?.recent?.track;
    if (track) {
      usePlaybackStore.getState().setQueue([track]);
      usePlaybackStore.getState().playAt(0);
      enterPlaybackSurface();
      return;
    }
    showToast("还没有听歌记录");
  }, [enterPlaybackSurface, homeListenSummary, showToast]);

  const openCollectPicker = useCallback(
    (track: Track) => {
      if (!isCollectSupportedTrack(track)) {
        showToast(collectUnsupportedMessage(track));
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
      if (!isCollectSupportedTrack(track)) {
        showToast(collectUnsupportedMessage(track));
        setCollectTarget(null);
        return;
      }
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
    if (!isProviderLikeSupported(track)) {
      showToast(likeUnsupportedMessage(track));
      return;
    }
    const client = sidecarClient;
    const key = trackLikeKey(track);
    const trackId = trackProviderLikeId(track);
    if (!client || !key || likeBusyMapRef.current[key]) {
      if (!client) showToast("红心操作失败");
      return;
    }

    const previous = likedSongMapRef.current[key] === true;
    const next = !previous;
    setLikeBusyMap((map) => ({ ...map, [key]: true }));
    setLikedSongMap((map) => ({ ...map, [key]: next }));
    try {
      const ack = await client.likeSong(track.provider, trackId, next);
      setLikedSongMap((map) => ({
        ...map,
        [key]: ack.liked === true,
      }));
      showToast(next ? "已加入红心喜欢" : "已取消红心");
    } catch (e) {
      setLikedSongMap((map) => ({ ...map, [key]: previous }));
      if (isLoginRequiredError(e)) {
        showToast(`登录后可同步到${providerLabelText(track.provider)}`);
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
    setLoginModalMode("full");
    setQqManualCookieOpen(false);
    resetProviderLoginQr();
    if (neteaseCookieInputRef.current) neteaseCookieInputRef.current.value = "";
    if (qqCookieInputRef.current) qqCookieInputRef.current.value = "";
    if (sodaCookieInputRef.current) sodaCookieInputRef.current.value = "";
  }, [resetProviderLoginQr]);

  const importProviderCookie = useCallback(
    async (provider: ProviderId) => {
      const client = sidecarClient;
      const input =
        provider === "netease"
          ? neteaseCookieInputRef.current
          : provider === "soda"
            ? sodaCookieInputRef.current
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
        setQqManualCookieOpen(false);
        const status = await client.loginStatus(provider);
        setProviderStatus(status);
        if (status.loggedIn) {
          try {
            await refreshProviderPlaylists(client, provider);
            await refreshHomeDiscover();
          } catch {
            showToast(`${label}已登录，歌单同步失败，可稍后刷新`);
          }
        } else {
          void refreshShelfPlaylists(client);
        }
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
      refreshHomeDiscover,
      refreshProviderPlaylists,
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

  const reloadCurrentTrackAndPlay = useCallback(
    async ({ preservePosition, reason }: PlaybackReloadOptions): Promise<boolean> => {
      const controller = controllerRef.current;
      const client = sidecarClient;
      const track = usePlaybackStore.getState().currentTrack;
      if (!controller || !client || !track) return false;

      const key = playbackKeyForTrack(track);
      if (!key || localAudioUrlsRef.current.has(key)) return false;

      const seq = playbackRequestSeqRef.current + 1;
      playbackRequestSeqRef.current = seq;
      const resumeAt = preservePosition
        ? Math.max(0, usePlaybackStore.getState().positionMs)
        : 0;

      try {
        const result = await client.resolveSongUrl(track, playbackQuality);
        if (playbackRequestSeqRef.current !== seq) return false;
        if (!result.url) {
          throw new Error(result.message || "播放地址不可用");
        }
        const proxiedUrl = (client as { proxiedUrl?: (url: string) => string }).proxiedUrl;
        const audioUrl = result.proxied
          ? (proxiedUrl ? proxiedUrl.call(client, result.url) : result.url)
          : client.audioProxyUrl(result.url);
        if (result.trial) {
          setTrialBanner({
            text: trialBannerText(result),
            provider: track.provider,
            showLogin: !result.loggedIn,
          });
        } else {
          setTrialBanner(null);
        }
        controller.load(audioUrl);
        loadedPlaybackUrlRef.current = {
          trackKey: key,
          quality: playbackQuality,
          resolvedAtMs: Date.now(),
          audioUrl,
          rawUrl: result.url,
          local: false,
          trial: result.trial === true,
        };
        if (reason !== "media-error") mediaErrorRecoveryTrackKeyRef.current = "";
        const beatmapResolver = client.podcastDjBeatmap?.bind(client);
        if (beatmapResolver && isPodcastTrack(track)) {
          void beatmapResolver(
            result.url,
            Math.max(
              0,
              Number(
                track.durationMs ??
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
        if (resumeAt > 0) {
          setPositionMs(resumeAt);
          controller.seek(resumeAt);
        }
        await controller.play();
        if (playbackRequestSeqRef.current !== seq) return false;
        setHomeForcedOpen(false);
        setHomeSuppressed(true);
        return true;
      } catch (e) {
        if (playbackRequestSeqRef.current !== seq) return false;
        const message = e instanceof Error ? e.message : "playback error";
        setTrialBanner(null);
        setPlaying(false);
        setSearchError(message);
        showToast(message);
        return false;
      }
    },
    [
      playbackQuality,
      setPlaying,
      setPositionMs,
      setSearchError,
      showToast,
      sidecarClient,
    ],
  );
  reloadCurrentTrackAndPlayRef.current = reloadCurrentTrackAndPlay;

  const handlePlaybackError = useCallback(
    (payload: ErrorPayload) => {
      const message = payload.message || "音频播放失败";
      const track = usePlaybackStore.getState().currentTrack;
      const key = playbackKeyForTrack(track);
      const loaded = loadedPlaybackUrlRef.current;
      const canResolveSongUrl = typeof sidecarClient?.resolveSongUrl === "function";
      if (
        key &&
        loaded &&
        loaded.trackKey === key &&
        !loaded.local &&
        !loaded.trial &&
        canResolveSongUrl &&
        mediaErrorRecoveryTrackKeyRef.current !== key
      ) {
        mediaErrorRecoveryTrackKeyRef.current = key;
        setTrialBanner(null);
        void reloadCurrentTrackAndPlayRef.current({
          preservePosition: true,
          reason: "media-error",
        });
        return;
      }
      setTrialBanner(null);
      setSearchError(message);
      showToast(message);
    },
    [setSearchError, showToast, sidecarClient],
  );
  handlePlaybackErrorRef.current = handlePlaybackError;

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
    if (usePlaybackStore.getState().isPlaying) {
      controller.pause();
      return;
    }
    const now = Date.now();
    const loaded = loadedPlaybackUrlRef.current;
    const pausedAt = pausedAtMsRef.current;
    const pauseAgeMs = pausedAt === null ? 0 : now - pausedAt;
    const urlAgeMs = loaded ? now - loaded.resolvedAtMs : 0;
    const shouldRefresh =
      loaded &&
      !loaded.local &&
      (
        pauseAgeMs >= LONG_PAUSE_PLAYBACK_URL_REFRESH_MS ||
        urlAgeMs >= PLAYBACK_URL_MAX_AGE_MS
      );
    if (shouldRefresh) {
      const reason: PlaybackReloadReason =
        pauseAgeMs >= LONG_PAUSE_PLAYBACK_URL_REFRESH_MS
          ? "long-pause"
          : "url-age";
      void reloadCurrentTrackAndPlayRef.current({
        preservePosition: true,
        reason,
      });
      return;
    }
    void controller.play();
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

  const cyclePlaylistPanelMode = useCallback(() => {
    const order: Array<typeof playbackMode> = ["queue", "loop", "single", "shuffle"];
    const next = order[(order.indexOf(playbackMode) + 1) % order.length] ?? "queue";
    setPlaybackMode(next);
  }, [playbackMode, setPlaybackMode]);

  const shufflePlaylistPanelQueue = useCallback(() => {
    const tracks = usePlaybackStore.getState().queue;
    if (tracks.length < 2) {
      showToast("队列歌曲不足");
      return;
    }
    const shuffled = [...tracks];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    setQueue(shuffled);
    showToast("队列已随机排序");
  }, [setQueue, showToast]);

  const clearPlaylistPanelQueue = useCallback(() => {
    clearQueue();
    showToast("队列已清空");
  }, [clearQueue, showToast]);

  const importSharedPlaylistFromText = useCallback(
    async (text: string) => {
      if (!sidecarClient) {
        const message = "sidecar 尚未就绪，稍后再试";
        setSearchError(message);
        showToast(message);
        throw new Error(message);
      }
      try {
        const result = await sidecarClient.importSharedPlaylist({ text });
        setImportedPlaylists((previous) => {
          const key = `${result.provider}:${result.playlist.id}`;
          const oldRecord = previous.find((item) => item.key === key);
          const record = importedPlaylistFromResult(result, Date.now(), oldRecord);
          const next = upsertImportedPlaylist(previous, record);
          saveImportedPlaylistsToStorage(next);
          return next;
        });
        useSearchStore.getState().reset();
        setPlaylistPanelTab("playlists");
        setPlaylistPanelOpen(true);
        const total = result.trackCount || result.tracks.length;
        showToast(`已导入「${result.playlist.name}」 · ${result.loadedCount}/${total} 首`);
      } catch (e) {
        const message = e instanceof Error ? e.message : "歌单导入失败";
        setSearchError(message);
        showToast(message);
        throw e;
      }
    },
    [setSearchError, showToast, sidecarClient],
  );

  const deleteImportedPlaylist = useCallback(
    (key: string) => {
      setImportedPlaylists((previous) => {
        const next = previous.filter((item) => item.key !== key);
        saveImportedPlaylistsToStorage(next);
        return next;
      });
      showToast("已删除导入歌单");
    },
    [showToast],
  );

  const loadPlaylistPanelDetail = useCallback(
    async (playlist: PlaylistSummary): Promise<PlaylistDetail> => {
      if (!sidecarClient) return { ...playlist, tracks: [] };
      return sidecarClient.playlistDetail(playlist.provider, playlist.id);
    },
    [sidecarClient],
  );

  const playPlaylistPanelTracks = useCallback(
    (tracks: Track[], index: number, title?: string) => {
      if (!tracks.length) {
        showToast("歌单暂时没有可播放歌曲");
        return;
      }
      const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
      setQueue(tracks);
      usePlaybackStore.getState().playAt(safeIndex);
      setPlaylistPanelTab("queue");
      enterPlaybackSurface();
      if (title) showToast(title);
    },
    [enterPlaybackSurface, setQueue, showToast],
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

  const openPlaylistPanelPodcastCollection = useCallback(
    async (collection: PodcastCollection) => {
      if (!sidecarClient) {
        searchQuery(collection.title || "播客", "podcast");
        return;
      }
      try {
        const detail = await sidecarClient.podcastMyItems(collection.key, 36, 0);
        if (!detail.loggedIn) {
          openLoginModal();
          return;
        }
        const playable = detail.items.flatMap((item) => {
          if (!("provider" in item) || !("title" in item)) return [];
          const track = item as Track;
          return isPlayable(track.playableState) ? [track] : [];
        });
        if (playable.length) {
          playPlaylistPanelTracks(playable, 0, detail.title || collection.title);
          return;
        }
        searchQuery(detail.title || collection.title || "播客", "podcast");
      } catch (e) {
        const message = e instanceof Error ? e.message : "播客加载失败";
        showToast(message);
      }
    },
    [
      openLoginModal,
      playPlaylistPanelTracks,
      searchQuery,
      showToast,
      sidecarClient,
    ],
  );

  const insertSearchResultNext = useCallback(
    (track: Track) => {
      insertQueueNext(track);
      showToast(`已设为下一首: ${track.title}`);
    },
    [insertQueueNext, showToast],
  );

  const searchArtistFromResult = useCallback(
    (artist: string) => {
      searchQuery(artist, "song");
    },
    [searchQuery],
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

  const setPlaybackQuality = useCallback(
    (quality: PlaybackQualityRequest) => {
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

  const setDesktopLyricsWindowEnabled = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      await desktopLyricsRuntime.closeWindow();
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
        stageLyricPalette: motion.palette,
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
      await desktopLyricsRuntime.updatePayload(payload);
    }
    await desktopLyricsRuntime.showWindow();
    setDesktopLyricsEnabled(true);
  }, [currentBeatMapState, currentDesktopLyricSnapshot, desktopLyricsRuntime]);
  setDesktopLyricsWindowEnabledRef.current = setDesktopLyricsWindowEnabled;

  const toggleDesktopLyrics = useCallback(async () => {
    await setDesktopLyricsWindowEnabled(!desktopLyricsEnabled);
  }, [desktopLyricsEnabled, setDesktopLyricsWindowEnabled]);

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
      );
    };
  }, [
    consoleVisible,
    emptyHomeActive,
    homeControlsLocked,
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
    void refreshUpdateStatus(false);
    if (shouldOpenDevUpdatePreview()) setUpdateModalOpen(true);
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
        stageLyricPalette: motion.palette,
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
    void desktopLyricsRuntime.updatePayload(payload);
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
    desktopLyricsRuntime,
  ]);

  useEffect(() => {
    if (!sidecarBaseUrl) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let clearRecoveredTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveReadyPolls = 0;

    async function pollStatus(): Promise<void> {
      let nextDelayMs = SIDECAR_STATUS_POLL_MS;
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
        nextDelayMs = nextSidecarStatusPollDelayMs({
          status,
          consecutiveReadyPolls,
          documentHidden:
            typeof document !== "undefined" &&
            document.visibilityState === "hidden",
        });
        consecutiveReadyPolls =
          status.phase === "ready" ? consecutiveReadyPolls + 1 : 0;
      } catch {
        consecutiveReadyPolls = 0;
      } finally {
        if (!cancelled) {
          pollTimer = setTimeout(() => {
            void pollStatus();
          }, nextDelayMs);
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
          const statusResults = await Promise.allSettled([
            ...LOGIN_PROVIDERS.map((provider) => client.loginStatus(provider)),
          ]);
          if (cancelledRef.current) return;
          for (const result of statusResults) {
            if (result.status === "fulfilled") {
              setProviderStatus(result.value);
            }
          }
          if (!cancelledRef.current) void refreshShelfPlaylists(client);
        } catch {
          if (cancelledRef.current) return;
          attempts += 1;
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
  }, [
    initSidecar,
    initialRuntimeConfig,
    refreshShelfPlaylists,
    setMatrix,
    setProviderStatus,
  ]);

  useEffect(() => {
    if (!audioElementSupported()) return;
    if (controllerRef.current) return;
    // Reuse the synchronously-created audio element from the ref; only create
    // a fresh one if SSR/storage disabled the early creation (audioRef null).
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio();
      audioRef.current = audio;
    }
    audio.preload = "metadata";
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
      homeListenSessionRef.current = updateHomeListenSession(
        homeListenSessionRef.current,
        payload.positionMs,
        payload.durationMs,
        Date.now(),
      );
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
      pausedAtMsRef.current = null;
      setPlaying(true);
    });
    controller.on("pause", () => {
      pausedAtMsRef.current = Date.now();
      homeListenSessionRef.current = updateHomeListenSession(
        homeListenSessionRef.current,
        usePlaybackStore.getState().positionMs,
        usePlaybackStore.getState().durationMs,
        Date.now(),
        true,
      );
      setPlaying(false);
    });
    controller.on("ended", () => {
      finalizeHomeListenSession(true);
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
      handlePlaybackErrorRef.current(payload);
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
    finalizeHomeListenSession,
    showToast,
  ]);

  useEffect(() => {
    if (!currentTrack) return;
    const hydrated = withStoredCustomCover(currentTrack);
    if (hydrated === currentTrack || hydrated.coverUrl === currentTrack.coverUrl) return;
    patchCustomCoverTrack(currentTrack, hydrated);
  }, [currentTrack, patchCustomCoverTrack]);

  useEffect(() => {
    const track = currentTrack;
    const client = sidecarClient;
    const key = playbackKeyForTrack(track);
    if (!track || !client || !key || localAudioUrlsRef.current.has(key)) {
      setTrackQualityOptions([]);
      return;
    }
    const trackQualities = (client as { trackQualities?: SidecarClient["trackQualities"] }).trackQualities;
    if (typeof trackQualities !== "function") {
      setTrackQualityOptions([]);
      return;
    }
    let cancelled = false;
    void trackQualities.call(client, track).then((availability) => {
      if (cancelled) return;
      const qualities = availability.qualities;
      setTrackQualityOptions(qualities);
      const selectedAvailable = qualities.some((quality) => quality.requestQuality === playbackQuality);
      const fallbackQuality = availability.defaultQuality ?? qualities[0]?.requestQuality;
      if (!selectedAvailable && fallbackQuality) {
        setPlaybackQuality(fallbackQuality);
      }
    }).catch(() => {
      if (!cancelled) setTrackQualityOptions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [currentTrack, playbackQuality, setPlaybackQuality, sidecarClient]);

  useEffect(() => {
    const track = currentTrack;
    const client = sidecarClient;
    if (!client || !isProviderLikeSupported(track)) return;
    const checkSongLikes = (client as { checkSongLikes?: SidecarClient["checkSongLikes"] }).checkSongLikes;
    if (typeof checkSongLikes !== "function") return;
    const key = trackLikeKey(track);
    const trackId = trackProviderLikeId(track);
    if (!key) return;
    const token = ++likeStatusRequestSeqRef.current;
    void checkSongLikes.call(client, track.provider, [trackId]).then((ack) => {
      if (token !== likeStatusRequestSeqRef.current) return;
      setLikedSongMap((map) => ({
        ...map,
        [key]: ack.liked[trackId] === true,
      }));
    }).catch(() => {
      // 红心状态只影响按钮高亮，失败不能阻断播放 UI。
    });
  }, [currentTrack, sidecarClient]);

  useEffect(() => {
    const controller = controllerRef.current;
    const client = sidecarClient;
    if (!controller) return;
    if (!currentTrack) {
      lastLoadedKeyRef.current = "";
      loadedPlaybackUrlRef.current = null;
      pausedAtMsRef.current = null;
      mediaErrorRecoveryTrackKeyRef.current = "";
      playbackRequestSeqRef.current += 1;
      lyricRequestSeqRef.current += 1;
      setCurrentBeatMapState(null);
      setTrialBanner(null);
      controller.pause();
      lyricsReset();
      return;
    }
    const key = playbackKeyForTrack(currentTrack);
    const localAudioUrl = localAudioUrlsRef.current.get(key);
    if (!localAudioUrl && !client) return;
    if (key === lastLoadedKeyRef.current) return;
    lastLoadedKeyRef.current = key;
    mediaErrorRecoveryTrackKeyRef.current = "";
    const playbackSeq = playbackRequestSeqRef.current + 1;
    playbackRequestSeqRef.current = playbackSeq;
    const lyricSeq = lyricRequestSeqRef.current + 1;
    lyricRequestSeqRef.current = lyricSeq;
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

    if (localAudioUrl) {
      void (async () => {
        try {
          controller.load(localAudioUrl);
          loadedPlaybackUrlRef.current = {
            trackKey: key,
            quality: playbackQuality,
            resolvedAtMs: Date.now(),
            audioUrl: localAudioUrl,
            rawUrl: localAudioUrl,
            local: true,
            trial: false,
          };
          if (positionRef.current > 0) controller.seek(positionRef.current);
          await controller.play();
          if (playbackRequestSeqRef.current !== playbackSeq) return;
          setLyricsLoading(false);
          setHomeForcedOpen(false);
          setHomeSuppressed(true);
        } catch (e) {
          if (playbackRequestSeqRef.current !== playbackSeq) return;
          const message = e instanceof Error ? e.message : "playback error";
          setPlaying(false);
          setSearchError(message);
          showToast(message);
        }
      })();
      return;
    }

    if (!client) return;

    void (async () => {
      try {
        const result = await client.resolveSongUrl(
          currentTrack,
          playbackQuality,
        );
        if (playbackRequestSeqRef.current !== playbackSeq) return;
        if (!result.url) {
          throw new Error(result.message || "播放地址不可用");
        }
        const proxiedUrl = (client as { proxiedUrl?: (url: string) => string }).proxiedUrl;
        const audioUrl = result.proxied
          ? (proxiedUrl ? proxiedUrl.call(client, result.url) : result.url)
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
        loadedPlaybackUrlRef.current = {
          trackKey: key,
          quality: playbackQuality,
          resolvedAtMs: Date.now(),
          audioUrl,
          rawUrl: result.url,
          local: false,
          trial: result.trial === true,
        };
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
            if (playbackRequestSeqRef.current !== playbackSeq) return;
            const map = toJsonValue(beatmap.map);
            setCurrentBeatMapState(map ? {
              key: desktopLyricsBeatMapKey(map, "dj"),
              map,
            } : null);
          }).catch(() => {
            if (playbackRequestSeqRef.current === playbackSeq) {
              setCurrentBeatMapState(null);
            }
          });
        }
        if (positionRef.current > 0) controller.seek(positionRef.current);
        await controller.play();
        if (playbackRequestSeqRef.current !== playbackSeq) return;
        setHomeForcedOpen(false);
        setHomeSuppressed(true);
      } catch (e) {
        if (playbackRequestSeqRef.current !== playbackSeq) return;
        const message = e instanceof Error ? e.message : "playback error";
        setTrialBanner(null);
        setPlaying(false);
        setSearchError(message);
        showToast(message);
      }
      try {
        setLyricsLoading(true);
        const lyric = ensureLyricFallbackPayload(await client.lyric(currentTrack), currentTrack);
        if (lyricRequestSeqRef.current !== lyricSeq) return;
        originalLyricsPayloadRef.current = lyric;
        const resolvedLyric = resolveLyricsForTrack({
          track: currentTrack,
          original: lyric,
          durationMs:
            usePlaybackStore.getState().durationMs ?? currentTrack.durationMs,
        });
        setLyricsPayload(resolvedLyric.payload);
      } catch (e) {
        if (lyricRequestSeqRef.current !== lyricSeq) return;
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
  const activeLoginQr =
    loginProvider === "qq" ? qqQr : loginProvider === "soda" ? sodaQr : neteaseQr;
  const activeLoginQrStatus =
    loginProvider === "qq"
      ? qqQrStatus
      : loginProvider === "soda"
        ? sodaQrStatus
        : neteaseQrStatus;
  const activeLoginStatus = providerStatuses[loginProvider] ?? null;
  const activeCookieInputRef =
    loginProvider === "netease"
      ? neteaseCookieInputRef
      : loginProvider === "soda"
        ? sodaCookieInputRef
        : qqCookieInputRef;

  return (
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
        onMinimize={() => void minimizeWindow()}
        onToggleMaximize={() => void toggleWindowMaximize()}
        onClose={() => void closeWindow()}
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
        client={sidecarClient}
        onFocus={focusSearch}
        onUpload={openLocalFileImport}
        onClearCustomCover={clearCustomCoverImage}
        onResultPlay={enterPlaybackSurface}
        onResultNext={insertSearchResultNext}
        onResultLike={(track) => void toggleLikeTrack(track)}
        onResultCollect={openCollectPicker}
        onSharedPlaylistImport={importSharedPlaylistFromText}
        onArtistSearch={searchArtistFromResult}
        isResultLiked={(track) => {
          const key = trackLikeKey(track);
          return key ? likedSongMap[key] === true : false;
        }}
        isResultLikeBusy={(track) => {
          const key = trackLikeKey(track);
          return key ? likeBusyMap[key] === true : false;
        }}
        hasCustomCover={currentHasCustomCover}
        peek={emptyHomeActive || searchKeyword.trim().length > 0}
        requestedMode={searchModeRequest}
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
        onRefresh={() => sidecarClient && void refreshShelfPlaylists(sidecarClient)}
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
    </div>
  );
}

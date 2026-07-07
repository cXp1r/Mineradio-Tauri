import type {
  LyricPayload,
  PlaylistDetail,
  PlaylistSummary,
  SongLikeAck,
  SongLikeCheckAck,
  Track,
  TrackQualityAvailability,
  TrackQualityOption
} from "@mineradio/shared";
import {
  ProviderError,
  ProviderNotImplementedError,
  type ProviderAdapter,
  type ProviderLoginStatus,
  type SongUrlOptions,
  type SongUrlResult
} from "../provider-adapter";
import { getProviderCookie } from "../../services/auth-session";
import { createSodaClient, type SodaClient, type SodaClientDeps } from "./soda-client";
import { mapSodaLyricToPayload, mapSodaPlaylistDetailToDetail, mapSodaPlaylistToSummary, mapSodaSongToTrack, normalizeProviderImageUrl, type SodaPlaylistBody, type SodaPlaylistDetailBody, type SodaSong } from "./map";

const SODA_PROVIDER_ID = "soda";

export interface SodaAdapterDeps extends SodaClientDeps {
  client?: SodaClient;
}

function fail(action: string): never {
  throw new ProviderNotImplementedError(SODA_PROVIDER_ID, action, `soda provider scaffold is not wired for ${action}`);
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = readString(value);
    if (text) return text;
  }
  return "";
}

type SodaPlaybackQualityOption = {
  level: SongUrlResult["level"];
  sodaLevel: string;
  label: string;
  aliases: string[];
};

type SodaPlayInfoEntry = {
  level?: SongUrlResult["level"];
  quality: string;
  playUrl: string;
  playAuth: string;
  filename?: string;
  raw: Record<string, unknown>;
};

const SODA_PLAYBACK_QUALITY_OPTIONS: SodaPlaybackQualityOption[] = [
  { level: "jymaster", sodaLevel: "spatial", label: "录音室", aliases: ["录音室音质", "spatial"] },
  { level: "hires", sodaLevel: "hi_res", label: "超清全景声", aliases: ["hi_res", "hi-res", "surround", "全景声"] },
  { level: "lossless", sodaLevel: "highest", label: "无损音质", aliases: ["highest", "无损"] },
  { level: "exhigh", sodaLevel: "higher", label: "极高音质", aliases: ["higher", "极高"] },
  { level: "standard", sodaLevel: "medium", label: "标准音质", aliases: ["medium", "标准"] }
];

function sodaQualityOptionForLevel(level: SongUrlResult["level"]): SodaPlaybackQualityOption {
  return SODA_PLAYBACK_QUALITY_OPTIONS.find((option) => option.level === level) ?? SODA_PLAYBACK_QUALITY_OPTIONS[1];
}

function mapSodaPlaybackQuality(value: string): SongUrlResult["level"] | undefined {
  const text = value.trim().toLowerCase();
  for (const option of SODA_PLAYBACK_QUALITY_OPTIONS) {
    const raw = option.sodaLevel.toLowerCase();
    if (text === raw || text.includes(raw)) return option.level;
    if (option.aliases.some((alias) => text === alias.toLowerCase() || text.includes(alias.toLowerCase()))) {
      return option.level;
    }
  }
  if (text.includes("master") || text.includes("jymaster")) return "jymaster";
  if (text.includes("320") || text.includes("exhigh")) return "exhigh";
  if (text.includes("hires") || text.includes("hi-res")) return "hires";
  if (text.includes("flac") || text.includes("lossless") || text.includes("sq")) return "lossless";
  if (text.includes("high")) return "exhigh";
  if (text.includes("128") || text.includes("standard") || text.includes("normal")) return "standard";
  return undefined;
}

function readNumber(value: unknown): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isFinite(num) ? num : 0;
}

function readPlayInfoList(body: unknown): Record<string, unknown>[] {
  const root = asObj(body);
  if (!root) return [];
  const result = asObj(root.Result);
  const data = asObj(result?.Data);
  const list = data?.PlayInfoList ?? [];
  return Array.isArray(list) ? list.map((item) => asObj(item)).filter(Boolean) as Record<string, unknown>[] : [];
}

function readSodaPlayInfoTable(list: Record<string, unknown>[]): Record<string, SodaPlayInfoEntry> {
  const table: Record<string, SodaPlayInfoEntry> = {};
  for (const playInfo of list) {
    const playUrl = firstString(playInfo.MainPlayUrl, playInfo.BackupPlayUrl);
    const playAuth = firstString(playInfo.PlayAuth);
    if (!playUrl || !playAuth) continue;
    const rawQuality = firstString(playInfo.Quality).trim();
    const level = mapSodaPlaybackQuality(rawQuality);
    const key = level ?? rawQuality.toLowerCase();
    if (!key || table[key]) continue;
    table[key] = {
      level,
      quality: rawQuality,
      playUrl,
      playAuth,
      filename: firstString(playInfo.FileID) || undefined,
      raw: playInfo
    };
  }
  return table;
}

function pickSodaPlayInfoEntry(
  table: Record<string, SodaPlayInfoEntry>,
  requested: SongUrlResult["level"] | undefined
): SodaPlayInfoEntry | null {
  if (requested) {
    const direct = table[requested];
    if (direct) return direct;
  }
  const first = Object.values(table)[0];
  return first ?? null;
}

function readSodaTrackPlayer(resp: unknown): Record<string, unknown> | null {
  const root = asObj(resp);
  return asObj(root?.track_player);
}

function readSodaLyricTranslation(value: unknown): string {
  let translations = asObj(value) ?? {};
  let cn = readString(translations.cn) ?? "";
  return cn
}

function readSodaCollectedState(resp: unknown): boolean | undefined {
  const root = asObj(resp);
  if (!root) return undefined;
  const track = asObj(root.track);
  const state = asObj(track?.state);
  const value = state?.is_collected;
  if (typeof value === "boolean") return value;
  return undefined;
}

function readSodaTrackObject(resp: unknown): Record<string, unknown> | null {
  const root = asObj(resp);
  return asObj(root?.track);
}

function readSodaBitRates(track: Record<string, unknown> | null): Record<string, unknown>[] {
  const bitRates = track?.bit_rates;
  return Array.isArray(bitRates)
    ? bitRates.map((item) => asObj(item)).filter(Boolean) as Record<string, unknown>[]
    : [];
}

function readSodaQualityList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => firstString(item).trim().toLowerCase()).filter(Boolean)
    : [];
}

function sodaQualityDetail(rawQuality: string, labelInfo: Record<string, unknown> | null): string {
  const quality = rawQuality.trim().toLowerCase();
  const vipPlayQualities = readSodaQualityList(labelInfo?.quality_only_vip_can_play);
  const vipDownloadQualities = readSodaQualityList(labelInfo?.quality_only_vip_can_download);
  const vipPlayable = labelInfo?.only_vip_playable === true || vipPlayQualities.includes(quality);
  const vipDownload = labelInfo?.only_vip_download === true || vipDownloadQualities.includes(quality);
  const parts = [vipPlayable ? "VIP 可播放" : "可播放"];
  if (vipDownload) parts.push("VIP 可下载");
  return parts.join(" · ");
}

function sodaQualityOptionFromBitRate(
  bitRate: Record<string, unknown>,
  labelInfo: Record<string, unknown> | null
): TrackQualityOption | null {
  const rawQuality = firstString(bitRate.quality).trim();
  if (!rawQuality || rawQuality.toLowerCase() === "lossless") return null;
  const level = mapSodaPlaybackQuality(rawQuality);
  if (!level) return null;
  const option = sodaQualityOptionForLevel(level);
  const br = readNumber(bitRate.br);
  const size = readNumber(bitRate.size);
  return {
    provider: SODA_PROVIDER_ID,
    id: level,
    label: option.label,
    requestQuality: level,
    level,
    type: rawQuality,
    detail: sodaQualityDetail(rawQuality, labelInfo),
    ...(br > 0 ? { br } : {}),
    ...(size > 0 ? { size } : {}),
    source: "declared"
  };
}

function sodaQualityRank(level: string | undefined): number {
  const index = SODA_PLAYBACK_QUALITY_OPTIONS.findIndex((option) => option.level === level);
  return index >= 0 ? index : SODA_PLAYBACK_QUALITY_OPTIONS.length;
}

function readSodaSearchList(body: unknown): unknown[] {
  const root = asObj(body);
  if (!root) return [];
  if (!Array.isArray(root.result_groups)) return [];
  return root.result_groups.flatMap(group => {
    const items = asObj(group)?.data;
    if (!Array.isArray(items)) return [];
    return items.flatMap(item => {
      const obj = asObj(item);
      const meta = asObj(obj?.meta);
      if (meta?.item_type !== "track") return [];
      const track = asObj(asObj(obj?.entity)?.track);
      return track ? [track] : [];
    });
  });
}

function readSodaPlaylistList(body: unknown): unknown[] {
  const root = asObj(body);
  if (!root) return [];
  return Array.isArray(root.playlists) ? root.playlists : [];
}

function readSodaPlaylistDetail(body: unknown): SodaPlaylistDetailBody | null {
  const root = asObj(body);
  if (!root) return null;
  const playlist = asObj(root.playlist);
  const mediaResources = Array.isArray(root.media_resources) ? root.media_resources : [];
  if (playlist || mediaResources.length > 0) {
    return {
      playlist: (playlist ?? undefined) as SodaPlaylistBody | undefined,
      media_resources: mediaResources as NonNullable<SodaPlaylistDetailBody["media_resources"]>
    };
  }
  return null;
}

function readSodaAvatarUrl(value: unknown): string {
  const obj = asObj(value);
  if (!obj) return "";
  const urls = Array.isArray(obj.urls) ? obj.urls : [];
  return firstString(urls[0], obj.uri);
}

function readSodaLoginStatus(body: unknown): ProviderLoginStatus {
  const root = asObj(body);
  const statusCode = typeof root?.status_code === "number" ? root.status_code : NaN;
  const info = asObj(root?.my_info);
  const userId = firstString(info?.id);
  const nickname = firstString(info?.nickname);
  const mediumAvatar = readSodaAvatarUrl(info?.medium_avatar_url);
  const avatarUrl = normalizeProviderImageUrl(mediumAvatar);
  const vipStage = firstString(info?.vip_stage);
  const isVip = info?.is_vip === true;
  const isSvip = isVip && vipStage === "svip";
  const vipLevel = isVip ? (isSvip ? "svip" : "vip") : "none";
  const vipType = vipLevel === "svip" ? 11 : vipLevel === "vip" ? 1 : 0;
  const vipLabel = isVip ? vipStage : "";
  const loggedIn = statusCode === 0 && !!userId;
  const status: ProviderLoginStatus = {
    provider: SODA_PROVIDER_ID,
    loggedIn
  };
  if (loggedIn) {
    if (nickname) status.nickname = nickname;
    if (avatarUrl) status.avatarUrl = avatarUrl;
    if (userId) status.userId = userId;
    if (Number.isFinite(vipType)) status.vipType = vipType;
    status.vipLevel = vipLevel;
    status.isVip = isVip || isSvip;
    status.isSvip = isSvip;
    if (vipLabel) status.vipLabel = vipLabel;
    if (vipStage) status.vipLevelName = vipStage;
  }
  return status;
}

export function createSodaAdapter(deps: SodaAdapterDeps): ProviderAdapter {
  const client = deps.client ?? createSodaClient(deps);

  return {
    id: SODA_PROVIDER_ID,
    async search({ keyword, limit }: { keyword: string; limit: number }): Promise<Track[]> {
      const resp = await client.search({ keyword, limit });
      return readSodaSearchList(resp.body)
        .slice(0, Math.max(0, limit))
        .map(item => mapSodaSongToTrack(item as SodaSong));
    },
    async songUrl(track: Track, opts?: SongUrlOptions): Promise<SongUrlResult> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) {
        throw new ProviderError(SODA_PROVIDER_ID, "LOGIN_REQUIRED", "soda song-url requires login", {
          retryable: true,
          action: "login"
        });
      }
      const requested = opts?.quality ?? "exhigh";

      const detail = await client.trackDetail(track.sourceId);
      const player = readSodaTrackPlayer(detail.body);
      const infoUrl = firstString(player?.url_player_info);
      if (!infoUrl) {
        throw new ProviderError(SODA_PROVIDER_ID, "UNAVAILABLE", `soda track ${track.sourceId} missing url_player_info`);
      }

      const headers: HeadersInit = {};
      headers.cookie = cfg.cookie;
      const infoResp = await (deps.fetch ?? fetch)(infoUrl, { method: "GET", headers });
      if (!infoResp.ok) {
        throw new ProviderError(
          SODA_PROVIDER_ID,
          "UNAVAILABLE",
          `soda url_player_info request failed with status ${infoResp.status}`
        );
      }
      const infoBody = await infoResp.json();
      const playInfoTable = readSodaPlayInfoTable(readPlayInfoList(infoBody));
      const playInfo = pickSodaPlayInfoEntry(playInfoTable, requested);
      if (!playInfo) {
        throw new ProviderError(SODA_PROVIDER_ID, "UNAVAILABLE", `soda track ${track.sourceId} missing play info`);
      }
      // playAuth is publicly returned by url_player_info, so we intentionally pass it along with the playback URL.
      const mappedQuality = playInfo.level;
      const quality = playInfo.quality;
      const url = playInfo.playUrl;
      const playAuth = playInfo.playAuth;
      const qualityOption = mappedQuality ? sodaQualityOptionForLevel(mappedQuality) : undefined;
      const result: SongUrlResult = {
        url: `/providers/soda/audio-proxy?url=${encodeURIComponent(url)}&playAuth=${encodeURIComponent(playAuth)}`,
        proxied: true,
        provider: SODA_PROVIDER_ID,
        trial: false,
        playable: true,
        level: mappedQuality,
        quality: qualityOption?.label || quality || undefined,
        filename: playInfo.filename
      };
      return result;
    },
    async trackQualities(track: Track): Promise<TrackQualityAvailability> {
      const resp = await client.trackDetail(track.sourceId);
      const sodaTrack = readSodaTrackObject(resp.body);
      const labelInfo = asObj(sodaTrack?.label_info);
      const byLevel = new Map<string, TrackQualityOption>();
      for (const bitRate of readSodaBitRates(sodaTrack)) {
        const option = sodaQualityOptionFromBitRate(bitRate, labelInfo);
        if (!option || byLevel.has(option.id)) continue;
        byLevel.set(option.id, option);
      }
      const qualities = [...byLevel.values()].sort((a, b) =>
        sodaQualityRank(a.level ?? a.id) - sodaQualityRank(b.level ?? b.id)
      );
      return {
        provider: SODA_PROVIDER_ID,
        trackId: track.sourceId,
        defaultQuality:
          qualities.find((quality) => quality.requestQuality === "exhigh")?.requestQuality ??
          qualities[0]?.requestQuality,
        qualities
      };
    },
    async lyric(track: Track): Promise<LyricPayload> {
      const resp = await client.trackDetail(track.sourceId);
      const root = asObj(resp.body);
      const lyric = asObj(root?.lyric);
      const trans = readSodaLyricTranslation(lyric?.translations);
      return mapSodaLyricToPayload({
        trackId: track.sourceId,
        lyric: readString(lyric?.content),
        trans,
      });
    },
    async playlistList(): Promise<PlaylistSummary[]> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) return [];
      const resp = await client.playlistList();
      return readSodaPlaylistList(resp.body)
        .map(item => mapSodaPlaylistToSummary(item as SodaPlaylistBody));
    },
    async playlistDetail(id: string): Promise<PlaylistDetail> {
      const resp = await client.playlistDetail(id);
      const playlist = readSodaPlaylistDetail(resp.body);
      return mapSodaPlaylistDetailToDetail(playlist, id);
    },
    async likeSong(id: string, liked: boolean): Promise<SongLikeAck> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) {
        throw new ProviderError(SODA_PROVIDER_ID, "LOGIN_REQUIRED", "soda like-song requires login", {
          retryable: true,
          action: "login"
        });
      }
      const cleanId = id.trim();
      const resp = await client.collectionMedia(cleanId, liked);
      const body = asObj(resp.body) ?? {};

      const info = liked ? body.collected_media : body.deleted_media;
      if (!info) {
        const status_info = asObj(body.status_info) ?? {};
        const status_msg = readString(status_info.status_msg) ?? "";
        throw new ProviderError(
          SODA_PROVIDER_ID,
          "UNAVAILABLE",
          status_msg || `soda like-song failed with status ${resp.status}`
        );
      }

      return {
        provider: SODA_PROVIDER_ID,
        id: cleanId,
        liked,
        code: resp.status
      };
    },
    async checkSongLikes(ids: string[]): Promise<SongLikeCheckAck> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) {
        throw new ProviderError(SODA_PROVIDER_ID, "LOGIN_REQUIRED", "soda like-check requires login", {
          retryable: true,
          action: "login"
        });
      }
      const cleanIds = ids.map(String).map((id) => id.trim()).filter(Boolean);
      if (cleanIds.length === 0) {
        return { provider: SODA_PROVIDER_ID, ids: [], liked: {} };
      }

      const settled = await Promise.allSettled(
        cleanIds.map(async (id) => {
          const resp = await client.trackDetail(id);
          const collected = readSodaCollectedState(resp.body);
          return [id, collected === true] as const;
        })
      );

      const liked: Record<string, boolean> = {};
      for (const result of settled) {
        if (result.status === "fulfilled") {
          const [id, collected] = result.value;
          liked[id] = collected;
          continue;
        }
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        throw new ProviderError(SODA_PROVIDER_ID, "UNAVAILABLE", `soda like-check failed: ${msg}`);
      }

      return {
        provider: SODA_PROVIDER_ID,
        ids: cleanIds,
        liked
      };
    },
    async loginStatus(): Promise<ProviderLoginStatus> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) return { provider: SODA_PROVIDER_ID, loggedIn: false };
      const resp = await client.loginStatus();
      return readSodaLoginStatus(resp.body);
    },
    async logout(): Promise<void> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) {
        throw new ProviderNotImplementedError(SODA_PROVIDER_ID, "no-session");
      }
      await client.logout();
    }
  };
}

export const sodaAdapter: ProviderAdapter = createSodaAdapter({
  getConfig() {
    return { cookie: getProviderCookie("soda") };
  }
});

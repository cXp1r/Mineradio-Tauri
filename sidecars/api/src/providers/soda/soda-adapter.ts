import type {
  LyricPayload,
  PlaylistDetail,
  PlaylistSummary,
  SongLikeAck,
  SongLikeCheckAck,
  Track
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

function mapSodaPlaybackQuality(value: string): SongUrlResult["level"] | undefined {
  const text = value.toLowerCase();
  if (text.includes("master") || text.includes("jymaster")) return "jymaster";
  if (text.includes("hires") || text.includes("hi-res") || text.includes("high")) return "hires";
  if (text.includes("flac") || text.includes("lossless") || text.includes("sq")) return "lossless";
  if (text.includes("320") || text.includes("exhigh") || text.includes("high")) return "exhigh";
  if (text.includes("128") || text.includes("standard") || text.includes("normal")) return "standard";
  return undefined;
}

function readPlayInfoList(body: unknown): Record<string, unknown>[] {
  const root = asObj(body);
  if (!root) return [];
  const result = asObj(root.Result) ?? asObj(root.result);
  const data = asObj(result?.Data) ?? asObj(result?.data) ?? asObj(root.Data) ?? asObj(root.data);
  const list = data?.PlayInfoList ?? data?.playInfoList ?? [];
  return Array.isArray(list) ? list.map((item) => asObj(item)).filter(Boolean) as Record<string, unknown>[] : [];
}

function readSodaTrackPlayer(resp: unknown): Record<string, unknown> | null {
  const root = asObj(resp);
  const data = asObj(root?.data) ?? root;
  const player = asObj(data?.track_player) ?? asObj(root?.track_player);
  return player;
}

function readSodaLyricTranslation(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asObj(value);
  if (!obj) return "";
  const direct = firstString(obj.content, obj.text, obj.lyric);
  if (direct) return direct;
  const nested = asObj(obj.cn) ?? asObj(obj.zh) ?? asObj(obj.translation) ?? asObj(obj.trans);
  if (nested) {
    const fromNested = firstString(nested.content, nested.text, nested.lyric);
    if (fromNested) return fromNested;
  }
  const translations = asObj(obj.translations) ?? asObj(obj.lang_translations);
  if (translations) {
    for (const item of Object.values(translations)) {
      const nestedText = readSodaLyricTranslation(item);
      if (nestedText) return nestedText;
    }
  }
  return "";
}

function readSodaCollectedState(resp: unknown): boolean | undefined {
  const root = asObj(resp);
  if (!root) return undefined;
  const data = asObj(root.data) ?? root;
  const state = asObj(data.state) ?? asObj(root.state);
  const value = state?.is_collected;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "1" || text === "true" || text === "yes" || text === "y") return true;
    if (text === "0" || text === "false" || text === "no" || text === "n" || text === "") return false;
  }
  return undefined;
}

function readSodaSearchList(body: unknown): unknown[] {
  const root = asObj(body);
  if (!root) return [];
  if (Array.isArray(root.result_groups)) {
    return root.result_groups.flatMap(group => {
      const items = asObj(group)?.data;
      if (!Array.isArray(items)) return [];
      return items.flatMap(item => {
        const track = asObj(asObj(item)?.entity)?.track;
        return track ? [track] : [];
      });
    });
  }
  if (Array.isArray(root.list)) return root.list;
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.tracks)) return root.tracks;
  if (Array.isArray(root.songs)) return root.songs;

  const data = asObj(root.data);
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.tracks)) return data.tracks;
  if (data && Array.isArray(data.songs)) return data.songs;
  if (data && Array.isArray(data.result_groups)) {
    return data.result_groups.flatMap(group => {
      const items = asObj(group)?.data;
      if (!Array.isArray(items)) return [];
      return items.flatMap(item => {
        const track = asObj(asObj(item)?.entity)?.track;
        return track ? [track] : [];
      });
    });
  }

  return [];
}

function readSodaPlaylistList(body: unknown): unknown[] {
  const root = asObj(body);
  if (!root) return [];
  if (Array.isArray(root.list)) return root.list;
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.playlists)) return root.playlists;
  if (Array.isArray(root.data)) return root.data;

  const data = asObj(root.data);
  if (!data) return [];
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.playlists)) return data.playlists;
  if (Array.isArray(data.playlist)) return data.playlist;
  if (Array.isArray(data.collection)) return data.collection;
  return [];
}

function readSodaPlaylistDetail(body: unknown): SodaPlaylistDetailBody | null {
  const root = asObj(body);
  if (!root) return null;
  const data = asObj(root.data);
  const playlist = asObj(root.playlist) ?? asObj(data?.playlist);
  const mediaResources =
    (Array.isArray(root.media_resources) ? root.media_resources : undefined) ??
    (Array.isArray(data?.media_resources) ? data?.media_resources : undefined) ??
    (Array.isArray(root.mediaResources) ? root.mediaResources : undefined) ??
    (Array.isArray(data?.mediaResources) ? data?.mediaResources : undefined) ??
    [];
  if (playlist || mediaResources.length > 0) {
    return {
      playlist: (playlist ?? undefined) as SodaPlaylistBody | undefined,
      media_resources: mediaResources as NonNullable<SodaPlaylistDetailBody["media_resources"]>
    };
  }
  const fromList = readSodaPlaylistList(root);
  if (fromList.length > 0) {
    const first = asObj(fromList[0]);
    if (first) {
      return { playlist: first as SodaPlaylistBody };
    }
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
  const data = asObj(root?.data) ?? root;
  const statusCodeRaw = root?.status_code ?? data?.status_code;
  const statusCode = typeof statusCodeRaw === "number" ? statusCodeRaw : Number(statusCodeRaw);
  const info = asObj(root?.my_info) ?? asObj(data?.my_info);
  const userId = firstString(info?.id, info?.douyin_id);
  const nickname = firstString(info?.nickname, info?.public_name);
  const mediumAvatar = readSodaAvatarUrl(info?.medium_avatar_url);
  const largerAvatar = readSodaAvatarUrl(info?.larger_avatar_url);
  const avatarUrl = normalizeProviderImageUrl(firstString(mediumAvatar, largerAvatar));
  const vipStage = firstString(info?.vip_stage);
  const isVip = info?.is_vip === true;
  const isSvip = /svip|super/i.test(vipStage);
  const vipLevel = isSvip ? "svip" : isVip ? "vip" : "none";
  const vipType = vipLevel === "svip" ? 11 : vipLevel === "vip" ? 1 : 0;
  const vipLabel = vipStage || (vipLevel === "svip" ? "SVIP" : vipLevel === "vip" ? "VIP" : "");
  const vipLevelName = vipStage || undefined;
  const loggedIn = statusCode === 0 ? !!userId || info != null : !!info && !!userId;
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
    if (vipLevelName) status.vipLevelName = vipLevelName;
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
    async songUrl(track: Track, __?: SongUrlOptions): Promise<SongUrlResult> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) {
        throw new ProviderError(SODA_PROVIDER_ID, "LOGIN_REQUIRED", "soda song-url requires login", {
          retryable: true,
          action: "login"
        });
      }

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
      const playInfoList = readPlayInfoList(infoBody);
      const playInfo = playInfoList[0];
      if (!playInfo) {
        throw new ProviderError(SODA_PROVIDER_ID, "UNAVAILABLE", `soda track ${track.sourceId} missing play info`);
      }
      const url = firstString(playInfo.MainPlayUrl, playInfo.BackupPlayUrl);
      if (!url) {
        throw new ProviderError(SODA_PROVIDER_ID, "UNAVAILABLE", `soda track ${track.sourceId} missing play url`);
      }
      const playAuth = firstString(playInfo.PlayAuth);
      if (!playAuth) {
        throw new ProviderError(SODA_PROVIDER_ID, "UNAVAILABLE", `soda track ${track.sourceId} missing play auth`);
      }
      // playAuth is publicly returned by url_player_info, so we intentionally pass it along with the playback URL.
      const quality = firstString(playInfo.Quality);
      const filename = firstString(playInfo.FileID);
      const result: SongUrlResult = {
        url: `/providers/soda/audio-proxy?url=${encodeURIComponent(url)}&playAuth=${encodeURIComponent(playAuth)}`,
        proxied: true,
        provider: SODA_PROVIDER_ID,
        trial: false,
        playable: true,
        level: mapSodaPlaybackQuality(quality),
        quality: quality || undefined,
        filename: filename || undefined
      };
      return result;
    },
    async lyric(track: Track): Promise<LyricPayload> {
      const resp = await client.trackDetail(track.sourceId);
      const root = asObj(resp.body);
      const data = asObj(root?.data) ?? root;
      const lyric = asObj(data?.lyric);
      const trans = readSodaLyricTranslation(lyric?.translations) || readSodaLyricTranslation(lyric?.lang_translations);
      return mapSodaLyricToPayload({
        trackId: track.sourceId,
        lyric: readString(lyric?.content),
        trans,
      });
    },
    async playlistList(): Promise<PlaylistSummary[]> {
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
      const message = typeof body.message === "string" ? body.message : "";
      if (resp.status < 200 || resp.status >= 300) {
        throw new ProviderError(
          SODA_PROVIDER_ID,
          "UNAVAILABLE",
          message || `soda like-song failed with status ${resp.status}`
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

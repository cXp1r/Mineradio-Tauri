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
import { createSodaClient, type SodaClient, type SodaClientDeps } from "./soda-client";
import { mapSodaLyricToPayload, mapSodaPlaylistToDetail, mapSodaPlaylistToSummary, mapSodaSongToTrack, type SodaSong } from "./map";

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
      const quality = firstString(playInfo.Quality);
      const filename = firstString(playInfo.FileID);
      const result: SongUrlResult = {
        url,
        proxied: false,
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
      const transMap = asObj(lyric?.lang_translations);
      const trans = transMap
        ? Object.values(transMap)
            .map(value => asObj(value)?.content)
            .map(readString)
            .filter(Boolean)
            .join("\n")
        : "";
      return mapSodaLyricToPayload({
        trackId: track.sourceId,
        lyric: readString(lyric?.content),
        trans
      });
    },
    async playlistList(): Promise<PlaylistSummary[]> {
      return fail("playlistList");
    },
    async playlistDetail(_: string): Promise<PlaylistDetail> {
      return fail("playlistDetail");
    },
    async likeSong(_: string, __: boolean): Promise<SongLikeAck> {
      return fail("likeSong");
    },
    async checkSongLikes(_: string[]): Promise<SongLikeCheckAck> {
      return fail("checkSongLikes");
    },
    async loginStatus(): Promise<ProviderLoginStatus> {
      return fail("loginStatus");
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
    return {};
  }
});

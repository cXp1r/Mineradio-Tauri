import type {
  Track,
  PlaylistSummary,
  PlaylistDetail,
  LyricPayload
} from "@mineradio/shared";
import {
  ProviderError,
  ProviderNotImplementedError,
  type ProviderAdapter,
  type ProviderLoginStatus,
  type SongUrlOptions,
  type SongUrlResult
} from "../provider-adapter";
import { hanaClient, getConfig } from "./hana-client";
import {
  mapHanaSongToTrack,
  mapHanaLyricToPayload,
  mapHanaPlaylistToDetail,
  mapPlayable,
  type HanaSong,
  type HanaPlaylistBody
} from "./map";

export interface NeteaseHanaCall {
  (
    query: Record<string, unknown>,
    config?: { cookie?: string }
  ): Promise<{ body: unknown }>;
}

export interface NeteaseHanaDeps {
  cloudsearch: NeteaseHanaCall;
  songDetail: NeteaseHanaCall;
  songUrlV1: NeteaseHanaCall;
  lyric: NeteaseHanaCall;
  lyricNew: NeteaseHanaCall;
  playlistDetail: NeteaseHanaCall;
  playlistCatlist: NeteaseHanaCall;
  loginStatus: NeteaseHanaCall;
  logout: NeteaseHanaCall;
  getConfig(): { cookie?: string };
}

function cast(fn: unknown): NeteaseHanaCall {
  return fn as unknown as NeteaseHanaCall;
}

const defaultDeps: NeteaseHanaDeps = {
  cloudsearch: cast(hanaClient.cloudsearch),
  songDetail: cast(hanaClient.songDetail),
  songUrlV1: cast(hanaClient.songUrlV1),
  lyric: cast(hanaClient.lyric),
  lyricNew: cast(hanaClient.lyricNew),
  playlistDetail: cast(hanaClient.playlistDetail),
  playlistCatlist: cast(hanaClient.playlistCatlist),
  loginStatus: cast(hanaClient.loginStatus),
  logout: cast(hanaClient.logout),
  getConfig
};

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function cfgOf(deps: NeteaseHanaDeps): { cookie?: string } {
  const cfg = deps.getConfig();
  return cfg.cookie ? { cookie: cfg.cookie } : {};
}

const STATE_TO_CODE: Record<string, string> = {
  login_required: "LOGIN_REQUIRED",
  vip_required: "VIP_REQUIRED",
  paid_required: "PAID_REQUIRED",
  trial_only: "TRIAL_ONLY",
  copyright_unavailable: "COPYRIGHT_UNAVAILABLE",
  unavailable: "UNAVAILABLE",
  unknown: "UNAVAILABLE"
};

const NETEASE_QUALITY_LABELS = {
  jymaster: "超清母带",
  hires: "高清臻音",
  lossless: "无损",
  exhigh: "极高",
  standard: "标准"
} as const;

function requestedQuality(opts?: SongUrlOptions) {
  return opts?.quality ?? "hires";
}

export function createNeteaseAdapter(
  deps: NeteaseHanaDeps = defaultDeps
): ProviderAdapter {
  return {
    id: "netease",
    async search({ keyword, limit }): Promise<Track[]> {
      const cfg = cfgOf(deps);
      const resp = await deps.cloudsearch({ keywords: keyword, limit, type: 1 }, cfg);
      const body = asObj(resp.body);
      const result = body ? asObj(body.result) : null;
      const songsRaw = result && Array.isArray(result.songs) ? result.songs : [];
      return (songsRaw as unknown[]).map(s => mapHanaSongToTrack(s as HanaSong));
    },
    async songUrl(track, opts): Promise<SongUrlResult> {
      const cfg = cfgOf(deps);
      const quality = requestedQuality(opts);
      const resp = await deps.songUrlV1(
        { id: track.sourceId, level: quality },
        cfg
      );
      const body = asObj(resp.body);
      const dataArr = body && Array.isArray(body.data) ? (body.data as unknown[]) : [];
      const targetId = String(track.sourceId);
      const matched =
        dataArr.find(d => {
          const o = asObj(d);
          return o != null && String(o.id) === targetId;
        }) ?? dataArr[0];
      const datum = asObj(matched);
      if (!datum) {
        throw new ProviderError(
          "netease",
          "UNAVAILABLE",
          `netease song-url returned no data for ${track.sourceId}`
        );
      }
      const fee = datum.fee;
      const code = datum.code;
      const freeTrialInfo = datum.freeTrialInfo;
      const url = typeof datum.url === "string" ? datum.url : null;
      const state = mapPlayable(
        fee,
        code,
        freeTrialInfo,
        !!deps.getConfig().cookie,
        url
      );
      if (state !== "playable") {
        throw new ProviderError(
          "netease",
          STATE_TO_CODE[state] ?? "UNAVAILABLE",
          `netease song-url ${track.sourceId} state ${state}`,
          { retryable: state === "login_required" }
        );
      }
      if (!url) {
        throw new ProviderError(
          "netease",
          "UNAVAILABLE",
          `netease song-url missing url for ${track.sourceId}`
        );
      }
      const br = typeof datum.br === "number" && Number.isFinite(datum.br) ? Math.max(0, Math.floor(datum.br)) : undefined;
      return {
        url,
        proxied: false,
        level: quality,
        quality: NETEASE_QUALITY_LABELS[quality],
        br,
        requestedQuality: quality
      };
    },
    async lyric(track): Promise<LyricPayload> {
      const cfg = cfgOf(deps);
      let body: unknown;
      try {
        body = (await deps.lyricNew({ id: track.sourceId }, cfg)).body;
      } catch {
        body = (await deps.lyric({ id: track.sourceId }, cfg)).body;
      }
      const o = asObj(body) ?? {};
      const lrc = asObj(o.lrc)?.lyric;
      const tlyric = asObj(o.tlyric)?.lyric;
      const klyric = asObj(o.klyric)?.lyric;
      const yrc = asObj(o.yrc)?.lyric;
      return mapHanaLyricToPayload({
        trackId: track.sourceId,
        lrc: typeof lrc === "string" ? lrc : "",
        tlyric: typeof tlyric === "string" ? tlyric : "",
        klyric: typeof klyric === "string" ? klyric : "",
        yrc: typeof yrc === "string" ? yrc : ""
      });
    },
    async playlistList(): Promise<PlaylistSummary[]> {
      throw new ProviderNotImplementedError("netease", "playlist-list-deferred");
    },
    async playlistDetail(id): Promise<PlaylistDetail> {
      const cfg = cfgOf(deps);
      const resp = await deps.playlistDetail({ id }, cfg);
      const body = asObj(resp.body);
      const pl = body ? asObj(body.playlist) : null;
      if (!pl) {
        throw new ProviderError(
          "netease",
          "UNAVAILABLE",
          `netease playlist ${id} missing payload`
        );
      }
      return mapHanaPlaylistToDetail(pl as unknown as HanaPlaylistBody, id);
    },
    async loginStatus(): Promise<ProviderLoginStatus> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) return { provider: "netease", loggedIn: false };
      const resp = await deps.loginStatus({}, { cookie: cfg.cookie });
      const body = asObj(resp.body);
      const data = body ? asObj(body.data) : null;
      const profile = data ? asObj(data.profile) : null;
      if (!profile) return { provider: "netease", loggedIn: false };
      const nickname = typeof profile.nickname === "string" ? profile.nickname : undefined;
      const avatarUrl = typeof profile.avatarUrl === "string" ? profile.avatarUrl : undefined;
      const userId =
        profile.userId != null ? String(profile.userId) : undefined;
      return { provider: "netease", loggedIn: true, nickname, avatarUrl, userId };
    },
    async logout(): Promise<void> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) {
        throw new ProviderNotImplementedError("netease", "no-session");
      }
      await deps.logout({}, { cookie: cfg.cookie });
    }
  };
}

export const neteaseAdapter: ProviderAdapter = createNeteaseAdapter(defaultDeps);

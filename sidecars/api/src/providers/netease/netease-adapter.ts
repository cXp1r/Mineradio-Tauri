import type {
  Track,
  PlaybackQuality,
  PlaylistSummary,
  PlaylistDetail,
  LyricPayload,
  SongLikeAck,
  SongLikeCheckAck,
  PlaylistAddSongAck
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
  mapHanaPlaylistToSummary,
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
  songUrl: NeteaseHanaCall;
  lyric: NeteaseHanaCall;
  lyricNew: NeteaseHanaCall;
  playlistDetail: NeteaseHanaCall;
  playlistCatlist: NeteaseHanaCall;
  userPlaylist: NeteaseHanaCall;
  like: NeteaseHanaCall;
  songLikeCheck: NeteaseHanaCall;
  likelist: NeteaseHanaCall;
  playlistTracks: NeteaseHanaCall;
  playlistTrackAdd: NeteaseHanaCall;
  loginStatus: NeteaseHanaCall;
  logout: NeteaseHanaCall;
  getConfig(): { cookie?: string };
}

export interface NeteaseAdapter extends ProviderAdapter {
  likeSong(id: string, liked: boolean): Promise<SongLikeAck>;
  checkSongLikes(ids: string[]): Promise<SongLikeCheckAck>;
  addSongToPlaylist(playlistId: string, trackId: string): Promise<PlaylistAddSongAck>;
}

function cast(fn: unknown): NeteaseHanaCall {
  return fn as unknown as NeteaseHanaCall;
}

const defaultDeps: NeteaseHanaDeps = {
  cloudsearch: cast(hanaClient.cloudsearch),
  songDetail: cast(hanaClient.songDetail),
  songUrlV1: cast(hanaClient.songUrlV1),
  songUrl: cast(hanaClient.songUrl),
  lyric: cast(hanaClient.lyric),
  lyricNew: cast(hanaClient.lyricNew),
  playlistDetail: cast(hanaClient.playlistDetail),
  playlistCatlist: cast(hanaClient.playlistCatlist),
  userPlaylist: cast(hanaClient.userPlaylist),
  like: cast(hanaClient.like),
  songLikeCheck: cast(hanaClient.songLikeCheck),
  likelist: cast(hanaClient.likelist),
  playlistTracks: cast(hanaClient.playlistTracks),
  playlistTrackAdd: cast(hanaClient.playlistTrackAdd),
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

function requireCookie(deps: NeteaseHanaDeps, action: string): string {
  const cookie = deps.getConfig().cookie;
  if (!cookie) {
    throw new ProviderError(
      "netease",
      "LOGIN_REQUIRED",
      `netease ${action} requires login`,
      { retryable: true, action: "login" }
    );
  }
  return cookie;
}

async function loginStatusOf(deps: NeteaseHanaDeps): Promise<ProviderLoginStatus> {
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

type NeteaseQualityCandidate = {
  level: PlaybackQuality;
  br: number;
  label: string;
};

const NETEASE_QUALITY_CANDIDATES: NeteaseQualityCandidate[] = [
  { level: "jymaster", br: 1999000, label: "超清母带" },
  { level: "hires", br: 1999000, label: "高清臻音" },
  { level: "lossless", br: 1411000, label: "无损" },
  { level: "exhigh", br: 999000, label: "极高" },
  { level: "standard", br: 128000, label: "标准" },
];

function requestedQuality(opts?: SongUrlOptions) {
  return opts?.quality ?? "hires";
}

function qualityCandidatesFrom(target: PlaybackQuality): NeteaseQualityCandidate[] {
  const start = NETEASE_QUALITY_CANDIDATES.findIndex(item => item.level === target);
  return NETEASE_QUALITY_CANDIDATES.slice(start >= 0 ? start : 1);
}

async function requestSongUrlForQuality(
  deps: NeteaseHanaDeps,
  track: Track,
  quality: NeteaseQualityCandidate,
  cfg: { cookie?: string },
): Promise<{ body: unknown }> {
  try {
    return await deps.songUrlV1(
      { id: track.sourceId, level: quality.level },
      cfg
    );
  } catch {
    return await deps.songUrl(
      { id: track.sourceId, br: quality.br },
      cfg
    );
  }
}

function pickSongUrlDatum(body: Record<string, unknown> | null, track: Track): Record<string, unknown> | null {
  const dataArr = body && Array.isArray(body.data) ? (body.data as unknown[]) : [];
  const targetId = String(track.sourceId);
  const matched =
    dataArr.find(d => {
      const o = asObj(d);
      return o != null && String(o.id) === targetId;
    }) ?? dataArr[0];
  return asObj(matched);
}

function responseCode(resp: { body: unknown } | unknown): number {
  const outer = asObj(resp);
  const body = outer && "body" in outer ? asObj(outer.body) : asObj(resp);
  const raw = body?.code ?? outer?.code;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 200;
}

function isSuccessful(resp: { body: unknown } | unknown): boolean {
  const code = responseCode(resp);
  const outer = asObj(resp);
  const body = outer && "body" in outer ? asObj(outer.body) : asObj(resp);
  return code === 200 && !body?.error;
}

function likedRecord(ids: string[], likedIds: string[]): Record<string, boolean> {
  const set = new Set(likedIds.map(String));
  const liked: Record<string, boolean> = {};
  for (const id of ids) liked[id] = set.has(id);
  return liked;
}

export function createNeteaseAdapter(
  deps: NeteaseHanaDeps = defaultDeps
): NeteaseAdapter {
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
      const requested = requestedQuality(opts);
      let trialFallback: SongUrlResult | null = null;
      let lastDatum: Record<string, unknown> | null = null;
      let lastState = "unknown";
      let lastError: unknown = null;
      for (const quality of qualityCandidatesFrom(requested)) {
        try {
          const resp = await requestSongUrlForQuality(deps, track, quality, cfg);
          const datum = pickSongUrlDatum(asObj(resp.body), track);
          if (!datum) continue;
          lastDatum = datum;
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
          lastState = state;
          if (state !== "playable" || !url) continue;
          const br = typeof datum.br === "number" && Number.isFinite(datum.br) ? Math.max(0, Math.floor(datum.br)) : undefined;
          const result = {
            url,
            proxied: false,
            level: quality.level,
            quality: quality.label,
            br,
            requestedQuality: requested
          };
          if (freeTrialInfo != null) {
            trialFallback ??= result;
            continue;
          }
          return result;
        } catch (err) {
          lastError = err;
        }
      }
      if (trialFallback) return trialFallback;
      if (!lastDatum && lastError instanceof ProviderError) throw lastError;
      if (!lastDatum) {
        throw new ProviderError(
          "netease",
          "UNAVAILABLE",
          `netease song-url returned no data for ${track.sourceId}`
        );
      }
      throw new ProviderError(
        "netease",
        STATE_TO_CODE[lastState] ?? "UNAVAILABLE",
        `netease song-url ${track.sourceId} state ${lastState}`,
        { retryable: lastState === "login_required", action: lastState === "login_required" ? "login" : undefined }
      );
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
      const cfg = cfgOf(deps);
      if (!cfg.cookie) return [];
      const status = await loginStatusOf(deps);
      if (!status.loggedIn || !status.userId) return [];
      const resp = await deps.userPlaylist(
        { uid: status.userId, limit: 60 },
        cfg
      );
      const body = asObj(resp.body);
      const list = body && Array.isArray(body.playlist) ? body.playlist : [];
      return list.map(pl => mapHanaPlaylistToSummary(pl as unknown as HanaPlaylistBody));
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
    async likeSong(id, liked): Promise<SongLikeAck> {
      const cookie = requireCookie(deps, "like");
      const resp = await deps.like(
        { id, like: String(liked), timestamp: Date.now() },
        { cookie }
      );
      return {
        provider: "netease",
        id,
        liked,
        code: responseCode(resp)
      };
    },
    async checkSongLikes(ids): Promise<SongLikeCheckAck> {
      const cookie = requireCookie(deps, "like-check");
      const cleanIds = ids.map(String).filter(Boolean);
      if (cleanIds.length === 0) {
        return { provider: "netease", ids: [], liked: {} };
      }

      let likedIds: string[] = [];
      try {
        const numericIds = cleanIds.map(Number).filter(Number.isFinite);
        const checked = await deps.songLikeCheck(
          { ids: JSON.stringify(numericIds), timestamp: Date.now() },
          { cookie }
        );
        const body = asObj(checked.body);
        const data = body?.data ?? body?.ids ?? checked.body;
        if (Array.isArray(data)) {
          likedIds = data.map(String);
        } else {
          const dataObj = asObj(data);
          if (dataObj) {
            likedIds = cleanIds.filter((id) => !!(dataObj[id] ?? dataObj[String(Number(id))]));
          }
        }
      } catch {
        likedIds = [];
      }

      if (likedIds.length === 0) {
        const status = await loginStatusOf(deps);
        if (!status.loggedIn || !status.userId) {
          throw new ProviderError("netease", "LOGIN_REQUIRED", "netease like-check requires login", {
            retryable: true,
            action: "login"
          });
        }
        const resp = await deps.likelist(
          { uid: status.userId, timestamp: Date.now() },
          { cookie }
        );
        const body = asObj(resp.body);
        const list = body && Array.isArray(body.ids) ? body.ids : [];
        likedIds = list.map(String);
      }

      return {
        provider: "netease",
        ids: cleanIds,
        liked: likedRecord(cleanIds, likedIds)
      };
    },
    async addSongToPlaylist(playlistId, trackId): Promise<PlaylistAddSongAck> {
      const cookie = requireCookie(deps, "playlist-add-song");
      const primary = await deps.playlistTracks(
        {
          op: "add",
          pid: playlistId,
          tracks: trackId,
          timestamp: Date.now()
        },
        { cookie }
      );
      let finalResp: { body: unknown } | unknown = primary;
      if (!isSuccessful(primary)) {
        finalResp = await deps.playlistTrackAdd(
          {
            pid: playlistId,
            ids: trackId,
            timestamp: Date.now()
          },
          { cookie }
        );
      }
      const success = isSuccessful(finalResp);
      if (!success) {
        throw new ProviderError(
          "netease",
          "PLAYLIST_ADD_FAILED",
          `netease playlist add failed for ${trackId}`,
          { retryable: false }
        );
      }
      return {
        provider: "netease",
        playlistId,
        trackId,
        success: true,
        code: responseCode(finalResp)
      };
    },
    async loginStatus(): Promise<ProviderLoginStatus> {
      return loginStatusOf(deps);
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

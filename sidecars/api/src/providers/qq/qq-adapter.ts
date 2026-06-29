import type {
  Track,
  PlaybackQuality,
  PlaylistSummary,
  PlaylistDetail,
  LyricPayload
} from "@mineradio/shared";
// NOTE: jsososo/qq-music-api (npm `qq-music-api`@^1.1.2, GPL-3.0) is a singleton.
// qq.setCookie mutates process-wide module state. The sidecar expects at most
// one cookie at a time (via MINERADIO_QQ_COOKIE env) so concurrent provider calls
// race for the singleton is bounded by single-process cookie ownership. If future
// multi-tenant QQ support is added, the wrapper in qq-client.ts must construct a
// new QQMusic instance per call rather than reusing the module singleton.
// logout(): jsososo has no dedicated logout route; the adapter calls
// `deps.logout()` best-effort and swallows; cookie env controls actual session.
import {
  ProviderError,
  ProviderNotImplementedError,
  type ProviderAdapter,
  type ProviderLoginStatus,
  type SongUrlOptions,
  type SongUrlResult
} from "../provider-adapter";
import { qqClient, getConfig } from "./qq-client";
import {
  mapQqSongToTrack,
  mapQqLyricToPayload,
  mapQqPlaylistToSummary,
  mapQqPlaylistToDetail,
  type QqSong,
  type QqPlaylistBody
} from "./map";

export interface QqCall {
  (
    query: Record<string, unknown>,
    config?: { cookie?: string }
  ): Promise<{ body: unknown }>;
}

export interface QqClientDeps {
  search: QqCall;
  songDetail: QqCall;
  songUrl: QqCall;
  lyric: QqCall;
  userSonglists: QqCall;
  userCollectSonglists: QqCall;
  playlistDetail: QqCall;
  addSongToPlaylist: QqCall;
  loginStatus: QqCall;
  logout: QqCall;
  getConfig(): { cookie?: string };
  smartboxSearch?: (keyword: string, limit: number) => Promise<unknown[]>;
  legacyLyric?: QqCall;
}

function cast(fn: unknown): QqCall {
  return fn as unknown as QqCall;
}

const defaultDeps: QqClientDeps = {
  search: cast(qqClient.search),
  songDetail: cast(qqClient.songDetail),
  songUrl: cast(qqClient.songUrl),
  lyric: cast(qqClient.lyric),
  userSonglists: cast(qqClient.userSonglists),
  userCollectSonglists: cast(qqClient.userCollectSonglists),
  playlistDetail: cast(qqClient.playlistDetail),
  addSongToPlaylist: cast(qqClient.addSongToPlaylist),
  loginStatus: cast(qqClient.loginStatus),
  logout: cast(qqClient.logout),
  getConfig,
  smartboxSearch: fallbackSmartboxSearch,
  legacyLyric: legacyQqLyric
};

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function readQqSearchList(body: unknown): unknown[] {
  const root = asObj(body);
  if (!root) return [];
  if (Array.isArray(root.list)) return root.list;

  const data = asObj(root.data);
  if (data && Array.isArray(data.list)) return data.list;

  const song = asObj(data?.song) ?? asObj(root.song);
  if (song && Array.isArray(song.list)) return song.list;

  return [];
}

async function fallbackSmartboxSearch(keyword: string, limit: number): Promise<unknown[]> {
  const params = new URLSearchParams({
    key: keyword,
    format: "json",
    g_tk: "5381"
  });
  const res = await fetch(`https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?${params.toString()}`, {
    headers: {
      Referer: "https://y.qq.com/",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!res.ok) {
    throw new ProviderError("qq", "UNAVAILABLE", `qq smartbox search failed with status ${res.status}`);
  }
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderError("qq", "UNAVAILABLE", "qq smartbox search returned invalid json");
  }
  const root = asObj(payload);
  const data = asObj(root?.data);
  const song = asObj(data?.song);
  const list = song && Array.isArray(song.itemlist) ? song.itemlist : [];
  return list.slice(0, Math.max(0, limit));
}

async function legacyQqLyric(query: Record<string, unknown>, config?: { cookie?: string }): Promise<{ body: unknown }> {
  const songmid = String(query.songmid ?? query.songMID ?? query.mid ?? "").trim();
  if (!songmid) return { body: {} };
  const loginUin = config?.cookie ? (qqUserIdFromCookie(config.cookie) ?? "0") : "0";
  const params = new URLSearchParams({
    songmid,
    songtype: "0",
    format: "json",
    nobase64: "1",
    g_tk: "5381",
    loginUin,
    hostUin: "0",
    inCharset: "utf8",
    outCharset: "utf-8",
    notice: "0",
    platform: "yqq.json",
    needNewCode: "0"
  });
  const headers: Record<string, string> = {
    Referer: "https://y.qq.com/portal/player.html",
    "user-agent": "Mozilla/5.0"
  };
  if (config?.cookie) headers.Cookie = config.cookie;
  const res = await fetch(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${params.toString()}`, { headers });
  if (!res.ok) {
    throw new ProviderError("qq", "UNAVAILABLE", `qq legacy lyric failed with status ${res.status}`);
  }
  return { body: await res.json() };
}

function cfgOf(deps: QqClientDeps): { cookie?: string } {
  const cfg = deps.getConfig();
  return cfg.cookie ? { cookie: cfg.cookie } : {};
}

function parseCookieText(cookie: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const raw = part.trim();
    const index = raw.indexOf("=");
    if (index <= 0) continue;
    const name = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function qqUserIdFromCookie(cookie: string): string | null {
  const obj = parseCookieText(cookie);
  const loginType = Number(obj.login_type);
  const raw =
    loginType === 2
      ? obj.wxuin ?? obj.uin ?? obj.p_uin
      : obj.uin ?? obj.qqmusic_uin ?? obj.wxuin ?? obj.p_uin;
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function readQqPlaylistList(body: unknown): unknown[] {
  const root = asObj(body);
  if (!root) return [];
  if (Array.isArray(root.list)) return root.list;
  const data = asObj(root.data);
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.disslist)) return data.disslist;
  if (data && Array.isArray(data.cdlist)) return data.cdlist;
  return [];
}

function isQqFavoritePlaylist(pl: PlaylistSummary): boolean {
  return /我喜欢|我的喜欢|喜欢的音乐/i.test(pl.name.trim());
}

function isQzoneBackgroundPlaylist(pl: PlaylistSummary, raw: unknown): boolean {
  const obj = asObj(raw);
  const creator =
    typeof obj?.hostname === "string" ? obj.hostname :
    typeof obj?.nick === "string" ? obj.nick :
    typeof obj?.creator === "string" ? obj.creator :
    "";
  const text = `${pl.name} ${creator}`.toLowerCase();
  return /qzone|空间|背景音乐/i.test(text);
}

function mapQqUserPlaylists(rawList: unknown[], seen: Set<string>, subscribed = false): PlaylistSummary[] {
  const out: PlaylistSummary[] = [];
  for (const raw of rawList) {
    const summary = { ...mapQqPlaylistToSummary(raw as QqPlaylistBody), subscribed };
    if (!summary.id || !summary.name || seen.has(summary.id)) continue;
    if (isQzoneBackgroundPlaylist(summary, raw)) continue;
    seen.add(summary.id);
    out.push(summary);
  }
  return out;
}

type QqQualityCandidate = {
  type: string;
  level: PlaybackQuality;
  label: string;
};

const QQ_QUALITY_CANDIDATES: QqQualityCandidate[] = [
  { type: "flac", level: "lossless", label: "无损 FLAC" },
  { type: "320", level: "exhigh", label: "320k MP3" },
  { type: "128", level: "standard", label: "128k MP3" },
];

function qqQualityCandidatesFrom(requested: PlaybackQuality): QqQualityCandidate[] {
  if (requested === "standard") return QQ_QUALITY_CANDIDATES.slice(2);
  if (requested === "exhigh") return QQ_QUALITY_CANDIDATES.slice(1);
  return QQ_QUALITY_CANDIDATES;
}

export function createQqAdapter(
  deps: QqClientDeps = defaultDeps
): ProviderAdapter {
  return {
    id: "qq",
    async search({ keyword, limit }): Promise<Track[]> {
      const cfg = cfgOf(deps);
      let listRaw: unknown[] = [];
      if (deps.smartboxSearch) {
        listRaw = await deps.smartboxSearch(keyword, limit);
      } else {
        const resp = await deps.search(
          { key: keyword, pageNo: 1, pageSize: limit, t: 0, raw: 1 },
          cfg
        );
        listRaw = readQqSearchList(resp.body);
      }
      return (listRaw as unknown[]).map(s =>
        mapQqSongToTrack(s as QqSong)
      );
    },
    async songUrl(track, opts): Promise<SongUrlResult> {
      const cfg = cfgOf(deps);
      const hasCookie = !!deps.getConfig().cookie;
      const requested = opts?.quality ?? "hires";
      let lastError: unknown = null;
      for (const quality of qqQualityCandidatesFrom(requested)) {
        try {
          const body = (await deps.songUrl({ id: track.sourceId, type: quality.type }, cfg)).body;
          const url = typeof body === "string" ? body : null;
          if (url) {
            return {
              url,
              proxied: false,
              level: quality.level,
              quality: quality.label,
              requestedQuality: requested
            };
          }
        } catch (err) {
          if (!hasCookie) {
            throw new ProviderError(
              "qq",
              "LOGIN_REQUIRED",
              `qq song-url ${track.sourceId} requires cookie`,
              { retryable: true, action: "login" }
            );
          }
          lastError = err;
        }
      }
      if (!hasCookie) {
        throw new ProviderError(
          "qq",
          "LOGIN_REQUIRED",
          `qq song-url ${track.sourceId} requires cookie`,
          { retryable: true, action: "login" }
        );
      }
      if (lastError) {
        const msg = lastError instanceof Error ? lastError.message : String(lastError);
        throw new ProviderError(
          "qq",
          "UNAVAILABLE",
          `qq song-url ${track.sourceId} failed: ${msg}`,
          { retryable: false }
        );
      }
      throw new ProviderError(
        "qq",
        "UNAVAILABLE",
        `qq song-url ${track.sourceId} returned no url`
      );
    },
    async lyric(track): Promise<LyricPayload> {
      const cfg = cfgOf(deps);
      const resp = await deps.lyric({ songmid: track.sourceId }, cfg);
      const o = asObj(resp.body) ?? {};
      let lyric = typeof o.lyric === "string" ? o.lyric : "";
      let trans = typeof o.trans === "string" ? o.trans : "";
      const qrc = typeof o.qrc === "string" ? o.qrc : "";
      let source = "qq-musicu";
      if (!lyric.trim() && deps.legacyLyric) {
        try {
          const legacy = asObj((await deps.legacyLyric({ songmid: track.sourceId }, cfg)).body) ?? {};
          const legacyLyric = typeof legacy.lyric === "string" ? legacy.lyric : "";
          const legacyTrans = typeof legacy.trans === "string"
            ? legacy.trans
            : typeof legacy.tlyric === "string"
              ? legacy.tlyric
              : "";
          if (legacyLyric.trim()) {
            lyric = legacyLyric;
            trans = legacyTrans || trans;
            source = "qq-legacy";
          }
        } catch {
          // QQ legacy lyric is best-effort, matching the Electron baseline.
        }
      }
      return mapQqLyricToPayload({
        trackId: track.sourceId,
        lyric,
        trans,
        qrc,
        source
      });
    },
    async playlistList(): Promise<PlaylistSummary[]> {
      const cfg = cfgOf(deps);
      if (!cfg.cookie) return [];
      const userId = qqUserIdFromCookie(cfg.cookie);
      if (!userId) return [];
      const [createdRaw, collectedRaw] = await Promise.allSettled([
        deps.userSonglists({ id: userId }, cfg),
        deps.userCollectSonglists({ id: userId, pageNo: 1, pageSize: 80 }, cfg)
      ]);
      const seen = new Set<string>();
      const created = createdRaw.status === "fulfilled"
        ? mapQqUserPlaylists(readQqPlaylistList(createdRaw.value.body), seen, false)
        : [];
      const collected = collectedRaw.status === "fulfilled"
        ? mapQqUserPlaylists(readQqPlaylistList(collectedRaw.value.body), seen, true)
        : [];
      return created.concat(collected).sort((a, b) => Number(isQqFavoritePlaylist(b)) - Number(isQqFavoritePlaylist(a)));
    },
    async playlistDetail(id): Promise<PlaylistDetail> {
      const cfg = cfgOf(deps);
      const resp = await deps.playlistDetail({ id }, cfg);
      const body = asObj(resp.body);
      const cdlist = body && Array.isArray(body.cdlist) ? body.cdlist : [];
      const first = cdlist.length > 0 ? asObj(cdlist[0]) : null;
      if (!first) {
        throw new ProviderError(
          "qq",
          "UNAVAILABLE",
          `qq playlist ${id} missing payload`
        );
      }
      return mapQqPlaylistToDetail(first as unknown as QqPlaylistBody, id);
    },
    async addSongToPlaylist(playlistId, trackId) {
      const cfg = cfgOf(deps);
      if (!cfg.cookie) {
        throw new ProviderError(
          "qq",
          "LOGIN_REQUIRED",
          `qq playlist ${playlistId} add-song requires cookie`,
          { retryable: true, action: "login" }
        );
      }
      const resp = await deps.addSongToPlaylist({ mid: trackId, dirid: playlistId }, cfg);
      const body = asObj(resp.body) ?? {};
      const codeRaw = body.result ?? body.code;
      const code = typeof codeRaw === "number" ? codeRaw : Number(codeRaw);
      if (code === 100 || code === 0) {
        return { provider: "qq", playlistId, trackId, success: true, code };
      }
      if (code === 301 || code === 1000) {
        throw new ProviderError(
          "qq",
          "LOGIN_REQUIRED",
          `qq playlist ${playlistId} add-song requires cookie`,
          { retryable: true, action: "login" }
        );
      }
      const message = typeof body.errMsg === "string"
        ? body.errMsg
        : typeof body.message === "string"
          ? body.message
          : `qq playlist ${playlistId} add-song failed`;
      throw new ProviderError("qq", "UNAVAILABLE", message);
    },
    async loginStatus(): Promise<ProviderLoginStatus> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) return { provider: "qq", loggedIn: false };
      // Trust cookie presence; jsososo has no anonymous loginStatus route.
      return { provider: "qq", loggedIn: true };
    },
    async logout(): Promise<void> {
      const cfg = deps.getConfig();
      if (!cfg.cookie) {
        throw new ProviderNotImplementedError("qq", "no-session");
      }
      // jsososo has no dedicated logout route; locally clear by calling user route.
      // The call is best-effort; cookie env remains the source of truth.
      try {
        await deps.logout({}, { cookie: cfg.cookie });
      } catch {
        // Swallow: local clear semantics — cookie env controls session.
      }
    }
  };
}

export const qqAdapter: ProviderAdapter = createQqAdapter(defaultDeps);

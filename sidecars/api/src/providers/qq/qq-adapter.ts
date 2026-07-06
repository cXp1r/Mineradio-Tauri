import type {
  Track,
  TrackQualityAvailability,
  TrackQualityOption,
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
  normalizeProviderImageUrl,
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
  vipInfo?: QqCall;
  logout: QqCall;
  getConfig(): { cookie?: string };
  smartboxSearch?: (keyword: string, limit: number) => Promise<unknown[]>;
  legacyLyric?: QqCall;
  officialPlaylistDetail?: (id: string, limit: number) => Promise<QqPlaylistBody | null>;
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
  vipInfo: cast(qqClient.vipInfo),
  logout: cast(qqClient.logout),
  getConfig,
  smartboxSearch: fallbackSmartboxSearch,
  legacyLyric: legacyQqLyric,
  officialPlaylistDetail: fetchOfficialPlaylistDetail
};

const QQ_PUBLIC_PLAYLIST_TRACK_LIMIT = 500;

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

async function fetchOfficialPlaylistDetail(id: string, limit: number): Promise<QqPlaylistBody | null> {
  const disstid = Number(id);
  if (!Number.isFinite(disstid) || disstid <= 0) return null;
  const songNum = Math.max(1, Math.min(limit || QQ_PUBLIC_PLAYLIST_TRACK_LIMIT, QQ_PUBLIC_PLAYLIST_TRACK_LIMIT));
  const data = {
    comm: { ct: 24, cv: 0 },
    req_0: {
      module: "music.srfDissInfo.aiDissInfo",
      method: "uniform_get_Dissinfo",
      param: {
        disstid,
        userinfo: 1,
        tag: 1,
        orderlist: 1,
        song_begin: 0,
        song_num: songNum,
        onlysonglist: 0,
        enc_host_uin: ""
      }
    },
    req_1: {
      module: "music.srfDissInfo.PlExtServer",
      method: "getPlExtInfo",
      param: { tid: disstid, need: [6] }
    }
  };
  const params = new URLSearchParams({
    format: "json",
    data: JSON.stringify(data)
  });
  const res = await fetch(`https://u.y.qq.com/cgi-bin/musicu.fcg?${params.toString()}`, {
    headers: {
      Referer: "https://y.qq.com/",
      Origin: "https://y.qq.com",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!res.ok) {
    throw new ProviderError("qq", "UNAVAILABLE", `qq official playlist ${id} failed with status ${res.status}`);
  }
  return normalizeOfficialPlaylistDetail(await res.json(), id);
}

function normalizeOfficialPlaylistDetail(body: unknown, id: string): QqPlaylistBody | null {
  const root = asObj(body);
  const block = asObj(root?.req_0);
  const data = asObj(block?.data);
  if (!data || Number(data.code ?? 0) !== 0) return null;
  const songlist = Array.isArray(data.songlist) ? data.songlist : [];
  if (!songlist.length) return null;
  const detail = asObj(data.dirinfo) ?? asObj(data.detail) ?? {};
  const totalRaw = data.total_song_num ?? detail.songnum ?? songlist.length;
  const total = typeof totalRaw === "number" ? totalRaw : Number(totalRaw);
  const detailId = typeof detail.id === "number" || typeof detail.id === "string" ? detail.id : id;
  return {
    disstid: detailId,
    dissname: typeof detail.dissname === "string" ? detail.dissname : undefined,
    name: typeof detail.name === "string" ? detail.name : undefined,
    title: typeof detail.title === "string" ? detail.title : undefined,
    logo: typeof detail.logo === "string" ? detail.logo : undefined,
    picurl: typeof detail.picurl === "string" ? detail.picurl : undefined,
    cover: typeof detail.cover === "string" ? detail.cover : undefined,
    songnum: Number.isFinite(total) ? total : songlist.length,
    total_song_num: Number.isFinite(total) ? total : songlist.length,
    songlist: songlist as QqSong[]
  };
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

function qqPlaybackKeyFromCookie(cookie: string): string {
  const obj = parseCookieText(cookie);
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || "";
}

function readStringField(obj: Record<string, unknown> | null | undefined, fields: string[]): string {
  if (!obj) return "";
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function readNumberField(obj: Record<string, unknown> | null | undefined, fields: string[]): number | undefined {
  if (!obj) return undefined;
  for (const field of fields) {
    const value = obj[field];
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function readFlagField(obj: Record<string, unknown> | null | undefined, fields: string[]): boolean | undefined {
  if (!obj) return undefined;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(obj, field)) continue;
    const value = obj[field];
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value > 0;
    if (typeof value === "string") {
      const text = value.trim().toLowerCase();
      if (text === "1" || text === "true" || text === "yes" || text === "y") return true;
      if (text === "0" || text === "false" || text === "no" || text === "n" || text === "") return false;
      const num = Number(text);
      if (Number.isFinite(num)) return num > 0;
    }
  }
  return undefined;
}

const VIP_LEVEL_NAMES = ["", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"] as const;

function vipLevelNameOf(tier: number | undefined): string | undefined {
  if (tier === undefined || !Number.isFinite(tier) || tier <= 0) return undefined;
  const whole = Math.floor(tier);
  return VIP_LEVEL_NAMES[whole] ?? String(whole);
}

function parseVipTierFromText(text: string): number | undefined {
  const digit = text.match(/(?:Lv\.?|等级|level)?\s*([1-9]\d?)/i)?.[1];
  if (digit) return Number(digit);
  const formal: Record<string, number> = {
    一: 1, 壹: 1,
    二: 2, 贰: 2,
    三: 3, 叁: 3,
    四: 4, 肆: 4,
    五: 5, 伍: 5,
    六: 6, 陆: 6,
    七: 7, 柒: 7,
    八: 8, 捌: 8,
    九: 9, 玖: 9,
    十: 10, 拾: 10,
  };
  for (const char of text) {
    const value = formal[char];
    if (value !== undefined) return value;
  }
  return undefined;
}

function appendVipTier(label: string, tierName: string | undefined): string {
  if (!label || !tierName || label.includes("·") || label.endsWith(tierName)) return label;
  return `${label}·${tierName}`;
}

function normalizeVipIconUrl(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (text.startsWith("//")) return `https:${text}`;
  if (/^https?:\/\//i.test(text) || /^data:image\//i.test(text)) return normalizeProviderImageUrl(text);
  return undefined;
}

function clampQqVipTier(tier: number | undefined): number | undefined {
  if (tier === undefined || !Number.isFinite(tier)) return undefined;
  return Math.max(0, Math.min(9, Math.floor(tier)));
}

type QqVipBadgeIcon = {
  url: string;
  level: "vip" | "svip";
  tier?: number;
};

function qqVipBadgeIconFromUrl(value: string): QqVipBadgeIcon | null {
  const url = normalizeVipIconUrl(value);
  if (!url) return null;
  const match = url.match(/\/(svip|vip)([1-9]\d*)\.png(?:[?#].*)?$/i);
  if (!match) return null;
  return {
    url,
    level: match[1].toLowerCase() === "svip" ? "svip" : "vip",
    tier: Number(match[2])
  };
}

function firstQqVipBadgeIcon(candidates: Record<string, unknown>[]): QqVipBadgeIcon | null {
  for (const item of candidates) {
    const badge = qqVipBadgeIconFromUrl(readStringField(item, [
      "srcUrl",
      "src",
      "vipIconUrl",
      "vipIcon",
      "iconUrl",
      "iconurl",
      "iconURL",
      "icon",
      "logoUrl",
      "imgUrl",
      "imageUrl",
      "picUrl",
      "levelIcon",
    ]));
    if (badge) return badge;
  }
  return null;
}

function qqOfficialVipIconUrl(level: "none" | "vip" | "svip", tier: number | undefined): string | undefined {
  if (level === "none") return undefined;
  const clampedTier = clampQqVipTier(tier);
  const badgeTier = clampedTier && clampedTier > 0 ? clampedTier : 1;
  return `https://y.qq.com/mediastyle/lv-icon/v14/2x/${level}${badgeTier}.png`;
}

function pushProfileCandidate(candidates: Record<string, unknown>[], value: unknown): void {
  const obj = asObj(value);
  if (!obj || candidates.includes(obj)) return;
  candidates.push(obj);
}

function pushMappedProfileCandidate(
  candidates: Record<string, unknown>[],
  map: Record<string, unknown> | null,
  fallbackUserId: string | null
): void {
  if (!map) return;
  if (fallbackUserId && map[fallbackUserId]) {
    pushProfileCandidate(candidates, map[fallbackUserId]);
    return;
  }
  for (const value of Object.values(map)) {
    pushProfileCandidate(candidates, value);
  }
}

function qqLoginProfileCandidates(body: unknown, fallbackUserId: string | null): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    const candidates: Record<string, unknown>[] = [];
    for (const item of body) {
      for (const candidate of qqLoginProfileCandidates(item, fallbackUserId)) {
        pushProfileCandidate(candidates, candidate);
      }
    }
    return candidates;
  }
  const root = asObj(body);
  if (!root) return [];
  const data = asObj(root.data);
  const user = asObj(root.user);
  const profile = asObj(root.profile);
  const dataUser = asObj(data?.user);
  const dataProfile = asObj(data?.profile);
  const vipInfoData = asObj(asObj(root.getVipInfo)?.data);
  const vipInfoMap = asObj(vipInfoData?.infoMap);
  const nickHeadData = asObj(asObj(root.getNickHead)?.data);
  const nickHeadMap = asObj(nickHeadData?.map_userinfo);
  const vipIconData = asObj(asObj(root.getVipIcon)?.data);
  const userInfoUi = asObj(vipIconData?.UserInfoUI);
  const iconList = Array.isArray(userInfoUi?.iconlist) ? userInfoUi.iconlist : [];

  const candidates: Record<string, unknown>[] = [];
  for (const icon of iconList) pushProfileCandidate(candidates, icon);
  pushMappedProfileCandidate(candidates, vipInfoMap, fallbackUserId);
  pushMappedProfileCandidate(candidates, nickHeadMap, fallbackUserId);
  pushProfileCandidate(candidates, asObj(data?.creator));
  pushProfileCandidate(candidates, asObj(root.creator));
  pushProfileCandidate(candidates, dataUser);
  pushProfileCandidate(candidates, dataProfile);
  pushProfileCandidate(candidates, user);
  pushProfileCandidate(candidates, profile);
  pushProfileCandidate(candidates, data);
  pushProfileCandidate(candidates, root);
  return candidates;
}

function mapQqVipStatus(candidates: Record<string, unknown>[]): Partial<ProviderLoginStatus> {
  let sawVipSignal = false;
  const mark = (value: unknown): void => {
    if (value !== undefined && value !== "") sawVipSignal = true;
  };
  const badgeIcon = firstQqVipBadgeIcon(candidates);
  const explicitLevel =
    candidates.map(item => readStringField(item, ["vipLevel", "level", "vip_level", "vipName", "vip_label", "vipLabel"])).find(Boolean) ?? "";
  const explicitType =
    candidates.map(item => readNumberField(item, ["vipType", "vip_type", "iVipType", "type"])).find(value => value !== undefined);
  const superVip =
    candidates.map(item => readFlagField(item, ["iSuperVip", "iNewSuperVip", "HugeVip", "hugeVip", "iHugeVip", "svip", "superVip", "isSvip", "isSuperVip", "itwelve", "twelve"])).find(value => value !== undefined);
  const normalVip =
    candidates.map(item => readFlagField(item, ["iVipFlag", "iNewVip", "iNewVipFlag", "iMusicVip", "iVip", "vipFlag", "vip", "isVip", "ieight", "eight"])).find(value => value !== undefined);
  const superTier =
    candidates.map(item => readNumberField(item, ["iSuperVipLevel", "iSvipLevel", "iNewSuperVipLevel", "iNewSvipLevel", "superVipLevel", "svipLevel", "itwelveLevel", "twelveLevel", "iCurLevel", "iMusicLevel"])).find(value => value !== undefined);
  const normalTier =
    candidates.map(item => readNumberField(item, ["iVipLevel", "iNewVipLevel", "vipLevelValue", "vip_level_value", "greenVipLevel", "iGreenVipLevel", "musicVipLevel", "ieightLevel", "eightLevel", "iMusicLevel", "iCurLevel", "iLevel", "level"])).find(value => value !== undefined);
  const vipIconUrl = normalizeVipIconUrl(
    candidates.map(item => readStringField(item, [
      "vipIconUrl",
      "vipIcon",
      "iconUrl",
      "iconurl",
      "iconURL",
      "icon",
      "logoUrl",
      "imgUrl",
      "imageUrl",
      "picUrl",
      "levelIcon",
    ])).find(Boolean) ?? ""
  );
  mark(explicitLevel);
  mark(explicitType);
  mark(superVip);
  mark(normalVip);
  mark(superTier);
  mark(normalTier);
  mark(vipIconUrl);
  mark(badgeIcon?.url);
  if (!sawVipSignal) return {};

  const lowerLevel = explicitLevel.toLowerCase();
  const level: "none" | "vip" | "svip" =
    badgeIcon?.level ??
    (/svip|super|超级会员/.test(lowerLevel) || superVip === true || (typeof explicitType === "number" && explicitType >= 10)
      ? "svip"
      : /vip|绿钻|豪华|付费|会员/.test(lowerLevel) || normalVip === true || (typeof explicitType === "number" && explicitType > 0)
        ? "vip"
        : "none");
  const usableExplicitLabel =
    explicitLevel && !/^(0|1|true|false|vip|svip|none)$/i.test(explicitLevel) && /vip|svip|绿钻|豪华|会员|super/i.test(explicitLevel)
      ? explicitLevel.replace(/\s+/g, "").replace("绿钻豪华版", "豪华绿钻")
      : "";
  const fallbackTier =
    level === "svip"
      ? (superTier ?? normalTier ?? parseVipTierFromText(explicitLevel))
      : level === "vip"
        ? (normalTier ?? parseVipTierFromText(explicitLevel))
        : undefined;
  const tier = badgeIcon?.tier ?? fallbackTier;
  const tierName = vipLevelNameOf(tier);
  const baseLabel =
    usableExplicitLabel ||
    (level === "svip"
      ? "超级会员"
      : level === "vip"
        ? "豪华绿钻"
        : "未开通");
  const label = appendVipTier(baseLabel, tierName);
  const resolvedVipIconUrl = badgeIcon?.url ?? vipIconUrl ?? qqOfficialVipIconUrl(level, tier);
  return {
    vipType: explicitType ?? (level === "svip" ? 11 : level === "vip" ? 1 : 0),
    vipLevel: level,
    isVip: level === "vip" || level === "svip",
    isSvip: level === "svip",
    vipLabel: label,
    vipIcon: level === "svip" ? "qq-super-vip" : level === "vip" ? "qq-green-vip" : undefined,
    vipIconUrl: resolvedVipIconUrl,
    vipTier: tier,
    vipLevelName: tierName
  };
}

function mapQqLoginStatus(body: unknown, fallbackUserId: string | null): ProviderLoginStatus {
  const candidates = qqLoginProfileCandidates(body, fallbackUserId);
  const status: ProviderLoginStatus = {
    provider: "qq",
    loggedIn: true
  };
  const mappedNickname =
    candidates.map(item => readStringField(item, ["nick", "nickname", "name", "hostname"])).find(Boolean) ?? "";
  const mappedAvatar =
    candidates.map(item => readStringField(item, ["headpic", "headurl", "avatarUrl", "avatar", "logo", "pic", "picurl", "head_pic", "avatar_url"])).find(Boolean) ?? "";
  const mappedUserId =
    candidates.map(item => readStringField(item, ["userid", "hostuin", "uin", "qq", "id", "musicid"])).find(Boolean) ??
    fallbackUserId ??
    "";

  if (mappedNickname) status.nickname = mappedNickname;
  const avatarUrl = normalizeProviderImageUrl(mappedAvatar);
  if (avatarUrl) status.avatarUrl = avatarUrl;
  if (mappedUserId) status.userId = mappedUserId;
  Object.assign(status, mapQqVipStatus(candidates));
  return status;
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
  id: string;
  type: string;
  level: string;
  label: string;
  short: string;
  prefix: string;
  ext: string;
  sizeFields: string[];
  format: string;
};

const QQ_QUALITY_CANDIDATES: QqQualityCandidate[] = [
  { id: "flac", type: "flac", level: "flac", label: "FLAC", short: "FLAC", prefix: "F000", ext: ".flac", sizeFields: ["size_flac"], format: "flac" },
  { id: "ape", type: "ape", level: "ape", label: "APE", short: "APE", prefix: "A000", ext: ".ape", sizeFields: ["size_ape"], format: "ape" },
  { id: "320", type: "320", level: "320", label: "320k MP3", short: "320", prefix: "M800", ext: ".mp3", sizeFields: ["size_320mp3"], format: "mp3" },
  { id: "128", type: "128", level: "128", label: "128k MP3", short: "128", prefix: "M500", ext: ".mp3", sizeFields: ["size_128mp3"], format: "mp3" },
  { id: "m4a", type: "m4a", level: "m4a", label: "AAC", short: "AAC", prefix: "C400", ext: ".m4a", sizeFields: ["size_96aac", "size_192aac", "size_48aac"], format: "m4a" },
];

const QQ_QUALITY_REQUEST_ALIASES: Record<string, string> = {
  jymaster: "flac",
  hires: "flac",
  lossless: "flac",
  sq: "flac",
  exhigh: "320",
  high: "320",
  hq: "320",
  standard: "128",
  normal: "128",
  std: "128",
  aac: "m4a"
};

function normalizeQqQualityRequest(requested: string): string {
  const value = requested.trim().toLowerCase();
  return QQ_QUALITY_REQUEST_ALIASES[value] ?? value;
}

function qqQualityCandidatesFrom(requested: string): QqQualityCandidate[] {
  const normalized = normalizeQqQualityRequest(requested);
  const start = QQ_QUALITY_CANDIDATES.findIndex(item => item.id === normalized || item.type === normalized);
  return QQ_QUALITY_CANDIDATES.slice(start >= 0 ? start : 0);
}

function qqFilenameFor(track: Track, quality: QqQualityCandidate): string {
  return `${quality.prefix}${track.mediaMid || track.sourceId}${quality.ext}`;
}

function readQqQualitySize(file: Record<string, unknown>, fields: string[]): number {
  for (const field of fields) {
    const value = file[field];
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return 0;
}

function formatQqQualitySize(size: number): string {
  if (size >= 1024 * 1024) {
    const mb = size / 1024 / 1024;
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  }
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function findQqFileObject(value: unknown, seen = new Set<object>(), depth = 0): Record<string, unknown> | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findQqFileObject(item, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  const directFile = asObj(obj.file);
  if (directFile) {
    const found = findQqFileObject(directFile, seen, depth + 1);
    if (found) return found;
  }
  if (QQ_QUALITY_CANDIDATES.some(candidate => readQqQualitySize(obj, candidate.sizeFields) > 0)) {
    return obj;
  }
  for (const child of Object.values(obj)) {
    const found = findQqFileObject(child, seen, depth + 1);
    if (found) return found;
  }
  return null;
}

function qqQualityOptionFromFile(candidate: QqQualityCandidate, file: Record<string, unknown>): TrackQualityOption | null {
  const size = readQqQualitySize(file, candidate.sizeFields);
  if (size <= 0) return null;
  return {
    provider: "qq",
    id: candidate.id,
    label: candidate.label,
    short: candidate.short,
    detail: formatQqQualitySize(size),
    requestQuality: candidate.id,
    level: candidate.level,
    type: candidate.type,
    size,
    format: candidate.format,
    source: "declared"
  };
}

function qqResponseData(body: unknown): Record<string, unknown> | null {
  const obj = asObj(body);
  if (!obj) return null;
  const req0 = asObj(obj.req_0);
  const req0Data = asObj(req0?.data);
  if (req0Data) return req0Data;
  return asObj(obj.data);
}

function qqSongUrlInfo(body: unknown): { url: string; filename?: string; info?: Record<string, unknown> } {
  if (typeof body === "string") return { url: body };
  const obj = asObj(body);
  if (!obj) return { url: "" };
  const direct = obj.url ?? obj.purl;
  if (typeof direct === "string" && direct.trim()) {
    if (/^https?:\/\//i.test(direct)) return { url: direct };
    const sip = typeof obj.sip === "string" ? obj.sip : "";
    return { url: sip ? `${sip}${direct}` : direct };
  }
  const data = qqResponseData(obj);
  if (data) {
    const infos = Array.isArray(data.midurlinfo) ? data.midurlinfo.map(asObj).filter(Boolean) as Record<string, unknown>[] : [];
    const info = infos.find(item => typeof item.purl === "string" && item.purl.trim()) ?? infos[0];
    const purl = typeof info?.purl === "string" ? info.purl.trim() : "";
    if (purl) {
      const sipList = Array.isArray(data.sip) ? data.sip : [];
      const sip = typeof sipList[0] === "string" ? sipList[0] : "https://ws.stream.qqmusic.qq.com/";
      return {
        url: /^https?:\/\//i.test(purl) ? purl : `${sip}${purl}`,
        filename: typeof info?.filename === "string" ? info.filename : undefined,
        info
      };
    }
    if (info) return { url: "", info };
    if (data !== obj) return qqSongUrlInfo(data);
  }
  return { url: "" };
}

function qqRestrictionInfo(body: unknown, session: { hasSession: boolean; hasPlaybackKey: boolean }, info?: Record<string, unknown>) {
  const obj = info ?? qqSongUrlInfo(body).info ?? qqResponseData(body) ?? asObj(body) ?? {};
  const rawMsg = String(obj.msg ?? obj.tips ?? obj.errmsg ?? obj.message ?? "").trim();
  const codeRaw = obj.result ?? obj.code ?? obj.errtype;
  const code = typeof codeRaw === "number" ? codeRaw : Number(codeRaw) || 0;
  const lower = rawMsg.toLowerCase();
  if (!session.hasSession) {
    return {
      code: "LOGIN_REQUIRED",
      category: "login_required" as const,
      retryable: true,
      action: "login",
      message: "QQ 音乐需要登录或授权后才能获取播放地址",
      qqCode: code || undefined,
      rawMessage: rawMsg || undefined,
      missingPlaybackKey: !session.hasPlaybackKey
    };
  }
  if (!session.hasPlaybackKey && code === 104003) {
    return {
      code: "LOGIN_REQUIRED",
      category: "login_required" as const,
      retryable: true,
      action: "login",
      message: "QQ 音乐当前只拿到了网页登录状态，还缺少播放授权，请重新打开官方 QQ 音乐登录窗口完成授权",
      qqCode: code,
      rawMessage: rawMsg || undefined,
      missingPlaybackKey: true
    };
  }
  if (code === 104003) {
    return {
      code: "COPYRIGHT_UNAVAILABLE",
      category: "copyright_unavailable" as const,
      retryable: false,
      action: "switch_source",
      message: "QQ 音乐没有给当前版本返回播放地址，通常是版权、会员或官方版本限制，可以换一个搜索结果或切到网易云源",
      qqCode: code,
      rawMessage: rawMsg || undefined
    };
  }
  if (/vip|会员|付费|购买|数字专辑|专辑|pay/.test(lower + rawMsg)) {
    return {
      code: "PAID_REQUIRED",
      category: "paid_required" as const,
      retryable: false,
      action: "upgrade",
      message: "QQ 音乐歌曲需要会员、购买或数字专辑权限",
      qqCode: code || undefined,
      rawMessage: rawMsg || undefined
    };
  }
  if (code && code !== 0) {
    return {
      code: "COPYRIGHT_UNAVAILABLE",
      category: "copyright_unavailable" as const,
      retryable: false,
      action: "switch_source",
      message: rawMsg || "QQ 音乐版权暂不可播或仅官方客户端可播",
      qqCode: code,
      rawMessage: rawMsg || undefined
    };
  }
  return null;
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
      const cookie = deps.getConfig().cookie ?? "";
      const hasCookie = !!cookie;
      const hasPlaybackKey = !!qqPlaybackKeyFromCookie(cookie);
      const requested = opts?.quality ?? "hires";
      let lastError: unknown = null;
      const candidates = qqQualityCandidatesFrom(requested);
      const tried: string[] = candidates.map(quality => `${quality.label} · ${qqFilenameFor(track, quality)}`);
      for (const quality of candidates) {
        try {
          const filename = qqFilenameFor(track, quality);
          const body = (await deps.songUrl({ id: track.sourceId, type: quality.type, filename }, cfg)).body;
          const info = qqSongUrlInfo(body);
          const url = info.url;
          if (url) {
            return {
              url,
              proxied: false,
              provider: "qq",
              trial: false,
              playable: true,
              level: quality.level,
              quality: quality.label,
              filename: info.filename ?? filename,
              requestedQuality: requested
            };
          }
          const restriction = qqRestrictionInfo(body, {
            hasSession: hasCookie,
            hasPlaybackKey
          }, info.info);
          if (restriction) {
            throw new ProviderError(
              "qq",
              restriction.code,
              restriction.message,
              {
                retryable: restriction.retryable,
                action: restriction.action,
                playbackKeyReady: hasPlaybackKey,
                reason: restriction.category,
                qqCode: restriction.qqCode,
                rawMessage: restriction.rawMessage,
                tried,
                restriction: {
                  provider: "qq",
                  category: restriction.category,
                  action: restriction.action,
                  message: restriction.message,
                  code: restriction.qqCode,
                  rawMessage: restriction.rawMessage,
                  missingPlaybackKey: restriction.missingPlaybackKey
                }
              }
            );
          }
        } catch (err) {
          if (err instanceof ProviderError) throw err;
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
    async trackQualities(track): Promise<TrackQualityAvailability> {
      const cfg = cfgOf(deps);
      const body = (await deps.songDetail({ songmid: track.sourceId }, cfg)).body;
      const file = findQqFileObject(body);
      const qualities = file
        ? QQ_QUALITY_CANDIDATES.flatMap((candidate) => {
            const option = qqQualityOptionFromFile(candidate, file);
            return option ? [option] : [];
          })
        : [];
      return {
        provider: "qq",
        trackId: track.sourceId,
        defaultQuality: qualities[0]?.requestQuality,
        qualities
      };
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
      const rawSonglist = first && Array.isArray(first.songlist) ? first.songlist : [];
      if ((!first || rawSonglist.length === 0) && deps.officialPlaylistDetail) {
        const official = await deps.officialPlaylistDetail(id, QQ_PUBLIC_PLAYLIST_TRACK_LIMIT);
        if (official && Array.isArray(official.songlist) && official.songlist.length > 0) {
          return mapQqPlaylistToDetail(official, id);
        }
      }
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
      const userId = qqUserIdFromCookie(cfg.cookie);
      if (!userId) return { provider: "qq", loggedIn: true };
      const readVipBody = async (): Promise<unknown | null> => {
        if (!deps.vipInfo) return null;
        try {
          return (await deps.vipInfo({ id: userId }, { cookie: cfg.cookie })).body;
        } catch {
          return null;
        }
      };
      try {
        const resp = await deps.loginStatus({ id: userId }, { cookie: cfg.cookie });
        const bodies: unknown[] = [resp.body];
        const vipBody = await readVipBody();
        if (vipBody) bodies.push(vipBody);
        return mapQqLoginStatus(bodies, userId);
      } catch {
        const vipBody = await readVipBody();
        if (vipBody) return mapQqLoginStatus([vipBody], userId);
        return { provider: "qq", loggedIn: true, userId };
      }
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

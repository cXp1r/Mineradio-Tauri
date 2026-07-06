import type {
  Track,
  TrackQualityAvailability,
  TrackQualityOption,
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
  vipInfo?: NeteaseHanaCall;
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
  vipInfo: cast(hanaClient.vipInfo),
  logout: cast(hanaClient.logout),
  getConfig
};

function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

const VIP_LEVEL_NAMES = ["", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"] as const;

function vipLevelNameOf(tier: number | undefined): string | undefined {
  if (tier === undefined || !Number.isFinite(tier) || tier <= 0) return undefined;
  const whole = Math.floor(tier);
  return VIP_LEVEL_NAMES[whole] ?? String(whole);
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

function collectObjectCandidates(
  value: unknown,
  out: Record<string, unknown>[],
  seen: Set<object>,
  depth = 0
): void {
  if (depth > 5 || value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectObjectCandidates(item, out, seen, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  out.push(obj);
  for (const child of Object.values(obj)) collectObjectCandidates(child, out, seen, depth + 1);
}

function candidatesOf(...values: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  for (const value of values) collectObjectCandidates(value, out, seen);
  return out;
}

function firstString(candidates: Record<string, unknown>[], fields: string[]): string {
  return candidates.map((item) => readStringField(item, fields)).find(Boolean) ?? "";
}

function firstNumber(candidates: Record<string, unknown>[], fields: string[]): number | undefined {
  return candidates.map((item) => readNumberField(item, fields)).find((value) => value !== undefined);
}

function firstFlag(candidates: Record<string, unknown>[], fields: string[]): boolean | undefined {
  return candidates.map((item) => readFlagField(item, fields)).find((value) => value !== undefined);
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

function usableVipLabel(label: string): string {
  const cleaned = label.replace(/\s+/g, "");
  return /vip|svip|黑胶|会员/i.test(cleaned) ? cleaned : "";
}

function normalizeVipIconUrl(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (text.startsWith("//")) return `https:${text}`;
  if (/^https?:\/\//i.test(text) || /^data:image\//i.test(text)) return text;
  return undefined;
}

function appendVipTier(label: string, tierName: string | undefined): string {
  if (!label || !tierName || label.includes("·") || label.endsWith(tierName)) return label;
  return `${label}·${tierName}`;
}

function mapNeteaseVipStatus(profile: Record<string, unknown>, vipInfoBody: unknown): ProviderLoginStatus {
  const candidates = candidatesOf(profile, vipInfoBody);
  const nickname = typeof profile.nickname === "string" ? profile.nickname : undefined;
  const avatarUrl = typeof profile.avatarUrl === "string" ? profile.avatarUrl : undefined;
  const userId = profile.userId != null ? String(profile.userId) : undefined;
  const vipType = firstNumber(candidates, ["vipType", "vip_type", "redVipType"]);
  const vipLevelRaw = firstString(candidates, ["vipLevel", "vip_level", "levelName", "vipLevelName"]);
  const rawLabel = usableVipLabel(firstString(candidates, [
    "vipLabel",
    "vip_label",
    "vipName",
    "memberName",
    "packageName",
    "productName",
    "displayName",
  ]));
  const vipIconUrl = normalizeVipIconUrl(firstString(candidates, [
    "redVipLevelIcon",
    "vipIconUrl",
    "vipIcon",
    "vipLevelIcon",
    "levelIconUrl",
    "dynamicIconUrl",
    "iconUrl",
    "iconURL",
    "icon",
    "logoUrl",
    "imgUrl",
    "imageUrl",
    "picUrl",
    "levelIcon",
    "rightsIcon",
  ]));
  const text = `${vipLevelRaw} ${rawLabel}`.toLowerCase();
  const explicitIsVip = firstFlag(candidates, ["isVip", "vip", "isRedVip", "isMusicPackage"]);
  const explicitIsSvip = firstFlag(candidates, ["isSvip", "svip", "isSuperVip", "isBlackVip"]);
  const vipLevel: "none" | "vip" | "svip" =
    /svip|super|黑胶svip|超级/.test(text) || explicitIsSvip || (typeof vipType === "number" && vipType >= 10)
      ? "svip"
      : /vip|黑胶|会员/.test(text) || explicitIsVip || (typeof vipType === "number" && vipType > 0)
        ? "vip"
        : "none";
  const rawVipTier =
    firstNumber(candidates, [
      "redVipLevel",
      "vipTier",
      "vipLevelValue",
      "vip_level_value",
      "level",
      "grade",
      "growthLevel",
      "musicPackageLevel",
    ]) ?? parseVipTierFromText(vipLevelRaw) ?? parseVipTierFromText(rawLabel);
  const vipTier = vipLevel === "none" ? undefined : rawVipTier;
  const vipLevelName = vipLevelNameOf(vipTier);
  const baseLabel =
    rawLabel ||
    (vipLevel === "svip"
      ? "黑胶SVIP"
      : vipLevel === "vip"
        ? "黑胶VIP"
        : "");
  const vipLabel = appendVipTier(baseLabel, vipLevelName);
  return {
    provider: "netease",
    loggedIn: true,
    nickname,
    avatarUrl,
    userId,
    vipType,
    vipLevel,
    isVip: vipLevel === "vip" || vipLevel === "svip",
    isSvip: vipLevel === "svip",
    vipLabel: vipLabel || undefined,
    vipIcon: vipLevel === "svip" ? "netease-svip" : vipLevel === "vip" ? "netease-vip" : undefined,
    vipIconUrl,
    vipTier,
    vipLevelName
  };
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
  let vipInfoBody: unknown;
  const userId = profile.userId != null ? String(profile.userId) : undefined;
  if (deps.vipInfo) {
    try {
      vipInfoBody = (await deps.vipInfo(userId ? { uid: userId } : {}, { cookie: cfg.cookie })).body;
    } catch {
      vipInfoBody = undefined;
    }
  }
  return mapNeteaseVipStatus(profile, vipInfoBody);
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

function neteaseRestriction(
  category: "login_required" | "vip_required" | "paid_required" | "trial_only" | "copyright_unavailable" | "url_unavailable",
  message: string,
  action: string,
  extra?: { code?: number; fee?: number },
) {
  return {
    provider: "netease",
    category,
    action,
    message,
    ...(extra ?? {})
  };
}

function neteaseTrialMessage(loggedIn: boolean, vipLevel: "none" | "vip" | "svip"): string {
  if (loggedIn && vipLevel === "svip") return "此歌曲需要单曲、专辑购买或更高权限";
  if (loggedIn && vipLevel === "vip") return "此歌曲需要 SVIP 或购买 · 当前仅播放试听片段";
  if (loggedIn) return "此歌曲需 VIP · 当前仅播放试听片段";
  return "当前未登录 · 仅播放试听片段";
}

async function neteaseTrialLoginStatus(deps: NeteaseHanaDeps): Promise<ProviderLoginStatus> {
  if (!deps.getConfig().cookie) return { provider: "netease", loggedIn: false, vipLevel: "none" };
  try {
    return await loginStatusOf(deps);
  } catch {
    return { provider: "netease", loggedIn: true, vipLevel: "none" };
  }
}

type NeteaseQualityCandidate = {
  level: string;
  br: number;
  label: string;
  short: string;
};

const NETEASE_QUALITY_CANDIDATES: NeteaseQualityCandidate[] = [
  { level: "jymaster", br: 1999000, label: "超清母带", short: "母带" },
  { level: "dolby", br: 1999000, label: "杜比全景声", short: "杜比" },
  { level: "sky", br: 1999000, label: "沉浸环绕声", short: "沉浸" },
  { level: "jyeffect", br: 1999000, label: "高清环绕声", short: "环绕" },
  { level: "hires", br: 1999000, label: "Hi-Res", short: "Hi-Res" },
  { level: "lossless", br: 1411000, label: "无损", short: "SQ" },
  { level: "exhigh", br: 999000, label: "极高", short: "HQ" },
  { level: "higher", br: 192000, label: "较高", short: "192k" },
  { level: "standard", br: 128000, label: "标准", short: "128k" },
];

function requestedQuality(opts?: SongUrlOptions) {
  return opts?.quality ?? "hires";
}

function qualityCandidatesFrom(target: string): NeteaseQualityCandidate[] {
  const start = NETEASE_QUALITY_CANDIDATES.findIndex(item => item.level === target);
  return NETEASE_QUALITY_CANDIDATES.slice(start >= 0 ? start : 4);
}

function neteaseQualityByLevel(level: string | undefined): NeteaseQualityCandidate | undefined {
  return NETEASE_QUALITY_CANDIDATES.find(item => item.level === level);
}

function neteaseActualLevel(datum: Record<string, unknown> | null, requested: NeteaseQualityCandidate): string {
  const raw = datum?.level;
  return typeof raw === "string" && raw.trim() ? raw.trim() : requested.level;
}

function neteaseQualityLabel(level: string, fallback: NeteaseQualityCandidate): string {
  return neteaseQualityByLevel(level)?.label ?? fallback.label;
}

function neteaseQualityShort(level: string, fallback: NeteaseQualityCandidate): string {
  return neteaseQualityByLevel(level)?.short ?? fallback.short;
}

function neteaseQualityRank(level: string): number {
  const index = NETEASE_QUALITY_CANDIDATES.findIndex(item => item.level === level);
  return index >= 0 ? index : NETEASE_QUALITY_CANDIDATES.length;
}

function neteaseQualityOptionFromDatum(
  datum: Record<string, unknown>,
  requested: NeteaseQualityCandidate,
  hasCookie: boolean
): TrackQualityOption | null {
  const url = typeof datum.url === "string" && datum.url.length > 0 ? datum.url : null;
  const code = typeof datum.code === "number" ? datum.code : 0;
  const state = mapPlayable(datum.fee, code, datum.freeTrialInfo, hasCookie, url);
  if (state !== "playable" || !url) return null;
  const actualLevel = neteaseActualLevel(datum, requested);
  const br = typeof datum.br === "number" && Number.isFinite(datum.br) ? Math.max(0, Math.floor(datum.br)) : requested.br;
  const type = typeof datum.type === "string" && datum.type.trim() ? datum.type.trim() : undefined;
  const label = neteaseQualityLabel(actualLevel, requested);
  return {
    provider: "netease",
    id: actualLevel,
    label,
    short: neteaseQualityShort(actualLevel, requested),
    detail: type ? `${Math.round(br / 1000)}kbps · ${type.toUpperCase()}` : `${Math.round(br / 1000)}kbps`,
    requestQuality: actualLevel,
    level: actualLevel,
    type,
    br,
    source: "resolved",
  };
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
          const trial = freeTrialInfo != null;
          const trialLoginStatus = trial
            ? await neteaseTrialLoginStatus(deps)
            : { provider: "netease" as const, loggedIn: !!cfg.cookie, vipLevel: "none" as const };
          const loggedIn = trialLoginStatus.loggedIn;
          const vipLevel = trialLoginStatus.vipLevel ?? "none";
          const restriction = trial
            ? neteaseRestriction(
                "trial_only",
                "网易云仅返回试听片段，完整播放需要会员或购买",
                "upgrade",
                {
                  code: typeof code === "number" ? code : undefined,
                  fee: typeof fee === "number" ? fee : undefined
                }
              )
            : undefined;
          const actualLevel = neteaseActualLevel(datum, quality);
          const result = {
            url,
            proxied: false,
            provider: "netease",
            trial,
            playable: true,
            level: actualLevel,
            quality: neteaseQualityLabel(actualLevel, quality),
            br,
            requestedQuality: requested,
            loggedIn,
            vipLevel,
            vipType: trialLoginStatus.vipType,
            isVip: trialLoginStatus.isVip,
            isSvip: trialLoginStatus.isSvip,
            vipLabel: trialLoginStatus.vipLabel,
            vipIcon: trialLoginStatus.vipIcon,
            vipIconUrl: trialLoginStatus.vipIconUrl,
            vipTier: trialLoginStatus.vipTier,
            vipLevelName: trialLoginStatus.vipLevelName,
            ...(restriction ? {
              restriction,
              reason: "trial_only" as const,
              message: neteaseTrialMessage(loggedIn, vipLevel)
            } : {})
          };
          if (trial) {
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
    async trackQualities(track): Promise<TrackQualityAvailability> {
      const cfg = cfgOf(deps);
      const byLevel = new Map<string, TrackQualityOption>();
      for (const quality of NETEASE_QUALITY_CANDIDATES) {
        try {
          const resp = await requestSongUrlForQuality(deps, track, quality, cfg);
          const datum = pickSongUrlDatum(asObj(resp.body), track);
          if (!datum) continue;
          const option = neteaseQualityOptionFromDatum(datum, quality, !!cfg.cookie);
          if (!option || byLevel.has(option.id)) continue;
          byLevel.set(option.id, option);
        } catch {
        }
      }
      const qualities = [...byLevel.values()].sort((a, b) =>
        neteaseQualityRank(a.level ?? a.id) - neteaseQualityRank(b.level ?? b.id)
      );
      return {
        provider: "netease",
        trackId: track.sourceId,
        defaultQuality: qualities[0]?.requestQuality,
        qualities
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

import {
  SharedPlaylistImportResultSchema,
  type ProviderId,
  type SharedPlaylistImportRequest,
  type SharedPlaylistImportResult,
  type SharedPlaylistSource,
  type Track
} from "@mineradio/shared";
import type { ProviderAdapter } from "../providers/provider-adapter";

const APPLE_MUSIC_ORIGIN = "https://music.apple.com";
const ITUNES_ORIGIN = "https://itunes.apple.com";
const QISHUI_MUSIC_ORIGIN = "https://music.douyin.com";
const KUGOU_MOBILE_ORIGIN = "https://m.kugou.com";
const KUGOU_MOBILE_ALT_ORIGIN = "https://m3ws.kugou.com";
const KUGOU_SIGN_SECRET = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
const KUGOU_ANDROID_SIGN_SECRET = "OIlwieks28dk2k092lksi2UIkp";
const APPLE_MUSIC_PLAYLIST_TRACK_LIMIT = 500;
const QISHUI_PLAYLIST_TRACK_LIMIT = 300;
const KUGOU_SHARED_PLAYLIST_TRACK_LIMIT = 500;

export type SharedPlaylistCandidate = {
  provider: SharedPlaylistSource;
  id: string;
  sourceUrl: string;
};

export type SharedPlaylistImporterDeps = {
  providerAdapters: Record<ProviderId, ProviderAdapter>;
};

export class SharedPlaylistImportError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "SharedPlaylistImportError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function importSharedPlaylist(
  input: SharedPlaylistImportRequest,
  deps: SharedPlaylistImporterDeps
): Promise<SharedPlaylistImportResult> {
  const candidate = detectSharedPlaylist(input);
  if (!candidate) {
    throw new SharedPlaylistImportError("UNSUPPORTED_LINK", "暂不支持这个歌单链接");
  }

  if (candidate.provider === "apple-music") return importAppleMusicPlaylist(candidate);
  if (candidate.provider === "qishui") return importQishuiPlaylist(candidate);
  if (candidate.provider === "kugou") return importKugouPlaylist(candidate);

  const adapter = deps.providerAdapters[candidate.provider];
  if (!adapter) {
    throw new SharedPlaylistImportError("UNSUPPORTED_PROVIDER", "暂不支持这个歌单来源");
  }

  const detail = await adapter.playlistDetail(candidate.id);
  const tracks = detail.tracks ?? [];
  const total = Math.max(Number(detail.trackCount ?? 0) || 0, tracks.length);
  const partial = total > tracks.length;
  return SharedPlaylistImportResultSchema.parse({
    provider: candidate.provider,
    playlist: {
      ...detail,
      id: detail.id || candidate.id,
      provider: candidate.provider,
      trackCount: total,
      sourceUrl: candidate.sourceUrl
    },
    tracks,
    trackCount: total,
    loadedCount: tracks.length,
    partial,
    partialReason: partial ? "分享歌单只导入了部分曲目" : ""
  });
}

export function detectSharedPlaylist(input: SharedPlaylistImportRequest): SharedPlaylistCandidate | null {
  for (const raw of collectCandidates(input)) {
    const parsed = parseUrl(raw);
    if (!parsed) continue;
    const qq = detectQqPlaylist(parsed, raw);
    if (qq) return qq;
    const netease = detectNeteasePlaylist(parsed, raw);
    if (netease) return netease;
    const apple = detectAppleMusicPlaylist(parsed, raw);
    if (apple) return apple;
    const qishui = detectQishuiPlaylist(parsed, raw);
    if (qishui) return qishui;
    const kugou = detectKugouPlaylist(parsed, raw);
    if (kugou) return kugou;
  }
  return null;
}

function collectCandidates(input: SharedPlaylistImportRequest): string[] {
  const values = [input.url, input.text].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const out: string[] = [];
  for (const value of values) {
    const trimmed = cleanCandidate(value);
    if (/^https?:\/\//i.test(trimmed)) out.push(trimmed);
    for (const match of trimmed.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      out.push(cleanCandidate(match[0]));
    }
  }
  return [...new Set(out)];
}

function cleanCandidate(value: string): string {
  return value
    .trim()
    .replace(/[，。；;、)）\]】>"'「」]+$/g, "");
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function hostMatches(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  return host === suffix || host.endsWith(`.${suffix}`);
}

function firstNonBlank(...values: Array<string | null | undefined>): string {
  return values.map(value => String(value ?? "").trim()).find(Boolean) ?? "";
}

function hashSearchParams(url: URL): URLSearchParams {
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const queryIndex = hash.indexOf("?");
  return new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : "");
}

function detectQqPlaylist(url: URL, sourceUrl: string): SharedPlaylistCandidate | null {
  if (!hostMatches(url.hostname, "y.qq.com")) return null;
  const path = decodeURIComponent(url.pathname);
  const id = firstNonBlank(
    url.searchParams.get("id"),
    url.searchParams.get("disstid"),
    url.searchParams.get("tid"),
    path.match(/\/n\/ryqq\/playlist\/([^/?#]+)/i)?.[1],
    path.match(/\/details\/playlist\.html\/?([^/?#]+)?/i)?.[1]
  );
  if (!id) return null;
  return { provider: "qq", id, sourceUrl };
}

function detectNeteasePlaylist(url: URL, sourceUrl: string): SharedPlaylistCandidate | null {
  if (!hostMatches(url.hostname, "music.163.com") && !hostMatches(url.hostname, "music.163.com.cn")) return null;
  const path = decodeURIComponent(url.pathname);
  const hashParams = hashSearchParams(url);
  const id = firstNonBlank(
    url.searchParams.get("id"),
    hashParams.get("id"),
    path.match(/\/playlist\/(\d+)/i)?.[1]
  );
  if (!id || !/(^|\/)playlist(\/|$)|playlist/i.test(`${path}${url.hash}`)) return null;
  return { provider: "netease", id, sourceUrl };
}

function detectAppleMusicPlaylist(url: URL, sourceUrl: string): SharedPlaylistCandidate | null {
  if (!hostMatches(url.hostname, "music.apple.com") && !hostMatches(url.hostname, "itunes.apple.com")) return null;
  const id = parseApplePlaylistId(sourceUrl);
  if (!id) return null;
  return { provider: "apple-music", id, sourceUrl };
}

function detectQishuiPlaylist(url: URL, sourceUrl: string): SharedPlaylistCandidate | null {
  if (!hostMatches(url.hostname, "qishui.douyin.com") && !hostMatches(url.hostname, "music.douyin.com")) return null;
  const path = decodeURIComponent(url.pathname);
  const id = firstNonBlank(
    url.searchParams.get("playlist_id"),
    path.match(/\/s\/([^/?#]+)/i)?.[1],
    parseQishuiPlaylistId(sourceUrl),
    simpleHashHex(sourceUrl)
  );
  return { provider: "qishui", id, sourceUrl };
}

function detectKugouPlaylist(url: URL, sourceUrl: string): SharedPlaylistCandidate | null {
  if (!hostMatches(url.hostname, "kugou.com")) return null;
  const info = parseKugouShareInput(sourceUrl);
  const id = firstNonBlank(info.globalCollectionId, info.gcid, url.pathname.match(/gcid_([a-z0-9]+)/i)?.[1], simpleHashHex(sourceUrl));
  return { provider: "kugou", id, sourceUrl };
}

type ExternalTrack = {
  id?: string;
  name: string;
  artist?: string;
  artists?: string[];
  album?: string;
  cover?: string;
  duration?: number;
  sourceUrl?: string;
};

function importOnlyTrack(source: SharedPlaylistSource, song: ExternalTrack, index: number, playlistCover: string, playlistUrl: string): Track {
  const title = cleanExternalText(song.name);
  const artistNames = Array.isArray(song.artists)
    ? song.artists.map(cleanExternalText).filter(Boolean)
    : splitArtistNames(song.artist ?? "");
  const stable = simpleHashHex([source, song.id || "", title, artistNames.join("/"), index].join("|"));
  return {
    provider: "netease",
    id: `import:${source}:${song.id || stable}`,
    sourceId: `import:${source}:${song.id || stable}`,
    title,
    artists: artistNames.length ? artistNames : ["未知歌手"],
    album: cleanExternalText(song.album ?? ""),
    coverUrl: normalizeImageUrl(song.cover || playlistCover),
    durationMs: normalizeDurationMs(song.duration),
    qualityHints: [],
    playableState: "unknown"
  };
}

function splitArtistNames(value: string): string[] {
  const text = cleanExternalText(value).split(/\s*[•∙]\s*/)[0] ?? "";
  if (!text) return [];
  return text.split(/\s*(?:\/|,|，|、|&| feat\.? | ft\.? )\s*/i).map(part => cleanExternalText(part)).filter(Boolean);
}

function normalizeDurationMs(value: unknown): number | undefined {
  const n = Number(value ?? 0) || 0;
  if (n <= 0) return undefined;
  return Math.round(n > 1000 ? n : n * 1000);
}

async function importAppleMusicPlaylist(candidate: SharedPlaylistCandidate): Promise<SharedPlaylistImportResult> {
  const target = candidate.sourceUrl || `${APPLE_MUSIC_ORIGIN}/cn/playlist/${encodeURIComponent(candidate.id)}`;
  const html = await fetchText(target, {
    headers: {
      Referer: `${APPLE_MUSIC_ORIGIN}/`,
      "User-Agent": desktopUserAgent()
    }
  }, 14_000);
  const schemaText = extractRawHtmlMatch(html.text, /<script[^>]+id=["']?schema:music-playlist["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (!schemaText) {
    throw new SharedPlaylistImportError("APPLE_METADATA_UNAVAILABLE", "Apple Music 歌单页面没有公开曲目信息");
  }

  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(schemaText) as Record<string, unknown>;
  } catch {
    throw new SharedPlaylistImportError("APPLE_PARSE_FAILED", "Apple Music 歌单解析失败");
  }

  const rawTracks = asArray(schema.track).slice(0, APPLE_MUSIC_PLAYLIST_TRACK_LIMIT);
  const trackIds = rawTracks
    .map(track => appleTrackIdFromUrl(appleSongUrlFromSchema(track)))
    .filter(Boolean);
  const lookup = await appleLookupTracks(trackIds);
  const cover = normalizeImageUrl(
    firstImageFromUnknown(schema.image) ||
    extractMeta(html.text, "og:image") ||
    extractMeta(html.text, "twitter:image")
  );
  const songs = rawTracks
    .map((raw, index) => normalizeAppleMusicTrack(raw, lookup[appleTrackIdFromUrl(appleSongUrlFromSchema(raw))], index))
    .filter((song): song is ExternalTrack => !!song && !!song.name);
  if (!songs.length) {
    throw new SharedPlaylistImportError("APPLE_EMPTY_PLAYLIST", "Apple Music 歌单没有可读取的曲目");
  }

  const tracks = songs.map((song, index) => importOnlyTrack("apple-music", song, index, cover, html.url || target));
  const total = Math.max(Number(schema.numTracks ?? 0) || 0, tracks.length);
  return SharedPlaylistImportResultSchema.parse({
    provider: "apple-music",
    playlist: {
      provider: "apple-music",
      id: candidate.id || parseApplePlaylistId(String(schema.url ?? "")) || simpleHashHex(target),
      name: cleanExternalText(String(schema.name ?? "")) || extractMeta(html.text, "og:title") || "Apple Music 歌单",
      coverUrl: cover || tracks.find(track => track.coverUrl)?.coverUrl || "",
      trackCount: total,
      trackIds: tracks.map(track => track.id),
      subscribed: false,
      sourceUrl: html.url || target
    },
    tracks,
    trackCount: total,
    loadedCount: tracks.length,
    partial: total > tracks.length,
    partialReason: total > tracks.length ? "Apple Music 分享页只公开了部分曲目" : ""
  });
}

function normalizeAppleMusicTrack(raw: unknown, lookup: Record<string, unknown> | undefined, index: number): ExternalTrack | null {
  const item = asRecord(raw);
  const lookupItem = lookup ?? {};
  const audio = asRecord(item.audio);
  const name = cleanExternalText(firstNonBlank(
    stringValue(lookupItem.trackName),
    stringValue(item.name),
    stringValue(audio.name)
  ));
  if (!name) return null;
  const songUrl = appleSongUrlFromSchema(raw);
  const id = firstNonBlank(
    stringValue(lookupItem.trackId),
    appleTrackIdFromUrl(songUrl),
    stringValue(item.id),
    `apple-${index}`
  );
  return {
    id,
    name,
    artist: cleanExternalText(firstNonBlank(
      stringValue(lookupItem.artistName),
      artistNameFromUnknown(item.byArtist)
    )),
    album: cleanExternalText(firstNonBlank(
      stringValue(lookupItem.collectionName),
      stringValue(asRecord(item.inAlbum).name)
    )),
    cover: normalizeImageUrl(firstNonBlank(
      stringValue(lookupItem.artworkUrl100).replace(/100x100bb/i, "600x600bb"),
      firstImageFromUnknown(item.image),
      firstImageFromUnknown(audio.thumbnailUrl),
      stringValue(item.thumbnailUrl)
    )),
    duration: Number(lookupItem.trackTimeMillis ?? 0) ? Number(lookupItem.trackTimeMillis) : parseIsoDurationMs(firstNonBlank(stringValue(item.duration), stringValue(audio.duration))),
    sourceUrl: songUrl
  };
}

function appleSongUrlFromSchema(raw: unknown): string {
  const item = asRecord(raw);
  const audio = asRecord(item.audio);
  const actionTarget = asRecord(asRecord(audio.potentialAction).target);
  return firstNonBlank(
    stringValue(item.url),
    stringValue(audio.url),
    firstStringFromUnknown(actionTarget.actionPlatform),
    firstStringFromUnknown(actionTarget.url)
  );
}

async function appleLookupTracks(ids: string[]): Promise<Record<string, Record<string, unknown>>> {
  const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))].slice(0, APPLE_MUSIC_PLAYLIST_TRACK_LIMIT);
  const out: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < unique.length; index += 100) {
    const batch = unique.slice(index, index + 100);
    const target = `${ITUNES_ORIGIN}/lookup?${new URLSearchParams({ id: batch.join(","), entity: "song", country: "CN" }).toString()}`;
    try {
      const data = await fetchJson(target, {
        headers: {
          Referer: `${APPLE_MUSIC_ORIGIN}/`,
          "User-Agent": desktopUserAgent()
        }
      }, 9_000);
      for (const item of asArray(asRecord(data).results)) {
        const row = asRecord(item);
        if (row.wrapperType === "track" && row.trackId) out[String(row.trackId)] = row;
      }
    } catch {
      // Lookup is a metadata enrichment only. The JSON-LD page data is enough to import.
    }
  }
  return out;
}

function parseApplePlaylistId(value: string): string {
  const raw = String(value || "").trim();
  const direct = raw.match(/\bpl\.[a-z0-9]+\b/i);
  return direct ? direct[0] : "";
}

function appleTrackIdFromUrl(value: string): string {
  const text = String(value || "");
  const match = text.match(/\/song\/[^/?#]+\/(\d{5,})/i) || text.match(/[?&]i=(\d{5,})/i) || text.match(/\/(\d{5,})(?:[?#]|$)/);
  return match ? match[1] : "";
}

async function importQishuiPlaylist(candidate: SharedPlaylistCandidate): Promise<SharedPlaylistImportResult> {
  const target = candidate.sourceUrl || qishuiPlaylistUrlFromInput(candidate.id);
  if (!target) throw new SharedPlaylistImportError("QISHUI_MISSING_URL", "缺少汽水音乐歌单链接");
  const fetched = await fetchText(target, {
    redirect: "follow",
    headers: {
      Referer: `${QISHUI_MUSIC_ORIGIN}/`,
      "User-Agent": mobileUserAgent()
    }
  }, 16_000);
  const html = fetched.text;
  const finalUrl = fetched.url || target;
  const id = firstNonBlank(parseQishuiPlaylistId(finalUrl), parseQishuiPlaylistId(html), candidate.id, simpleHashHex(finalUrl));
  const name = cleanQishuiPlaylistName(
    extractMeta(html, "title") ||
    extractMeta(html, "og:title") ||
    extractMeta(html, "name") ||
    extractTitle(html) ||
    "汽水音乐歌单"
  );
  const cover = normalizeImageUrl(
    extractMeta(html, "image") ||
    extractMeta(html, "og:image") ||
    extractMeta(html, "twitter:image") ||
    extractFirstJsonLikeImage(html)
  );
  const renderedSongs = parseQishuiRenderedTracks(html, cover);
  const songs = (renderedSongs.length ? renderedSongs : uniqueExternalTracks(parseQishuiJsonTracks(html, cover))).slice(0, QISHUI_PLAYLIST_TRACK_LIMIT);
  const tracks = songs.map((song, index) => importOnlyTrack("qishui", song, index, cover, finalUrl));
  const visibleCount = Number((html.match(/(\d+)\s*首/) || [])[1] || 0) || 0;
  const total = Math.max(visibleCount, tracks.length);
  const partial = tracks.length === 0 || total > tracks.length;
  return SharedPlaylistImportResultSchema.parse({
    provider: "qishui",
    playlist: {
      provider: "qishui",
      id,
      name,
      coverUrl: cover,
      trackCount: total,
      trackIds: tracks.map(track => track.id),
      subscribed: false,
      sourceUrl: finalUrl
    },
    tracks,
    trackCount: total,
    loadedCount: tracks.length,
    partial,
    partialReason: partial
      ? tracks.length
        ? "汽水分享页只公开了部分曲目"
        : "汽水分享页未公开曲目列表，已保存歌单信息"
      : ""
  });
}

function parseQishuiPlaylistId(value: string): string {
  const raw = String(value || "").trim();
  const prefixed = raw.match(/(?:^|[^a-z0-9])qishui:(\d{5,})(?:\D|$)/i);
  if (prefixed) return prefixed[1];
  const direct = raw.match(/(?:playlist_id|playlist)[:=\/\s]+(\d{5,})/i);
  if (direct) return direct[1];
  const target = externalUrlFromInput(raw);
  try {
    const parsed = new URL(target);
    return parsed.searchParams.get("playlist_id") || "";
  } catch {
    return "";
  }
}

function qishuiPlaylistUrlFromInput(id: string): string {
  return /^\d{5,}$/.test(id) ? `${QISHUI_MUSIC_ORIGIN}/qishui/share/playlist?playlist_id=${encodeURIComponent(id)}` : "";
}

function cleanQishuiPlaylistName(value: string): string {
  return cleanExternalText(value)
    .replace(/^#?汽水音乐#?\s*/i, "")
    .replace(/[「《]?汽水音乐[」》]?$/i, "")
    .replace(/\s*[-_｜|]\s*汽水音乐\s*$/i, "")
    .trim() || "汽水音乐歌单";
}

function parseQishuiRenderedTracks(html: string, cover: string): ExternalTrack[] {
  const tracks: ExternalTrack[] = [];
  const rowRe = /<div[^>]*style=["'][^"']*padding-top:14px;[^"']*padding-bottom:14px;[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*style=["'][^"']*padding-top:14px;[^"']*padding-bottom:14px;|<\/body>|$)/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(String(html || ""))) && tracks.length < QISHUI_PLAYLIST_TRACK_LIMIT) {
    const ps = Array.from(row[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
      .map(match => cleanExternalText(match[1]))
      .filter(Boolean);
    if (ps.length < 2) continue;
    const song = normalizeQishuiTrack(ps[0], ps[1], cover, tracks.length);
    if (song) tracks.push(song);
  }
  return tracks;
}

function parseQishuiJsonTracks(html: string, cover: string): ExternalTrack[] {
  const tracks: ExternalTrack[] = [];
  const scripts = Array.from(String(html || "").matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi))
    .map(match => match[1])
    .filter(text => /song|track|music|artist|author|title|name|singer/i.test(text));
  for (const script of scripts) {
    if (tracks.length >= QISHUI_PLAYLIST_TRACK_LIMIT) break;
    for (const jsonText of extractJsonObjects(script).slice(0, 4)) {
      try {
        collectQishuiTracksFromJson(JSON.parse(jsonText), cover, tracks, 0);
      } catch {
      }
      if (tracks.length >= QISHUI_PLAYLIST_TRACK_LIMIT) break;
    }
  }
  return tracks;
}

function collectQishuiTracksFromJson(value: unknown, cover: string, tracks: ExternalTrack[], depth: number): void {
  if (depth > 7 || tracks.length >= QISHUI_PLAYLIST_TRACK_LIMIT || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectQishuiTracksFromJson(item, cover, tracks, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const name = firstNonBlank(
    stringValue(obj.name),
    stringValue(obj.title),
    stringValue(obj.songName),
    stringValue(obj.song_name),
    stringValue(obj.musicName),
    stringValue(obj.music_name)
  );
  const artist = firstNonBlank(
    stringValue(obj.artist),
    stringValue(obj.author),
    stringValue(obj.singer),
    stringValue(obj.singerName),
    stringValue(obj.singer_name),
    artistNameFromUnknown(obj.artists)
  );
  const song = normalizeQishuiTrack(name, artist, firstNonBlank(firstImageFromUnknown(obj.cover), firstImageFromUnknown(obj.image), cover), tracks.length);
  if (song) tracks.push(song);
  for (const key of Object.keys(obj)) {
    if (/song|track|music|playlist|list|item|data/i.test(key)) collectQishuiTracksFromJson(obj[key], cover, tracks, depth + 1);
  }
}

function normalizeQishuiTrack(name: string, meta: string, cover: string, index: number): ExternalTrack | null {
  const title = cleanExternalText(name);
  const text = cleanExternalText(meta);
  if (!title || title.length > 120 || /^(\d+|播放|打开|下载|汽水音乐)$/.test(title)) return null;
  let artist = text;
  let album = "";
  if (/[•∙·-]/.test(text)) {
    const parts = text.split(/\s*[•∙·-]\s*/).map(cleanExternalText).filter(Boolean);
    artist = parts[0] || text;
    album = parts.slice(1).join(" · ");
  }
  return {
    id: `qishui:${simpleHashHex([title, artist, index].join("|"))}`,
    name: title,
    artist,
    album,
    cover
  };
}

async function importKugouPlaylist(candidate: SharedPlaylistCandidate): Promise<SharedPlaylistImportResult> {
  const source = candidate.sourceUrl;
  const info = parseKugouShareInput(source);
  if (!info.gcid && !info.globalCollectionId) {
    throw new SharedPlaylistImportError("KUGOU_MISSING_ID", "缺少酷狗歌单 ID");
  }

  let result: KugouPlaylistPayload | null = null;
  try {
    result = await kugouSharedPlaylistFull(info);
  } catch {
    if (info.gcid) result = await kugouSharedPlaylistFromMobile(info);
  }
  if (!result || !result.tracks.length) {
    throw new SharedPlaylistImportError("KUGOU_EMPTY_PLAYLIST", "酷狗歌单没有可读取的曲目");
  }

  const tracks = result.tracks.map((song, index) => importOnlyTrack("kugou", song, index, result.cover, source));
  return SharedPlaylistImportResultSchema.parse({
    provider: "kugou",
    playlist: {
      provider: "kugou",
      id: result.id || candidate.id,
      name: result.name || "酷狗歌单",
      coverUrl: result.cover,
      trackCount: result.trackCount,
      trackIds: tracks.map(track => track.id),
      subscribed: false,
      sourceUrl: source
    },
    tracks,
    trackCount: result.trackCount,
    loadedCount: tracks.length,
    partial: result.trackCount > tracks.length,
    partialReason: result.trackCount > tracks.length ? "酷狗分享页只公开了部分曲目" : ""
  });
}

type KugouShareInfo = {
  url: string;
  gcid: string;
  globalCollectionId: string;
  uid: string;
  cover: string;
  title: string;
};

type KugouPlaylistPayload = {
  id: string;
  name: string;
  cover: string;
  trackCount: number;
  tracks: ExternalTrack[];
};

function parseKugouShareInput(value: string): KugouShareInfo {
  const raw = String(value || "").trim();
  const urlText = externalUrlFromInput(raw);
  let parsed: URL | null = null;
  try { parsed = new URL(urlText); } catch {}
  const source = parsed ? parsed.toString() : raw;
  const gcidMatch = source.match(/gcid_([a-z0-9]+)/i) || source.match(/[?&]src_cid=(?:gcid_)?([a-z0-9]+)/i);
  const collectionMatch = source.match(/[?&](?:global_collection_id|global_specialid)=([a-z0-9_]+)/i) || source.match(/\bcollection_[a-z0-9_]+\b/i);
  const titleMatch = raw.match(/歌单[《「]?([^》」]+)[》」]?/) || raw.match(/《([^》]+)》/);
  return {
    url: urlText,
    gcid: gcidMatch ? gcidMatch[1] : "",
    globalCollectionId: collectionMatch ? (collectionMatch[1] || collectionMatch[0]) : "",
    uid: parsed ? (parsed.searchParams.get("uid") || "") : ((raw.match(/[?&]uid=(\d+)/) || [])[1] || ""),
    cover: parsed ? (parsed.searchParams.get("cover") || "") : "",
    title: titleMatch ? cleanExternalText(titleMatch[1]) : ""
  };
}

async function kugouSharedPlaylistFull(info: KugouShareInfo): Promise<KugouPlaylistPayload> {
  let globalCollectionId = String(info.globalCollectionId || "").trim();
  if (!globalCollectionId && info.gcid) globalCollectionId = await kugouDecodeGcid(info.gcid);
  if (!globalCollectionId) throw new Error("no kugou collection id");
  const listInfo = await kugouCollectionInfo(globalCollectionId);
  const songs = await kugouCollectionSongs(globalCollectionId, Number(listInfo.songcount ?? listInfo.count ?? KUGOU_SHARED_PLAYLIST_TRACK_LIMIT) || KUGOU_SHARED_PLAYLIST_TRACK_LIMIT);
  const result = normalizeKugouCollectionPlaylist(globalCollectionId, listInfo, songs, info);
  if (!result.tracks.length) throw new Error("empty kugou collection");
  return result;
}

async function kugouSharedPlaylistFromMobile(info: KugouShareInfo): Promise<KugouPlaylistPayload> {
  const mobileUrl = kugouMobileSonglistUrl(info);
  if (!mobileUrl) throw new Error("missing kugou mobile url");
  const html = await fetchText(mobileUrl, {
    headers: {
      Referer: `${KUGOU_MOBILE_ORIGIN}/`,
      Origin: KUGOU_MOBILE_ORIGIN,
      "User-Agent": mobileUserAgent()
    }
  }, 12_000);
  const jsonText = extractWindowOutputJson(html.text);
  if (!jsonText) throw new Error("missing kugou h5 data");
  const data = JSON.parse(jsonText);
  return normalizeKugouH5Playlist(data, info);
}

function kugouMobileSonglistUrl(info: KugouShareInfo): string {
  const gcid = String(info.gcid || "").replace(/^gcid_/i, "");
  if (!gcid) return "";
  const url = new URL(`/songlist/gcid_${gcid}/`, KUGOU_MOBILE_ORIGIN);
  url.searchParams.set("iszlist", "1");
  url.searchParams.set("src_cid", gcid);
  if (info.uid) url.searchParams.set("uid", info.uid);
  if (info.cover) url.searchParams.set("cover", info.cover);
  url.searchParams.set("chl", "weibo");
  return url.toString();
}

async function kugouDecodeGcid(gcid: string): Promise<string> {
  const id = /^gcid_/i.test(gcid) ? gcid : `gcid_${gcid}`;
  const params = "dfid=-&appid=1005&mid=0&clientver=20109&clienttime=640612895&uuid=-";
  const body = JSON.stringify({ ret_info: 1, data: [{ id, id_type: 2 }] });
  const url = `https://t.kugou.com/v1/songlist/batch_decode?${params}&signature=${kugouSignatureFromQuery(params, "android", body)}`;
  const data = await kugouApiJson(url, {
    method: "POST",
    headers: kugouHeaders({
      Referer: `${KUGOU_MOBILE_ORIGIN}/`,
      Origin: KUGOU_MOBILE_ORIGIN,
      "Content-Type": "application/json",
      "User-Agent": mobileUserAgent()
    }),
    body
  });
  const list = asArray(asRecord(normalizeKugouApiJson(data)).list);
  const first = asRecord(list[0]);
  return firstNonBlank(stringValue(first.global_collection_id), stringValue(first.global_specialid));
}

async function kugouCollectionInfo(globalCollectionId: string): Promise<Record<string, unknown>> {
  const params = `appid=1058&specialid=0&global_specialid=${encodeURIComponent(globalCollectionId)}&format=jsonp&srcappid=2919&clientver=20000&clienttime=1586163242519&mid=1586163242519&uuid=1586163242519&dfid=-`;
  const url = `https://mobiles.kugou.com/api/v5/special/info_v2?${params}&signature=${kugouSignatureFromQuery(params, "web")}`;
  return asRecord(normalizeKugouApiJson(await kugouApiJson(url, {
    headers: kugouHeaders({
      mid: "1586163242519",
      Referer: `${KUGOU_MOBILE_ALT_ORIGIN}/share/index.php`,
      Origin: KUGOU_MOBILE_ALT_ORIGIN,
      dfid: "-",
      clienttime: "1586163242519",
      "User-Agent": mobileUserAgent()
    })
  })));
}

async function kugouCollectionSongs(globalCollectionId: string, total: number): Promise<unknown[]> {
  const tracks: unknown[] = [];
  let page = 1;
  let remaining = Math.min(Number(total || 0) || KUGOU_SHARED_PLAYLIST_TRACK_LIMIT, KUGOU_SHARED_PLAYLIST_TRACK_LIMIT);
  while (remaining > 0) {
    const limit = Math.min(remaining, 300);
    const params = `appid=1058&global_specialid=${encodeURIComponent(globalCollectionId)}&specialid=0&plat=0&version=8000&page=${page}&pagesize=${limit}&srcappid=2919&clientver=20000&clienttime=1586163263991&mid=1586163263991&uuid=1586163263991&dfid=-`;
    const url = `https://mobiles.kugou.com/api/v5/special/song_v2?${params}&signature=${kugouSignatureFromQuery(params, "web")}`;
    const data = await kugouApiJson(url, {
      headers: kugouHeaders({
        mid: "1586163263991",
        Referer: `${KUGOU_MOBILE_ALT_ORIGIN}/share/index.php`,
        Origin: KUGOU_MOBILE_ALT_ORIGIN,
        dfid: "-",
        clienttime: "1586163263991",
        "User-Agent": mobileUserAgent()
      })
    });
    const body = asRecord(normalizeKugouApiJson(data));
    const songs = asArray(body.info).length ? asArray(body.info) : (asArray(body.songs).length ? asArray(body.songs) : asArray(body.list));
    if (!songs.length) break;
    tracks.push(...songs);
    if (songs.length < limit) break;
    remaining -= songs.length;
    page++;
  }
  return tracks.slice(0, KUGOU_SHARED_PLAYLIST_TRACK_LIMIT);
}

function normalizeKugouCollectionPlaylist(globalCollectionId: string, info: Record<string, unknown>, rawSongs: unknown[], fallback: KugouShareInfo): KugouPlaylistPayload {
  const tracks = rawSongs
    .slice(0, KUGOU_SHARED_PLAYLIST_TRACK_LIMIT)
    .map(normalizeKugouSharedSong)
    .filter((song): song is ExternalTrack => !!song && !!song.name);
  const trackCount = Number(info.songcount ?? info.count ?? info.total ?? tracks.length) || tracks.length;
  return {
    id: `kugou:${globalCollectionId || `gcid_${fallback.gcid}`}`,
    name: cleanExternalText(firstNonBlank(stringValue(info.specialname), stringValue(info.name), fallback.title, "酷狗歌单")),
    cover: kugouCoverUrl(firstNonBlank(stringValue(info.imgurl), stringValue(info.pic), fallback.cover)),
    trackCount,
    tracks
  };
}

function normalizeKugouH5Playlist(data: unknown, fallback: KugouShareInfo): KugouPlaylistPayload {
  const root = asRecord(data);
  const info = asRecord(root.info);
  const listInfo = asRecord(info.listinfo);
  const rawSongs = asArray(info.songs);
  const tracks = rawSongs.map(normalizeKugouSharedSong).filter((song): song is ExternalTrack => !!song && !!song.name);
  const trackCount = Number(listInfo.count ?? info.count ?? tracks.length) || tracks.length;
  return {
    id: `kugou:gcid_${fallback.gcid}`,
    name: cleanExternalText(firstNonBlank(stringValue(listInfo.name), fallback.title, "酷狗歌单")),
    cover: kugouCoverUrl(firstNonBlank(stringValue(listInfo.pic), fallback.cover)),
    trackCount,
    tracks
  };
}

function normalizeKugouSharedSong(raw: unknown): ExternalTrack | null {
  const song = asRecord(raw);
  const nameText = cleanExternalText(firstNonBlank(
    stringValue(song.name),
    stringValue(song.songname),
    stringValue(song.fileName),
    stringValue(song.filename),
    stringValue(song.SongName)
  ));
  let artist = "";
  let title = nameText;
  const splitIndex = nameText.indexOf(" - ");
  if (splitIndex > 0) {
    artist = nameText.slice(0, splitIndex).trim();
    title = nameText.slice(splitIndex + 3).trim();
  }
  if (!artist) artist = artistNameFromUnknown(song.singerinfo);
  if (!artist) artist = firstNonBlank(stringValue(song.singerName), stringValue(song.author_name), stringValue(song.singername), stringValue(song.SingerName));
  if (!title) return null;
  const transParam = asRecord(song.trans_param);
  const albumInfo = asRecord(song.albuminfo);
  const mid = firstNonBlank(
    stringValue(song.mixsongid),
    stringValue(song.add_mixsongid),
    stringValue(song.EMixSongID),
    stringValue(song.MixSongID),
    stringValue(song.album_audio_id),
    stringValue(song.audio_id)
  );
  const hash = firstNonBlank(stringValue(song.hash), stringValue(song.FileHash));
  const duration = Number(song.timelen ?? song.timeLength ?? 0) || (Number(song.duration ?? 0) * 1000);
  return {
    id: firstNonBlank(mid, hash, simpleHashHex(`${title}|${artist}`)),
    name: title,
    artist: cleanExternalText(artist),
    album: cleanExternalText(firstNonBlank(stringValue(song.remark), stringValue(song.albumName), stringValue(song.AlbumName), stringValue(albumInfo.name))),
    cover: kugouCoverUrl(firstNonBlank(stringValue(song.cover), stringValue(song.imgUrl), stringValue(song.Image), stringValue(transParam.union_cover))),
    duration
  };
}

function kugouCoverUrl(raw: string): string {
  return normalizeImageUrl(raw.replace("{size}", "480"));
}

async function kugouApiJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const data = await fetchJson(url, { ...init, headers: { ...kugouHeaders(), ...(init.headers as Record<string, string> | undefined) } }, 12_000);
  const obj = asRecord(data);
  const code = obj.errcode ?? obj.err_code ?? obj.error_code;
  const ok = obj.status === 1 || code === 0 || code === "0";
  if (!ok) throw new Error(String(obj.error || obj.errmsg || obj.msg || "Kugou API request failed"));
  return data;
}

function normalizeKugouApiJson(data: unknown): unknown {
  const obj = asRecord(data);
  return obj.data ?? obj.info ?? data;
}

function kugouHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Referer: `${KUGOU_MOBILE_ORIGIN}/`,
    "User-Agent": desktopUserAgent(),
    ...extra
  };
}

function kugouSignatureFromQuery(query: string, platform: "android" | "web", body = ""): string {
  const secret = platform === "android" ? KUGOU_ANDROID_SIGN_SECRET : KUGOU_SIGN_SECRET;
  const params = String(query || "").split("&").filter(Boolean).sort().join("");
  return md5Hex(secret + params + body + secret);
}

function md5Hex(value: string): string {
  function rotateLeft(lValue: number, shiftBits: number): number {
    return (lValue << shiftBits) | (lValue >>> (32 - shiftBits));
  }
  function addUnsigned(lX: number, lY: number): number {
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const result = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return result ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) return (result & 0x40000000) ? result ^ 0xc0000000 ^ lX8 ^ lY8 : result ^ 0x40000000 ^ lX8 ^ lY8;
    return result ^ lX8 ^ lY8;
  }
  function f(x: number, y: number, z: number): number { return (x & y) | ((~x) & z); }
  function g(x: number, y: number, z: number): number { return (x & z) | (y & (~z)); }
  function h(x: number, y: number, z: number): number { return x ^ y ^ z; }
  function iiBase(x: number, y: number, z: number): number { return y ^ (x | (~z)); }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(f(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(g(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(h(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(iiBase(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function convertToWordArray(str: string): number[] {
    const utf8 = unescape(encodeURIComponent(str));
    const wordArray: number[] = [];
    let byteCount = 0;
    while (byteCount < utf8.length) {
      wordArray[byteCount >> 2] = (wordArray[byteCount >> 2] ?? 0) | (utf8.charCodeAt(byteCount) << ((byteCount % 4) * 8));
      byteCount++;
    }
    wordArray[byteCount >> 2] = (wordArray[byteCount >> 2] ?? 0) | (0x80 << ((byteCount % 4) * 8));
    wordArray[(((byteCount + 8) >> 6) + 1) * 16 - 2] = utf8.length * 8;
    return wordArray;
  }
  function wordToHex(input: number): string {
    let out = "";
    for (let count = 0; count <= 3; count++) {
      out += ((input >>> (count * 8)) & 255).toString(16).padStart(2, "0");
    }
    return out;
  }
  const x = convertToWordArray(String(value || ""));
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  for (let k = 0; k < x.length; k += 16) {
    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;
    a = ff(a, b, c, d, x[k + 0] ?? 0, 7, 0xd76aa478);
    d = ff(d, a, b, c, x[k + 1] ?? 0, 12, 0xe8c7b756);
    c = ff(c, d, a, b, x[k + 2] ?? 0, 17, 0x242070db);
    b = ff(b, c, d, a, x[k + 3] ?? 0, 22, 0xc1bdceee);
    a = ff(a, b, c, d, x[k + 4] ?? 0, 7, 0xf57c0faf);
    d = ff(d, a, b, c, x[k + 5] ?? 0, 12, 0x4787c62a);
    c = ff(c, d, a, b, x[k + 6] ?? 0, 17, 0xa8304613);
    b = ff(b, c, d, a, x[k + 7] ?? 0, 22, 0xfd469501);
    a = ff(a, b, c, d, x[k + 8] ?? 0, 7, 0x698098d8);
    d = ff(d, a, b, c, x[k + 9] ?? 0, 12, 0x8b44f7af);
    c = ff(c, d, a, b, x[k + 10] ?? 0, 17, 0xffff5bb1);
    b = ff(b, c, d, a, x[k + 11] ?? 0, 22, 0x895cd7be);
    a = ff(a, b, c, d, x[k + 12] ?? 0, 7, 0x6b901122);
    d = ff(d, a, b, c, x[k + 13] ?? 0, 12, 0xfd987193);
    c = ff(c, d, a, b, x[k + 14] ?? 0, 17, 0xa679438e);
    b = ff(b, c, d, a, x[k + 15] ?? 0, 22, 0x49b40821);
    a = gg(a, b, c, d, x[k + 1] ?? 0, 5, 0xf61e2562);
    d = gg(d, a, b, c, x[k + 6] ?? 0, 9, 0xc040b340);
    c = gg(c, d, a, b, x[k + 11] ?? 0, 14, 0x265e5a51);
    b = gg(b, c, d, a, x[k + 0] ?? 0, 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, x[k + 5] ?? 0, 5, 0xd62f105d);
    d = gg(d, a, b, c, x[k + 10] ?? 0, 9, 0x2441453);
    c = gg(c, d, a, b, x[k + 15] ?? 0, 14, 0xd8a1e681);
    b = gg(b, c, d, a, x[k + 4] ?? 0, 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, x[k + 9] ?? 0, 5, 0x21e1cde6);
    d = gg(d, a, b, c, x[k + 14] ?? 0, 9, 0xc33707d6);
    c = gg(c, d, a, b, x[k + 3] ?? 0, 14, 0xf4d50d87);
    b = gg(b, c, d, a, x[k + 8] ?? 0, 20, 0x455a14ed);
    a = gg(a, b, c, d, x[k + 13] ?? 0, 5, 0xa9e3e905);
    d = gg(d, a, b, c, x[k + 2] ?? 0, 9, 0xfcefa3f8);
    c = gg(c, d, a, b, x[k + 7] ?? 0, 14, 0x676f02d9);
    b = gg(b, c, d, a, x[k + 12] ?? 0, 20, 0x8d2a4c8a);
    a = hh(a, b, c, d, x[k + 5] ?? 0, 4, 0xfffa3942);
    d = hh(d, a, b, c, x[k + 8] ?? 0, 11, 0x8771f681);
    c = hh(c, d, a, b, x[k + 11] ?? 0, 16, 0x6d9d6122);
    b = hh(b, c, d, a, x[k + 14] ?? 0, 23, 0xfde5380c);
    a = hh(a, b, c, d, x[k + 1] ?? 0, 4, 0xa4beea44);
    d = hh(d, a, b, c, x[k + 4] ?? 0, 11, 0x4bdecfa9);
    c = hh(c, d, a, b, x[k + 7] ?? 0, 16, 0xf6bb4b60);
    b = hh(b, c, d, a, x[k + 10] ?? 0, 23, 0xbebfbc70);
    a = hh(a, b, c, d, x[k + 13] ?? 0, 4, 0x289b7ec6);
    d = hh(d, a, b, c, x[k + 0] ?? 0, 11, 0xeaa127fa);
    c = hh(c, d, a, b, x[k + 3] ?? 0, 16, 0xd4ef3085);
    b = hh(b, c, d, a, x[k + 6] ?? 0, 23, 0x4881d05);
    a = hh(a, b, c, d, x[k + 9] ?? 0, 4, 0xd9d4d039);
    d = hh(d, a, b, c, x[k + 12] ?? 0, 11, 0xe6db99e5);
    c = hh(c, d, a, b, x[k + 15] ?? 0, 16, 0x1fa27cf8);
    b = hh(b, c, d, a, x[k + 2] ?? 0, 23, 0xc4ac5665);
    a = ii(a, b, c, d, x[k + 0] ?? 0, 6, 0xf4292244);
    d = ii(d, a, b, c, x[k + 7] ?? 0, 10, 0x432aff97);
    c = ii(c, d, a, b, x[k + 14] ?? 0, 15, 0xab9423a7);
    b = ii(b, c, d, a, x[k + 5] ?? 0, 21, 0xfc93a039);
    a = ii(a, b, c, d, x[k + 12] ?? 0, 6, 0x655b59c3);
    d = ii(d, a, b, c, x[k + 3] ?? 0, 10, 0x8f0ccc92);
    c = ii(c, d, a, b, x[k + 10] ?? 0, 15, 0xffeff47d);
    b = ii(b, c, d, a, x[k + 1] ?? 0, 21, 0x85845dd1);
    a = ii(a, b, c, d, x[k + 8] ?? 0, 6, 0x6fa87e4f);
    d = ii(d, a, b, c, x[k + 15] ?? 0, 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, x[k + 6] ?? 0, 15, 0xa3014314);
    b = ii(b, c, d, a, x[k + 13] ?? 0, 21, 0x4e0811a1);
    a = ii(a, b, c, d, x[k + 4] ?? 0, 6, 0xf7537e82);
    d = ii(d, a, b, c, x[k + 11] ?? 0, 10, 0xbd3af235);
    c = ii(c, d, a, b, x[k + 2] ?? 0, 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, x[k + 9] ?? 0, 21, 0xeb86d391);
    a = addUnsigned(a, aa);
    b = addUnsigned(b, bb);
    c = addUnsigned(c, cc);
    d = addUnsigned(d, dd);
  }
  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
}

function extractWindowOutputJson(html: string): string {
  const marker = "window.$output";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return "";
  const equalsIndex = html.indexOf("=", markerIndex);
  if (equalsIndex < 0) return "";
  return extractBalancedJson(html, equalsIndex + 1);
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<unknown> {
  const text = await fetchText(url, init, timeoutMs);
  const normalized = text.text.trim().replace(/^callback\d*\(/, "").replace(/\)$/, "");
  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<{ text: string; url: string; status: number; ok: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        ...(init.headers as Record<string, string> | undefined)
      }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    return { text, url: response.url || url, status: response.status, ok: response.ok };
  } finally {
    clearTimeout(timeout);
  }
}

function extractRawHtmlMatch(html: string, pattern: RegExp): string {
  const match = String(html || "").match(pattern);
  return match ? (match[1] || "").trim() : "";
}

function extractFirstHtmlMatch(html: string, pattern: RegExp): string {
  return cleanExternalText(extractRawHtmlMatch(html, pattern));
}

function extractMeta(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return extractFirstHtmlMatch(html, new RegExp(`<meta[^>]+(?:name|property|itemprop)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"));
}

function extractTitle(html: string): string {
  return extractFirstHtmlMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
}

function extractFirstJsonLikeImage(value: string): string {
  const text = String(value || "");
  const patterns = [
    /"(?:coverUrl|cover_url|cover|image|imageUrl|image_url|picUrl|pic_url|avatarThumb|avatar_thumb|thumbUrl|thumb_url)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i,
    /"url_list"\s*:\s*\[\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i,
    /(https?:\\?\/\\?\/[^"'<>\s]+\.(?:jpg|jpeg|png|webp)(?:[^"'<>\s]*)?)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    let raw = match[1] || "";
    try { raw = JSON.parse(`"${raw.replace(/"/g, "\\\"")}"`); } catch {}
    raw = cleanExternalText(raw).replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    if (raw) return raw;
  }
  return "";
}

function extractJsonObjects(value: string): string[] {
  const out: string[] = [];
  const text = String(value || "");
  for (let index = 0; index < text.length && out.length < 12; index++) {
    if (text[index] !== "{") continue;
    const json = extractBalancedJson(text, index);
    if (json) {
      out.push(json);
      index += json.length - 1;
    }
  }
  return out;
}

function extractBalancedJson(text: string, start: number): string {
  let index = start;
  while (/\s/.test(text[index] || "")) index++;
  if (text[index] !== "{") return "";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(index, i + 1);
    }
  }
  return "";
}

function cleanExternalText(value: unknown): string {
  return decodeHtmlEntities(stripHtml(String(value || "")))
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string): string {
  return String(value || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower.startsWith("#x");
      const code = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[lower] ?? `&${entity};`;
  });
}

function normalizeImageUrl(raw: string): string {
  let text = cleanExternalText(raw).replace(/\\u002F/g, "/").replace(/\\\//g, "/");
  if (!text) return "";
  if (/^\/\//.test(text)) text = `https:${text}`;
  return /^https?:\/\//i.test(text) ? text.replace(/^http:\/\//i, "https://") : "";
}

function externalUrlFromInput(value: string): string {
  const raw = String(value || "").trim();
  const match = raw.match(/https?:\/\/[^\s"'<>]+/i);
  return cleanCandidate(match ? match[0] : raw);
}

function parseIsoDurationMs(value: string): number {
  const match = String(value || "").trim().match(/^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;
  return ((Number(match[1] || 0) || 0) * 3600 + (Number(match[2] || 0) || 0) * 60 + (Number(match[3] || 0) || 0)) * 1000;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function firstStringFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstStringFromUnknown).find(Boolean) || "";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return firstNonBlank(stringValue(obj.url), stringValue(obj.href), stringValue(obj["@id"]));
  }
  return "";
}

function firstImageFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstImageFromUnknown).find(Boolean) || "";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return firstNonBlank(
      stringValue(obj.url),
      stringValue(obj.contentUrl),
      stringValue(obj.thumbnailUrl),
      firstStringFromUnknown(obj.url_list)
    );
  }
  return "";
}

function artistNameFromUnknown(value: unknown): string {
  if (typeof value === "string") return cleanExternalText(value);
  if (Array.isArray(value)) return value.map(artistNameFromUnknown).filter(Boolean).join(" / ");
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return cleanExternalText(firstNonBlank(stringValue(obj.name), stringValue(obj.artistName), stringValue(obj.nickname)));
  }
  return "";
}

function uniqueExternalTracks(tracks: ExternalTrack[]): ExternalTrack[] {
  const seen = new Set<string>();
  const out: ExternalTrack[] = [];
  for (const track of tracks) {
    const key = `${cleanExternalText(track.name)}|${cleanExternalText(track.artist || track.artists?.join("/") || "")}`;
    if (!track.name || seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function simpleHashHex(value: string): string {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
}

function desktopUserAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
}

function mobileUserAgent(): string {
  return "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
}

import type { Track, PlaylistSummary, PlaylistDetail, LyricLine, LyricPayload, PlayableState } from "@mineradio/shared";

const SODA_PROVIDER_ID = "soda";

export interface SodaSong {
  id?: string;
  name?: string;
  artists?: Array<{ id?: string; name?: string }>;
  album?: {
    id?: string;
    name?: string;
    url_cover?: { uri?: string; urls?: string[]; template_prefix?: string };
  };
  duration?: number;
  preview?: {
    start?: number;
    duration?: number;
  } | null;
  bit_rates?: Array<{
    br?: number;
    size?: number;
    quality?: string;
  } | null | undefined>;
}

export interface SodaPlaylistBody {
  id?: string;
  title?: string;
  url_cover?: { uri?: string; urls?: string[]; template_prefix?: string };
  count_tracks?: number;
  is_private?: boolean;
  public_title?: string;
}

export interface SodaPlaylistDetailBody {
  playlist?: SodaPlaylistBody | null;
  media_resources?: Array<{
    id?: string;
    type?: string;
    entity?: {
      track_wrapper?: {
        track?: SodaSong | null;
      } | null;
    } | null;
  } | null>;
}

export function normalizeProviderImageUrl(url: string | null | undefined): string {
  const value = String(url ?? "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  return value.replace(/^http:\/\//i, "https://");
}

function toArtists(raw: SodaSong): string[] {
  const artists: string[] = [];
  if (Array.isArray(raw.artists)) {
    for (const item of raw.artists) {
      if (item && typeof item.name === "string" && item.name.trim()) {
        artists.push(item.name.trim());
      }
    }
  }
  return artists;
}

function albumName(raw: SodaSong): string {
  if (raw.album && typeof raw.album === "object" && typeof raw.album.name === "string") {
    return raw.album.name.trim();
  }
  return "";
}

function sodaSizedCoverUrl(cover: { uri?: string; urls?: string[]; template_prefix?: string } | null | undefined): string {
  const uri = String(cover?.uri ?? "").trim();
  if (!uri) return "";
  const cdn = (cover?.urls || [])[0] ?? "https://p3-luna.douyinpic.com/img/";
  const templatePrefix = String(cover?.template_prefix ?? "").trim() || "tplv-b829550vbb";
  return `${cdn}${uri}~${templatePrefix}-crop-center:256:256.webp`;
}

function albumCoverUrl(raw: SodaSong): string {
  return sodaSizedCoverUrl(raw.album?.url_cover);
}

function qualityHints(raw: SodaSong): string[] {
  const qualities = Array.isArray(raw.bit_rates)
    ? raw.bit_rates
      .map(item => typeof item?.quality === "string" ? item.quality.trim() : "")
      .filter(Boolean)
    : [];
  return qualities.length > 0 ? Array.from(new Set(qualities)) : ["standard"];
}

function playableState(raw: SodaSong): PlayableState {
  return raw.preview ? "trial_only" : "unknown";
}

export function mapSodaSongToTrack(raw: SodaSong): Track {
  const id = String(raw.id ?? "").trim();
  const durationMs = typeof raw.duration === "number" ? raw.duration : undefined;
  return {
    provider: SODA_PROVIDER_ID,
    id,
    sourceId: id,
    title: String(raw.name ?? "").trim(),
    artists: toArtists(raw),
    album: albumName(raw),
    coverUrl: normalizeProviderImageUrl(albumCoverUrl(raw)),
    durationMs,
    qualityHints: qualityHints(raw),
    playableState: playableState(raw)
  };
}

export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  if (!text || typeof text !== "string") return out;
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (!rawLine) continue;
    const marks: Array<{ ms: number; end: number }> = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawLine)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] ?? "";
      const frac = fracRaw ? parseInt((fracRaw + "000").slice(0, 3), 10) : 0;
      marks.push({ ms: min * 60000 + sec * 1000 + frac, end: m.index + m[0].length });
    }
    if (marks.length === 0) continue;
    const last = marks[marks.length - 1];
    const lineText = rawLine.slice(last.end).trim();
    for (const mark of marks) out.push({ timeMs: mark.ms, text: lineText });
  }
  return out;
}

function finalizeLyricLineDurations(lines: LyricLine[]): LyricLine[] {
  lines.sort((a, b) => a.timeMs - b.timeMs);
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    if (!current) continue;
    const next = lines[i + 1];
    const inferred = next && next.timeMs > current.timeMs ? next.timeMs - current.timeMs : 4800;
    const duration = typeof current.durationMs === "number" && Number.isFinite(current.durationMs) && current.durationMs > 0
      ? current.durationMs
      : inferred;
    current.durationMs = Math.max(450, Math.min(12000, duration));
    current.charCount = Math.max(1, current.charCount ?? String(current.text ?? "").length);
  }
  return lines;
}

export function parseSodaLyricText(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const raw = String(text ?? "");
  if (!raw.trim()) return lines;

  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) continue;

    const lineStartMs = Math.max(0, parseInt(lineMatch[1], 10) || 0);
    const lineDurationMs = Math.max(0, parseInt(lineMatch[2], 10) || 0);
    const body = String(lineMatch[3] ?? "");
    const words: NonNullable<LyricLine["words"]> = [];
    let fullText = "";
    let pos = 0;

    while (pos < body.length) {
      const open = body.indexOf("<", pos);
      if (open < 0) break;
      const afterOpen = open + 1;
      if (afterOpen >= body.length || !/\d/.test(body[afterOpen] ?? "")) {
        pos = afterOpen;
        continue;
      }

      const comma1 = body.indexOf(",", afterOpen);
      if (comma1 < 0) break;
      const startRaw = body.slice(afterOpen, comma1);
      const wordStartMs = parseInt(startRaw, 10);
      if (!Number.isFinite(wordStartMs)) {
        pos = afterOpen;
        continue;
      }

      const durStart = comma1 + 1;
      const close = body.indexOf(">", durStart);
      const comma2 = body.indexOf(",", durStart);
      const durEnd = close < 0 ? body.length : close;
      const durationSliceEnd = comma2 >= 0 && comma2 < durEnd ? comma2 : durEnd;
      const wordDurationMs = parseInt(body.slice(durStart, durationSliceEnd), 10);
      if (!Number.isFinite(wordDurationMs)) {
        pos = afterOpen;
        continue;
      }

      const textStart = close >= 0 ? close + 1 : body.length;
      const nextOpen = body.indexOf("<", textStart);
      const text = body.slice(textStart, nextOpen < 0 ? body.length : nextOpen);
      const c0 = fullText.length;
      fullText += text;
      if (text) {
        words.push({
          text,
          timeMs: Math.max(0, lineStartMs + wordStartMs),
          durationMs: Math.max(0, wordDurationMs),
          c0,
          c1: fullText.length
        });
      }
      pos = nextOpen < 0 ? body.length : nextOpen;
    }

    if (words.length > 0) {
      lines.push({
        timeMs: lineStartMs,
        durationMs: lineDurationMs,
        text: fullText,
        words,
        source: "soda-word",
        charCount: Math.max(1, fullText.length)
      });
      continue;
    }

    const plainText = body.replace(/<\d+,\d+(?:,\d+)?>/g, "").trim();
    if (!plainText) continue;
    lines.push({
      timeMs: lineStartMs,
      durationMs: lineDurationMs,
      text: plainText,
      source: "soda-line",
      charCount: Math.max(1, plainText.length)
    });
  }

  return finalizeLyricLineDurations(lines);
}

export function mapSodaLyricToPayload(opts: {
  trackId: string;
  lyric?: string;
  trans?: string;
}): LyricPayload {
  const sodaLines = parseSodaLyricText(opts.lyric ?? "");
  const baseLines = sodaLines.length > 0 ? sodaLines : parseLrc(opts.lyric ?? "");
  const transLines = parseLrc(opts.trans ?? "");
  const transMap = new Map<number, string>();
  for (const line of transLines) transMap.set(line.timeMs, line.text);
  return {
    provider: SODA_PROVIDER_ID,
    trackId: opts.trackId,
    lines: baseLines.map(line => {
      const translation = transMap.get(line.timeMs);
      return translation ? { ...line, translation } : line;
    }),
    hasTranslation: transLines.length > 0,
    isWordByWord: baseLines.some((line) => Array.isArray(line.words) && line.words.length > 0)
  };
}

export function mapSodaPlaylistToSummary(raw: SodaPlaylistBody, idHint?: string): PlaylistSummary {
  const id = String(raw.id ?? idHint ?? "").trim();
  const trackCount = typeof raw.count_tracks === "number" ? raw.count_tracks : undefined;
  return {
    provider: SODA_PROVIDER_ID,
    id,
    name: String(raw.title ?? raw.public_title ?? "").trim(),
    coverUrl: normalizeProviderImageUrl(sodaSizedCoverUrl(raw.url_cover)),
    trackCount,
    trackIds: [],
    subscribed: raw.is_private === false
  };
}

export function mapSodaPlaylistToDetail(raw: SodaPlaylistBody | null | undefined, idHint?: string): PlaylistDetail {
  if (!raw) {
    return {
      provider: SODA_PROVIDER_ID,
      id: String(idHint ?? "").trim(),
      name: "",
      coverUrl: "",
      trackCount: undefined,
      trackIds: [],
      subscribed: false,
      tracks: []
    };
  }
  const summary = mapSodaPlaylistToSummary(raw, idHint);
  return {
    ...summary,
    tracks: []
  };
}

export function mapSodaPlaylistDetailToDetail(
  raw: SodaPlaylistDetailBody | null | undefined,
  idHint?: string
): PlaylistDetail {
  const playlist = raw?.playlist ?? null;
  const resources = raw && Array.isArray(raw.media_resources) ? raw.media_resources : [];
  const tracks = resources
    .map((item) => item?.entity?.track_wrapper?.track ?? null)
    .filter(Boolean)
    .map((track) => mapSodaSongToTrack(track as SodaSong));
  const summary = mapSodaPlaylistToSummary(playlist ?? {}, idHint);
  return {
    ...summary,
    tracks
  };
}

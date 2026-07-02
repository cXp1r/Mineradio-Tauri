import type { Track, PlaylistSummary, PlaylistDetail, LyricLine, LyricPayload, PlayableState } from "@mineradio/shared";

const SODA_PROVIDER_ID = "soda";

export interface SodaSong {
  id?: number | string;
  songId?: number | string;
  sourceId?: number | string;
  title?: string;
  name?: string;
  artist?: string;
  artists?: Array<{ id?: number | string; name?: string } | string | null | undefined>;
  album?: string | { id?: number | string; name?: string; coverUrl?: string; picUrl?: string };
  albumName?: string;
  coverUrl?: string;
  durationMs?: number;
  duration?: number;
  mediaMid?: string;
  preview?: {
    start?: number;
    duration?: number;
  } | null;
}

export interface SodaPlaylistBody {
  id?: number | string;
  playlistId?: number | string;
  title?: string;
  name?: string;
  coverUrl?: string;
  url_cover?: { uri?: string; urls?: string[]; template_prefix?: string } | string;
  trackCount?: number;
  count_tracks?: number;
  trackIds?: Array<number | string>;
  tracks?: SodaSong[];
  subscribed?: boolean;
  is_private?: boolean;
  public_title?: string;
  countTracks?: number;
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
  mediaResources?: Array<{
    id?: string;
    type?: string;
    entity?: {
      track_wrapper?: {
        track?: SodaSong | null;
      } | null;
    } | null;
  } | null>;
}

function playlistCoverUrl(raw: SodaPlaylistBody): string {
  const cover = raw.url_cover;
  if (typeof cover === "string") return cover;
  if (cover && typeof cover === "object") {
    if (Array.isArray(cover.urls) && cover.urls[0]) return cover.urls[0];
    if (cover.uri) return cover.uri;
  }
  return raw.coverUrl ?? "";
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
      if (typeof item === "string" && item.trim()) artists.push(item.trim());
      else if (item && typeof item === "object" && typeof item.name === "string" && item.name.trim()) {
        artists.push(item.name.trim());
      }
    }
  }
  if (artists.length === 0 && typeof raw.artist === "string" && raw.artist.trim()) {
    artists.push(...raw.artist.split(/[\/,、]/).map(s => s.trim()).filter(Boolean));
  }
  return artists;
}

function albumName(raw: SodaSong): string {
  if (typeof raw.album === "string") return raw.album.trim();
  if (raw.album && typeof raw.album === "object" && typeof raw.album.name === "string") {
    return raw.album.name.trim();
  }
  return String(raw.albumName ?? "").trim();
}

function albumCoverUrl(raw: SodaSong): string {
  if (raw.coverUrl) return raw.coverUrl;
  if (raw.album && typeof raw.album === "object") {
    return raw.album.coverUrl ?? raw.album.picUrl ?? "";
  }
  return "";
}

function playableState(raw: SodaSong): PlayableState {
  return raw.preview ? "trial_only" : "unknown";
}

export function mapSodaSongToTrack(raw: SodaSong): Track {
  const id = String(raw.id ?? raw.songId ?? raw.sourceId ?? "").trim();
  const durationMs =
    typeof raw.durationMs === "number"
      ? raw.durationMs
      : typeof raw.duration === "number"
        ? raw.duration
        : undefined;
  return {
    provider: SODA_PROVIDER_ID,
    id,
    sourceId: id,
    mediaMid: raw.mediaMid ? String(raw.mediaMid) : undefined,
    title: String(raw.title ?? raw.name ?? "").trim(),
    artists: toArtists(raw),
    album: albumName(raw),
    coverUrl: normalizeProviderImageUrl(albumCoverUrl(raw)),
    durationMs,
    qualityHints: ["standard"],
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

export function mapSodaLyricToPayload(opts: {
  trackId: string;
  lyric?: string;
  trans?: string;
}): LyricPayload {
  const baseLines = parseLrc(opts.lyric ?? "");
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
    isWordByWord: false
  };
}

export function mapSodaPlaylistToSummary(raw: SodaPlaylistBody, idHint?: string): PlaylistSummary {
  const id = String(raw.id ?? raw.playlistId ?? idHint ?? "").trim();
  const trackCount =
    typeof raw.trackCount === "number" ? raw.trackCount :
    typeof raw.count_tracks === "number" ? raw.count_tracks :
    typeof raw.countTracks === "number" ? raw.countTracks :
    undefined;
  return {
    provider: SODA_PROVIDER_ID,
    id,
    name: String(raw.title ?? raw.name ?? raw.public_title ?? "").trim(),
    coverUrl: normalizeProviderImageUrl(playlistCoverUrl(raw)),
    trackCount,
    trackIds: Array.isArray(raw.trackIds) ? raw.trackIds.map(String).filter(Boolean) : [],
    subscribed: raw.subscribed === true || raw.is_private === false
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
    tracks: Array.isArray(raw.tracks) ? raw.tracks.map(mapSodaSongToTrack) : []
  };
}

export function mapSodaPlaylistDetailToDetail(
  raw: SodaPlaylistDetailBody | null | undefined,
  idHint?: string
): PlaylistDetail {
  const playlist = raw?.playlist ?? null;
  const resources = raw
    ? (Array.isArray(raw.media_resources) ? raw.media_resources : Array.isArray(raw.mediaResources) ? raw.mediaResources : [])
    : [];
  const tracks = resources
    .map((item) => item?.entity?.track_wrapper?.track ?? null)
    .filter(Boolean)
    .map((track) => mapSodaSongToTrack(track as SodaSong));
  const summary = mapSodaPlaylistToSummary(playlist ?? {}, idHint);
  return {
    ...summary,
    tracks: tracks.length > 0
      ? tracks
      : Array.isArray((playlist as SodaPlaylistBody | null | undefined)?.tracks)
        ? ((playlist as SodaPlaylistBody).tracks ?? []).map(mapSodaSongToTrack)
        : []
  };
}

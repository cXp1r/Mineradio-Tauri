import type {
  Track,
  PlaylistSummary,
  PlaylistDetail,
  LyricLine,
  LyricPayload
} from "@mineradio/shared";

export interface QqSong {
  songmid?: string;
  mid?: string;
  songname?: string;
  name?: string;
  singer?: Array<{ mid?: string; name?: string } | null | undefined>;
  singername?: string;
  singerName?: string;
  albumname?: string;
  albummid?: string;
  albumid?: number | string;
  interval?: number; // seconds
  songid?: number | string;
  pic?: string;
}

export interface QqPlaylistBody {
  disstid?: number | string;
  dissid?: number | string;
  dirid?: number | string;
  tid?: number | string;
  id?: number | string;
  dissname?: string;
  diss_name?: string;
  name?: string;
  title?: string;
  logo?: string;
  diss_cover?: string;
  picurl?: string;
  cover?: string;
  total_song_num?: number;
  song_cnt?: number;
  songnum?: number;
  song_count?: number;
  songlist?: QqSong[];
}

export function mapQqSongToTrack(raw: QqSong): Track {
  const idStr = raw && raw.songmid != null ? String(raw.songmid) : (raw?.mid != null ? String(raw.mid) : "");
  const singers = raw && Array.isArray(raw.singer) ? raw.singer : [];
  const artists: string[] = [];
  for (const s of singers) {
    if (s && typeof s === "object" && typeof s.name === "string" && s.name.length > 0) {
      artists.push(s.name);
    }
  }
  if (artists.length === 0) {
    const singerText = typeof raw?.singer === "string"
      ? raw.singer
      : (typeof raw?.singername === "string" ? raw.singername : raw?.singerName);
    if (typeof singerText === "string" && singerText.trim().length > 0) {
      artists.push(...singerText.split(/[、/,]/).map(s => s.trim()).filter(Boolean));
    }
  }
  const intervalSec = raw && typeof raw.interval === "number" ? raw.interval : undefined;
  const durationMs = intervalSec != null ? intervalSec * 1000 : undefined;
  // QQ search returns `albummid`; jsososo album cover URL is derived client-side:
  //   https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg
  const albumMid = raw && typeof raw.albummid === "string" ? raw.albummid : "";
  const coverUrl = typeof raw?.pic === "string" && raw.pic.length > 0
    ? raw.pic.replace(/^http:\/\//, "https://")
    : albumMid.length > 0
    ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
    : "";
  return {
    provider: "qq",
    id: idStr,
    sourceId: idStr,
    title: raw?.songname ?? raw?.name ?? "",
    artists,
    album: raw?.albumname ?? "",
    coverUrl,
    durationMs,
    qualityHints: ["standard"],
    playableState: "unknown"
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
      let frac = 0;
      if (fracRaw) {
        const padded = (fracRaw + "000").slice(0, 3);
        frac = parseInt(padded, 10);
      }
      marks.push({ ms: min * 60000 + sec * 1000 + frac, end: m.index + m[0].length });
    }
    if (marks.length === 0) continue;
    const last = marks[marks.length - 1];
    const lineText = rawLine.slice(last.end).trim();
    for (const mark of marks) out.push({ timeMs: mark.ms, text: lineText });
  }
  return out;
}

export function parseQrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  if (!text || typeof text !== "string") return out;
  const lineRe = /\[(\d+),(\d+)\]([^\r\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    const timeMs = Math.max(0, parseInt(m[1], 10) || 0);
    const durationMs = Math.max(0, parseInt(m[2], 10) || 0);
    const rawText = String(m[3] ?? "")
      .replace(/\(\d+,\d+(?:,\d+)?\)/g, "")
      .trim();
    if (!rawText) continue;
    out.push({
      timeMs,
      durationMs,
      text: rawText,
      source: "qrc"
    });
  }
  return out;
}

export function mapQqLyricToPayload(opts: {
  trackId: string;
  lyric?: string;
  trans?: string;
  qrc?: string;
  source?: string;
}): LyricPayload {
  const lrcText = opts.lyric ?? "";
  const transText = opts.trans ?? "";
  const qrcText = opts.qrc ?? "";
  let source = opts.source;
  let baseLines = parseLrc(lrcText);
  if (baseLines.length === 0 && qrcText.trim()) {
    baseLines = parseQrc(qrcText);
    source = "qrc";
  }
  const transLines = parseLrc(transText);
  const transMap = new Map<number, string>();
  for (const t of transLines) transMap.set(t.timeMs, t.text);
  const lines: LyricLine[] = baseLines.map(l => {
    const tr = transMap.get(l.timeMs);
    const line = source ? { ...l, source } : l;
    return tr != null ? { ...line, translation: tr } : line;
  });
  const hasTranslation = transText.trim().length > 0 && transLines.length > 0;
  return {
    provider: "qq",
    trackId: opts.trackId,
    lines,
    hasTranslation,
    isWordByWord: false
  };
}

export function mapQqPlaylistToSummary(
  raw: QqPlaylistBody,
  idHint?: string
): PlaylistSummary {
  const rawId =
    raw?.disstid ??
    raw?.dissid ??
    raw?.dirid ??
    raw?.tid ??
    raw?.id;
  const idStr = rawId != null ? String(rawId) : (idHint ?? "");
  const trackIds: string[] = [];
  if (raw && Array.isArray(raw.songlist)) {
    for (const s of raw.songlist) {
      if (s && typeof s === "object" && s.songmid != null) {
        const sm = String(s.songmid);
        if (sm.length > 0) trackIds.push(sm);
      }
    }
  }
  return {
    provider: "qq",
    id: idStr,
    name: raw?.dissname ?? raw?.diss_name ?? raw?.name ?? raw?.title ?? "",
    coverUrl: raw?.logo ?? raw?.diss_cover ?? raw?.picurl ?? raw?.cover ?? "",
    trackCount:
      typeof raw?.total_song_num === "number" ? raw.total_song_num :
      typeof raw?.song_cnt === "number" ? raw.song_cnt :
      typeof raw?.songnum === "number" ? raw.songnum :
      typeof raw?.song_count === "number" ? raw.song_count :
      undefined,
    trackIds,
    subscribed: false
  };
}

export function mapQqPlaylistToDetail(
  raw: QqPlaylistBody | null | undefined,
  idHint?: string
): PlaylistDetail {
  if (!raw) {
    return {
      provider: "qq",
      id: idHint ?? "",
      name: "",
      coverUrl: "",
      trackCount: undefined,
      trackIds: [],
      subscribed: false,
      tracks: []
    };
  }
  const summary = mapQqPlaylistToSummary(raw, idHint);
  const tracks: Track[] = Array.isArray(raw.songlist)
    ? (raw.songlist as QqSong[]).map(mapQqSongToTrack)
    : [];
  return { ...summary, tracks };
}

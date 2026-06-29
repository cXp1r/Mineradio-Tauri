import { z } from "zod";
import { ProviderIdSchema } from "./provider";
import type { Track } from "./track";

export const LyricLineSchema = z.object({
  timeMs: z.number().nonnegative(),
  text: z.string(),
  translation: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  charCount: z.number().int().positive().optional(),
  source: z.string().optional(),
  words: z.array(z.object({
    text: z.string().optional(),
    timeMs: z.number().nonnegative(),
    durationMs: z.number().nonnegative().optional(),
    c0: z.number().int().nonnegative(),
    c1: z.number().int().nonnegative()
  })).optional()
});

export const LyricPayloadSchema = z.object({
  provider: ProviderIdSchema,
  trackId: z.string().min(1),
  lines: z.array(LyricLineSchema),
  hasTranslation: z.boolean().default(false),
  isWordByWord: z.boolean().default(false)
});

export type LyricLine = z.infer<typeof LyricLineSchema>;
export type LyricPayload = z.infer<typeof LyricPayloadSchema>;

const NO_LYRIC_TEXTS = new Set([
  "纯音乐请欣赏",
  "暂无歌词",
  "暂无歌词敬请期待",
  "此歌曲为没有填词的纯音乐请您欣赏"
]);

function isNoLyricText(text: string): boolean {
  const compact = String(text || "").replace(/\s+/g, "").replace(/[，,。.!！?？、~～]/g, "");
  return !compact || NO_LYRIC_TEXTS.has(compact);
}

function lyricFallbackText(track: Track): string {
  const title = String(track.title || "").trim();
  const artist = track.artists.map((name) => String(name || "").trim()).filter(Boolean).join(" / ");
  if (title && artist) return `${title} - ${artist}`;
  return title || artist;
}

export function ensureLyricFallbackPayload(payload: LyricPayload, track: Track): LyricPayload {
  const lines = Array.isArray(payload.lines)
    ? payload.lines.filter((line) => line && String(line.text || "").trim())
    : [];
  if (lines.length > 0 && !lines.every((line) => isNoLyricText(line.text))) {
    return { ...payload, lines };
  }
  const text = lyricFallbackText(track);
  if (!text) return { ...payload, lines: [] };
  return {
    ...payload,
    lines: [{
      timeMs: 0,
      durationMs: 9999000,
      text,
      source: "fallback",
      charCount: Math.max(1, text.length)
    }],
    hasTranslation: false,
    isWordByWord: false
  };
}

function parseTagTimeMs(min: string, sec: string, frac?: string): number {
  let t = (parseInt(min, 10) || 0) * 60000 + (parseInt(sec, 10) || 0) * 1000;
  if (frac) {
    const padded = (frac + "000").slice(0, 3);
    t += parseInt(padded, 10) || 0;
  }
  return t;
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

export function parseCustomLyricText(text: string, opts: { durationMs?: number } = {}): LyricLine[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const lrcLines: LyricLine[] = [];
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    const times: number[] = [];
    tagRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(rawLine)) !== null) {
      times.push(parseTagTimeMs(m[1], m[2], m[3]));
    }
    if (times.length === 0) continue;
    const lineText = rawLine.replace(tagRe, "").trim();
    if (!lineText || isNoLyricText(lineText)) continue;
    for (const timeMs of times) {
      lrcLines.push({
        timeMs,
        text: lineText,
        source: "custom-lrc"
      });
    }
  }
  if (lrcLines.length > 0) return finalizeLyricLineDurations(lrcLines);

  const rows = raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isNoLyricText(line));
  if (rows.length === 0) return [];
  const durationMs = typeof opts.durationMs === "number" && Number.isFinite(opts.durationMs) && opts.durationMs > 8000 ? opts.durationMs : 0;
  const gapMs = durationMs
    ? Math.max(2800, Math.min(7200, durationMs / Math.max(1, rows.length)))
    : 4800;
  return finalizeLyricLineDurations(rows.map((line, i) => ({
    timeMs: Math.round(i * gapMs),
    durationMs: gapMs,
    text: line,
    source: "custom-text",
    charCount: Math.max(1, line.length)
  })));
}

export type LyricSourcePreference = "custom" | "original";

export function resolvePreferredLyricPayload(input: {
  original: LyricPayload;
  customText?: string | null;
  preference?: LyricSourcePreference | null;
  durationMs?: number;
}): { payload: LyricPayload; source: LyricSourcePreference } {
  const customLines = parseCustomLyricText(input.customText ?? "", { durationMs: input.durationMs });
  if (input.preference !== "custom" && input.preference !== "original" && customLines.length === 0) {
    return { payload: input.original, source: "original" };
  }
  if (input.preference === "original") return { payload: input.original, source: "original" };
  const originalIsFallback = input.original.lines.length > 0 && input.original.lines.every((line) => line.source === "fallback");
  const useCustom = input.preference === "custom" || (input.preference == null && originalIsFallback && customLines.length > 0);
  if (!useCustom || customLines.length === 0) return { payload: input.original, source: "original" };
  return {
    source: "custom",
    payload: {
      provider: input.original.provider,
      trackId: input.original.trackId,
      lines: customLines,
      hasTranslation: false,
      isWordByWord: false
    }
  };
}

import type { LyricPayload, LyricLine } from "@mineradio/shared";
import {
  getLyricIndex,
  selectLyricLineAtPosition,
} from "../lyrics/lyric-index";

export interface DesktopLyricSnapshot {
  text: string;
  progress: number;
  progressSpan: number;
}

export function buildDesktopLyricSnapshot(
  payload: LyricPayload | null,
  positionMs: number,
  fallbackText: string,
): DesktopLyricSnapshot {
  const index = getLyricIndex(payload);
  const sorted = index.lines;
  const current = selectLyricLineAtPosition(index, positionMs, { leadMs: 50 });
  if (!current) {
    return fallbackSnapshot(fallbackText);
  }
  const next = sorted[current.index + 1]?.line ?? null;
  const text = normalizeDesktopLyricText(current.line.text || fallbackText);
  if (!text) return fallbackSnapshot(fallbackText);
  const progressSpan = currentLineSpanSeconds(current.line, next, positionMs);
  return {
    text,
    progress: lyricLineProgress(current.line, next, positionMs),
    progressSpan,
  };
}

export function normalizeDesktopLyricText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function currentLineSpanSeconds(
  line: LyricLine,
  next: LyricLine | null,
  positionMs: number,
): number {
  const lineSeconds = line.timeMs / 1000;
  const nextSeconds =
    next && next.timeMs > line.timeMs
      ? next.timeMs / 1000
      : lineSeconds + Math.max(0, (line.durationMs ?? 4800) / 1000);
  const currentSeconds = Number.isFinite(positionMs) ? positionMs / 1000 : 0;
  const fallbackEnd = Math.max(currentSeconds + 0.75, lineSeconds + 0.75);
  return Math.max(0.75, (nextSeconds || fallbackEnd) - lineSeconds);
}

function lyricLineProgress(
  line: LyricLine,
  next: LyricLine | null,
  positionMs: number,
): number {
  const now = (Number.isFinite(positionMs) ? positionMs : 0) / 1000;
  const words = Array.isArray(line.words) ? line.words : [];
  const charCount = line.charCount ?? 0;
  if (words.length > 0 && charCount > 0) {
    let lastProgress = 0;
    const adjustedNow = now + 0.03;
    for (const word of words) {
      const start = word.timeMs / 1000;
      const end = start + Math.max(0.08, (word.durationMs ?? 240) / 1000);
      if (adjustedNow < start) return lastProgress;
      const span = Math.max(0.08, end - start);
      const local = adjustedNow >= end ? 1 : clamp01((adjustedNow - start) / span);
      const progress = (word.c0 + (word.c1 - word.c0) * local) / charCount;
      lastProgress = Math.max(lastProgress, progress);
      if (adjustedNow < end) return clamp01(lastProgress);
    }
    return 1;
  }
  const lineSeconds = line.timeMs / 1000;
  const span = currentLineSpanSeconds(line, next, positionMs);
  const adjustedNow = now + 0.02;
  const raw = clamp01((adjustedNow - lineSeconds) / span);
  return raw * raw * (3 - 2 * raw);
}

function fallbackSnapshot(text: string): DesktopLyricSnapshot {
  return {
    text: normalizeDesktopLyricText(text),
    progress: 0,
    progressSpan: 4.8,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

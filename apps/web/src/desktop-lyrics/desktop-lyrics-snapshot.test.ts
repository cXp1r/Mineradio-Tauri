import { expect, test } from "bun:test";
import type { LyricPayload } from "@mineradio/shared";
import { buildDesktopLyricSnapshot } from "./desktop-lyrics-snapshot";

function payload(lines: LyricPayload["lines"]): LyricPayload {
  return {
    provider: "netease",
    trackId: "42",
    lines,
    hasTranslation: false,
    isWordByWord: false,
  };
}

test("buildDesktopLyricSnapshot follows sorted current line and baseline progress span", () => {
  const snapshot = buildDesktopLyricSnapshot(
    payload([
      { timeMs: 5000, text: "next" },
      { timeMs: 1000, text: " first  line ", durationMs: 3200 },
    ]),
    2500,
    "fallback",
  );

  expect(snapshot.text).toBe("first line");
  expect(snapshot.progressSpan).toBe(4);
  expect(snapshot.progress).toBeGreaterThan(0.3);
  expect(snapshot.progress).toBeLessThan(0.4);
});

test("buildDesktopLyricSnapshot uses native word timing when present", () => {
  const snapshot = buildDesktopLyricSnapshot(
    payload([
      {
        timeMs: 1000,
        text: "hello world",
        durationMs: 2400,
        charCount: 10,
        words: [
          { text: "hello", timeMs: 1000, durationMs: 500, c0: 0, c1: 5 },
          { text: "world", timeMs: 1600, durationMs: 500, c0: 5, c1: 10 },
        ],
      },
    ]),
    1750,
    "fallback",
  );

  expect(snapshot.text).toBe("hello world");
  expect(snapshot.progress).toBeGreaterThan(0.6);
  expect(snapshot.progress).toBeLessThan(0.8);
  expect(snapshot.progressSpan).toBe(2.4);
});

test("buildDesktopLyricSnapshot falls back to current track label", () => {
  const snapshot = buildDesktopLyricSnapshot(null, 1200, "Track - Artist");

  expect(snapshot).toEqual({
    text: "Track - Artist",
    progress: 0,
    progressSpan: 4.8,
  });
});

test("buildDesktopLyricSnapshot reuses one normalized lyric index across playback ticks", () => {
  const p = payload([
    { timeMs: 5000, text: "cached next" },
    { timeMs: 1000, text: "cached first", durationMs: 3200 },
    { timeMs: 3000, text: "cached middle", durationMs: 1800 },
  ]);
  const originalSort = Array.prototype.sort;
  let sortCalls = 0;
  Array.prototype.sort = function patchedSort<T>(
    this: T[],
    compareFn?: (a: T, b: T) => number,
  ): T[] {
    sortCalls += 1;
    return originalSort.call(this, compareFn) as T[];
  };
  try {
    expect(buildDesktopLyricSnapshot(p, 1500, "fallback").text).toBe("cached first");
    expect(buildDesktopLyricSnapshot(p, 3500, "fallback").text).toBe("cached middle");
    expect(buildDesktopLyricSnapshot(p, 6000, "fallback").text).toBe("cached next");
    expect(sortCalls).toBe(1);
  } finally {
    Array.prototype.sort = originalSort;
  }
});

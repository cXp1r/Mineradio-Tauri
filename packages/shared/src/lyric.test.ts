import { expect, test } from "bun:test";
import {
  LyricPayloadSchema,
  ensureLyricFallbackPayload,
  parseCustomLyricText,
  resolvePreferredLyricPayload
} from "./lyric";
import type { Track } from "./track";

test("LyricPayloadSchema carries native karaoke word timing without losing plain line fields", () => {
  const parsed = LyricPayloadSchema.parse({
    provider: "netease",
    trackId: "42",
    hasTranslation: true,
    isWordByWord: true,
    lines: [
      {
        timeMs: 1000,
        durationMs: 2000,
        text: "你好",
        translation: "hello",
        charCount: 2,
        source: "yrc-word",
        words: [
          { text: "你", timeMs: 1000, durationMs: 500, c0: 0, c1: 1 },
          { text: "好", timeMs: 1500, durationMs: 500, c0: 1, c1: 2 }
        ]
      }
    ]
  });

  expect(parsed.lines[0].timeMs).toBe(1000);
  expect(parsed.lines[0].durationMs).toBe(2000);
  expect(parsed.lines[0].translation).toBe("hello");
  expect(parsed.lines[0].charCount).toBe(2);
  expect(parsed.lines[0].source).toBe("yrc-word");
  expect(parsed.lines[0].words?.[1]).toEqual({
    text: "好",
    timeMs: 1500,
    durationMs: 500,
    c0: 1,
    c1: 2
  });
});

test("parseCustomLyricText parses timestamped LRC as custom-lrc lines", () => {
  const lines = parseCustomLyricText("[00:01.00]第一句\n[00:03.50]第二句", { durationMs: 9000 });

  expect(lines).toEqual([
    { timeMs: 1000, durationMs: 2500, text: "第一句", source: "custom-lrc", charCount: 3 },
    { timeMs: 3500, durationMs: 4800, text: "第二句", source: "custom-lrc", charCount: 3 }
  ]);
});

test("parseCustomLyricText spreads plain text across known duration like the baseline", () => {
  const lines = parseCustomLyricText("第一句\n\n第二句", { durationMs: 10000 });

  expect(lines).toEqual([
    { timeMs: 0, durationMs: 5000, text: "第一句", source: "custom-text", charCount: 3 },
    { timeMs: 5000, durationMs: 5000, text: "第二句", source: "custom-text", charCount: 3 }
  ]);
});

test("resolvePreferredLyricPayload picks custom lyrics when original payload is fallback unless user pins original", () => {
  const original = LyricPayloadSchema.parse({
    provider: "netease",
    trackId: "42",
    lines: [{ timeMs: 0, text: "Song - Artist", source: "fallback" }],
    hasTranslation: false,
    isWordByWord: false
  });

  const custom = "自定义第一句\n自定义第二句";
  const picked = resolvePreferredLyricPayload({
    original,
    customText: custom,
    preference: undefined,
    durationMs: 9600
  });
  const pinnedOriginal = resolvePreferredLyricPayload({
    original,
    customText: custom,
    preference: "original",
    durationMs: 9600
  });

  expect(picked.source).toBe("custom");
  expect(picked.payload.lines[0].text).toBe("自定义第一句");
  expect(picked.payload.lines[0].durationMs).toBe(4800);
  expect(pinnedOriginal.source).toBe("original");
  expect(pinnedOriginal.payload.lines[0].text).toBe("Song - Artist");
});

test("ensureLyricFallbackPayload mirrors baseline title-artist fallback for empty provider lyrics", () => {
  const track: Track = {
    provider: "netease",
    id: "42",
    sourceId: "42",
    title: "夜航",
    artists: ["星野"],
    album: "",
    coverUrl: "",
    qualityHints: [],
    playableState: "playable"
  };
  const original = LyricPayloadSchema.parse({
    provider: "netease",
    trackId: "42",
    lines: [],
    hasTranslation: false,
    isWordByWord: false
  });

  const payload = ensureLyricFallbackPayload(original, track);

  expect(payload.lines).toEqual([
    { timeMs: 0, durationMs: 9999000, text: "夜航 - 星野", source: "fallback", charCount: 7 }
  ]);
});

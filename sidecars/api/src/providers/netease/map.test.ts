import { expect, test } from "bun:test";
import {
  parseLrc,
  parseYrcText,
  mapHanaSongToTrack,
  mapHanaLyricToPayload,
  mapHanaPlaylistToSummary,
  mapHanaPlaylistToDetail,
  normalizeProviderImageUrl,
  mapPlayable
} from "./map";

test("parseLrc parses mm:ss.xx and mm:ss.xxx, supports multi-timestamp, ignores metadata", () => {
  const lrc =
    "[ti:Title]\n[ar:Artist]\n[al:Album]\n[by:Author]\n[offset:5]\n" +
    "[00:01.00]line1\n[00:03.50]line2\n[00:05.123]line3\n[00:10.00][00:11.00]line4";
  const lines = parseLrc(lrc);
  expect(lines.length).toBe(5);
  expect(lines[0].timeMs).toBe(1000);
  expect(lines[0].text).toBe("line1");
  expect(lines[1].timeMs).toBe(3500);
  expect(lines[1].text).toBe("line2");
  expect(lines[2].timeMs).toBe(5123);
  expect(lines[2].text).toBe("line3");
  expect(lines[3].timeMs).toBe(10000);
  expect(lines[3].text).toBe("line4");
  expect(lines[4].timeMs).toBe(11000);
  expect(lines[4].text).toBe("line4");
});

test("parseLrc returns empty array for empty string", () => {
  expect(parseLrc("").length).toBe(0);
  expect(parseLrc("[ar:Only]\n[offset:5]").length).toBe(0);
});

test("parseLrc handles missing fractional seconds", () => {
  const lines = parseLrc("[00:01]a\n[01:02]b");
  expect(lines.length).toBe(2);
  expect(lines[0].timeMs).toBe(1000);
  expect(lines[1].timeMs).toBe(62000);
});

test("mapHanaSongToTrack maps all fields with provider netease and sourceId from id", () => {
  const t = mapHanaSongToTrack({
    id: 42,
    name: "n",
    ar: [{ id: 1, name: "a" }, { id: 2, name: "b" }, , { id: 3, name: "" }],
    al: { id: 2, name: "album", picUrl: "cover" },
    dt: 123000,
    fee: 0
  });
  expect(t.provider).toBe("netease");
  expect(t.id).toBe("42");
  expect(t.sourceId).toBe("42");
  expect(t.title).toBe("n");
  expect(t.artists.length).toBe(2);
  expect(t.artists[0]).toBe("a");
  expect(t.artists[1]).toBe("b");
  expect(t.album).toBe("album");
  expect(t.coverUrl).toBe("cover");
  expect(t.durationMs).toBe(123000);
  expect(t.qualityHints.length).toBe(1);
  expect(t.qualityHints[0]).toBe("standard");
  expect(t.playableState).toBe("unknown");
});

test("normalizeProviderImageUrl keeps protocol-relative provider covers usable outside CSS", () => {
  expect(normalizeProviderImageUrl("//p3.music.126.net/a.jpg")).toBe("https://p3.music.126.net/a.jpg");
  expect(normalizeProviderImageUrl("http://p3.music.126.net/a.jpg")).toBe("https://p3.music.126.net/a.jpg");
  expect(normalizeProviderImageUrl(" https://p3.music.126.net/a.jpg ")).toBe("https://p3.music.126.net/a.jpg");
});

test("mapHanaSongToTrack maps fee to playableState (1=>vip_required, 4=>paid_required, 8=>trial_only)", () => {
  expect(mapHanaSongToTrack({ id: 1, name: "vip", fee: 1 }).playableState).toBe("vip_required");
  expect(mapHanaSongToTrack({ id: 1, name: "paid", fee: 4 }).playableState).toBe("paid_required");
  expect(mapHanaSongToTrack({ id: 1, name: "trial", fee: 8 }).playableState).toBe("trial_only");
});

test("mapHanaSongToTrack tolerates missing ar/al pruned to safe defaults", () => {
  const t = mapHanaSongToTrack({ id: "5", name: "n" });
  expect(t.artists.length).toBe(0);
  expect(t.album).toBe("");
  expect(t.coverUrl).toBe("");
  expect(t.durationMs).toBe(undefined);
});

test("mapHanaLyricToPayload sets hasTranslation when tlyric present and matches by timestamp", () => {
  const payload = mapHanaLyricToPayload({
    trackId: "1",
    lrc: "[00:01.00]l1\n[00:02.00]l2",
    tlyric: "[00:01.00]t1",
    klyric: null,
    yrc: null
  });
  expect(payload.provider).toBe("netease");
  expect(payload.trackId).toBe("1");
  expect(payload.lines.length).toBe(2);
  expect(payload.hasTranslation).toBe(true);
  expect(payload.isWordByWord).toBe(false);
  expect(payload.lines[0].timeMs).toBe(1000);
  expect(payload.lines[0].text).toBe("l1");
  expect(payload.lines[0].translation).toBe("t1");
  expect(payload.lines[1].timeMs).toBe(2000);
  expect(payload.lines[1].text).toBe("l2");
  expect(payload.lines[1].translation).toBe(undefined);
});

test("mapHanaLyricToPayload sets isWordByWord when yrc present", () => {
  const payload = mapHanaLyricToPayload({
    trackId: "1",
    lrc: "[00:01.00]l",
    yrc: "[1000,2000](1000,500,0)你(1500,500,0)好"
  });
  expect(payload.isWordByWord).toBe(true);
  expect(payload.hasTranslation).toBe(false);
  expect(payload.lines[0].timeMs).toBe(1000);
  expect(payload.lines[0].durationMs).toBe(2000);
  expect(payload.lines[0].text).toBe("你好");
  expect(payload.lines[0].source).toBe("yrc-word");
  expect(payload.lines[0].words?.[0]).toEqual({
    text: "你",
    timeMs: 1000,
    durationMs: 500,
    c0: 0,
    c1: 1
  });
});

test("parseYrcText follows baseline absolute-or-relative word timing and trims character ranges", () => {
  const lines = parseYrcText("[2000,3000](0,400,0) 你 (2450,500,0)好 ");

  expect(lines.length).toBe(1);
  expect(lines[0].timeMs).toBe(2000);
  expect(lines[0].durationMs).toBe(3000);
  expect(lines[0].text).toBe("你 好");
  expect(lines[0].charCount).toBe(3);
  expect(lines[0].source).toBe("yrc-word");
  expect(lines[0].words).toEqual([
    { text: " 你 ", timeMs: 2000, durationMs: 400, c0: 0, c1: 2 },
    { text: "好 ", timeMs: 2450, durationMs: 500, c0: 2, c1: 3 }
  ]);
});

test("mapHanaLyricToPayload preserves native karaoke words when translation matches", () => {
  const payload = mapHanaLyricToPayload({
    trackId: "1",
    tlyric: "[00:01.00]hello",
    yrc: "[1000,2000](1000,500,0)你(1500,500,0)好"
  });

  expect(payload.hasTranslation).toBe(true);
  expect(payload.isWordByWord).toBe(true);
  expect(payload.lines[0].translation).toBe("hello");
  expect(payload.lines[0].durationMs).toBe(2000);
  expect(payload.lines[0].source).toBe("yrc-word");
  expect(payload.lines[0].words?.length).toBe(2);
});

test("mapHanaLyricToPayload sets isWordByWord when klyric present", () => {
  const payload = mapHanaLyricToPayload({
    trackId: "1",
    lrc: "[00:01.00]l",
    klyric: "[00:01.00]l(x)"
  });
  expect(payload.isWordByWord).toBe(true);
});

test("mapHanaPlaylistToSummary maps id/name/cover/trackCount/trackIds", () => {
  const s = mapHanaPlaylistToSummary({
    id: 123,
    name: "pl",
    coverImgUrl: "c",
    trackCount: 5,
    subscribed: true,
    trackIds: [{ id: 1 }, { id: "2" }, 3]
  });
  expect(s.provider).toBe("netease");
  expect(s.id).toBe("123");
  expect(s.name).toBe("pl");
  expect(s.coverUrl).toBe("c");
  expect(s.trackCount).toBe(5);
  expect(s.trackIds.length).toBe(3);
  expect(s.trackIds[0]).toBe("1");
  expect(s.trackIds[1]).toBe("2");
  expect(s.trackIds[2]).toBe("3");
  expect(s.subscribed).toBe(true);
});

test("mapHanaPlaylistToDetail maps tracks via mapHanaSongToTrack", () => {
  const d = mapHanaPlaylistToDetail({
    id: 7,
    name: "p",
    coverImgUrl: "u",
    trackCount: 1,
    tracks: [{ id: 1, name: "s", ar: [{ id: 1, name: "a" }], al: { name: "al" }, dt: 1000, fee: 0 }]
  });
  expect(d.id).toBe("7");
  expect(d.tracks.length).toBe(1);
  expect(d.tracks[0].id).toBe("1");
  expect(d.tracks[0].title).toBe("s");
  expect(d.tracks[0].album).toBe("al");
});

test("mapHanaPlaylistToDetail returns empty tracks for null/missing playlist", () => {
  const d = mapHanaPlaylistToDetail(null, "9");
  expect(d.id).toBe("9");
  expect(d.tracks.length).toBe(0);
});

test("mapPlayable priority: code 200 + url -> playable; code 401 -> login_required", () => {
  expect(mapPlayable(0, 200, null, false, "http://x")).toBe("playable");
  expect(mapPlayable(0, 401, null, false, null)).toBe("login_required");
});

test("mapPlayable fee 1 -> vip_required without cookie+url", () => {
  expect(mapPlayable(1, 0, null, false, null)).toBe("vip_required");
  expect(mapPlayable(1, 200, null, false, "http://x")).toBe("playable");
  expect(mapPlayable(1, 0, null, true, "http://x")).toBe("playable");
  expect(mapPlayable(1, 0, null, true, null)).toBe("vip_required");
});

test("mapPlayable fee 4 -> paid_required", () => {
  expect(mapPlayable(4, 0, null, false, null)).toBe("paid_required");
});

test("mapPlayable fee 8 + freeTrialInfo -> trial_only", () => {
  expect(mapPlayable(8, 0, { start: 1 }, false, null)).toBe("trial_only");
  expect(mapPlayable(8, 0, null, false, "http://x")).toBe("playable");
});

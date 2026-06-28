import { expect, test } from "bun:test";
import { PlaybackQualitySchema, SongUrlRequestSchema, SongUrlResultSchema } from "./song-url";

test("SongUrlResultSchema parses a valid url result", () => {
	const parsed = SongUrlResultSchema.parse({
		url: "https://example.com/audio.mp3",
		proxied: true,
		level: "hires",
		quality: "高清臻音",
		br: 1999000,
		requestedQuality: "hires",
	});
	expect(parsed.url).toBe("https://example.com/audio.mp3");
	expect(parsed.proxied).toBe(true);
	expect(parsed.level).toBe("hires");
	expect(parsed.quality).toBe("高清臻音");
	expect(parsed.br).toBe(1999000);
	expect(parsed.requestedQuality).toBe("hires");
});

test("SongUrlResultSchema rejects missing url", () => {
	const result = SongUrlResultSchema.safeParse({ proxied: false });
	expect(result.success).toBe(false);
});

test("SongUrlResultSchema rejects missing proxied flag", () => {
	const result = SongUrlResultSchema.safeParse({ url: "https://example.com/a.mp3" });
	expect(result.success).toBe(false);
});

test("SongUrlResultSchema rejects wrong proxied type", () => {
	const result = SongUrlResultSchema.safeParse({ url: "https://example.com/a.mp3", proxied: "yes" });
	expect(result.success).toBe(false);
});

test("PlaybackQualitySchema normalizes baseline aliases and rejects unknown quality", () => {
	expect(PlaybackQualitySchema.parse("hi-res")).toBe("hires");
	expect(PlaybackQualitySchema.parse("320k")).toBe("exhigh");
	expect(PlaybackQualitySchema.parse("sq")).toBe("lossless");
	expect(PlaybackQualitySchema.safeParse("bad").success).toBe(false);
});

test("SongUrlRequestSchema carries track plus requested playback quality", () => {
	const parsed = SongUrlRequestSchema.parse({
		track: {
			provider: "netease",
			id: "1",
			sourceId: "1",
			title: "Song",
			artists: [],
			album: "",
			coverUrl: "",
			qualityHints: [],
			playableState: "playable",
		},
		quality: "lossless",
	});
	expect(parsed.quality).toBe("lossless");
	expect(parsed.track.id).toBe("1");
});

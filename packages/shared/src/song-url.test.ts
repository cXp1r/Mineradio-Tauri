import { expect, test } from "bun:test";
import { PlaybackQualitySchema, SongUrlRequestSchema, SongUrlResultSchema, TrackQualityAvailabilitySchema } from "./song-url";

test("SongUrlResultSchema parses a valid url result", () => {
	const parsed = SongUrlResultSchema.parse({
		url: "https://example.com/audio.mp3",
		proxied: true,
		level: "hires",
		quality: "高清臻音",
		br: 1999000,
		requestedQuality: "hires",
		provider: "netease",
		trial: true,
		playable: true,
		loggedIn: false,
		vipLevel: "none",
		reason: "trial_only",
		message: "当前未登录 · 仅播放试听片段",
		restriction: {
			provider: "netease",
			category: "trial_only",
			action: "upgrade",
			message: "网易云仅返回试听片段，完整播放需要会员或购买",
			code: 200,
			fee: 8,
		},
	});
	expect(parsed.url).toBe("https://example.com/audio.mp3");
	expect(parsed.proxied).toBe(true);
	expect(parsed.level).toBe("hires");
	expect(parsed.quality).toBe("高清臻音");
	expect(parsed.br).toBe(1999000);
	expect(parsed.requestedQuality).toBe("hires");
	expect(parsed.trial).toBe(true);
	expect(parsed.playable).toBe(true);
	expect(parsed.restriction?.category).toBe("trial_only");
});

test("SongUrlResultSchema rejects missing url", () => {
	const result = SongUrlResultSchema.safeParse({ proxied: false });
	expect(result.success).toBe(false);
});

test("SongUrlResultSchema accepts baseline restriction-only playback metadata", () => {
	const parsed = SongUrlResultSchema.parse({
		url: null,
		proxied: false,
		provider: "qq",
		playable: false,
		playbackKeyReady: false,
		reason: "login_required",
		message: "QQ 音乐当前只拿到了网页登录状态，还缺少播放授权",
		restriction: {
			provider: "qq",
			category: "login_required",
			action: "login",
			message: "QQ 音乐当前只拿到了网页登录状态，还缺少播放授权",
			code: 104003,
			rawMessage: "no vkey",
			missingPlaybackKey: true,
		},
		qqCode: 104003,
		rawMessage: "no vkey",
		tried: ["无损 FLAC · F000abc.flac"],
	});

	expect(parsed.url).toBe(null);
	expect(parsed.playable).toBe(false);
	expect(parsed.restriction?.missingPlaybackKey).toBe(true);
});

test("PlaybackRestrictionSchema strips unexpected provider fields at the API boundary", () => {
	const parsed = SongUrlResultSchema.parse({
		url: null,
		proxied: false,
		provider: "qq",
		playable: false,
		restriction: {
			provider: "qq",
			category: "login_required",
			action: "login",
			message: "需要登录后播放",
			cookie: "qqmusic_key=secret",
		},
	});

	expect(JSON.stringify(parsed)).not.toContain("qqmusic_key");
	expect(JSON.stringify(parsed)).not.toContain("cookie");
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

test("SongUrlRequestSchema accepts provider-native quality ids while normalizing legacy aliases", () => {
	const baseTrack = {
		provider: "qq",
		id: "1",
		sourceId: "1",
		title: "Song",
		artists: [],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
	};

	expect(SongUrlRequestSchema.parse({ track: baseTrack, quality: "320" }).quality).toBe("320");
	expect(SongUrlRequestSchema.parse({ track: baseTrack, quality: "higher" }).quality).toBe("higher");
	expect(SongUrlRequestSchema.parse({ track: baseTrack, quality: "hi-res" }).quality).toBe("hires");
});

test("TrackQualityAvailabilitySchema parses actual per-track quality options", () => {
	const parsed = TrackQualityAvailabilitySchema.parse({
		provider: "qq",
		trackId: "q1",
		defaultQuality: "flac",
		qualities: [
			{
				provider: "qq",
				id: "flac",
				label: "FLAC",
				short: "FLAC",
				requestQuality: "flac",
				type: "flac",
				size: 1024,
				source: "declared",
			},
		],
	});

	expect(parsed.qualities[0].requestQuality).toBe("flac");
	expect(parsed.qualities[0].source).toBe("declared");
});

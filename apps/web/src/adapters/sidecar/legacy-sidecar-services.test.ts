import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import { SidecarClientError, type SidecarClient } from "../../api/sidecar-client";
import { createLegacySidecarServices } from "./legacy-sidecar-services";

const track: Track = {
	provider: "netease",
	id: "track-1",
	sourceId: "track-1",
	title: "测试歌曲",
	artists: ["测试歌手"],
	album: "测试专辑",
	coverUrl: "https://example.com/cover.jpg",
	qualityHints: [],
	playableState: "playable",
	durationMs: 180_000,
};

test("legacy sidecar services preserve current request arguments", async () => {
	const calls: unknown[][] = [];
	const fakeClient = {
		async search(...args: unknown[]) {
			calls.push(["search", ...args]);
			return [track];
		},
		async searchAll(...args: unknown[]) {
			calls.push(["searchAll", ...args]);
			return [track];
		},
		async resolveSongUrl(...args: unknown[]) {
			calls.push(["resolveSongUrl", ...args]);
			return { url: "https://example.com/audio.mp3", proxied: false };
		},
		async playlistDetail(...args: unknown[]) {
			calls.push(["playlistDetail", ...args]);
			return {
				provider: "netease",
				id: "playlist-1",
				name: "测试歌单",
				coverUrl: "",
				trackIds: [track.id],
				subscribed: false,
				tracks: [track],
			};
		},
	} as unknown as SidecarClient;
	const services = createLegacySidecarServices(fakeClient);

	await services.search.search("netease", "测试", 12);
	await services.search.searchAll("测试", 18, "qq");
	await services.playback.resolveSongUrl(track, "lossless");
	await services.library.playlistDetail("netease", "playlist-1");

	expect(calls).toEqual([
		["search", "netease", "测试", 12],
		["searchAll", "测试", 18, "qq"],
		["resolveSongUrl", track, "lossless"],
		["playlistDetail", "netease", "playlist-1"],
	]);
});

test("legacy sidecar services preserve the complete SidecarClientError instance", async () => {
	const error = new SidecarClientError({
		code: "PLAYBACK_RESTRICTED",
		message: "当前歌曲不可播放",
		provider: "qq",
		retryable: true,
		action: "refresh-key",
		playbackKeyReady: false,
		restriction: { category: "login_required" },
		reason: "key-expired",
		qqCode: 104003,
		rawMessage: "provider raw message",
		tried: ["qq", "netease"],
	});
	const fakeClient = {
		async lyric() {
			throw error;
		},
	} as unknown as SidecarClient;
	const services = createLegacySidecarServices(fakeClient);

	try {
		await services.lyrics.lyric(track);
		throw new Error("预期 legacy adapter 抛出错误");
	} catch (caught) {
		expect(caught).toBe(error);
		const preserved = caught as SidecarClientError;
		expect({
			restriction: preserved.restriction,
			reason: preserved.reason,
			qqCode: preserved.qqCode,
			rawMessage: preserved.rawMessage,
			tried: preserved.tried,
		}).toEqual({
			restriction: { category: "login_required" },
			reason: "key-expired",
			qqCode: 104003,
			rawMessage: "provider raw message",
			tried: ["qq", "netease"],
		});
	}
});

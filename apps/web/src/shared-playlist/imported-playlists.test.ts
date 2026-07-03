import { expect, test } from "bun:test";
import {
	importedPlaylistFromResult,
	isSharedPlaylistCandidateText,
	readImportedPlaylistsFromStorage,
	saveImportedPlaylistsToStorage,
	upsertImportedPlaylist,
} from "./imported-playlists";

function storage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() { return map.size; },
		clear: () => map.clear(),
		getItem: (key) => map.get(key) ?? null,
		key: (index) => [...map.keys()][index] ?? null,
		removeItem: (key) => { map.delete(key); },
		setItem: (key, value) => { map.set(key, value); },
	};
}

test("isSharedPlaylistCandidateText recognizes supported share links", () => {
	expect(isSharedPlaylistCandidateText("https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=1")).toBe(true);
	expect(isSharedPlaylistCandidateText("分享 https://music.163.com/#/playlist?id=2")).toBe(true);
	expect(isSharedPlaylistCandidateText("https://music.apple.com/cn/playlist/demo/pl.3950454ced8c45a3b0cc693c2a7db97b")).toBe(true);
	expect(isSharedPlaylistCandidateText("https://qishui.douyin.com/s/iCdLprn7/")).toBe(true);
	expect(isSharedPlaylistCandidateText("https://m.kugou.com/songlist/gcid_3z106tadezl7z03a/")).toBe(true);
	expect(isSharedPlaylistCandidateText("周杰伦")).toBe(false);
});

test("imported playlist storage upserts by provider and playlist id", () => {
	const first = importedPlaylistFromResult({
		provider: "qq",
		playlist: { provider: "qq", id: "p1", name: "Old", coverUrl: "", trackCount: 1, trackIds: [], subscribed: false, sourceUrl: "" },
		tracks: [],
		trackCount: 1,
		loadedCount: 0,
		partial: false,
		partialReason: "",
	}, 1);
	const second = importedPlaylistFromResult({
		...first,
		playlist: { ...first.playlist, name: "New" },
		loadedCount: 1,
	}, 2, first);
	const list = upsertImportedPlaylist(upsertImportedPlaylist([], first), second);

	expect(list.length).toBe(1);
	expect(list[0]?.playlist.name).toBe("New");
	expect(list[0]?.importedAt).toBe(1);
	expect(list[0]?.updatedAt).toBe(2);
});

test("imported playlist storage roundtrips records", () => {
	const mem = storage();
	const record = importedPlaylistFromResult({
		provider: "netease",
		playlist: { provider: "netease", id: "p1", name: "歌单", coverUrl: "", trackCount: 0, trackIds: [], subscribed: false, sourceUrl: "" },
		tracks: [],
		trackCount: 0,
		loadedCount: 0,
		partial: false,
		partialReason: "",
	}, 1);

	saveImportedPlaylistsToStorage([record], mem);
	expect(readImportedPlaylistsFromStorage(mem)[0]?.playlist.name).toBe("歌单");
});

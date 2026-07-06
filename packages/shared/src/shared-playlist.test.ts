import { expect, test } from "bun:test";
import { SharedPlaylistImportResultSchema } from "./shared-playlist";

test("SharedPlaylistImportResultSchema accepts imported qq playlist details", () => {
  const parsed = SharedPlaylistImportResultSchema.parse({
    provider: "qq",
    playlist: {
      provider: "qq",
      id: "7167576049",
      name: "R&B",
      coverUrl: "https://y.qq.com/cover.jpg",
      trackCount: 1,
      trackIds: ["song-1"],
      sourceUrl: "https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=7167576049"
    },
    tracks: [{
      provider: "qq",
      id: "song-1",
      sourceId: "song-1",
      title: "Song",
      artists: ["Artist"],
      album: "",
      coverUrl: "",
      qualityHints: [],
      playableState: "unknown"
    }],
    trackCount: 1,
    loadedCount: 1
  });

  expect(parsed.provider).toBe("qq");
  expect(parsed.playlist.sourceUrl).toContain("7167576049");
});

test("SharedPlaylistImportResultSchema accepts import-only playlist sources", () => {
  const parsed = SharedPlaylistImportResultSchema.parse({
    provider: "apple-music",
    playlist: {
      provider: "apple-music",
      id: "pl.1",
      name: "Apple List",
      coverUrl: "https://example.com/cover.jpg",
      trackCount: 1,
      trackIds: ["import:apple-music:1"],
      sourceUrl: "https://music.apple.com/cn/playlist/demo/pl.1"
    },
    tracks: [{
      provider: "netease",
      id: "import:apple-music:1",
      sourceId: "import:apple-music:1",
      title: "Song",
      artists: ["Artist"],
      album: "",
      coverUrl: "",
      qualityHints: [],
      playableState: "unknown"
    }],
    trackCount: 1,
    loadedCount: 1
  });

  expect(parsed.provider).toBe("apple-music");
  expect(parsed.tracks[0]?.provider).toBe("netease");
});

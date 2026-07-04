import { expect, test } from "bun:test";
import type { ProviderId, Track } from "@mineradio/shared";
import type { ProviderAdapter } from "../providers/provider-adapter";
import {
  detectSharedPlaylist,
  importSharedPlaylist
} from "./shared-playlist-import";

const track: Track = {
  provider: "qq",
  id: "song-1",
  sourceId: "song-1",
  title: "Song",
  artists: ["Artist"],
  album: "",
  coverUrl: "",
  qualityHints: [],
  playableState: "unknown"
};

function adapter(provider: ProviderId): ProviderAdapter {
  return {
    id: provider,
    async search() { return []; },
    async songUrl() { return { provider, url: "https://audio.example/song.mp3", proxied: false }; },
    async lyric() { return { provider, trackId: "song-1", lines: [], hasTranslation: false, isWordByWord: false }; },
    async playlistList() { return []; },
    async playlistDetail(id) {
      return {
        provider,
        id,
        name: "Imported",
        coverUrl: "https://img.example/cover.jpg",
        trackCount: 1,
        trackIds: ["song-1"],
        subscribed: false,
        tracks: [{ ...track, provider }]
      };
    },
    async loginStatus() { return { provider, loggedIn: false }; },
    async logout() {}
  };
}

test("detectSharedPlaylist supports i2.y.qq.com playlist share URLs", () => {
  const candidate = detectSharedPlaylist({
    text: "https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=7167576049&hosteuin="
  });

  expect(candidate).toEqual({
    provider: "qq",
    id: "7167576049",
    sourceUrl: "https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=7167576049&hosteuin="
  });
});

test("detectSharedPlaylist supports y.qq.com ryqq playlist URLs", () => {
  const candidate = detectSharedPlaylist({
    url: "https://y.qq.com/n/ryqq/playlist/7697196542"
  });

  expect(candidate?.provider).toBe("qq");
  expect(candidate?.id).toBe("7697196542");
});

test("detectSharedPlaylist supports netease playlist links inside share text", () => {
  const candidate = detectSharedPlaylist({
    text: "分享歌单 https://music.163.com/#/playlist?id=12345"
  });

  expect(candidate?.provider).toBe("netease");
  expect(candidate?.id).toBe("12345");
});

test("detectSharedPlaylist supports Apple Music playlist URLs", () => {
  const candidate = detectSharedPlaylist({
    text: "https://music.apple.com/cn/playlist/taylor-swift-代表作/pl.3950454ced8c45a3b0cc693c2a7db97b"
  });

  expect(candidate).toEqual({
    provider: "apple-music",
    id: "pl.3950454ced8c45a3b0cc693c2a7db97b",
    sourceUrl: "https://music.apple.com/cn/playlist/taylor-swift-代表作/pl.3950454ced8c45a3b0cc693c2a7db97b"
  });
});

test("detectSharedPlaylist supports Qishui short links", () => {
  const candidate = detectSharedPlaylist({
    text: "汽水音乐 https://qishui.douyin.com/s/iCdLprn7/"
  });

  expect(candidate?.provider).toBe("qishui");
  expect(candidate?.id).toBe("iCdLprn7");
});

test("detectSharedPlaylist supports Kugou gcid links", () => {
  const candidate = detectSharedPlaylist({
    text: "https://m.kugou.com/songlist/gcid_3z106tadezl7z03a/?src_cid=3z106tadezl7z03a"
  });

  expect(candidate?.provider).toBe("kugou");
  expect(candidate?.id).toBe("3z106tadezl7z03a");
});

test("importSharedPlaylist fetches the detected Apple Music link when share text has multiple URLs", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const trap = "https://example.invalid/not-a-playlist";
  const apple = "https://music.apple.com/cn/playlist/demo/pl.abc123";
  const playlistHtml = `<script id="schema:music-playlist" type="application/ld+json">${JSON.stringify({
    name: "Apple Demo",
    numTracks: 1,
    image: "https://img.example/cover.jpg",
    track: [{
      name: "Song",
      byArtist: { name: "Artist" },
      url: "https://music.apple.com/cn/song/song/123456789",
      duration: "PT3M"
    }]
  })}</script>`;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith("https://music.apple.com/")) {
      return new Response(playlistHtml, { status: 200 });
    }
    if (url.startsWith("https://itunes.apple.com/")) {
      return Response.json({
        results: [{
          wrapperType: "track",
          trackId: 123456789,
          trackName: "Song",
          artistName: "Artist",
          collectionName: "Album",
          trackTimeMillis: 180000
        }]
      });
    }
    return new Response("wrong url", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await importSharedPlaylist(
      { text: `${trap} ${apple}` },
      { providerAdapters: {} as Record<ProviderId, ProviderAdapter> }
    );

    expect(result.provider).toBe("apple-music");
    expect(result.loadedCount).toBe(1);
    expect(requested.some((url) => url.startsWith(trap))).toBe(false);
    expect(requested[0]).toBe(apple);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("importSharedPlaylist maps adapter playlist detail into import result", async () => {
  const result = await importSharedPlaylist(
    { url: "https://y.qq.com/n/ryqq/playlist/7697196542" },
    { providerAdapters: { netease: adapter("netease"), qq: adapter("qq") } }
  );

  expect(result.provider).toBe("qq");
  expect(result.playlist.id).toBe("7697196542");
  expect(result.loadedCount).toBe(1);
  expect(result.tracks[0]?.provider).toBe("qq");
});

test("importSharedPlaylist marks adapter playlist imports partial when fewer tracks are loaded than declared", async () => {
  const qq = adapter("qq");
  const result = await importSharedPlaylist(
    { url: "https://y.qq.com/n/ryqq/playlist/7697196542" },
    {
      providerAdapters: {
        netease: adapter("netease"),
        qq: {
          ...qq,
          async playlistDetail(id) {
            return {
              provider: "qq",
              id,
              name: "Large QQ Share",
              coverUrl: "",
              trackCount: 3,
              trackIds: ["song-1"],
              subscribed: false,
              tracks: [{ ...track, provider: "qq" }]
            };
          }
        }
      }
    }
  );

  expect(result.trackCount).toBe(3);
  expect(result.loadedCount).toBe(1);
  expect(result.partial).toBe(true);
  expect(result.partialReason.length > 0).toBe(true);
});

import { expect, test } from "bun:test";
import { clearRuntimeProviderCookie, getProviderCookie, setRuntimeProviderCookie } from "../../services/auth-session";
import { ProviderError } from "../provider-adapter";
import { ProviderNotImplementedError } from "../provider-adapter";
import { createSodaAdapter } from "./soda-adapter";
import { createSodaClient } from "./soda-client";
import { mapSodaSongToTrack, mapSodaPlaylistToSummary, parseSodaLyricText, mapSodaLyricToPayload } from "./map";

function sodaPlayInfo(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    Quality: "",
    PlayAuth: "",
    MainPlayUrl: "",
    BackupPlayUrl: "",
    FileID: "",
    ...overrides
  };
}

function sodaPlayInfoBody(playInfoList: Record<string, unknown>[]): Record<string, unknown> {
  return {
    Result: {
      Data: {
        PlayInfoList: playInfoList
      }
    }
  };
}

test("soda mapping helpers produce provider-shaped objects", () => {
  const track = mapSodaSongToTrack({
    id: "123",
    name: "Demo Song",
    artists: [{ id: "artist-1", name: "Alice" }, { id: "artist-2", name: "Bob" }],
    album: {
      id: "album-1",
      name: "Demo Album",
      url_cover: {
        uri: "demo-cover",
        urls: ["https://cdn.example.com/"],
        template_prefix: "tplv-b829550vbb"
      }
    },
    duration: 215000
  });
  expect(track.provider).toBe("soda");
  expect(track.id).toBe("123");
  expect(track.artists).toEqual(["Alice", "Bob"]);
  expect(track.album).toBe("Demo Album");
  expect(track.coverUrl).toBe("https://cdn.example.com/demo-cover~tplv-b829550vbb-crop-center:256:256.webp");
  expect(track.qualityHints).toEqual(["standard"]);

  const playlist = mapSodaPlaylistToSummary({
    id: "pl-1",
    title: "Favorites",
    public_title: "Favorites",
    url_cover: {
      uri: "playlist-cover",
      urls: ["https://cdn.example.com/"],
      template_prefix: "tplv-b829550vbb"
    },
    count_tracks: 12,
    is_private: false
  });
  expect(playlist.provider).toBe("soda");
  expect(playlist.coverUrl).toBe("https://cdn.example.com/playlist-cover~tplv-b829550vbb-crop-center:256:256.webp");
  expect(playlist.trackCount).toBe(12);
  expect(playlist.trackIds).toEqual([]);
  expect(playlist.subscribed).toBe(true);
});

test("soda client search requests qishui track search with keyword", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ data: { list: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.search({ keyword: "hectopascal", limit: 10 });
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/luna/pc/search/track");
  expect(url.searchParams.get("q")).toBe("hectopascal");
  expect(url.searchParams.get("aid")).toBe("386088");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda client lyric requests qishui track detail with track id", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({
        data: {
          lyric: {
            content: "[00:01.00]hello",
            lang_translations: {
              zh: { content: "[00:01.00]你好", lang: "zh" }
            }
          }
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.lyric("track-1");
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/luna/pc/track_v2");
  expect(url.searchParams.get("track_id")).toBe("track-1");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda client songUrl delegates to qishui track detail with track id", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({
        track_player: {
          url_player_info: "https://api.qishui.com/mock/url-player-info"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.songUrl("track-1");
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/luna/pc/track_v2");
  expect(url.searchParams.get("track_id")).toBe("track-1");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda adapter songUrl resolves track_v2 url_player_info and returns main play url", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const url = String(input);
    if (url.includes("/luna/pc/track_v2")) {
      return new Response(JSON.stringify({
        track_player: {
          url_player_info: "https://api.qishui.com/mock/url-player-info"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify(sodaPlayInfoBody([
      sodaPlayInfo({
        Quality: "m4a",
        Duration: 180000,
        PlayAuth: "play-auth-1",
        MainPlayUrl: "https://cdn.example.com/main.m4a",
        BackupPlayUrl: "https://cdn.example.com/backup.m4a",
        UrlExpire: 3600,
        FileID: "file-1"
      })
    ])), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: fetcher
  });
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: fetcher,
    client
  });

  const result = await adapter.songUrl({
    provider: "soda",
    id: "soda-1",
    sourceId: "soda-1",
    title: "Hectopascal",
    artists: ["Yui"],
    album: "Bloom",
    coverUrl: "",
    durationMs: 180000,
    qualityHints: ["standard"],
    playableState: "unknown"
  });

  expect(result).toMatchObject({
    url: "/providers/soda/audio-proxy?url=https%3A%2F%2Fcdn.example.com%2Fmain.m4a&playAuth=play-auth-1",
    proxied: true,
    provider: "soda",
    trial: false,
    playable: true,
    quality: "m4a",
    filename: "file-1"
  });
  expect(calls.length).toBe(2);
  expect(calls[0]?.input).toContain("/luna/pc/track_v2");
  expect(calls[1]?.input).toBe("https://api.qishui.com/mock/url-player-info");
  expect(calls[1]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda adapter songUrl falls back to the first PlayInfoList entry when requested tier is absent", async () => {
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/luna/pc/track_v2")) {
      return new Response(JSON.stringify({
        track_player: {
          url_player_info: "https://api.qishui.com/mock/url-player-info"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    expect(init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
    return new Response(JSON.stringify(sodaPlayInfoBody([
      sodaPlayInfo({
        Quality: "standard",
        Bitrate: 128000,
        Size: 1000,
        PlayAuth: "play-auth-low",
        MainPlayUrl: "https://cdn.example.com/low.m4a",
        FileID: "low-file"
      }),
      sodaPlayInfo({
        Quality: "exhigh",
        Bitrate: 320000,
        Size: 4000,
        PlayAuth: "play-auth-high",
        BackupPlayUrl: "https://cdn.example.com/high.m4a",
        FileID: "high-file"
      })
    ])), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: fetcher
  });
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: fetcher,
    client
  });

  const result = await adapter.songUrl({
    provider: "soda",
    id: "soda-1",
    sourceId: "soda-1",
    title: "Hectopascal",
    artists: ["Yui"],
    album: "Bloom",
    coverUrl: "",
    durationMs: 180000,
    qualityHints: ["standard"],
    playableState: "unknown"
  }, { quality: "jymaster" });

  expect(result.url).toBe("/providers/soda/audio-proxy?url=https%3A%2F%2Fcdn.example.com%2Flow.m4a&playAuth=play-auth-low");
  expect(result.quality).toBe("标准音质");
  expect(result.level).toBe("standard");
  expect(result.filename).toBe("low-file");
});

test("soda adapter songUrl maps requested PlaybackQuality onto soda quality tiers from top to bottom", async () => {
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/luna/pc/track_v2")) {
      return new Response(JSON.stringify({
        track_player: {
          url_player_info: "https://api.qishui.com/mock/url-player-info"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    expect(init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
    return new Response(JSON.stringify(sodaPlayInfoBody([
      sodaPlayInfo({
        Quality: "medium",
        Bitrate: 128000,
        Size: 1000,
        PlayAuth: "play-auth-medium",
        MainPlayUrl: "https://cdn.example.com/medium.m4a",
        FileID: "medium-file"
      }),
      sodaPlayInfo({
        Quality: "higher",
        Bitrate: 320000,
        Size: 4000,
        PlayAuth: "play-auth-higher",
        MainPlayUrl: "https://cdn.example.com/higher.m4a",
        FileID: "higher-file"
      })
    ])), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: fetcher
  });
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: fetcher,
    client
  });

  const result = await adapter.songUrl({
    provider: "soda",
    id: "soda-1",
    sourceId: "soda-1",
    title: "Hectopascal",
    artists: ["Yui"],
    album: "Bloom",
    coverUrl: "",
    durationMs: 180000,
    qualityHints: ["standard"],
    playableState: "unknown"
  }, { quality: "standard" });

  expect(result.url).toBe("/providers/soda/audio-proxy?url=https%3A%2F%2Fcdn.example.com%2Fmedium.m4a&playAuth=play-auth-medium");
  expect(result.level).toBe("standard");
  expect(result.quality).toBe("标准音质");
  expect(result.filename).toBe("medium-file");
});

test("soda adapter songUrl without cookie throws LOGIN_REQUIRED before calling client", async () => {
  let trackDetailCalls = 0;
  let infoCalls = 0;
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => {
        trackDetailCalls += 1;
        return { body: {} };
      },
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    },
    fetch: async () => {
      infoCalls += 1;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  try {
    await adapter.songUrl({
      provider: "soda",
      id: "soda-1",
      sourceId: "soda-1",
      title: "Hectopascal",
      artists: ["Yui"],
      album: "Bloom",
    coverUrl: "",
    durationMs: 180000,
    qualityHints: ["standard"],
    playableState: "unknown"
  }, { quality: "jymaster" });
    throw new Error("expected songUrl to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("LOGIN_REQUIRED");
  }
  expect(trackDetailCalls).toBe(0);
  expect(infoCalls).toBe(0);
});

test("soda client logout requests qishui logout with cookie", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ message: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.logout();
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/passport/web/logout/");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda client playlistList requests qishui playlist list with cookie", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.playlistList();
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/luna/pc/me/playlist");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda client playlistDetail requests qishui playlist detail with playlist id", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ playlist: { id: "7590144593510006847", title: "Empty" }, media_resources: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.playlistDetail("7590144593510006847");
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/luna/pc/playlist/detail");
  expect(url.searchParams.get("playlist_id")).toBe("7590144593510006847");
  expect(url.searchParams.get("cursor")).toBe("1");
  expect(url.searchParams.get("count")).toBe("20");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda client playlistDetail follows next_cursor while has_more is true", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor") ?? "1";
      const body = cursor === "1"
        ? {
            playlist: { id: "pl-1", title: "Paged", count_tracks: 3 },
            has_more: true,
            next_cursor: "3",
            media_resources: [
              { id: "r-1", entity: { track_wrapper: { track: { id: "t-1", name: "One" } } } },
              { id: "r-2", entity: { track_wrapper: { track: { id: "t-2", name: "Two" } } } }
            ]
          }
        : {
            playlist: { id: "pl-1", title: "Paged", count_tracks: 3 },
            media_resources: [
              { id: "r-3", entity: { track_wrapper: { track: { id: "t-3", name: "Three" } } } }
            ]
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const detail = await client.playlistDetail("pl-1");

  expect(calls.map(({ input }) => new URL(input).searchParams.get("cursor") ?? "1")).toEqual(["1", "3"]);
  expect(calls.map(({ input }) => new URL(input).searchParams.get("count") ?? "")).toEqual(["20", "20"]);
  expect((detail.body as { media_resources?: unknown[] }).media_resources?.length).toBe(3);
});

test("soda client loginStatus requests qishui me endpoint with cookie", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ status_code: 0, my_info: {}, my_stats: {} }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.loginStatus();
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/luna/pc/me");
  expect(url.searchParams.get("aid")).toBe("386088");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda client collectionMedia posts collection body to favorite and delete endpoints", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ message: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.collectionMedia("6941309256906622978", true);
  await client.collectionMedia("6941309256906622978", false);

  const favoriteUrl = new URL(calls[0]?.input ?? "");
  const deleteUrl = new URL(calls[1]?.input ?? "");
  expect(favoriteUrl.origin + favoriteUrl.pathname).toBe("https://api.qishui.com/luna/pc/me/collection/media");
  expect(deleteUrl.origin + deleteUrl.pathname).toBe("https://api.qishui.com/luna/pc/me/collection/media/delete");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(calls[0]?.init?.headers).toMatchObject({
    cookie: "soda_session=abc123",
    "content-type": "application/json"
  });
  expect(calls[0]?.init?.body).toBe(JSON.stringify({
    media: [{ type: "track", id: "6941309256906622978" }],
    scene: ""
  }));
});

test("soda adapter maps search results from client", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({
        body: {
          result_groups: [
            {
              data: [
                {
                  meta: { item_type: "track" },
                  entity: {
                    track: {
                      id: "soda-1",
                      name: "Hectopascal",
                      artists: [{ id: "artist-1", name: "Yui" }],
                      album: {
                        id: "album-1",
                        name: "Bloom",
                        url_cover: {
                          uri: "tos-cn-v-2774c002/oQBkC1s9PiDAIteAEliB5WfWEAH4gqawBQ3wLZ",
                          urls: [
                            "https://p3-luna.douyinpic.com/img/",
                            "https://p6-luna.douyinpic.com/img/"
                          ],
                          template_prefix: "tplv-b829550vbb"
                        }
                      },
                      duration: 180000,
                      preview: { start: 30000, duration: 60000 },
                      bit_rates: [
                        { br: 885991, size: 19934895, quality: "highest" },
                        { br: 320000, size: 7200000, quality: "higher" },
                        { br: 128000, size: 2880000, quality: "medium" }
                      ]
                    }
                  }
                },
                {
                  meta: { item_type: "artist" },
                  entity: {
                    track: {
                      id: "not-a-track",
                      name: "Should Not Map"
                    }
                  }
                }
              ]
            }
          ]
        }
      }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    }
  });

  const tracks = await adapter.search({ keyword: "hectopascal", limit: 10 });
  expect(tracks.length).toBe(1);
  expect(tracks[0]).toMatchObject({
    provider: "soda",
    id: "soda-1",
    sourceId: "soda-1",
    title: "Hectopascal",
    artists: ["Yui"],
    album: "Bloom",
    coverUrl: "https://p3-luna.douyinpic.com/img/tos-cn-v-2774c002/oQBkC1s9PiDAIteAEliB5WfWEAH4gqawBQ3wLZ~tplv-b829550vbb-crop-center:256:256.webp",
    durationMs: 180000,
    qualityHints: ["highest", "higher", "medium"],
    playableState: "trial_only"
  });
});

test("soda adapter maps playlistList from client response", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({
        body: {
          playlists: [
            {
              id: "pl-1",
              title: "Favorites",
              public_title: "Favorites",
              url_cover: {
                uri: "pl-cover",
                urls: ["https://cdn.example.com/"],
                template_prefix: "tplv-b829550vbb"
              },
              count_tracks: 2,
              is_private: false
            }
          ]
        }
      }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    }
  });

  const playlists = await adapter.playlistList();
  expect(playlists).toEqual([
    {
      provider: "soda",
      id: "pl-1",
      name: "Favorites",
      coverUrl: "https://cdn.example.com/pl-cover~tplv-b829550vbb-crop-center:256:256.webp",
      trackCount: 2,
      trackIds: [],
      subscribed: true
    }
  ]);
});

test("soda adapter playlistList without cookie returns empty list without calling client", async () => {
  let calls = 0;
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => {
        calls += 1;
        return { body: { playlists: [] } };
      },
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    }
  });

  const playlists = await adapter.playlistList();
  expect(playlists).toEqual([]);
  expect(calls).toBe(0);
});

test("soda adapter maps playlistDetail from client response", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({
        body: {
          playlist: {
            id: "7590144593510006847",
            title: "My Playlist",
            url_cover: {
              uri: "detail-cover",
              urls: ["https://cdn.example.com/"],
              template_prefix: "tplv-b829550vbb"
            },
            count_tracks: 3
          },
          media_resources: [
            {
              id: "r-1",
              type: "track",
              entity: {
                track_wrapper: {
                  track: {
                    id: "t-1",
                    name: "Track 1",
                    artists: [{ id: "artist-1", name: "Alice" }],
                    album: {
                      id: "album-1",
                      name: "Album",
                      url_cover: {
                        uri: "track-cover",
                        urls: ["https://cdn.example.com/"],
                        template_prefix: "tplv-b829550vbb"
                      }
                    },
                    duration: 120000
                  }
                }
              }
            }
          ]
        }
      }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    }
  });

  const detail = await adapter.playlistDetail("7590144593510006847");
  expect(detail).toEqual({
    provider: "soda",
    id: "7590144593510006847",
    name: "My Playlist",
    coverUrl: "https://cdn.example.com/detail-cover~tplv-b829550vbb-crop-center:256:256.webp",
    trackCount: 3,
    trackIds: [],
    subscribed: false,
    tracks: [
      {
        provider: "soda",
        id: "t-1",
        sourceId: "t-1",
        title: "Track 1",
        artists: ["Alice"],
        album: "Album",
        coverUrl: "https://cdn.example.com/track-cover~tplv-b829550vbb-crop-center:256:256.webp",
        durationMs: 120000,
        qualityHints: ["standard"],
        playableState: "unknown"
      }
    ]
  });
});

test("soda adapter maps loginStatus from client response", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({
        body: {
          status_code: 0,
          my_info: {
            id: "user-1",
            nickname: "Soda User",
            medium_avatar_url: { urls: ["//cdn.example.com/avatar-md.jpg"], uri: "" },
            is_vip: true,
            vip_stage: "svip"
          },
          my_stats: {
            count_all_liked: 99
          }
        }
      }),
      logout: async () => ({ body: {} })
    }
  });

  const status = await adapter.loginStatus();
  expect(status).toEqual({
    provider: "soda",
    loggedIn: true,
    nickname: "Soda User",
    avatarUrl: "https://cdn.example.com/avatar-md.jpg",
    userId: "user-1",
    vipType: 11,
    vipLevel: "svip",
    isVip: true,
    isSvip: true,
    vipLabel: "svip",
    vipLevelName: "svip"
  });
});

test("soda adapter loginStatus can use runtime session cookie config", async () => {
  clearRuntimeProviderCookie("soda");
  setRuntimeProviderCookie("soda", "soda_session=abc123");
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: getProviderCookie("soda") };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({
        status_code: 0,
        my_info: {
          id: "user-runtime",
          nickname: "Runtime Soda",
          medium_avatar_url: { urls: ["//cdn.example.com/runtime-avatar.jpg"], uri: "" },
          is_vip: false,
          vip_stage: "free"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  try {
    const status = await adapter.loginStatus();

    expect(status.loggedIn).toBe(true);
    expect(status.userId).toBe("user-runtime");
    expect(calls.length).toBe(1);
    expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
  } finally {
    clearRuntimeProviderCookie("soda");
  }
});

test("soda adapter loginStatus without cookie returns loggedIn:false without calling client", async () => {
  let called = false;
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => {
        called = true;
        return { body: { status_code: 0, my_info: {}, my_stats: {} } };
      },
      logout: async () => ({ body: {} })
    }
  });

  const status = await adapter.loginStatus();
  expect(status).toEqual({
    provider: "soda",
    loggedIn: false
  });
  expect(called).toBe(false);
});

test("soda adapter checkSongLikes uses track_v2 state.is_collected", async () => {
  const calls: string[] = [];
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async (trackId) => {
        calls.push(trackId);
        return {
          body: {
            track: {
              state: {
                is_collected: trackId === "t-1"
              }
            }
          }
        };
      },
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    }
  });

  const ack = await adapter.checkSongLikes!(["t-1", "t-2"]);
  expect(ack).toEqual({
    provider: "soda",
    ids: ["t-1", "t-2"],
    liked: {
      "t-1": true,
      "t-2": false
    }
  });
  expect(calls).toEqual(["t-1", "t-2"]);
});

test("soda adapter checkSongLikes without cookie throws LOGIN_REQUIRED before calling client", async () => {
  let calls = 0;
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => {
        calls += 1;
        return { body: {} };
      },
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    }
  });

  try {
    await adapter.checkSongLikes!(["t-1", "t-2"]);
    throw new Error("expected checkSongLikes to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("LOGIN_REQUIRED");
  }
  expect(calls).toBe(0);
});

test("soda adapter maps lyric payload from client detail response", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({
        body: {
          data: {
            lyric: {
              content: "[00:01.00]hello\n[00:02.00]world",
              lang_translations: {
                zh: {
                  content: "[00:01.00]你好\n[00:02.00]世界",
                  lang: "zh"
                }
              }
            }
          }
        }
      }),
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    }
  });

  const payload = await adapter.lyric({
    provider: "soda",
    id: "soda-1",
    sourceId: "soda-1",
    title: "Hectopascal",
    artists: ["Yui"],
    album: "Bloom",
    coverUrl: "",
    durationMs: 180000,
    qualityHints: ["standard"],
    playableState: "unknown"
  });

  expect(payload).toEqual({
    provider: "soda",
    trackId: "soda-1",
    lines: [
      {
        timeMs: 1000,
        text: "hello",
        translation: "你好"
      },
      {
        timeMs: 2000,
        text: "world",
        translation: "世界"
      }
    ],
    hasTranslation: true,
    isWordByWord: false
  });
});

test("parseSodaLyricText parses baseline soda word-by-word lyrics", () => {
  const lines = parseSodaLyricText("[2000,3000]<0,400> Hello<400,600>world");

  expect(lines.length).toBe(1);
  expect(lines[0].timeMs).toBe(2000);
  expect(lines[0].durationMs).toBe(3000);
  expect(lines[0].text).toBe(" Helloworld");
  expect(lines[0].source).toBe("soda-word");
  expect(lines[0].words).toEqual([
    {
      text: " Hello",
      timeMs: 2000,
      durationMs: 400,
      c0: 0,
      c1: 6
    },
    {
      text: "world",
      timeMs: 2400,
      durationMs: 600,
      c0: 6,
      c1: 11
    }
  ]);
});

test("mapSodaLyricToPayload marks soda word lyrics as word-by-word", () => {
  const payload = mapSodaLyricToPayload({
    trackId: "soda-1",
    lyric: "[2000,3000]<2000,400> Hello<2400,600>world",
    trans: "[00:02.00]你好"
  });

  expect(payload.isWordByWord).toBe(true);
  expect(payload.hasTranslation).toBe(true);
  expect(payload.lines[0].translation).toBe("你好");
});

test("soda adapter logout requires a cookie and delegates to client logout", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => ({ body: {}, status: 200 }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => {
        calls.push({ input: "logout" });
        return { body: { message: "success" } };
      }
    }
  });

  await adapter.logout();
  expect(calls.length).toBe(1);
});

test("soda adapter likeSong calls collection endpoint with liked flag", async () => {
  const calls: Array<{ id: string; liked: boolean }> = [];
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async (trackId, liked) => {
        calls.push({ id: trackId, liked });
        return {
          body: {
            message: "success",
            collected_media: liked ? { id: trackId } : undefined
          },
          status: 200
        };
      },
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: { message: "success" } })
    }
  });

  const ack = await adapter.likeSong!("6941309256906622978", true);
  expect(ack).toEqual({
    provider: "soda",
    id: "6941309256906622978",
    liked: true,
    code: 200
  });
  expect(calls).toEqual([{ id: "6941309256906622978", liked: true }]);
});

test("soda adapter likeSong without cookie throws LOGIN_REQUIRED before calling client", async () => {
  let calls = 0;
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => {
        calls += 1;
        return { body: {}, status: 200 };
      },
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: { message: "success" } })
    }
  });

  try {
    await adapter.likeSong!("6941309256906622978", true);
    throw new Error("expected likeSong to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("LOGIN_REQUIRED");
  }
  expect(calls).toBe(0);
});

test("soda adapter unlikeSong calls delete collection endpoint", async () => {
  const calls: Array<{ id: string; liked: boolean }> = [];
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async (trackId, liked) => {
        calls.push({ id: trackId, liked });
        return {
          body: {
            message: "success",
            deleted_media: liked ? undefined : { id: trackId }
          },
          status: 200
        };
      },
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: { message: "success" } })
    }
  });

  const ack = await adapter.likeSong!("6941309256906622978", false);
  expect(ack).toEqual({
    provider: "soda",
    id: "6941309256906622978",
    liked: false,
    code: 200
  });
  expect(calls).toEqual([{ id: "6941309256906622978", liked: false }]);
});

test("soda adapter likeSong rejects JSON-level collection errors even on 200", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    client: {
      search: async () => ({ body: { result_groups: [] } }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      trackDetail: async () => ({ body: {} }),
      collectionMedia: async () => ({
        body: {
          "status_code": 1000016,
          "status_info": {
            "log_id": "202607051551321EB5DBFEB19719D64BB0",
            "now": 1783237892,
            "status_msg": "登录状态已失效，请重新登录",
            "now_ts_ms": 1783237892261
          }
        },
        status: 200
      }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: { message: "success" } })
    }
  });

  try {
    await adapter.likeSong!("6941309256906622978", true);
    throw new Error("expected likeSong to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe("soda");
    expect((err as ProviderError).code).toBe("UNAVAILABLE");
    expect((err as Error).message).toContain("登录状态已失效");
  }
});

test("soda adapter logout without cookie throws ProviderNotImplementedError no-session", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    }
  });

  try {
    await adapter.logout();
    throw new Error("expected logout to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderNotImplementedError);
    expect((err as ProviderNotImplementedError).action).toBe("no-session");
  }
});

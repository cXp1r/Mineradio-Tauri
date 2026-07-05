import { expect, test } from "bun:test";
import { clearRuntimeProviderCookie, getProviderCookie, setRuntimeProviderCookie } from "../../services/auth-session";
import { ProviderError } from "../provider-adapter";
import { ProviderNotImplementedError } from "../provider-adapter";
import { createSodaAdapter } from "./soda-adapter";
import { createSodaClient } from "./soda-client";
import { mapSodaSongToTrack, mapSodaPlaylistToSummary, parseSodaLyricText, mapSodaLyricToPayload } from "./map";

test("soda mapping helpers produce provider-shaped objects", () => {
  const track = mapSodaSongToTrack({
    id: 123,
    title: "Demo Song",
    artist: "Alice / Bob",
    albumName: "Demo Album",
    coverUrl: "//cdn.example.com/cover.jpg",
    durationMs: 215000
  });
  expect(track.provider).toBe("soda");
  expect(track.id).toBe("123");
  expect(track.artists).toEqual(["Alice", "Bob"]);
  expect(track.coverUrl).toBe("https://cdn.example.com/cover.jpg");
  expect(track.qualityHints).toEqual(["standard"]);

  const playlist = mapSodaPlaylistToSummary({
    id: "pl-1",
    name: "Favorites",
    trackCount: 12,
    trackIds: ["1", 2, 3]
  });
  expect(playlist.provider).toBe("soda");
  expect(playlist.trackIds).toEqual(["1", "2", "3"]);
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
        data: {
          track_player: {
            url_player_info: "https://api.qishui.com/mock/url-player-info"
          }
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
        data: {
          track_player: {
            url_player_info: "https://api.qishui.com/mock/url-player-info"
          }
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      ResponseMetadata: {
        RequestId: "req-1",
        Action: "GetPlayInfo",
        Version: "2024-01-01",
        Service: "qishui",
        Region: "cn"
      },
      Result: {
        EncryptKey: "",
        CipherText: "",
        Data: {
          PlayInfoList: [
            {
              Quality: "m4a",
              Duration: 180000,
              PlayAuth: "play-auth-1",
              PlayAuthID: "",
              MainPlayUrl: "https://cdn.example.com/main.m4a",
              BackupPlayUrl: "https://cdn.example.com/backup.m4a",
              UrlExpire: 3600,
              FileID: "file-1",
              P2pVerifyURL: "",
              PreloadInterval: 0,
              PreloadMaxStep: 0,
              PreloadMinStep: 0,
              PreloadSize: 0,
              CheckInfo: ""
            }
          ]
        }
      }
    }), {
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

test("soda adapter songUrl chooses the best playable entry from PlayInfoList", async () => {
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/luna/pc/track_v2")) {
      return new Response(JSON.stringify({
        data: {
          track_player: {
            url_player_info: "https://api.qishui.com/mock/url-player-info"
          }
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    expect(init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
    return new Response(JSON.stringify({
      Result: {
        Data: {
          PlayInfoList: [
            {
              Quality: "standard",
              Bitrate: 128000,
              Size: 1000,
              PlayAuth: "play-auth-low",
              MainPlayUrl: "https://cdn.example.com/low.m4a",
              FileID: "low-file"
            },
            {
              Quality: "exhigh",
              Bitrate: 320000,
              Size: 4000,
              PlayAuth: "play-auth-high",
              BackupPlayUrl: "https://cdn.example.com/high.m4a",
              FileID: "high-file"
            }
          ]
        }
      }
    }), {
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

  expect(result.url).toBe("/providers/soda/audio-proxy?url=https%3A%2F%2Fcdn.example.com%2Fhigh.m4a&playAuth=play-auth-high");
  expect(result.quality).toBe("exhigh");
  expect(result.level).toBe("exhigh");
  expect(result.filename).toBe("high-file");
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
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.playlistDetail("7590144593510006847");
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/luna/pc/playlist/detail");
  expect(url.searchParams.get("playlist_id")).toBe("7590144593510006847");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda client playlistDetail follows cursor pages until count_tracks is reached", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor") ?? "0";
      const body = cursor === "0"
        ? {
            playlist: { id: "pl-1", title: "Paged", count_tracks: 3 },
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

  expect(calls.map(({ input }) => new URL(input).searchParams.get("cursor") ?? "0")).toEqual(["0", "2"]);
  expect(calls.map(({ input }) => new URL(input).searchParams.get("cnt") ?? "")).toEqual(["20", "20"]);
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
                      preview: { start: 30000, duration: 60000 }
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
    qualityHints: ["standard"],
    playableState: "trial_only"
  });
});

test("soda adapter maps playlistList from client response", async () => {
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
      playlistList: async () => ({
        body: {
          data: [
            {
              id: "pl-1",
              name: "Favorites",
              coverUrl: "//cdn.example.com/pl.jpg",
              trackCount: 2,
              trackIds: ["1", 2],
              subscribed: true
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
      coverUrl: "https://cdn.example.com/pl.jpg",
      trackCount: 2,
      trackIds: ["1", "2"],
      subscribed: true
    }
  ]);
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
            url_cover: { urls: ["//cdn.example.com/detail.jpg"], uri: "" },
            count_tracks: 3,
            tracks: [
              {
                id: "t-1",
                title: "Track 1",
                artist: "Alice",
                albumName: "Album",
                durationMs: 120000
              }
            ]
          }
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
    coverUrl: "https://cdn.example.com/detail.jpg",
    trackCount: 3,
    trackIds: [],
    subscribed: false,
    tracks: [
      {
        provider: "soda",
        id: "t-1",
        sourceId: "t-1",
        mediaMid: undefined,
        title: "Track 1",
        artists: ["Alice"],
        album: "Album",
        coverUrl: "",
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
      loginStatus: async () => ({
        body: {
          status_code: 0,
          my_info: {
            id: "user-1",
            nickname: "Soda User",
            medium_avatar_url: { urls: ["//cdn.example.com/avatar-md.jpg"], uri: "" },
            larger_avatar_url: { urls: ["//cdn.example.com/avatar-lg.jpg"], uri: "" },
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
          nickname: "Runtime Soda"
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
            data: {
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
  const lines = parseSodaLyricText("[2000,3000]<2000,400> Hello<2400,600>world");

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

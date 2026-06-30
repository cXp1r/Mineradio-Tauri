import { expect, test } from "bun:test";
import {
  ProviderError,
  ProviderNotImplementedError
} from "../provider-adapter";
import { createNeteaseAdapter, type NeteaseHanaDeps } from "./netease-adapter";
import type { Track } from "@mineradio/shared";

const trackFixture: Track = {
  provider: "netease",
  id: "1",
  sourceId: "1",
  title: "t",
  artists: [],
  album: "",
  coverUrl: "",
  qualityHints: ["standard"],
  playableState: "unknown"
};

function withEnv(key: string, value: string | undefined, run: () => Promise<void> | void): Promise<void> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  const result = run();
  const restore = () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
  if (result instanceof Promise) {
    return result.then(restore, () => { restore(); throw new Error("rejected"); });
  }
  restore();
  return Promise.resolve();
}

function noopDeps(overrides: Partial<NeteaseHanaDeps>): NeteaseHanaDeps {
  const call = async () => ({ body: {} });
  return {
    cloudsearch: call,
    songDetail: call,
    songUrlV1: call,
    songUrl: call,
    lyric: call,
    lyricNew: call,
	    playlistDetail: call,
	    playlistCatlist: call,
	    userPlaylist: call,
	    like: call,
	    songLikeCheck: call,
	    likelist: call,
	    playlistTracks: call,
	    playlistTrackAdd: call,
	    loginStatus: call,
	    logout: call,
    getConfig: () => ({}),
    ...overrides
  };
}

test("search calls hana cloudsearch with keywords/limit/type and maps result to Track[]", async () => {
  let lastQuery: Record<string, unknown> = {};
  const deps = noopDeps({
    cloudsearch: async (q) => {
      lastQuery = q;
      return {
        body: {
          result: {
            songs: [
              {
                id: 100,
                name: "song one",
                ar: [{ id: 1, name: "art one" }],
                al: { id: 2, name: "album one", picUrl: "http://cover" },
                dt: 180000,
                fee: 0
              }
            ]
          }
        }
      };
    }
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.search({ keyword: "x", limit: 5 });
  expect(lastQuery["keywords"]).toBe("x");
  expect(lastQuery["limit"]).toBe(5);
  expect(lastQuery["type"]).toBe(1);
  expect(out.length).toBe(1);
  const t = out[0];
  expect(t.provider).toBe("netease");
  expect(t.id).toBe("100");
  expect(t.sourceId).toBe("100");
  expect(t.title).toBe("song one");
  expect(t.artists.length).toBe(1);
  expect(t.artists[0]).toBe("art one");
  expect(t.album).toBe("album one");
  expect(t.coverUrl).toBe("https://cover");
  expect(t.durationMs).toBe(180000);
});

test("songUrl maps playable fixture data element to {url, proxied:false}", async () => {
  const deps = noopDeps({
    songUrlV1: async () => ({
      body: { data: [{ id: 1, url: "http://audio", br: 128000, size: 100, type: "mp3", fee: 0, code: 200 }] }
    })
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.songUrl(trackFixture);
  expect(out.url).toBe("http://audio");
  expect(out.proxied).toBe(false);
});

test("songUrl sends requested playback quality to hana and returns resolved quality metadata", async () => {
  let lastQuery: Record<string, unknown> = {};
  const deps = noopDeps({
    songUrlV1: async (query) => {
      lastQuery = query;
      return {
        body: { data: [{ id: 1, url: "http://audio", br: 999000, size: 100, type: "mp3", fee: 0, code: 200 }] }
      };
    }
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "exhigh" });
  expect(lastQuery["level"]).toBe("exhigh");
  expect(out.level).toBe("exhigh");
  expect(out.quality).toBe("极高");
  expect(out.br).toBe(999000);
  expect(out.requestedQuality).toBe("exhigh");
});

test("songUrl walks the baseline quality ladder until a playable Netease URL is found", async () => {
  const calls: string[] = [];
  const deps = noopDeps({
    songUrlV1: async (query) => {
      calls.push(String(query["level"]));
      if (query["level"] === "lossless") {
        return {
          body: { data: [{ id: 1, url: null, br: 1411000, fee: 0, code: 200 }] }
        };
      }
      return {
        body: { data: [{ id: 1, url: "http://audio-320", br: 999000, fee: 0, code: 200 }] }
      };
    }
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "lossless" });

  expect(calls).toEqual(["lossless", "exhigh"]);
  expect(out.url).toBe("http://audio-320");
  expect(out.level).toBe("exhigh");
  expect(out.quality).toBe("极高");
  expect(out.br).toBe(999000);
  expect(out.requestedQuality).toBe("lossless");
});

test("songUrl falls back to legacy br endpoint when Netease songUrlV1 throws", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const deps = noopDeps({
    songUrlV1: async (query) => {
      calls.push({ endpoint: "v1", ...query });
      throw new Error("v1 down");
    },
    songUrl: async (query) => {
      calls.push({ endpoint: "legacy", ...query });
      return {
        body: { data: [{ id: 1, url: "http://legacy-audio", br: 999000, fee: 0, code: 200 }] }
      };
    }
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "exhigh" });

  expect(calls).toEqual([
    { endpoint: "v1", id: "1", level: "exhigh" },
    { endpoint: "legacy", id: "1", br: 999000 }
  ]);
  expect(out.url).toBe("http://legacy-audio");
  expect(out.level).toBe("exhigh");
  expect(out.requestedQuality).toBe("exhigh");
});

test("songUrl returns baseline trial metadata when Netease only returns a free trial URL", async () => {
  const calls: string[] = [];
  const deps = noopDeps({
    getConfig: () => ({}),
    songUrlV1: async (query) => {
      calls.push(String(query["level"]));
      return {
        body: {
          data: [{
            id: 1,
            url: "http://trial-audio",
            br: 128000,
            fee: 8,
            code: 200,
            freeTrialInfo: { start: 0, end: 60 }
          }]
        }
      };
    }
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "standard" });

  expect(calls).toEqual(["standard"]);
  expect(out.url).toBe("http://trial-audio");
  expect(out.trial).toBe(true);
  expect(out.playable).toBe(true);
  expect(out.reason).toBe("trial_only");
  expect(out.loggedIn).toBe(false);
  expect(out.vipLevel).toBe("none");
  expect(out.restriction).toEqual({
    provider: "netease",
    category: "trial_only",
    action: "upgrade",
    message: "网易云仅返回试听片段，完整播放需要会员或购买",
    code: 200,
    fee: 8
  });
});

test("songUrl carries logged-in VIP state into Netease trial metadata", async () => {
  const deps = noopDeps({
    getConfig: () => ({ cookie: "MUSIC_U=fake" }),
    loginStatus: async () => ({
      body: {
        data: {
          profile: {
            userId: 42,
            nickname: "vip user",
            avatarUrl: "",
            vipType: 1,
            vipLevel: "vip",
            isVip: true,
            isSvip: false,
            vipLabel: "黑胶VIP"
          }
        }
      }
    }),
    songUrlV1: async () => ({
      body: {
        data: [{
          id: 1,
          url: "http://trial-audio",
          br: 128000,
          fee: 8,
          code: 200,
          freeTrialInfo: { start: 0, end: 60 }
        }]
      }
    })
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "standard" });

  expect(out.trial).toBe(true);
  expect(out.loggedIn).toBe(true);
  expect(out.vipType).toBe(1);
  expect(out.vipLevel).toBe("vip");
  expect(out.isVip).toBe(true);
  expect(out.isSvip).toBe(false);
  expect(out.vipLabel).toBe("黑胶VIP");
  expect(out.message).toBe("此歌曲需要 SVIP 或购买 · 当前仅播放试听片段");
});

test("songUrl normalizes numeric Netease SVIP vipType for trial banner metadata", async () => {
  const deps = noopDeps({
    getConfig: () => ({ cookie: "MUSIC_U=fake" }),
    loginStatus: async () => ({
      body: {
        data: {
          profile: {
            userId: 42,
            nickname: "svip user",
            avatarUrl: "",
            vipType: 11
          }
        }
      }
    }),
    songUrlV1: async () => ({
      body: {
        data: [{
          id: 1,
          url: "http://trial-audio",
          br: 128000,
          fee: 8,
          code: 200,
          freeTrialInfo: { start: 0, end: 60 }
        }]
      }
    })
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "standard" });

  expect(out.vipType).toBe(11);
  expect(out.vipLevel).toBe("svip");
  expect(out.message).toBe("此歌曲需要单曲、专辑购买或更高权限");
});

test("songUrl for url:null + code:401 throws ProviderError LOGIN_REQUIRED", async () => {
  const deps = noopDeps({
    songUrlV1: async () => ({ body: { data: [{ id: 1, url: null, code: 401, fee: 0 }] } })
  });
  const adapter = createNeteaseAdapter(deps);
  let err: unknown = null;
  try {
    await adapter.songUrl(trackFixture);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProviderError);
  const e = err as ProviderError;
  expect(e.code).toBe("LOGIN_REQUIRED");
  expect(e.provider).toBe("netease");
});

test("lyric maps lrc+tlyric to LyricPayload (hasTranslation true, isWordByWord false)", async () => {
  const deps = noopDeps({
    lyricNew: async () => ({
      body: {
        lrc: { lyric: "[00:01.00]line1\n[00:03.50]line2" },
        tlyric: { lyric: "[00:01.00]翻译1" }
      }
    })
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.lyric(trackFixture);
  expect(out.provider).toBe("netease");
  expect(out.trackId).toBe("1");
  expect(out.lines.length).toBe(2);
  expect(out.hasTranslation).toBe(true);
  expect(out.isWordByWord).toBe(false);
  expect(out.lines[0].timeMs).toBe(1000);
  expect(out.lines[0].text).toBe("line1");
  expect(out.lines[0].translation).toBe("翻译1");
  expect(out.lines[1].timeMs).toBe(3500);
  expect(out.lines[1].text).toBe("line2");
});

test("lyric falls back to lyric() when lyricNew throws", async () => {
  let lyricCalled = 0;
  const deps = noopDeps({
    lyricNew: async () => { throw new Error("not found"); },
    lyric: async () => {
      lyricCalled++;
      return { body: { lrc: { lyric: "[00:00.00]fallback" } } };
    }
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.lyric(trackFixture);
  expect(lyricCalled).toBe(1);
  expect(out.lines.length).toBe(1);
  expect(out.lines[0].text).toBe("fallback");
});

test("playlistDetail maps fixture payload into a PlaylistDetail", async () => {
  const deps = noopDeps({
    playlistDetail: async () => ({
      body: {
        playlist: {
          id: 123,
          name: "pl",
          coverImgUrl: "c",
          trackCount: 1,
          tracks: [{ id: 1, name: "s", ar: [], al: {}, dt: 1000, fee: 0 }]
        }
      }
    })
  });
  const adapter = createNeteaseAdapter(deps);
  const out = await adapter.playlistDetail("123");
  expect(out.id).toBe("123");
  expect(out.name).toBe("pl");
  expect(out.coverUrl).toBe("c");
  expect(out.trackCount).toBe(1);
  expect(out.tracks.length).toBe(1);
  expect(out.tracks[0].id).toBe("1");
  expect(out.tracks[0].title).toBe("s");
});

test("loginStatus without MINERADIO_NETEASE_COOKIE returns loggedIn:false WITHOUT calling hana", async () => {
  await withEnv("MINERADIO_NETEASE_COOKIE", undefined, async () => {
    let calls = 0;
    const deps = noopDeps({
      getConfig: () => ({}),
      loginStatus: async () => { calls++; return { body: {} }; }
    });
    const adapter = createNeteaseAdapter(deps);
    const r = await adapter.loginStatus();
    expect(r.provider).toBe("netease");
    expect(r.loggedIn).toBe(false);
    expect(calls).toBe(0);
  });
});

test("logout without cookie throws ProviderNotImplementedError action no-session", async () => {
  await withEnv("MINERADIO_NETEASE_COOKIE", undefined, async () => {
    let calls = 0;
    const deps = noopDeps({
      getConfig: () => ({}),
      logout: async () => { calls++; return { body: {} }; }
    });
    const adapter = createNeteaseAdapter(deps);
    let err: unknown = null;
    try {
      await adapter.logout();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderNotImplementedError);
    const e = err as ProviderNotImplementedError;
    expect(e.provider).toBe("netease");
    expect(e.action).toBe("no-session");
    expect(calls).toBe(0);
  });
});

test("loginStatus with cookie proxies hana loginStatus and maps profile", async () => {
  await withEnv("MINERADIO_NETEASE_COOKIE", "MUSIC_U=demo", async () => {
    const deps = noopDeps({
      getConfig: () => ({ cookie: "MUSIC_U=demo" }),
      loginStatus: async () => ({
        body: { data: { profile: { nickname: "n", avatarUrl: "u", userId: 42 } } }
      })
    });
    const adapter = createNeteaseAdapter(deps);
    const r = await adapter.loginStatus();
    expect(r.provider).toBe("netease");
    expect(r.loggedIn).toBe(true);
    expect(r.nickname).toBe("n");
    expect(r.avatarUrl).toBe("u");
    expect(r.userId).toBe("42");
  });
});

test("logout with cookie calls hana logout", async () => {
  await withEnv("MINERADIO_NETEASE_COOKIE", "MUSIC_U=demo", async () => {
    let calls = 0;
    const deps = noopDeps({
      getConfig: () => ({ cookie: "MUSIC_U=demo" }),
      logout: async () => { calls++; return { body: { code: 200 } }; }
    });
    const adapter = createNeteaseAdapter(deps);
    await adapter.logout();
    expect(calls).toBe(1);
  });
});

test("playlistList without cookie returns empty list without calling hana", async () => {
  let calls = 0;
  const adapter = createNeteaseAdapter(noopDeps({
    getConfig: () => ({}),
    loginStatus: async () => { calls++; return { body: {} }; },
    userPlaylist: async () => { calls++; return { body: {} }; }
  }));
  const out = await adapter.playlistList();
  expect(out).toEqual([]);
  expect(calls).toBe(0);
});

test("playlistList uses logged-in user id and maps userPlaylist payload", async () => {
  const queries: Record<string, unknown>[] = [];
  const adapter = createNeteaseAdapter(noopDeps({
    getConfig: () => ({ cookie: "MUSIC_U=demo" }),
    loginStatus: async (query) => {
      queries.push(query);
      return {
        body: { data: { profile: { userId: 42, nickname: "n" } } }
      };
    },
    userPlaylist: async (query) => {
      queries.push(query);
      return {
        body: {
          playlist: [
            {
              id: 101,
              name: "我喜欢的音乐",
              coverImgUrl: "http://cover/like.jpg",
              trackCount: 12,
              trackIds: [{ id: 1 }, { id: 2 }]
            },
            {
              id: 102,
              name: "收藏歌单",
              coverImgUrl: "http://cover/coll.jpg",
              trackCount: 3
            }
          ]
        }
      };
    }
  }));

  const out = await adapter.playlistList();
  expect(queries[1]["uid"]).toBe("42");
  expect(queries[1]["limit"]).toBe(60);
  expect(out.length).toBe(2);
  expect(out[0]).toEqual({
    provider: "netease",
    id: "101",
    name: "我喜欢的音乐",
    coverUrl: "https://cover/like.jpg",
    trackCount: 12,
    trackIds: ["1", "2"],
    subscribed: false
  });
  expect(out[1].id).toBe("102");
});

test("likeSong requires a cookie and calls hana like with baseline string boolean", async () => {
	  let query: Record<string, unknown> = {};
  let cfg: { cookie?: string } | undefined;
  const adapter = createNeteaseAdapter(noopDeps({
    getConfig: () => ({ cookie: "MUSIC_U=demo" }),
    like: async (q, c) => {
      query = q;
      cfg = c;
      return { body: { code: 200 } };
    }
  }));

  const ack = await adapter.likeSong("100", true);

	  expect(query.id).toBe("100");
	  expect(query.like).toBe("true");
	  expect(typeof query.timestamp).toBe("number");
  expect(cfg).toEqual({ cookie: "MUSIC_U=demo" });
  expect(ack).toEqual({ provider: "netease", id: "100", liked: true, code: 200 });
});

test("likeSong without cookie throws LOGIN_REQUIRED before hana call", async () => {
  let calls = 0;
  const adapter = createNeteaseAdapter(noopDeps({
    getConfig: () => ({}),
    like: async () => { calls++; return { body: {} }; }
  }));

  let err: unknown = null;
  try {
    await adapter.likeSong("100", true);
  } catch (e) {
    err = e;
  }

  expect(calls).toBe(0);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).code).toBe("LOGIN_REQUIRED");
});

test("checkSongLikes prefers songLikeCheck and falls back to likelist by logged-in user id", async () => {
  const directQueries: Record<string, unknown>[] = [];
  const adapter = createNeteaseAdapter(noopDeps({
    getConfig: () => ({ cookie: "MUSIC_U=demo" }),
    loginStatus: async () => ({
      body: { data: { profile: { userId: 42, nickname: "n" } } }
    }),
    songLikeCheck: async (q) => {
      directQueries.push(q);
      return { body: { data: ["100"] } };
    },
    likelist: async () => {
      throw new Error("should not fallback when direct check returns data");
    }
  }));

  const direct = await adapter.checkSongLikes(["100", "200"]);
  expect(directQueries[0].ids).toBe("[100,200]");
  expect(direct.liked).toEqual({ "100": true, "200": false });

  const fallbackAdapter = createNeteaseAdapter(noopDeps({
    getConfig: () => ({ cookie: "MUSIC_U=demo" }),
    loginStatus: async () => ({
      body: { data: { profile: { userId: 42, nickname: "n" } } }
    }),
    songLikeCheck: async () => ({ body: { data: [] } }),
    likelist: async (q) => {
      expect(q.uid).toBe("42");
      return { body: { ids: [200] } };
    }
  }));
  const fallback = await fallbackAdapter.checkSongLikes(["100", "200"]);
  expect(fallback.liked).toEqual({ "100": false, "200": true });
});

test("addSongToPlaylist calls playlistTracks and falls back to playlistTrackAdd", async () => {
  const attempts: string[] = [];
  const adapter = createNeteaseAdapter(noopDeps({
    getConfig: () => ({ cookie: "MUSIC_U=demo" }),
    playlistTracks: async (q) => {
      attempts.push(`tracks:${q.op}:${q.pid}:${q.tracks}`);
      return { body: { code: 500, message: "failed" } };
    },
    playlistTrackAdd: async (q) => {
      attempts.push(`trackAdd:${q.pid}:${q.ids}`);
      return { body: { code: 200 } };
    }
  }));

  const ack = await adapter.addSongToPlaylist("p1", "100");

  expect(attempts).toEqual(["tracks:add:p1:100", "trackAdd:p1:100"]);
  expect(ack).toEqual({
    provider: "netease",
    playlistId: "p1",
    trackId: "100",
    success: true,
    code: 200
  });
});

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
    lyric: call,
    lyricNew: call,
    playlistDetail: call,
    playlistCatlist: call,
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
  expect(t.coverUrl).toBe("http://cover");
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

test("playlistList deferred throws ProviderNotImplementedError action playlist-list-deferred", async () => {
  const adapter = createNeteaseAdapter(noopDeps({}));
  let err: unknown = null;
  try {
    await adapter.playlistList();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProviderNotImplementedError);
  const e = err as ProviderNotImplementedError;
  expect(e.provider).toBe("netease");
  expect(e.action).toBe("playlist-list-deferred");
});

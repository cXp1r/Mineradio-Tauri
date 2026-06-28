import { expect, test } from "bun:test";
import {
  ProviderError,
  ProviderNotImplementedError
} from "../provider-adapter";
import { createQqAdapter, type QqClientDeps } from "./qq-adapter";
import type { Track } from "@mineradio/shared";

const trackFixture: Track = {
  provider: "qq",
  id: "002Zkt5S2oAB7X",
  sourceId: "002Zkt5S2oAB7X",
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

function noopDeps(overrides: Partial<QqClientDeps>): QqClientDeps {
  const call = async () => ({ body: {} });
  return {
    search: call,
    songDetail: call,
    songUrl: call,
    lyric: call,
    playlistDetail: call,
    loginStatus: call,
    logout: call,
    getConfig: () => ({}),
    ...overrides
  };
}

test("search calls qq search with key/pageNo/pageSize/t=0 and maps body.data.list to Track[]", async () => {
  let lastQuery: Record<string, unknown> = {};
  const deps = noopDeps({
    search: async (q) => {
      lastQuery = q;
      return {
        body: {
          list: [
            {
              songmid: "002Zkt5S2oAB7X",
              songname: "song one",
              singer: [{ mid: "s1", name: "art one" }],
              albumname: "album one",
              albummid: "albMid",
              interval: 180
            }
          ],
          total: 1
        }
      };
    }
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.search({ keyword: "x", limit: 5 });
  expect(lastQuery["key"]).toBe("x");
  expect(lastQuery["pageSize"]).toBe(5);
  expect(lastQuery["pageNo"]).toBe(1);
  expect(lastQuery["t"]).toBe(0);
  expect(lastQuery["raw"]).toBe(1);
  expect(out.length).toBe(1);
  const t = out[0];
  expect(t.provider).toBe("qq");
  expect(t.id).toBe("002Zkt5S2oAB7X");
  expect(t.sourceId).toBe("002Zkt5S2oAB7X");
  expect(t.title).toBe("song one");
  expect(t.artists.length).toBe(1);
  expect(t.artists[0]).toBe("art one");
  expect(t.album).toBe("album one");
  expect(t.coverUrl).toBe("https://y.gtimg.cn/music/photo_new/T002R300x300M000albMid.jpg");
  expect(t.durationMs).toBe(180000);
});

test("search maps raw qq response body data.song.list when package formatter is brittle", async () => {
  const deps = noopDeps({
    search: async () => ({
      body: {
        code: 0,
        data: {
          keyword: "x",
          song: {
            list: [
              {
                songmid: "rawMid",
                songname: "raw song",
                singer: [{ name: "raw art" }],
                albumname: "raw album",
                interval: 99
              }
            ]
          }
        }
      }
    })
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.search({ keyword: "x", limit: 5 });
  expect(out.length).toBe(1);
  expect(out[0].id).toBe("rawMid");
  expect(out[0].title).toBe("raw song");
  expect(out[0].artists).toEqual(["raw art"]);
});

test("search falls back to smartbox when qq package search route fails", async () => {
  let fallbackKeyword = "";
  let fallbackLimit = 0;
  const deps = noopDeps({
    search: async () => {
      throw new TypeError("package formatter failed");
    },
    smartboxSearch: async (keyword, limit) => {
      fallbackKeyword = keyword;
      fallbackLimit = limit;
      return [
        {
          mid: "smartMid",
          name: "smart song",
          singer: "smart art",
          pic: "http://y.gtimg.cn/music/photo_new/T002R180x180M000abc.jpg"
        }
      ];
    }
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.search({ keyword: "x", limit: 5 });
  expect(fallbackKeyword).toBe("x");
  expect(fallbackLimit).toBe(5);
  expect(out.length).toBe(1);
  expect(out[0].id).toBe("smartMid");
  expect(out[0].title).toBe("smart song");
  expect(out[0].artists).toEqual(["smart art"]);
  expect(out[0].coverUrl.startsWith("https://")).toBe(true);
});

test("songUrl without cookie throws ProviderError LOGIN_REQUIRED", async () => {
  const deps = noopDeps({
    getConfig: () => ({}),
    songUrl: async () => { throw new Error("获取播放链接出错"); }
  });
  const adapter = createQqAdapter(deps);
  let err: unknown = null;
  try {
    await adapter.songUrl(trackFixture);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProviderError);
  const e = err as ProviderError;
  expect(e.code).toBe("LOGIN_REQUIRED");
  expect(e.provider).toBe("qq");
  expect(e.retryable).toBe(true);
});

test("songUrl with cookie returns {url, proxied:false} when qq resolves url string", async () => {
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
    songUrl: async () => ({ body: "http://audio.example/x.mp3" })
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.songUrl(trackFixture);
  expect(out.url).toBe("http://audio.example/x.mp3");
  expect(out.proxied).toBe(false);
});

test("songUrl maps requested playback quality to qq type and returns resolved quality metadata", async () => {
  let lastQuery: Record<string, unknown> = {};
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
    songUrl: async (query) => {
      lastQuery = query;
      return { body: "http://audio.example/x.flac" };
    }
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "lossless" });
  expect(lastQuery["type"]).toBe("flac");
  expect(out.level).toBe("lossless");
  expect(out.quality).toBe("无损 FLAC");
  expect(out.requestedQuality).toBe("lossless");
});

test("songUrl with cookie but empty url throws ProviderError UNAVAILABLE", async () => {
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
    songUrl: async () => ({ body: "" })
  });
  const adapter = createQqAdapter(deps);
  let err: unknown = null;
  try {
    await adapter.songUrl(trackFixture);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProviderError);
  const e = err as ProviderError;
  expect(e.code).toBe("UNAVAILABLE");
  expect(e.provider).toBe("qq");
});

test("lyric maps body.lyric + body.trans to LyricPayload (hasTranslation true)", async () => {
  const deps = noopDeps({
    lyric: async () => ({
      body: {
        lyric: "[00:01.00]line1\n[00:03.50]line2",
        trans: "[00:01.00]翻译1"
      }
    })
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.lyric(trackFixture);
  expect(out.provider).toBe("qq");
  expect(out.trackId).toBe("002Zkt5S2oAB7X");
  expect(out.lines.length).toBe(2);
  expect(out.hasTranslation).toBe(true);
  expect(out.isWordByWord).toBe(false);
  expect(out.lines[0].timeMs).toBe(1000);
  expect(out.lines[0].text).toBe("line1");
  expect(out.lines[0].translation).toBe("翻译1");
  expect(out.lines[1].timeMs).toBe(3500);
  expect(out.lines[1].text).toBe("line2");
});

test("lyric with no trans returns hasTranslation false", async () => {
  const deps = noopDeps({
    lyric: async () => ({ body: { lyric: "[00:00.00]only", trans: "" } })
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.lyric(trackFixture);
  expect(out.lines.length).toBe(1);
  expect(out.hasTranslation).toBe(false);
});

test("playlistList deferred throws ProviderNotImplementedError action playlist-list-deferred", async () => {
  const adapter = createQqAdapter(noopDeps({}));
  let err: unknown = null;
  try {
    await adapter.playlistList();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProviderNotImplementedError);
  const e = err as ProviderNotImplementedError;
  expect(e.provider).toBe("qq");
  expect(e.action).toBe("playlist-list-deferred");
});

test("playlistDetail maps body.cdlist[0] into PlaylistDetail", async () => {
  const deps = noopDeps({
    playlistDetail: async () => ({
      body: {
        cdlist: [
          {
            disstid: 123,
            dissname: "pl",
            logo: "c",
            total_song_num: 1,
            songlist: [
              {
                songmid: "sm1",
                songname: "s",
                singer: [{ name: "art" }],
                albumname: "alb",
                interval: 100
              }
            ]
          }
        ]
      }
    })
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.playlistDetail("123");
  expect(out.id).toBe("123");
  expect(out.name).toBe("pl");
  expect(out.coverUrl).toBe("c");
  expect(out.trackCount).toBe(1);
  expect(out.tracks.length).toBe(1);
  expect(out.tracks[0].id).toBe("sm1");
  expect(out.tracks[0].title).toBe("s");
});

test("playlistDetail with empty cdlist throws ProviderError UNAVAILABLE", async () => {
  const deps = noopDeps({
    playlistDetail: async () => ({ body: { cdlist: [] } })
  });
  const adapter = createQqAdapter(deps);
  let err: unknown = null;
  try {
    await adapter.playlistDetail("123");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProviderError);
  const e = err as ProviderError;
  expect(e.code).toBe("UNAVAILABLE");
  expect(e.provider).toBe("qq");
});

test("loginStatus without MINERADIO_QQ_COOKIE returns loggedIn:false WITHOUT calling qq", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", undefined, async () => {
    let calls = 0;
    const deps = noopDeps({
      getConfig: () => ({}),
      loginStatus: async () => { calls++; return { body: {} }; }
    });
    const adapter = createQqAdapter(deps);
    const r = await adapter.loginStatus();
    expect(r.provider).toBe("qq");
    expect(r.loggedIn).toBe(false);
    expect(calls).toBe(0);
  });
});

test("loginStatus with cookie returns loggedIn:true trusting cookie presence", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=abc", async () => {
    const deps = noopDeps({
      getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
      loginStatus: async () => { throw new Error("should not be called"); }
    });
    const adapter = createQqAdapter(deps);
    const r = await adapter.loginStatus();
    expect(r.provider).toBe("qq");
    expect(r.loggedIn).toBe(true);
  });
});

test("logout without cookie throws ProviderNotImplementedError action no-session", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", undefined, async () => {
    let calls = 0;
    const deps = noopDeps({
      getConfig: () => ({}),
      logout: async () => { calls++; return { body: {} }; }
    });
    const adapter = createQqAdapter(deps);
    let err: unknown = null;
    try {
      await adapter.logout();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderNotImplementedError);
    const e = err as ProviderNotImplementedError;
    expect(e.provider).toBe("qq");
    expect(e.action).toBe("no-session");
    expect(calls).toBe(0);
  });
});

test("logout with cookie calls qq logout", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=abc", async () => {
    let calls = 0;
    const deps = noopDeps({
      getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
      logout: async () => { calls++; return { body: {} }; }
    });
    const adapter = createQqAdapter(deps);
    await adapter.logout();
    expect(calls).toBe(1);
  });
});

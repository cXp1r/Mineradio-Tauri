import { expect, test } from "bun:test";
import {
  ProviderError,
  ProviderNotImplementedError
} from "../provider-adapter";
import { createQqAdapter, type QqClientDeps } from "./qq-adapter";
import { mapQqSongToTrack, normalizeProviderImageUrl } from "./map";
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

test("mapQqSongToTrack preserves QQ file media_mid for vkey filename generation", () => {
  const track = mapQqSongToTrack({
    songmid: "song-mid",
    songname: "song",
    file: { media_mid: "media-mid" }
  });

  expect(track.sourceId).toBe("song-mid");
  expect(track.mediaMid).toBe("media-mid");
});

test("mapQqSongToTrack maps official playlist song fields", () => {
  const track = mapQqSongToTrack({
    mid: "001hRqO33rprdA",
    title: "家的方向",
    singer: [{ name: "李卿" }],
    album: { mid: "0029EuuF18FxcG", title: "家的方向" },
    interval: 192
  });

  expect(track.id).toBe("001hRqO33rprdA");
  expect(track.title).toBe("家的方向");
  expect(track.album).toBe("家的方向");
  expect(track.coverUrl).toContain("0029EuuF18FxcG");
});

test("QQ map normalizes protocol-relative and http cover URLs for WebGL consumers", () => {
  expect(normalizeProviderImageUrl("//y.gtimg.cn/music/photo_new/a.jpg")).toBe("https://y.gtimg.cn/music/photo_new/a.jpg");
  expect(normalizeProviderImageUrl("http://y.gtimg.cn/music/photo_new/a.jpg")).toBe("https://y.gtimg.cn/music/photo_new/a.jpg");
  expect(mapQqSongToTrack({ songmid: "s", pic: "//y.gtimg.cn/music/photo_new/a.jpg" }).coverUrl).toBe("https://y.gtimg.cn/music/photo_new/a.jpg");
});

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
    return result.then(restore, (err) => { restore(); throw err; });
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
    userSonglists: call,
    userCollectSonglists: call,
    playlistDetail: call,
    addSongToPlaylist: call,
    loginStatus: call,
    logout: call,
    getConfig: () => ({}),
    legacyLyric: call,
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

test("songUrl builds baseline QQ filenames from mediaMid when it differs from songmid", async () => {
  let lastQuery: Record<string, unknown> = {};
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
    songUrl: async (query) => {
      lastQuery = query;
      return { body: "http://audio.example/media-mid.flac" };
    }
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.songUrl({ ...trackFixture, mediaMid: "media-mid" }, { quality: "lossless" });

  expect(lastQuery["filename"]).toBe("F000media-mid.flac");
  expect(lastQuery["id"]).toBe("002Zkt5S2oAB7X");
  expect(out.filename).toBe("F000media-mid.flac");
});

test("songUrl walks the QQ quality ladder until a playable URL is returned", async () => {
  const calls: string[] = [];
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
    songUrl: async (query) => {
      calls.push(String(query["type"]));
      return { body: query["type"] === "320" ? "http://audio.example/320.mp3" : "" };
    }
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "lossless" });

  expect(calls).toEqual(["flac", "320"]);
  expect(out.url).toBe("http://audio.example/320.mp3");
  expect(out.level).toBe("exhigh");
  expect(out.quality).toBe("320k MP3");
  expect(out.requestedQuality).toBe("lossless");
});

test("songUrl parses baseline QQ musicu midurlinfo plus sip response", async () => {
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
    songUrl: async () => ({
      body: {
        req_0: {
          data: {
            sip: ["https://ws.stream.qqmusic.qq.com/"],
            midurlinfo: [{
              filename: "F000002Zkt5S2oAB7X.flac",
              purl: "C400002Zkt5S2oAB7X.m4a?guid=1",
              result: 0
            }]
          }
        }
      }
    })
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.songUrl(trackFixture, { quality: "lossless" });

  expect(out.url).toBe("https://ws.stream.qqmusic.qq.com/C400002Zkt5S2oAB7X.m4a?guid=1");
  expect(out.filename).toBe("F000002Zkt5S2oAB7X.flac");
  expect(out.level).toBe("lossless");
  expect(out.quality).toBe("无损 FLAC");
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

test("songUrl classifies QQ 104003 without playback key as LOGIN_REQUIRED", async () => {
  const calls: string[] = [];
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=123" }),
    songUrl: async (query) => {
      calls.push(String(query["type"]));
      return {
        body: {
          code: 104003,
          msg: "no vkey",
          url: ""
        }
      };
    }
  });
  const adapter = createQqAdapter(deps);
  let err: unknown = null;
  try {
    await adapter.songUrl(trackFixture, { quality: "lossless" });
  } catch (e) {
    err = e;
  }
  expect(calls).toEqual(["flac"]);
  expect(err).toBeInstanceOf(ProviderError);
  const e = err as ProviderError;
  expect(e.code).toBe("LOGIN_REQUIRED");
  expect(e.provider).toBe("qq");
  expect(e.retryable).toBe(true);
  expect(e.action).toBe("login");
  expect(e.message).toContain("播放授权");
  expect(e.playbackKeyReady).toBe(false);
  expect(e.reason).toBe("login_required");
  expect(e.qqCode).toBe(104003);
  expect(e.rawMessage).toBe("no vkey");
  expect(e.tried).toEqual([
    "无损 FLAC · F000002Zkt5S2oAB7X.flac",
    "320k MP3 · M800002Zkt5S2oAB7X.mp3",
    "128k MP3 · M500002Zkt5S2oAB7X.mp3"
  ]);
  expect(e.restriction?.provider).toBe("qq");
  expect(e.restriction?.category).toBe("login_required");
  expect(e.restriction?.action).toBe("login");
  expect(e.restriction?.code).toBe(104003);
  expect(e.restriction?.rawMessage).toBe("no vkey");
  expect(e.restriction?.missingPlaybackKey).toBe(true);
  expect(e.restriction).toEqual({
    provider: "qq",
    category: "login_required",
    action: "login",
    message: "QQ 音乐当前只拿到了网页登录状态，还缺少播放授权，请重新打开官方 QQ 音乐登录窗口完成授权",
    code: 104003,
    rawMessage: "no vkey",
    missingPlaybackKey: true
  });
});

test("songUrl classifies baseline QQ midurlinfo restriction without losing metadata", async () => {
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=123" }),
    songUrl: async () => ({
      body: {
        req_0: {
          data: {
            sip: ["https://ws.stream.qqmusic.qq.com/"],
            midurlinfo: [{
              filename: "F000002Zkt5S2oAB7X.flac",
              purl: "",
              result: 104003,
              msg: "no vkey from musicu"
            }]
          }
        }
      }
    })
  });
  const adapter = createQqAdapter(deps);
  let err: unknown = null;
  try {
    await adapter.songUrl(trackFixture, { quality: "lossless" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProviderError);
  const e = err as ProviderError;
  expect(e.code).toBe("LOGIN_REQUIRED");
  expect(e.qqCode).toBe(104003);
  expect(e.rawMessage).toBe("no vkey from musicu");
  expect(e.restriction?.missingPlaybackKey).toBe(true);
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

test("lyric falls back to legacy fcg_query_lyric_new payload when QQ musicu lyric is empty", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const deps = noopDeps({
    lyric: async (query) => {
      calls.push({ endpoint: "musicu", ...query });
      return { body: { lyric: "", trans: "" } };
    },
    legacyLyric: async (query) => {
      calls.push({ endpoint: "legacy", ...query });
      return {
        body: {
          lyric: "[00:01.00]legacy line",
          tlyric: "[00:01.00]legacy trans"
        }
      };
    }
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.lyric(trackFixture);

  expect(calls).toEqual([
    { endpoint: "musicu", songmid: "002Zkt5S2oAB7X" },
    { endpoint: "legacy", songmid: "002Zkt5S2oAB7X" }
  ]);
  expect(out.lines.length).toBe(1);
  expect(out.lines[0].text).toBe("legacy line");
  expect(out.lines[0].translation).toBe("legacy trans");
  expect(out.lines[0].source).toBe("qq-legacy");
  expect(out.hasTranslation).toBe(true);
});

test("lyric maps QQ qrc-only payload into timed native lyric lines", async () => {
  const deps = noopDeps({
    lyric: async () => ({
      body: {
        lyric: "",
        trans: "",
        qrc: "[1000,2500](1000,500)你(1500,500)好"
      }
    }),
    legacyLyric: undefined
  });
  const adapter = createQqAdapter(deps);
  const out = await adapter.lyric(trackFixture);

  expect(out.lines).toEqual([
    { timeMs: 1000, durationMs: 2500, text: "你好", source: "qrc" }
  ]);
  expect(out.isWordByWord).toBe(false);
});

test("playlistList without cookie returns empty list without calling qq", async () => {
  let calls = 0;
  const adapter = createQqAdapter(noopDeps({
    getConfig: () => ({}),
    userSonglists: async () => { calls++; return { body: {} }; },
    userCollectSonglists: async () => { calls++; return { body: {} }; }
  }));

  const out = await adapter.playlistList();
  expect(out).toEqual([]);
  expect(calls).toBe(0);
});

test("playlistList merges created and collected QQ playlists, filters qzone, and sorts favorites first", async () => {
  const queries: Record<string, unknown>[] = [];
  const adapter = createQqAdapter(noopDeps({
    getConfig: () => ({ cookie: "uin=o00123; qqmusic_key=abc" }),
    userSonglists: async (query) => {
      queries.push(query);
      return {
        body: {
          list: [
            {
              dirid: 201,
              diss_name: "我喜欢",
              diss_cover: "http://cover/like.jpg",
              song_cnt: 8,
              listen_num: 1,
              hostname: "me"
            },
            {
              dissid: "300",
              diss_name: "空间背景音乐",
              diss_cover: "http://cover/qzone.jpg",
              song_cnt: 1,
              hostname: "Qzone"
            }
          ]
        }
      };
    },
    userCollectSonglists: async (query) => {
      queries.push(query);
      return {
        body: {
          list: [
            {
              dissid: "301",
              diss_name: "收藏歌单",
              diss_cover: "http://cover/coll.jpg",
              song_cnt: 3,
              nick: "friend"
            },
            {
              dissid: "301",
              diss_name: "收藏歌单重复",
              diss_cover: "http://cover/dup.jpg",
              song_cnt: 4,
              nick: "friend"
            }
          ]
        }
      };
    }
  }));

  const out = await adapter.playlistList();
  expect(queries[0]["id"]).toBe("00123");
  expect(queries[1]["id"]).toBe("00123");
  expect(out.length).toBe(2);
  expect(out[0]).toEqual({
    provider: "qq",
    id: "201",
    name: "我喜欢",
    coverUrl: "https://cover/like.jpg",
    trackCount: 8,
    trackIds: [],
    subscribed: false
  });
  expect(out[1].id).toBe("301");
  expect(out[1].name).toBe("收藏歌单");
  expect(out[1].subscribed).toBe(true);
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

test("playlistDetail falls back to official public playlist detail when legacy cdlist is empty", async () => {
  const deps = noopDeps({
    playlistDetail: async () => ({ body: { cdlist: [] } }),
    officialPlaylistDetail: async (id) => ({
      disstid: id,
      title: "Public QQ",
      picurl: "https://qpic.y.qq.com/cover/600",
      total_song_num: 1,
      songlist: [{
        mid: "001hRqO33rprdA",
        title: "家的方向",
        singer: [{ name: "李卿" }],
        album: { mid: "0029EuuF18FxcG", title: "家的方向" },
        interval: 192
      }]
    })
  });
  const adapter = createQqAdapter(deps);

  const out = await adapter.playlistDetail("7167576049");

  expect(out.id).toBe("7167576049");
  expect(out.name).toBe("Public QQ");
  expect(out.tracks.length).toBe(1);
  expect(out.tracks[0].id).toBe("001hRqO33rprdA");
});

test("addSongToPlaylist requires cookie and calls qq songlist add with mid and dirid", async () => {
  const calls: unknown[] = [];
  const deps = noopDeps({
    getConfig: () => ({ cookie: "uin=o00123; qm_keyst=abc" }),
    addSongToPlaylist: async (query, config) => {
      calls.push({ query, config });
      return { body: { result: 100, message: "添加成功" } };
    }
  });
  const adapter = createQqAdapter(deps);

  const ack = await adapter.addSongToPlaylist?.("201", "002Zkt5S2oAB7X");

  expect(ack).toEqual({
    provider: "qq",
    playlistId: "201",
    trackId: "002Zkt5S2oAB7X",
    success: true,
    code: 100
  });
  expect(calls).toEqual([
    {
      query: { mid: "002Zkt5S2oAB7X", dirid: "201" },
      config: { cookie: "uin=o00123; qm_keyst=abc" }
    }
  ]);
});

test("addSongToPlaylist without cookie throws LOGIN_REQUIRED before qq call", async () => {
  let calls = 0;
  const deps = noopDeps({
    getConfig: () => ({}),
    addSongToPlaylist: async () => {
      calls++;
      return { body: {} };
    }
  });
  const adapter = createQqAdapter(deps);

  let err: unknown = null;
  try {
    await adapter.addSongToPlaylist?.("201", "002Zkt5S2oAB7X");
  } catch (e) {
    err = e;
  }

  expect(calls).toBe(0);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).code).toBe("LOGIN_REQUIRED");
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

test("loginStatus with cookie calls qq user detail and maps account profile", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=abc", async () => {
    const calls: Array<{ query: Record<string, unknown>; config?: { cookie?: string } }> = [];
    const deps = noopDeps({
      getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
      loginStatus: async (query, config) => {
        calls.push({ query, config });
        return {
          body: {
            result: 100,
            data: {
              creator: {
                hostname: "QQ昵称",
                nick: "QQ昵称",
                headpic: "//thirdqq.qlogo.cn/avatar.jpg",
                userid: "123"
              },
              mymusic: [],
              mydiss: []
            }
          }
        };
      }
    });
    const adapter = createQqAdapter(deps);
    const r = await adapter.loginStatus();
    expect(calls).toEqual([
      {
        query: { id: "123" },
        config: { cookie: "uin=123; qqmusic_key=abc" }
      }
    ]);
    expect(r.provider).toBe("qq");
    expect(r.loggedIn).toBe(true);
    expect(r.nickname).toBe("QQ昵称");
    expect(r.avatarUrl).toBe("https://thirdqq.qlogo.cn/avatar.jpg");
    expect(r.userId).toBe("123");
  });
});

test("loginStatus maps QQ vip info from musicu vip query payload", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=abc", async () => {
    const calls: string[] = [];
    const deps = noopDeps({
      getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
      loginStatus: async () => {
        calls.push("profile");
        return { body: { result: 100, data: { mymusic: [], mydiss: [] } } };
      },
      vipInfo: async (query, config) => {
        calls.push("vip");
        expect(query).toEqual({ id: "123" });
        expect(config).toEqual({ cookie: "uin=123; qqmusic_key=abc" });
        return {
          body: {
            code: 0,
            getVipInfo: {
              code: 0,
              data: {
                infoMap: {
                  "123": {
                    iVipFlag: 1,
                    iSuperVip: 1,
                    iSuperVipLevel: 5,
                    iconUrl: "//y.qq.com/super-vip.png",
                    ieight: 1,
                    itwelve: 0,
                    iYearFlag: 1
                  }
                }
              }
            },
            getNickHead: {
              code: 0,
              data: {
                map_userinfo: {
                  "123": {
                    nick: "绿钻用户",
                    headurl: "http://q.qlogo.cn/head.jpg"
                  }
                }
              }
            }
          }
        };
      }
    } as Partial<QqClientDeps>);
    const adapter = createQqAdapter(deps);
    const r = await adapter.loginStatus();

    expect(calls).toEqual(["profile", "vip"]);
    expect(r.provider).toBe("qq");
    expect(r.loggedIn).toBe(true);
    expect(r.nickname).toBe("绿钻用户");
    expect(r.avatarUrl).toBe("https://q.qlogo.cn/head.jpg");
    expect(r.userId).toBe("123");
    expect(r.vipType).toBe(11);
    expect(r.vipLevel).toBe("svip");
    expect(r.isVip).toBe(true);
    expect(r.isSvip).toBe(true);
    expect(r.vipLabel).toBe("超级会员·伍");
    expect(r.vipIcon).toBe("qq-super-vip");
    expect(r.vipIconUrl).toBe("https://y.qq.com/super-vip.png");
    expect(r.vipTier).toBe(5);
    expect(r.vipLevelName).toBe("伍");
  });
});

test("loginStatus maps QQ green VIP tier without super member", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=abc", async () => {
    const deps = noopDeps({
      getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
      loginStatus: async () => ({ body: { data: {} } }),
      vipInfo: async () => ({
        body: {
          getVipInfo: {
            data: {
              infoMap: {
                "123": {
                  iVipFlag: 1,
                  iSuperVip: 0,
                  iVipLevel: 3,
                  iconUrl: "https://y.qq.com/green-vip.png"
                }
              }
            }
          }
        }
      })
    } as Partial<QqClientDeps>);
    const adapter = createQqAdapter(deps);
    const r = await adapter.loginStatus();

    expect(r.vipLevel).toBe("vip");
    expect(r.vipLabel).toBe("豪华绿钻·叁");
    expect(r.vipIcon).toBe("qq-green-vip");
    expect(r.vipIconUrl).toBe("https://y.qq.com/green-vip.png");
    expect(r.vipTier).toBe(3);
    expect(r.vipLevelName).toBe("叁");
  });
});

test("loginStatus derives QQ official badge icon from VIP tier when musicu omits image URL", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=abc", async () => {
    const deps = noopDeps({
      getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
      loginStatus: async () => ({ body: { data: {} } }),
      vipInfo: async () => ({
        body: {
          getVipInfo: {
            data: {
              infoMap: {
                "123": {
                  iNewVip: 1,
                  iNewSuperVip: 1,
                  iCurLevel: 6,
                  sIcon: "oKnq7K6FoKni7z**"
                }
              }
            }
          }
        }
      })
    } as Partial<QqClientDeps>);
    const adapter = createQqAdapter(deps);
    const r = await adapter.loginStatus();

    expect(r.vipLevel).toBe("svip");
    expect(r.vipLabel).toBe("超级会员·陆");
    expect(r.vipIcon).toBe("qq-super-vip");
    expect(r.vipIconUrl).toBe("https://y.qq.com/mediastyle/lv-icon/v14/2x/svip6.png");
    expect(r.vipTier).toBe(6);
    expect(r.vipLevelName).toBe("陆");
  });
});

test("loginStatus lets QQ official badge icon override ambiguous super member flags", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", "uin=123; qqmusic_key=abc", async () => {
    const deps = noopDeps({
      getConfig: () => ({ cookie: "uin=123; qqmusic_key=abc" }),
      loginStatus: async () => ({ body: { data: {} } }),
      vipInfo: async () => ({
        body: {
          getVipInfo: {
            data: {
              infoMap: {
                "123": {
                  iNewVip: 1,
                  iNewSuperVip: 1,
                  iCurLevel: 7,
                  sIcon: "oKnq7K6FoKni7z**"
                }
              }
            }
          },
          getVipIcon: {
            data: {
              UserInfoUI: {
                iconlist: [
                  { srcUrl: "https://y.qq.com/mediastyle/lv-icon/v14/2x/vip7.png", width: 96, height: 46 },
                  { srcUrl: "https://y.qq.com/mediastyle/lv-icon/v10/audio/2x/d-vip1.png", width: 34, height: 46 }
                ]
              }
            }
          }
        }
      })
    } as Partial<QqClientDeps>);
    const adapter = createQqAdapter(deps);
    const r = await adapter.loginStatus();

    expect(r.vipLevel).toBe("vip");
    expect(r.vipLabel).toBe("豪华绿钻·柒");
    expect(r.vipIcon).toBe("qq-green-vip");
    expect(r.vipIconUrl).toBe("https://y.qq.com/mediastyle/lv-icon/v14/2x/vip7.png");
    expect(r.vipTier).toBe(7);
    expect(r.vipLevelName).toBe("柒");
  });
});

test("loginStatus with cookie falls back to cookie userId when qq user detail fails", async () => {
  await withEnv("MINERADIO_QQ_COOKIE", "uin=o00123; qqmusic_key=abc", async () => {
    const deps = noopDeps({
      getConfig: () => ({ cookie: "uin=o00123; qqmusic_key=abc" }),
      loginStatus: async () => { throw new Error("expired profile endpoint"); }
    });
    const adapter = createQqAdapter(deps);
    const r = await adapter.loginStatus();

    expect(r).toEqual({
      provider: "qq",
      loggedIn: true,
      userId: "00123"
    });
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

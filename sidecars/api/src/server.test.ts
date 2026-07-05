import { expect, test } from "bun:test";
import { routeHandler, createRouteHandler } from "./server";
import type { Track } from "@mineradio/shared";
import { providers } from "./providers/registry";
import { ProviderError, ProviderNotImplementedError, type ProviderAdapter } from "./providers/provider-adapter";
import { getProviderCookie } from "./services/auth-session";
import type { SidecarLogger } from "./services/sidecar-log";

async function call(path: string, init?: RequestInit): Promise<Response> {
  const req = new Request(`http://127.0.0.1${path}`, init);
  return routeHandler(req);
}

async function body(r: Response): Promise<any> {
  return await r.json();
}

const routeTrack: Track = {
  provider: "netease",
  id: "1",
  sourceId: "1",
  title: "t",
  artists: [],
  album: "",
  coverUrl: "",
  qualityHints: [],
  playableState: "playable"
};

test("GET /health returns 200 with both providers", async () => {
  const r = await call("/health");
  expect(r.status).toBe(200);
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.providers).toEqual(["netease", "qq", "soda"]);
  expect(b.providerStatus.providers.map((p: { providerId: string }) => p.providerId)).toEqual(["netease", "qq", "soda"]);
  expect(b.providerStatus.providers[0].capabilities).toContain("search");
});

test("OPTIONS preflight returns sidecar CORS headers", async () => {
  const r = await call("/providers/netease/search", {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:5173",
      "access-control-request-method": "GET",
      "access-control-request-headers": "content-type"
    }
  });
  expect(r.status).toBe(204);
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  expect(r.headers.get("access-control-allow-methods")).toContain("GET");
  expect(r.headers.get("access-control-allow-headers")).toContain("content-type");
});

test("route handler writes sanitized request logs through injected sidecar logger", async () => {
  const entries: Record<string, unknown>[] = [];
  const logger: SidecarLogger = {
    async log(entry) {
      entries.push(entry);
    }
  };
  const handler = createRouteHandler({ logger });

  try {
    const r = await handler(new Request("http://127.0.0.1/providers/qq/session-cookie", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ cookie: "qqmusic_key=secret" })
    }));

    expect(r.status).toBe(200);
    expect(entries.length).toBe(1);
    expect(entries[0].event).toBe("request");
    expect(entries[0].method).toBe("POST");
    expect(entries[0].path).toBe("/providers/qq/session-cookie");
    expect(entries[0].status).toBe(200);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("qqmusic_key");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("secret");
  } finally {
    await call("/providers/qq/session-cookie", { method: "DELETE" });
  }
});

test("GET unknown path returns 404 NOT_FOUND envelope", async () => {
  const r = await call("/nope");
  expect(r.status).toBe(404);
  const b = await body(r);
  expect(b.ok).toBe(false);
  expect(b.error.code).toBe("NOT_FOUND");
  expect(b.error.retryable).toBe(false);
});

test("GET /providers/unknown/login-status returns 404 NOT_FOUND for unknown provider", async () => {
  const r = await call("/providers/bad/login-status");
  expect(r.status).toBe(404);
  const b = await body(r);
  expect(b.error.code).toBe("NOT_FOUND");
});

test("GET /providers/netease/search without keyword returns 400 BAD_REQUEST", async () => {
  const r = await call("/providers/netease/search");
  expect(r.status).toBe(400);
  const b = await body(r);
  expect(b.error.code).toBe("BAD_REQUEST");
  expect(b.error.provider).toBe("netease");
});

test("GET /providers/netease/search with blank keyword returns 400", async () => {
  const r = await call("/providers/netease/search?keyword=%20%20");
  expect(r.status).toBe(400);
});

test("GET /search without keyword returns 400 BAD_REQUEST", async () => {
  const r = await call("/search");
  expect(r.status).toBe(400);
  const b = await body(r);
  expect(b.error.code).toBe("BAD_REQUEST");
});

test("GET /search with unknown provider returns 404 NOT_FOUND", async () => {
  const r = await call("/search?keyword=t&provider=bad");
  expect(r.status).toBe(404);
  const b = await body(r);
  expect(b.error.code).toBe("NOT_FOUND");
});

test("GET /search uses injected cross-source resolver", async () => {
  const handler = createRouteHandler({
    crossSourceResolver: {
      async resolveSearch(query) {
        expect(query).toEqual({ keyword: "t", provider: "qq", limit: 2 });
        return [{ ...routeTrack, provider: "qq", id: "q", sourceId: "q" }];
      },
      async resolveSongUrl() {
        throw new Error("unused");
      }
    }
  });

  const r = await handler(new Request("http://127.0.0.1/search?keyword=t&provider=qq&limit=2"));

  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data[0].provider).toBe("qq");
});

test("GET /weather/radio returns weather radio success envelope", async () => {
  const handler = createRouteHandler({
    weatherRadio: {
      async build(params) {
        expect(params.city).toBe("上海");
        return {
          ok: true,
          weather: {
            provider: "open-meteo",
            location: {
              name: "上海",
              country: "中国",
              admin1: "",
              latitude: 31.23,
              longitude: 121.47,
              timezone: "Asia/Shanghai",
              fallback: false
            },
            label: "雨",
            weatherCode: 61,
            temperature: 22,
            apparentTemperature: 21,
            humidity: 88,
            precipitation: 1,
            cloudCover: 90,
            windSpeed: 6,
            windGusts: 10,
            isDay: 1,
            time: "",
            updatedAt: 1,
            error: "",
            mood: {
              key: "rain",
              title: "雨天电台",
              tagline: "留一点潮湿的空间给旋律",
              energy: 0.38,
              warmth: 0.42,
              focus: 0.64,
              melancholy: 0.66,
              keywords: ["雨天 R&B"]
            }
          },
          radio: {
            title: "雨天电台",
            subtitle: "留一点潮湿的空间给旋律",
            seedQueries: ["陈奕迅 阴天快乐"],
            songs: [routeTrack],
            updatedAt: 1
          }
        };
      }
    }
  });

  const r = await handler(new Request("http://127.0.0.1/weather/radio?city=%E4%B8%8A%E6%B5%B7"));

  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.weather.mood.title).toBe("雨天电台");
  expect(b.data.radio.songs[0].id).toBe("1");
});

test("GET /podcast/search returns mapped podcast radios", async () => {
  const handler = createRouteHandler({
    podcast: {
      async search(params) {
        expect(params).toEqual({ keywords: "故事", limit: 18 });
        return {
          podcasts: [{
            id: "r1",
            rid: "r1",
            name: "故事电台",
            coverUrl: "",
            description: "",
            djName: "",
            category: "",
            programCount: 0,
            subCount: 0
          }],
          total: 1
        };
      }
    }
  });

  const r = await handler(new Request("http://127.0.0.1/podcast/search?keywords=%E6%95%85%E4%BA%8B&limit=18"));

  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.podcasts[0].name).toBe("故事电台");
});

test("GET /podcast/programs returns playable podcast programs", async () => {
  const handler = createRouteHandler({
    podcast: {
      async programs(params) {
        expect(params).toEqual({ rid: "r1", limit: 30, offset: 0 });
        return {
          radio: {
            id: "r1",
            rid: "r1",
            name: "电台",
            coverUrl: "",
            description: "",
            djName: "",
            category: "",
            programCount: 0,
            subCount: 0
          },
          programs: [{
            ...routeTrack,
            type: "podcast",
            programId: "p1",
            radioId: "r1",
            radioName: "电台",
            djName: "",
            description: "",
            createTime: 0,
            serialNum: 0
          }],
          more: false,
          total: 1
        };
      }
    }
  });

  const r = await handler(new Request("http://127.0.0.1/podcast/programs?id=r1"));

  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.data.programs[0].type).toBe("podcast");
  expect(b.data.programs[0].programId).toBe("p1");
});

test("GET /podcast/my and /podcast/my/items preserve logged-out baseline envelopes", async () => {
  const handler = createRouteHandler({
    podcast: {
      async my() {
        return {
          loggedIn: false,
          collections: [{
            key: "collect",
            title: "收藏播客",
            sub: "你收藏的播客",
            itemType: "radio",
            count: 0,
            coverUrl: ""
          }]
        };
      },
      async myItems(params) {
        expect(params.key).toBe("liked");
        return {
          loggedIn: false,
          key: "liked",
          title: "喜欢的声音",
          sub: "收藏或最近喜欢的声音",
          itemType: "voice",
          count: 0,
          coverUrl: "",
          items: []
        };
      }
    }
  });

  const my = await body(await handler(new Request("http://127.0.0.1/podcast/my")));
  expect(my.data.loggedIn).toBe(false);
  expect(my.data.collections[0].key).toBe("collect");

  const items = await body(await handler(new Request("http://127.0.0.1/podcast/my/items?key=liked")));
  expect(items.data.itemType).toBe("voice");
});

test("GET /podcast/dj-beatmap validates url before analyzer call", async () => {
  const handler = createRouteHandler({
    podcast: {
      async djBeatmap(params) {
        expect(params.url).toBe("https://example.com/a.mp3");
        return { ok: true, map: { visualBeatCount: 3 } };
      }
    }
  });

  const bad = await handler(new Request("http://127.0.0.1/podcast/dj-beatmap?url=file:///bad"));
  expect(bad.status).toBe(400);

  const good = await handler(new Request("http://127.0.0.1/podcast/dj-beatmap?url=https%3A%2F%2Fexample.com%2Fa.mp3&duration=30&intro=5"));
  expect(good.status).toBe(200);
  const b = await body(good);
  expect(b.data.map.visualBeatCount).toBe(3);
});

test("GET /providers/netease/login-status returns 200 logged-out when no cookie", async () => {
  const r = await call("/providers/netease/login-status");
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.provider).toBe("netease");
  expect(b.data.loggedIn).toBe(false);
});

test("GET /providers/qq/login-status returns 200 logged-out when no cookie (no network)", async () => {
  const r = await call("/providers/qq/login-status");
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.provider).toBe("qq");
  expect(b.data.loggedIn).toBe(false);
});

test("Netease QR login routes return key image and poll status without exposing cookies", async () => {
  const handler = createRouteHandler({
    neteaseQrLogin: {
      createKey: async () => ({ provider: "netease", key: "qr-key-1" }),
      createImage: async (key: string) => ({
        provider: "netease",
        key,
        img: "data:image/png;base64,abc",
        url: "https://music.163.com/login?codekey=qr-key-1"
      }),
      check: async (key: string) => ({
        provider: "netease",
        key,
        code: 803,
        message: "授权登录成功",
        loggedIn: true,
        stored: true
      })
    }
  });

  const key = await body(await handler(new Request("http://127.0.0.1/providers/netease/login-qr-key")));
  expect(key).toEqual({ ok: true, data: { provider: "netease", key: "qr-key-1" } });

  const image = await body(await handler(new Request("http://127.0.0.1/providers/netease/login-qr-create?key=qr-key-1")));
  expect(image.data.img).toBe("data:image/png;base64,abc");

  const checked = await body(await handler(new Request("http://127.0.0.1/providers/netease/login-qr-check?key=qr-key-1")));
  expect(checked.data).toEqual({
    provider: "netease",
    key: "qr-key-1",
    code: 803,
    message: "授权登录成功",
    loggedIn: true,
    stored: true
  });
  expect(JSON.stringify(checked)).not.toContain("MUSIC_U");
});

test("QQ QR login routes return key image and poll status without exposing cookies", async () => {
  const handler = createRouteHandler({
    qqQrLogin: {
      createKey: async () => ({ provider: "qq", key: "qr_sig_1|1987342677" }),
      createImage: async (key: string) => ({
        provider: "qq",
        key,
        img: "data:image/png;base64,qq"
      }),
      check: async (key: string) => ({
        provider: "qq",
        key,
        code: 0,
        message: "登录成功",
        loggedIn: true,
        scanned: true,
        stored: true
      })
    }
  });

  const key = await body(await handler(new Request("http://127.0.0.1/providers/qq/login-qr-key")));
  expect(key).toEqual({ ok: true, data: { provider: "qq", key: "qr_sig_1|1987342677" } });

  const image = await body(await handler(new Request("http://127.0.0.1/providers/qq/login-qr-create?key=qr_sig_1%7C1987342677")));
  expect(image.data.img).toBe("data:image/png;base64,qq");

  const checked = await body(await handler(new Request("http://127.0.0.1/providers/qq/login-qr-check?key=qr_sig_1%7C1987342677")));
  expect(checked.data).toMatchObject({
    provider: "qq",
    key: "qr_sig_1|1987342677",
    code: 0,
    loggedIn: true,
    stored: true
  });
  expect(JSON.stringify(checked)).not.toContain("qqmusic_key");
  expect(JSON.stringify(checked)).not.toContain("cookie");
});

test("Soda QR login routes return key image and poll status without exposing cookies", async () => {
  const handler = createRouteHandler({
    sodaQrLogin: {
      createImage: async () => ({
        provider: "soda",
        key: "soda-qr-key-1",
        img: "data:image/png;base64,soda"
      }),
      check: async (key: string) => ({
        provider: "soda",
        key,
        code: 803,
        message: "login success",
        loggedIn: true,
        stored: true
      })
    }
  });

  const key = await body(await handler(new Request("http://127.0.0.1/providers/soda/login-qr-key")));
  expect(key).toEqual({ ok: true, data: { provider: "soda", key: "soda-qr-key-1" } });

  const image = await body(await handler(new Request("http://127.0.0.1/providers/soda/login-qr-create")));
  expect(image.data.img).toBe("data:image/png;base64,soda");

  const checked = await body(await handler(new Request("http://127.0.0.1/providers/soda/login-qr-check?key=soda-qr-key-1")));
  expect(checked.data).toMatchObject({
    provider: "soda",
    key: "soda-qr-key-1",
    code: 803,
    loggedIn: true,
    stored: true
  });
});

test("POST /providers/qq/session-cookie stores runtime cookie without echoing secrets", async () => {
  const secret = "uin=123; qqmusic_key=runtime-secret";
  const r = await call("/providers/qq/session-cookie", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cookie: secret })
  });

  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b).toEqual({ ok: true, data: { provider: "qq", stored: true } });
  const serialized = JSON.stringify(b);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("qqmusic_key");

  const status = await body(await call("/providers/qq/login-status"));
  expect(status.data.loggedIn).toBe(true);

  const cleared = await body(await call("/providers/qq/session-cookie", { method: "DELETE" }));
  expect(cleared).toEqual({ ok: true, data: { provider: "qq", stored: false } });
});

test("POST /providers/qq/logout clears runtime cookie before best-effort provider logout", async () => {
  const secret = "uin=123; qqmusic_key=runtime-secret";
  try {
    const fakeQq: ProviderAdapter = {
      ...providers.qq,
      async loginStatus() {
        return { provider: "qq", loggedIn: !!getProviderCookie("qq") };
      },
      async logout() {
        expect(getProviderCookie("qq")).toBe(undefined);
        throw new ProviderNotImplementedError("qq", "no-session");
      }
    };
    const handler = createRouteHandler({
      providerAdapters: { ...providers, qq: fakeQq }
    });
    const localCall = (path: string, init?: RequestInit) =>
      handler(new Request(`http://127.0.0.1${path}`, init));

    await localCall("/providers/qq/session-cookie", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: secret })
    });

    const before = await body(await localCall("/providers/qq/login-status"));
    expect(before.data.loggedIn).toBe(true);

    const logout = await localCall("/providers/qq/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    const logoutBody = await body(logout);
    expect(logoutBody).toEqual({ ok: true, data: { provider: "qq", loggedOut: true } });
    expect(JSON.stringify(logoutBody)).not.toContain(secret);

    const after = await body(await localCall("/providers/qq/login-status"));
    expect(after.data.provider).toBe("qq");
    expect(after.data.loggedIn).toBe(false);

    const secondLogout = await localCall("/providers/qq/logout", { method: "POST" });
    expect(secondLogout.status).toBe(501);
    const secondBody = await body(secondLogout);
    expect(secondBody.error.action).toBe("no-session");
    expect(JSON.stringify(secondBody)).not.toContain(secret);
  } finally {
    await call("/providers/qq/session-cookie", { method: "DELETE" });
  }
});

test("POST /providers/qq/logout clears runtime cookie even when provider logout fails", async () => {
  const secret = "uin=123; qqmusic_key=runtime-secret";
  try {
    await call("/providers/qq/session-cookie", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: secret })
    });
    const fakeQq: ProviderAdapter = {
      ...providers.qq,
      async loginStatus() {
        return { provider: "qq", loggedIn: false };
      },
      async logout() {
        throw new ProviderError("qq", "UPSTREAM_LOGOUT_FAILED", "fake logout failed");
      }
    };
    const handler = createRouteHandler({
      providerAdapters: { ...providers, qq: fakeQq }
    });

    const logout = await handler(new Request("http://127.0.0.1/providers/qq/logout", { method: "POST" }));
    expect(logout.status).toBe(500);
    const logoutBody = await body(logout);
    expect(JSON.stringify(logoutBody)).not.toContain(secret);

    const after = await body(await call("/providers/qq/login-status"));
    expect(after.data.loggedIn).toBe(false);
  } finally {
    await call("/providers/qq/session-cookie", { method: "DELETE" });
  }
});

test("POST /providers/soda/logout uses the saved cookie before clearing it", async () => {
  const secret = "soda_session=runtime-secret";
  try {
    await call("/providers/soda/session-cookie", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: secret })
    });
    const fakeSoda: ProviderAdapter = {
      ...providers.soda,
      async loginStatus() {
        return { provider: "soda", loggedIn: !!getProviderCookie("soda") };
      },
      async logout() {
        const cookie = getProviderCookie("soda");
        if (!cookie) {
          throw new ProviderNotImplementedError("soda", "no-session");
        }
        expect(cookie).toBe(secret);
      }
    };
    const handler = createRouteHandler({
      providerAdapters: { ...providers, soda: fakeSoda }
    });

    const logout = await handler(new Request("http://127.0.0.1/providers/soda/logout", { method: "POST" }));
    expect(logout.status).toBe(200);
    const logoutBody = await body(logout);
    expect(logoutBody).toEqual({ ok: true, data: { provider: "soda", loggedOut: true } });
    expect(JSON.stringify(logoutBody)).not.toContain(secret);

    const after = await body(await call("/providers/soda/login-status"));
    expect(after.data.provider).toBe("soda");
    expect(after.data.loggedIn).toBe(false);

    const secondLogout = await handler(new Request("http://127.0.0.1/providers/soda/logout", { method: "POST" }));
    expect(secondLogout.status).toBe(501);
    const secondBody = await body(secondLogout);
    expect(secondBody.error.action).toBe("no-session");
    expect(JSON.stringify(secondBody)).not.toContain(secret);
  } finally {
    await call("/providers/soda/session-cookie", { method: "DELETE" });
  }
});

test("provider route redacts sensitive raw error messages at response boundary", async () => {
  const sensitiveMessage = ["MUSIC_U", "=", "secret"].join("");
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async search() {
      throw new Error(sensitiveMessage);
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });

  const r = await handler(new Request("http://127.0.0.1/providers/netease/search?keyword=x"));
  expect(r.status).toBe(500);
  const b = await body(r);
  expect(b.ok).toBe(false);
  expect(b.error.code).toBe("INTERNAL");
  expect(b.error.provider).toBe("netease");
  expect(b.error.retryable).toBe(true);
  expect(b.error.message).toBe("provider error redacted");
  const serialized = JSON.stringify(b);
  expect(serialized).not.toContain("MUSIC_U");
  expect(serialized).not.toContain("secret");
});

test("provider route redacts sensitive ProviderError messages while preserving envelope fields", async () => {
  const sensitiveMessage = ["qqmusic_key", "=", "secret"].join("");
  const fakeQq: ProviderAdapter = {
    ...providers.qq,
    async songUrl() {
      throw new ProviderError("qq", "LOGIN_REQUIRED", sensitiveMessage, {
        retryable: true,
        action: "login",
        rawMessage: sensitiveMessage,
        restriction: {
          provider: "qq",
          category: "login_required",
          action: "login",
          message: sensitiveMessage,
          rawMessage: sensitiveMessage
        }
      });
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, qq: fakeQq }
  });

  const r = await handler(
    new Request("http://127.0.0.1/providers/qq/song-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "qq", id: "1", sourceId: "1", title: "t", artists: [] })
    })
  );
  expect(r.status).toBe(500);
  const b = await body(r);
  expect(b.ok).toBe(false);
  expect(b.error.code).toBe("LOGIN_REQUIRED");
  expect(b.error.provider).toBe("qq");
  expect(b.error.retryable).toBe(true);
  expect(b.error.action).toBe("login");
  expect(b.error.message).toBe("provider error redacted");
  expect(b.error.rawMessage).toBe("provider error redacted");
  expect(b.error.restriction.message).toBe("provider error redacted");
  expect(b.error.restriction.rawMessage).toBe("provider error redacted");
  const serialized = JSON.stringify(b);
  expect(serialized).not.toContain("qqmusic_key");
  expect(serialized).not.toContain("secret");
});

test("GET /discover/home returns the logged-out starter envelope", async () => {
  const handler = createRouteHandler({
    providerAdapters: {
      ...providers,
      netease: {
        ...providers.netease,
        async loginStatus() {
          return { provider: "netease", loggedIn: false };
        }
      },
      qq: {
        ...providers.qq,
        async loginStatus() {
          return { provider: "qq", loggedIn: false };
        }
      }
    },
    now: () => 1782656256000
  });

  const r = await handler(new Request("http://127.0.0.1/discover/home"));
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b).toEqual({
    ok: true,
    data: {
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [],
      podcasts: [],
      mode: "starter",
      updatedAt: 1782656256000
    }
  });
});

test("GET /discover/home aggregates logged-in playlists, daily tracks, and podcasts", async () => {
  const calls: string[] = [];
  const handler = createRouteHandler({
    providerAdapters: {
      ...providers,
      netease: {
        ...providers.netease,
        async loginStatus() {
          calls.push("netease:login");
          return { provider: "netease", loggedIn: true, nickname: "tester", userId: "42" };
        },
        async playlistList() {
          calls.push("netease:list");
          return [{
            provider: "netease",
            id: "p1",
            name: "我的歌单",
            coverUrl: "https://img.example/p.jpg",
            trackCount: 2,
            trackIds: ["1", "2"],
            subscribed: false
          }];
        },
        async playlistDetail(id) {
          calls.push(`netease:detail:${id}`);
          return {
            provider: "netease",
            id,
            name: "我的歌单",
            coverUrl: "https://img.example/p.jpg",
            trackCount: 2,
            trackIds: ["1", "2"],
            subscribed: false,
            tracks: [{ ...routeTrack, title: "今日歌曲" }]
          };
        }
      },
      qq: {
        ...providers.qq,
        async loginStatus() {
          calls.push("qq:login");
          return { provider: "qq", loggedIn: false };
        }
      }
    },
    podcast: {
      async hot() {
        calls.push("podcast:hot");
        return {
          podcasts: [{
            id: "r1",
            rid: "r1",
            name: "热门播客",
            coverUrl: "",
            description: "",
            djName: "DJ",
            category: "音乐",
            programCount: 5,
            subCount: 0
          }],
          more: false
        };
      }
    },
    now: () => 1782656256000
  });

  const r = await handler(new Request("http://127.0.0.1/discover/home"));
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.loggedIn).toBe(true);
  expect(b.data.mode).toBe("member");
  expect(b.data.user).toEqual({ provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" });
  expect(b.data.dailySongs[0].title).toBe("今日歌曲");
  expect(b.data.playlists[0].name).toBe("我的歌单");
  expect(b.data.podcasts[0].name).toBe("热门播客");
  expect(calls).toContain("netease:detail:p1");
});

test("GET /discover/home uses the baseline Netease recommendation sources", async () => {
  const calls: string[] = [];
  const handler = createRouteHandler({
    providerAdapters: {
      ...providers,
      netease: {
        ...providers.netease,
        async loginStatus() {
          return { provider: "netease", loggedIn: true, nickname: "tester", userId: "42" };
        },
        async playlistList() {
          calls.push("adapter:list");
          return [];
        },
        async search() {
          calls.push("adapter:search");
          return [];
        }
      },
      qq: {
        ...providers.qq,
        async loginStatus() {
          return { provider: "qq", loggedIn: false };
        }
      }
    },
    discoverRequester: {
      async personalized() {
        calls.push("personalized");
        return {
          body: {
            result: [{
              id: 7001,
              name: "公开推荐歌单",
              picUrl: "https://img.example/public.jpg",
              trackCount: 24,
              playCount: 1024,
              creator: { nickname: "DJ" }
            }]
          }
        };
      },
      async djHot() {
        calls.push("dj_hot");
        return {
          body: {
            djRadios: [{
              id: 8001,
              name: "热门播客",
              picUrl: "https://img.example/radio.jpg",
              dj: { nickname: "主播" },
              category: "音乐",
              programCount: 12,
              subCount: 9
            }]
          }
        };
      },
      async recommendResource() {
        calls.push("recommend_resource");
        return {
          body: {
            recommend: [{
              id: 7002,
              name: "私人推荐歌单",
              coverImgUrl: "https://img.example/private.jpg",
              trackCount: 8
            }]
          }
        };
      },
      async recommendSongs() {
        calls.push("recommend_songs");
        return {
          body: {
            data: {
              dailySongs: [{
                id: 9001,
                name: "今日推荐歌曲",
                ar: [{ id: 1, name: "Alice" }],
                al: { name: "专辑", picUrl: "https://img.example/song.jpg" },
                dt: 210000,
                fee: 0
              }]
            }
          }
        };
      }
    },
    now: () => 1782656256000
  });

  const r = await handler(new Request("http://127.0.0.1/discover/home"));
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.data.dailySongs[0]).toMatchObject({
    provider: "netease",
    id: "9001",
    title: "今日推荐歌曲",
    artists: ["Alice"],
    album: "专辑",
    coverUrl: "https://img.example/song.jpg",
    durationMs: 210000
  });
  expect(b.data.playlists.map((playlist: { name: string }) => playlist.name)).toEqual([
    "私人推荐歌单",
    "公开推荐歌单"
  ]);
  expect(b.data.podcasts[0]).toMatchObject({
    id: "8001",
    rid: "8001",
    name: "热门播客",
    coverUrl: "https://img.example/radio.jpg",
    djName: "主播"
  });
  expect(calls).toEqual([
    "personalized",
    "dj_hot",
    "recommend_resource",
    "recommend_songs"
  ]);
});

test("GET /discover/home falls back to provider search when playlist detail has no daily tracks", async () => {
  const handler = createRouteHandler({
    providerAdapters: {
      ...providers,
      netease: {
        ...providers.netease,
        async loginStatus() {
          return { provider: "netease", loggedIn: true, nickname: "tester", userId: "42" };
        },
        async playlistList() {
          return [{
            provider: "netease",
            id: "p1",
            name: "空歌单",
            coverUrl: "",
            trackCount: 0,
            trackIds: [],
            subscribed: false
          }];
        },
        async playlistDetail(id) {
          return {
            provider: "netease",
            id,
            name: "空歌单",
            coverUrl: "",
            trackCount: 0,
            trackIds: [],
            subscribed: false,
            tracks: []
          };
        },
        async search(query) {
          expect(query).toEqual({ keyword: "每日推荐", limit: 12 });
          return [{ ...routeTrack, title: "搜索补位日推" }];
        }
      },
      qq: {
        ...providers.qq,
        async loginStatus() {
          return { provider: "qq", loggedIn: false };
        }
      }
    },
    podcast: {
      async hot() {
        return { podcasts: [], more: false };
      }
    },
    now: () => 1782656256000
  });

  const r = await handler(new Request("http://127.0.0.1/discover/home"));
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.data.dailySongs[0].title).toBe("搜索补位日推");
});

test("provider route does not serialize extra ProviderError restriction fields", async () => {
  const fakeQq: ProviderAdapter = {
    ...providers.qq,
    async songUrl() {
      throw new ProviderError("qq", "LOGIN_REQUIRED", "login required", {
        retryable: true,
        action: "login",
        restriction: {
          provider: "qq",
          category: "login_required",
          action: "login",
          message: "login required",
          internalCookie: "qqmusic_key=secret"
        } as any
      });
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, qq: fakeQq }
  });

  const r = await handler(
    new Request("http://127.0.0.1/providers/qq/song-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "qq", id: "1", sourceId: "1", title: "t", artists: [] })
    })
  );

  const b = await body(r);
  expect(b.error.restriction).toEqual({
    provider: "qq",
    category: "login_required",
    action: "login",
    message: "login required"
  });
  const serialized = JSON.stringify(b);
  expect(serialized).not.toContain("internalCookie");
  expect(serialized).not.toContain("qqmusic_key");
  expect(serialized).not.toContain("secret");
});

test("provider route redacts sensitive ProviderError tried entries", async () => {
  const fakeQq: ProviderAdapter = {
    ...providers.qq,
    async songUrl() {
      throw new ProviderError("qq", "NO_URL", "no url", {
        tried: ["standard", "Bearer secret-token", "qqmusic_key=secret"]
      });
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, qq: fakeQq }
  });

  const r = await handler(
    new Request("http://127.0.0.1/providers/qq/song-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "qq", id: "1", sourceId: "1", title: "t", artists: [] })
    })
  );

  const b = await body(r);
  expect(b.error.tried).toEqual(["standard", "provider error redacted", "provider error redacted"]);
  const serialized = JSON.stringify(b);
  expect(serialized).not.toContain("secret-token");
  expect(serialized).not.toContain("qqmusic_key");
  expect(serialized).not.toContain("secret");
});

test("POST /providers/netease/session-cookie/clear clears runtime cookie without exposing it", async () => {
  const secret = "MUSIC_U=runtime-secret";
  const stored = await call("/providers/netease/session-cookie", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cookie: secret })
  });
  expect(stored.status).toBe(200);

  const r = await call("/providers/netease/session-cookie/clear", { method: "POST" });
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b).toEqual({ ok: true, data: { provider: "netease", stored: false } });
  expect(JSON.stringify(b)).not.toContain(secret);
  expect(JSON.stringify(await body(await call("/diagnostics")))).not.toContain(secret);
});

test("POST /providers/netease/song-url without body returns 400 BAD_REQUEST", async () => {
  const r = await call("/providers/netease/song-url", { method: "POST" });
  expect(r.status).toBe(400);
  const b = await body(r);
  expect(b.error.code).toBe("BAD_REQUEST");
});

test("POST /providers/netease/song-url invalid JSON returns 400", async () => {
  const r = await call("/providers/netease/song-url", {
    method: "POST",
    body: "not-json"
  });
  expect(r.status).toBe(400);
});

test("POST /song-url without body returns 400 BAD_REQUEST", async () => {
  const r = await call("/song-url", { method: "POST" });
  expect(r.status).toBe(400);
  const b = await body(r);
  expect(b.error.code).toBe("BAD_REQUEST");
});

test("POST /song-url invalid Track body returns 400 BAD_REQUEST", async () => {
  const r = await call("/song-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "missing required fields" })
  });
  expect(r.status).toBe(400);
  const b = await body(r);
  expect(b.error.code).toBe("BAD_REQUEST");
});

test("POST /song-url uses injected cross-source resolver", async () => {
  const handler = createRouteHandler({
    crossSourceResolver: {
      async resolveSearch() {
        throw new Error("unused");
      },
      async resolveSongUrl(track, opts) {
        expect(track).toEqual(routeTrack);
        expect(opts?.quality).toBe("lossless");
        return { url: "https://example.test/t.mp3", proxied: false, requestedQuality: opts?.quality ?? null };
      }
    }
  });

  const r = await handler(
    new Request("http://127.0.0.1/song-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ track: routeTrack, quality: "lossless" })
    })
  );

  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.url).toBe("https://example.test/t.mp3");
  expect(b.data.requestedQuality).toBe("lossless");
});

test("POST /providers/netease/song-url valid body calls adapter (not 501 NOT_IMPLEMENTED)", async () => {
  const calls: unknown[] = [];
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async songUrl(track, opts) {
      calls.push({ track, opts });
      return {
        url: "https://media.example.test/netease.mp3",
        proxied: false,
        requestedQuality: opts?.quality ?? null
      };
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });

  const r = await handler(new Request("http://127.0.0.1/providers/netease/song-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "netease",
      id: "1",
      sourceId: "1",
      title: "t",
      artists: []
    })
  }));

  expect(r.status).toBe(200);
  expect(calls).toEqual([{
    track: {
      provider: "netease",
      id: "1",
      sourceId: "1",
      title: "t",
      artists: [],
      album: "",
      coverUrl: "",
      playableState: "unknown",
      qualityHints: []
    },
    opts: { quality: undefined }
  }]);
  expect(await body(r)).toEqual({
    ok: true,
    data: {
      url: "https://media.example.test/netease.mp3",
      proxied: false,
      requestedQuality: null
    }
  });
});

test("POST /providers/netease/lyric valid body returns lyric payload (not 501 NOT_IMPLEMENTED)", async () => {
  const calls: unknown[] = [];
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async lyric(track) {
      calls.push(track);
      return {
        provider: "netease",
        trackId: track.id,
        lines: [{ timeMs: 0, text: "测试歌词", durationMs: 4800, charCount: 4 }],
        hasTranslation: false,
        isWordByWord: false
      };
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });

  const r = await handler(new Request("http://127.0.0.1/providers/netease/lyric", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "netease",
      id: "1",
      sourceId: "1",
      title: "t",
      artists: []
    })
  }));

  expect(r.status).toBe(200);
  expect(calls).toEqual([{
    provider: "netease",
    id: "1",
    sourceId: "1",
    title: "t",
    artists: [],
    album: "",
    coverUrl: "",
    qualityHints: [],
    playableState: "unknown"
  }]);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data).toEqual({
    provider: "netease",
    trackId: "1",
    lines: [{ timeMs: 0, text: "测试歌词", durationMs: 4800, charCount: 4 }],
    hasTranslation: false,
    isWordByWord: false
  });
});

test("POST /providers/netease/lyric invalid Track body returns 400 BAD_REQUEST", async () => {
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async lyric() {
      throw new Error("lyric adapter should not run for invalid Track body");
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });

  const r = await handler(new Request("http://127.0.0.1/providers/netease/lyric", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "missing provider and id" })
  }));

  expect(r.status).toBe(400);
  const b = await body(r);
  expect(b.ok).toBe(false);
  expect(b.error.code).toBe("BAD_REQUEST");
  expect(b.error.provider).toBe("netease");
});

test("POST /providers/qq/logout returns 501 action no-session when no cookie", async () => {
  const r = await call("/providers/qq/logout", { method: "POST" });
  expect(r.status).toBe(501);
  const b = await body(r);
  expect(b.error.action).toBe("no-session");
  expect(b.error.provider).toBe("qq");
});

test("GET /providers/netease/playlists calls adapter and returns playlist summaries", async () => {
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async playlistList() {
      return [
        {
          provider: "netease",
          id: "p1",
          name: "我的歌单",
          coverUrl: "http://cover",
          trackCount: 2,
          trackIds: ["1", "2"],
          subscribed: false
        }
      ];
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });
  const r = await handler(new Request("http://127.0.0.1/providers/netease/playlists"));
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data[0].id).toBe("p1");
  expect(b.data[0].trackIds).toEqual(["1", "2"]);
});

test("GET /providers/netease/playlists/123 calls adapter (not 501 NOT_IMPLEMENTED)", async () => {
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async playlistDetail(id) {
      expect(id).toBe("123");
      throw new ProviderError("netease", "UNAVAILABLE", "fake playlist unavailable");
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });
  const r = await handler(new Request("http://127.0.0.1/providers/netease/playlists/123"));
  expect(r.status).not.toBe(501);
});

test("POST /providers/netease/like validates body and calls adapter", async () => {
  const calls: unknown[] = [];
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async likeSong(id, liked) {
      calls.push({ id, liked });
      return { provider: "netease", id, liked, code: 200 };
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });

  const r = await handler(new Request("http://127.0.0.1/providers/netease/like", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "100", liked: true })
  }));

  expect(r.status).toBe(200);
  expect(calls).toEqual([{ id: "100", liked: true }]);
  expect(await body(r)).toEqual({ ok: true, data: { provider: "netease", id: "100", liked: true, code: 200 } });
});

test("GET /providers/netease/like-check validates ids and calls adapter", async () => {
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async checkSongLikes(ids) {
      expect(ids).toEqual(["100", "200"]);
      return { provider: "netease", ids, liked: { "100": true, "200": false } };
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });

  const r = await handler(new Request("http://127.0.0.1/providers/netease/like-check?ids=100,200"));

  expect(r.status).toBe(200);
  expect(await body(r)).toEqual({
    ok: true,
    data: { provider: "netease", ids: ["100", "200"], liked: { "100": true, "200": false } }
  });
});

test("POST /providers/netease/playlists/add-song validates body and calls adapter", async () => {
  const calls: unknown[] = [];
  const fakeNetease: ProviderAdapter = {
    ...providers.netease,
    async addSongToPlaylist(playlistId, trackId) {
      calls.push({ playlistId, trackId });
      return { provider: "netease", playlistId, trackId, success: true, code: 200 };
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, netease: fakeNetease }
  });

  const r = await handler(new Request("http://127.0.0.1/providers/netease/playlists/add-song", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playlistId: "p1", trackId: "100" })
  }));

  expect(r.status).toBe(200);
  expect(calls).toEqual([{ playlistId: "p1", trackId: "100" }]);
  expect(await body(r)).toEqual({
    ok: true,
    data: { provider: "netease", playlistId: "p1", trackId: "100", success: true, code: 200 }
  });
});

test("POST /providers/qq/playlists/add-song validates body and calls adapter", async () => {
  const calls: unknown[] = [];
  const fakeQq: ProviderAdapter = {
    ...providers.qq,
    async addSongToPlaylist(playlistId, trackId) {
      calls.push({ playlistId, trackId });
      return { provider: "qq", playlistId, trackId, success: true, code: 100 };
    }
  };
  const handler = createRouteHandler({
    providerAdapters: { ...providers, qq: fakeQq }
  });

  const r = await handler(new Request("http://127.0.0.1/providers/qq/playlists/add-song", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playlistId: "201", trackId: "002Zkt5S2oAB7X" })
  }));

  expect(r.status).toBe(200);
  expect(calls).toEqual([{ playlistId: "201", trackId: "002Zkt5S2oAB7X" }]);
  expect(await body(r)).toEqual({
    ok: true,
    data: { provider: "qq", playlistId: "201", trackId: "002Zkt5S2oAB7X", success: true, code: 100 }
  });
});

test("POST /providers/netease/login-status (method mismatch) returns 404", async () => {
  const r = await call("/providers/netease/login-status", { method: "POST" });
  expect(r.status).toBe(404);
});

test("GET /providers/capabilities returns 200 matrix with netease, qq, and soda", async () => {
  const r = await call("/providers/capabilities");
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.providers.length).toBe(3);
  const netease = b.data.providers.find((e: { providerId: string }) => e.providerId === "netease");
  const qq = b.data.providers.find((e: { providerId: string }) => e.providerId === "qq");
  const soda = b.data.providers.find((e: { providerId: string }) => e.providerId === "soda");
  expect(netease.available).toBe(true);
  expect(qq.available).toBe(true);
  expect(soda.available).toBe(true);
});

test("GET /diagnostics returns 200 and contains none of the forbidden cookie/auth keys", async () => {
  const r = await call("/diagnostics");
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(Array.isArray(b.recentErrors)).toBe(true);
  const serialized = JSON.stringify(b);
  for (const key of ["cookie", "MUSIC_U", "qm_keyst", "qqmusic_key", "wxskey"]) {
    expect(serialized).not.toContain(key);
  }
});

test("GET /audio-proxy without url returns 400 BAD_REQUEST", async () => {
  const r = await call("/audio-proxy");
  expect(r.status).toBe(400);
  const b = await body(r);
  expect(b.error.code).toBe("BAD_REQUEST");
  expect(b.error.retryable).toBe(false);
});

test("GET /audio-proxy returns injected proxy response directly", async () => {
  const handler = createRouteHandler({
    audioProxy: async ({ target, request }) => {
      expect(target).toBe("https://media.example.test/song.mp3");
      expect(request.headers.get("range")).toBe("bytes=0-3");
      return new Response("song", {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "access-control-allow-origin": "*"
        }
      });
    }
  });

  const r = await handler(
    new Request("http://127.0.0.1/audio-proxy?url=https%3A%2F%2Fmedia.example.test%2Fsong.mp3", {
      headers: { range: "bytes=0-3" }
    })
  );

  expect(r.status).toBe(206);
  expect(r.headers.get("content-type")).toBe("audio/mpeg");
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  expect(await r.text()).toBe("song");
});

test("GET /providers/soda/audio-proxy returns injected soda proxy response directly", async () => {
  const handler = createRouteHandler({
    sodaAudioProxy: async ({ target, playAuth, request }) => {
      expect(target).toBe("https://media.example.test/soda.m4a");
      expect(playAuth).toBe("play-auth-1");
      expect(request.method).toBe("GET");
      return new Response("soda-song", {
        status: 200,
        headers: {
          "content-type": "audio/mp4",
          "access-control-allow-origin": "*"
        }
      });
    }
  });

  const r = await handler(
    new Request("http://127.0.0.1/providers/soda/audio-proxy?url=https%3A%2F%2Fmedia.example.test%2Fsoda.m4a&playAuth=play-auth-1")
  );

  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("audio/mp4");
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  expect(await r.text()).toBe("soda-song");
});

test("GET /image-proxy returns injected proxy response directly", async () => {
  const handler = createRouteHandler({
    imageProxy: async ({ target, request }) => {
      expect(target).toBe("https://img.example.test/cover.jpg");
      expect(request.headers.get("cookie")).toBe("session=secret");
      return new Response("cover", {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "access-control-allow-origin": "*"
        }
      });
    }
  });

  const r = await handler(
    new Request("http://127.0.0.1/image-proxy?url=https%3A%2F%2Fimg.example.test%2Fcover.jpg", {
      headers: { cookie: "session=secret" }
    })
  );

  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/jpeg");
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  expect(await r.text()).toBe("cover");
});

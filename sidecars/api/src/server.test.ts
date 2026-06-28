import { expect, test } from "bun:test";
import { routeHandler, createRouteHandler } from "./server";
import type { Track } from "@mineradio/shared";
import { providers } from "./providers/registry";
import { ProviderError, type ProviderAdapter } from "./providers/provider-adapter";
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
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.providers).toEqual(["netease", "qq"]);
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
    await call("/providers/qq/session-cookie", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: secret })
    });

    const before = await body(await call("/providers/qq/login-status"));
    expect(before.data.loggedIn).toBe(true);

    const logout = await call("/providers/qq/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    const logoutBody = await body(logout);
    expect(logoutBody).toEqual({ ok: true, data: { provider: "qq", loggedOut: true } });
    expect(JSON.stringify(logoutBody)).not.toContain(secret);

    const after = await body(await call("/providers/qq/login-status"));
    expect(after.data.provider).toBe("qq");
    expect(after.data.loggedIn).toBe(false);

    const secondLogout = await call("/providers/qq/logout", { method: "POST" });
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
        action: "login"
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
  const serialized = JSON.stringify(b);
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
  const r = await call("/providers/netease/song-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "netease",
      id: "1",
      sourceId: "1",
      title: "t",
      artists: []
    })
  });
  expect(r.status).not.toBe(501);
  if (r.status === 200) {
    const b = await body(r);
    expect(b.ok).toBe(true);
    expect(typeof b.data.url).toBe("string");
  } else {
    const b = await body(r);
    expect(b.ok).toBe(false);
    expect(b.error.provider).toBe("netease");
  }
});

test("POST /providers/netease/lyric valid body returns lyric payload (not 501 NOT_IMPLEMENTED)", async () => {
  const r = await call("/providers/netease/lyric", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "netease",
      id: "1",
      sourceId: "1",
      title: "t",
      artists: []
    })
  });
  expect(r.status).not.toBe(501);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.lines).toBeDefined();
});

test("POST /providers/qq/logout returns 501 action no-session when no cookie", async () => {
  const r = await call("/providers/qq/logout", { method: "POST" });
  expect(r.status).toBe(501);
  const b = await body(r);
  expect(b.error.action).toBe("no-session");
  expect(b.error.provider).toBe("qq");
});

test("GET /providers/netease/playlists returns 501 NOT_IMPLEMENTED", async () => {
  const r = await call("/providers/netease/playlists");
  expect(r.status).toBe(501);
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

test("POST /providers/netease/login-status (method mismatch) returns 404", async () => {
  const r = await call("/providers/netease/login-status", { method: "POST" });
  expect(r.status).toBe(404);
});

test("GET /providers/capabilities returns 200 matrix with both netease and qq online (post-A6)", async () => {
  const r = await call("/providers/capabilities");
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b.ok).toBe(true);
  expect(b.data.providers.length).toBe(2);
  const netease = b.data.providers.find((e: { providerId: string }) => e.providerId === "netease");
  const qq = b.data.providers.find((e: { providerId: string }) => e.providerId === "qq");
  expect(netease.available).toBe(true);
  expect(qq.available).toBe(true);
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

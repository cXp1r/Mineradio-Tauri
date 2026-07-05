import { expect, test } from "bun:test";
import { createAudioProxy, resolveAudioProxy } from "./audio-proxy";

async function jsonBody(response: Response): Promise<any> {
  return await response.json();
}

test("audio proxy returns BAD_REQUEST envelope when url is missing or blank", async () => {
  for (const target of ["", "   "]) {
    const response = await resolveAudioProxy({
      target,
      request: new Request("http://127.0.0.1/audio-proxy")
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await jsonBody(response);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.retryable).toBe(false);
  }
});

test("audio proxy rejects invalid and non-http URLs", async () => {
  for (const target of ["not-a-url", "file:///C:/music.mp3", "ftp://example.test/a.mp3"]) {
    const response = await resolveAudioProxy({
      target,
      request: new Request("http://127.0.0.1/audio-proxy")
    });

    expect(response.status).toBe(400);
    const body = await jsonBody(response);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.retryable).toBe(false);
  }
});

test("audio proxy streams upstream body and forwards only safe playback request headers", async () => {
  let upstreamRequest: Request | undefined;
  const service = createAudioProxy({
    fetch: async (request) => {
      upstreamRequest = request;
      return new Response("audio-bytes", {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": "11",
          "accept-ranges": "bytes",
          "content-range": "bytes 0-10/100",
          "cache-control": "public, max-age=60",
          etag: '"abc"',
          "last-modified": "Sat, 27 Jun 2026 00:00:00 GMT",
          "set-cookie": "secret=1",
          "x-private": "hidden"
        }
      });
    }
  });

  const response = await service({
    target: "https://media.example.test/song.mp3",
    request: new Request("http://127.0.0.1/audio-proxy", {
      headers: {
        range: "bytes=0-10",
        cookie: "session=secret",
        authorization: "Bearer secret",
        "user-agent": "unit-test"
      }
    })
  });

  expect(response.status).toBe(206);
  expect(await response.text()).toBe("audio-bytes");
  expect(upstreamRequest?.url).toBe("https://media.example.test/song.mp3");
  expect(upstreamRequest?.headers.get("range")).toBe("bytes=0-10");
  expect(upstreamRequest?.headers.get("cookie")).toBe(null);
  expect(upstreamRequest?.headers.get("authorization")).toBe(null);
  expect(upstreamRequest?.headers.get("user-agent")).toBe(null);
  expect(response.headers.get("content-type")).toBe("audio/mpeg");
  expect(response.headers.get("content-length")).toBe("11");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(response.headers.get("content-range")).toBe("bytes 0-10/100");
  expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  expect(response.headers.get("etag")).toBe('"abc"');
  expect(response.headers.get("last-modified")).toBe("Sat, 27 Jun 2026 00:00:00 GMT");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("set-cookie")).toBe(null);
  expect(response.headers.get("x-private")).toBe(null);
});

test("audio proxy converts network failure to retryable 502 envelope", async () => {
  const service = createAudioProxy({
    fetch: async () => {
      throw new Error("network down");
    }
  });

  const response = await service({
    target: "https://media.example.test/song.mp3",
    request: new Request("http://127.0.0.1/audio-proxy")
  });

  expect(response.status).toBe(502);
  const body = await jsonBody(response);
  expect(body.error.code).toBe("UPSTREAM_AUDIO_PROXY");
  expect(body.error.retryable).toBe(true);
});

test("audio proxy converts upstream non-ok status to retryable 502 envelope", async () => {
  const logs: Record<string, unknown>[] = [];
  const service = createAudioProxy({
    fetch: async () => new Response("not playable", { status: 403 }),
    log: async (entry) => {
      logs.push(entry);
    }
  });

  const response = await service({
    target: "https://media.example.test/song.mp3?token=secret-token",
    request: new Request("http://127.0.0.1/audio-proxy")
  });

  expect(response.status).toBe(502);
  const body = await jsonBody(response);
  expect(body.error.code).toBe("UPSTREAM_AUDIO_PROXY");
  expect(body.error.retryable).toBe(true);
  expect(body.error.message).toContain("403");
  expect(logs).toEqual([{
    event: "audio-proxy-upstream-failure",
    upstreamStatus: 403
  }]);
  expect(JSON.stringify(logs)).not.toContain("secret-token");
});

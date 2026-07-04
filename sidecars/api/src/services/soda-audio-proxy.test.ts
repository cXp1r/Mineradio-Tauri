import { expect, test } from "bun:test";
import { createSodaAudioProxy } from "./soda-audio-proxy";

async function jsonBody(response: Response): Promise<any> {
  return await response.json();
}

test("soda audio proxy rejects missing playAuth", async () => {
  const service = createSodaAudioProxy({
    fetch: async () => new Response("unused"),
    decrypt: async () => ({ data: new Uint8Array(), decrypted: true, reason: "decrypted" })
  });

  const response = await service({
    target: "https://media.example.test/song.m4a",
    request: new Request("http://127.0.0.1/providers/soda/audio-proxy")
  });

  expect(response.status).toBe(400);
  const body = await jsonBody(response);
  expect(body.error.code).toBe("BAD_REQUEST");
  expect(body.error.message).toBe("playAuth required");
});

test("soda audio proxy caches the decrypted bytes after the first request", async () => {
  const fetchCalls: string[] = [];
  const decryptCalls: string[] = [];
  const service = createSodaAudioProxy({
    fetch: async (request) => {
      fetchCalls.push(request.url);
      return new Response("upstream-bytes", {
        status: 200,
        headers: { "content-type": "audio/mp4" }
      });
    },
    decrypt: async (_bytes, playAuth) => {
      decryptCalls.push(playAuth);
      return {
        data: new TextEncoder().encode("abcdefghij"),
        decrypted: true,
        reason: "decrypted"
      };
    }
  });

  const target = "https://media.example.test/cache-song.m4a";
  const playAuth = "play-auth-cache";

  const first = await service({
    target,
    playAuth,
    request: new Request("http://127.0.0.1/providers/soda/audio-proxy")
  });
  expect(first.status).toBe(200);
  expect(await first.text()).toBe("abcdefghij");

  const second = await service({
    target,
    playAuth,
    request: new Request("http://127.0.0.1/providers/soda/audio-proxy")
  });
  expect(second.status).toBe(200);
  expect(await second.text()).toBe("abcdefghij");

  expect(fetchCalls).toEqual([target]);
  expect(decryptCalls).toEqual([playAuth]);
  expect(second.headers.get("x-soda-audio-cache")).toBe("hit");
  expect(second.headers.get("accept-ranges")).toBe("bytes");
});

test("soda audio proxy serves range requests from the cached decrypted bytes", async () => {
  const fetchCalls: string[] = [];
  const service = createSodaAudioProxy({
    fetch: async (request) => {
      fetchCalls.push(request.url);
      return new Response("upstream-bytes", {
        status: 200,
        headers: { "content-type": "audio/mp4" }
      });
    },
    decrypt: async () => ({
      data: new TextEncoder().encode("abcdefghij"),
      decrypted: true,
      reason: "decrypted"
    })
  });

  const target = "https://media.example.test/range-song.m4a";
  const playAuth = "play-auth-range";

  const warmup = await service({
    target,
    playAuth,
    request: new Request("http://127.0.0.1/providers/soda/audio-proxy")
  });
  expect(warmup.status).toBe(200);

  const ranged = await service({
    target,
    playAuth,
    request: new Request("http://127.0.0.1/providers/soda/audio-proxy", {
      headers: { range: "bytes=2-5" }
    })
  });

  expect(ranged.status).toBe(206);
  expect(await ranged.text()).toBe("cdef");
  expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(ranged.headers.get("content-length")).toBe("4");
  expect(ranged.headers.get("accept-ranges")).toBe("bytes");
  expect(ranged.headers.get("x-soda-audio-cache")).toBe("hit");
  expect(fetchCalls).toEqual([target]);
});

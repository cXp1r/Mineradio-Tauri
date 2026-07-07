import { expect, test } from "bun:test";
import { __decodeSodaSpadeBytesForTest, decryptSodaAudioData, createSodaAudioProxy } from "./soda-audio-proxy";

async function jsonBody(response: Response): Promise<any> {
  return await response.json();
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function u32(value: number): Uint8Array {
  return bytes(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  );
}

function u16(value: number): Uint8Array {
  return bytes((value >>> 8) & 0xff, value & 0xff);
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function mp4Box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const data = concat(...payload);
  return concat(u32(data.length + 8), ascii(type), data);
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

test("Soda Spade byte decoding wraps underflow with byte modulo 256", () => {
  const decoded = __decodeSodaSpadeBytesForTest(bytes(0xee));

  expect(decoded[0]).toBe(0xff);
});

test("decryptSodaAudioData rejects subsample-encrypted samples instead of decrypting them as full samples", async () => {
  const playAuth = "AHBg";
  const senc = mp4Box(
    "senc",
    u32(0x00000002),
    u32(1),
    bytes(0, 1, 2, 3, 4, 5, 6, 7),
    u16(1),
    u16(0),
    u32(4)
  );
  const stsz = mp4Box("stsz", u32(0), u32(1), u32(4));
  const stbl = mp4Box("stbl", stsz);
  const minf = mp4Box("minf", stbl);
  const mdia = mp4Box("mdia", minf);
  const trak = mp4Box("trak", mdia);
  const moov = mp4Box("moov", senc, trak);
  const fileData = concat(moov, mp4Box("mdat", bytes(1, 2, 3, 4)));
  const result = await decryptSodaAudioData(fileData, playAuth);

  expect(result).toEqual({
    data: fileData,
    decrypted: false,
    reason: "soda audio subsample encryption is not supported"
  });
});

test("decryptSodaAudioData rejects mismatched sample sizes instead of reporting encrypted mdat as decrypted", async () => {
  const playAuth = "AHBg";
  const senc = mp4Box("senc", u32(0), u32(0));
  const stsz = mp4Box("stsz", u32(0), u32(1), u32(4));
  const stbl = mp4Box("stbl", stsz);
  const minf = mp4Box("minf", stbl);
  const mdia = mp4Box("mdia", minf);
  const trak = mp4Box("trak", mdia);
  const moov = mp4Box("moov", senc, trak);
  const mdat = mp4Box("mdat", bytes(1, 2, 3, 4, 5));
  const fileData = concat(moov, mdat);
  const result = await decryptSodaAudioData(fileData, playAuth);

  expect(result).toEqual({
    data: fileData,
    decrypted: false,
    reason: "sample size table does not match mdat payload"
  });
});

test("decryptSodaAudioData rejects mismatched fixed sample sizes before allocating sample entries", async () => {
  const playAuth = "AHBg";
  const senc = mp4Box("senc", u32(0), u32(0));
  const stsz = mp4Box("stsz", u32(0), u32(1), u32(5));
  const stbl = mp4Box("stbl", stsz);
  const minf = mp4Box("minf", stbl);
  const mdia = mp4Box("mdia", minf);
  const trak = mp4Box("trak", mdia);
  const moov = mp4Box("moov", senc, trak);
  const mdat = mp4Box("mdat", bytes(1, 2, 3, 4));
  const fileData = concat(moov, mdat);
  const result = await decryptSodaAudioData(fileData, playAuth);

  expect(result).toEqual({
    data: fileData,
    decrypted: false,
    reason: "sample size table does not match mdat payload"
  });
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

test("soda audio proxy evicts old decrypted entries when cache entry limit is reached", async () => {
  const fetchCalls: string[] = [];
  const service = createSodaAudioProxy({
    maxCacheEntries: 1,
    fetch: async (request) => {
      fetchCalls.push(request.url);
      return new Response(`upstream:${request.url}`, {
        status: 200,
        headers: { "content-type": "audio/mp4" }
      });
    },
    decrypt: async (bytes) => ({
      data: bytes,
      decrypted: true,
      reason: "decrypted"
    })
  });

  const firstTarget = "https://media.example.test/first.m4a";
  const secondTarget = "https://media.example.test/second.m4a";
  const request = new Request("http://127.0.0.1/providers/soda/audio-proxy");

  expect((await service({ target: firstTarget, playAuth: "auth-1", request })).status).toBe(200);
  expect((await service({ target: secondTarget, playAuth: "auth-2", request })).status).toBe(200);
  expect((await service({ target: firstTarget, playAuth: "auth-1", request })).status).toBe(200);

  expect(fetchCalls).toEqual([firstTarget, secondTarget, firstTarget]);
});

import { fail, json } from "../http/envelope";

export type SodaAudioProxyRequest = {
  target: string;
  request: Request;
};

export type SodaAudioProxy = (input: SodaAudioProxyRequest) => Promise<Response>;

export type SodaAudioProxyDeps = {
  fetch?: (request: Request) => Promise<Response>;
};

type Mp4Box = {
  offset: number;
  size: number;
  data: Uint8Array;
};

const audioAuthByUrl = new Map<string, string>();
const ENCA_BYTES = new TextEncoder().encode("enca");
const MP4A_BYTES = new TextEncoder().encode("mp4a");
const SPADE_PREFIX = new Uint8Array([0xfa, 0x55]);

export function registerSodaAudioAuth(url: string, playAuth: string): void {
  const parsed = parseTargetUrl(url);
  const target = parsed.ok ? parsed.url : url.trim();
  const auth = playAuth.trim();
  if (!target || !auth) return;
  audioAuthByUrl.set(target, auth);
}

export function createSodaAudioProxy(deps: SodaAudioProxyDeps = {}): SodaAudioProxy {
  const fetcher = deps.fetch ?? fetch;

  return async function proxySodaAudio(input: SodaAudioProxyRequest): Promise<Response> {
    const parsed = parseTargetUrl(input.target);
    if (!parsed.ok) return badRequest(parsed.message);

    const playAuth = audioAuthByUrl.get(parsed.url);
    if (!playAuth) return upstreamFailure("soda audio auth missing");

    let upstream: Response;
    try {
      upstream = await fetcher(new Request(parsed.url, { method: "GET" }));
    } catch {
      return upstreamFailure("soda audio request failed");
    }
    if (!upstream.ok) {
      return upstreamFailure(`soda audio request returned ${upstream.status}`);
    }

    let decrypted: DecryptDataResult;
    try {
      decrypted = await decryptSodaAudioData(new Uint8Array(await upstream.arrayBuffer()), playAuth);
    } catch {
      return upstreamFailure("soda audio decrypt failed");
    }
    if (!decrypted.decrypted) return upstreamFailure(`soda audio decrypt failed: ${decrypted.reason}`);

    const body = toArrayBuffer(decrypted.data);
    return new Response(body, {
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": upstream.headers.get("content-type") ?? "audio/mp4",
        "content-length": String(body.byteLength),
        "cache-control": "no-store",
        "x-soda-audio-decrypted": "1"
      }
    });
  };
}

export const resolveSodaAudioProxy = createSodaAudioProxy();

type DecryptDataResult = {
  data: Uint8Array;
  decrypted: boolean;
  reason: string;
};

function parseTargetUrl(target: string): { ok: true; url: string } | { ok: false; message: string } {
  if (!target.trim()) return { ok: false, message: "url required" };
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, message: "url must use http or https" };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, message: "invalid url" };
  }
}

function badRequest(message: string): Response {
  return json(fail({ code: "BAD_REQUEST", message, retryable: false }), 400);
}

function upstreamFailure(message: string): Response {
  return json(fail({ code: "SODA_AUDIO_PROXY", message, retryable: true }), 502);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function readUInt16BE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false);
}

function readUInt32BE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
}

function bytesToAscii(data: Uint8Array): string {
  return String.fromCharCode(...data);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim();
  const bytes = new Uint8Array(Math.floor(normalized.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (!needle.length || haystack.length < needle.length) return -1;
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

async function decryptAesCtr(data: Uint8Array, keyBytes: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), { name: "AES-CTR" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: toArrayBuffer(iv), length: 64 },
    key,
    toArrayBuffer(data)
  );
  return new Uint8Array(decrypted);
}

class SpadeDecryptor {
  private static bitCount(value: number): number {
    let current = value >>> 0;
    current -= (current >>> 1) & 0x55555555;
    current = (current & 0x33333333) + ((current >>> 2) & 0x33333333);
    return (((current + (current >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  private static decodeBase36(value: number): number {
    if (value >= 48 && value <= 57) return value - 48;
    if (value >= 97 && value <= 122) return value - 97 + 10;
    return 0xff;
  }

  private static decryptSpadeInner(spadeKeyBytes: Uint8Array): Uint8Array {
    const result = new Uint8Array(spadeKeyBytes.length);
    const buff = concatBytes(SPADE_PREFIX, spadeKeyBytes);
    for (let index = 0; index < result.length; index += 1) {
      const raw = (spadeKeyBytes[index] ^ buff[index]) - SpadeDecryptor.bitCount(index) - 21;
      result[index] = raw >= 0 ? raw : ((raw % 255) + 255) % 255;
    }
    return result;
  }

  static extractKey(playAuth: string): string | null {
    const bytes = base64ToBytes(playAuth);
    if (bytes.length < 3) return null;

    const paddingLength = (bytes[0] ^ bytes[1] ^ bytes[2]) - 48;
    if (bytes.length < paddingLength + 2) return null;

    const tmpBuff = SpadeDecryptor.decryptSpadeInner(bytes.subarray(1, bytes.length - paddingLength));
    if (!tmpBuff.length) return null;

    const endIndex = 1 + (bytes.length - paddingLength - 2) - SpadeDecryptor.decodeBase36(tmpBuff[0]);
    return new TextDecoder().decode(tmpBuff.subarray(1, endIndex));
  }
}

function findBox(data: Uint8Array, boxType: string, start = 0, end = data.length): Mp4Box | null {
  let position = start;
  while (position + 8 <= end) {
    const size = readUInt32BE(data, position);
    if (size < 8 || position + size > data.length) break;
    const currentType = bytesToAscii(data.subarray(position + 4, position + 8));
    if (currentType === boxType) {
      return {
        offset: position,
        size,
        data: data.subarray(position + 8, position + size)
      };
    }
    position += size;
  }
  return null;
}

export async function decryptSodaAudioData(fileData: Uint8Array, playAuth: string): Promise<DecryptDataResult> {
  const hexKey = SpadeDecryptor.extractKey(playAuth);
  if (!hexKey) return { data: fileData, decrypted: false, reason: "playAuth key extraction failed" };

  const moov = findBox(fileData, "moov");
  if (!moov) return { data: fileData, decrypted: false, reason: "moov box not found" };

  let senc = findBox(fileData, "senc", moov.offset + 8, moov.offset + moov.size);
  const trak = findBox(fileData, "trak", moov.offset + 8, moov.offset + moov.size);
  if (!trak) return { data: fileData, decrypted: false, reason: "trak box not found" };

  const mdia = findBox(fileData, "mdia", trak.offset + 8, trak.offset + trak.size);
  if (!mdia) return { data: fileData, decrypted: false, reason: "mdia box not found" };

  const minf = findBox(fileData, "minf", mdia.offset + 8, mdia.offset + mdia.size);
  if (!minf) return { data: fileData, decrypted: false, reason: "minf box not found" };

  const stbl = findBox(fileData, "stbl", minf.offset + 8, minf.offset + minf.size);
  if (!stbl) return { data: fileData, decrypted: false, reason: "stbl box not found" };

  const stsz = findBox(fileData, "stsz", stbl.offset + 8, stbl.offset + stbl.size);
  if (!stsz) return { data: fileData, decrypted: false, reason: "stsz box not found" };

  const stszData = stsz.data;
  const sampleSizeFixed = readUInt32BE(stszData, 4);
  const sampleCount = readUInt32BE(stszData, 8);
  const sampleSizes = sampleSizeFixed
    ? Array.from({ length: sampleCount }, () => sampleSizeFixed)
    : Array.from({ length: sampleCount }, (_, index) => readUInt32BE(stszData, 12 + index * 4));

  if (!senc) {
    senc = findBox(fileData, "senc", stbl.offset + 8, stbl.offset + stbl.size);
    if (!senc) return { data: fileData, decrypted: false, reason: "senc box not found" };
  }

  const sencData = senc.data;
  const sencFlags = readUInt32BE(sencData, 0) & 0x00ffffff;
  const sencSampleCount = readUInt32BE(sencData, 4);
  const ivs: Uint8Array[] = [];
  let sencPtr = 8;
  for (let index = 0; index < sencSampleCount; index += 1) {
    ivs.push(concatBytes(sencData.subarray(sencPtr, sencPtr + 8), new Uint8Array(8)));
    sencPtr += 8;
    if ((sencFlags & 0x02) !== 0) {
      const subCount = readUInt16BE(sencData, sencPtr);
      sencPtr += 2 + subCount * 6;
    }
  }

  const mdat = findBox(fileData, "mdat");
  if (!mdat) return { data: fileData, decrypted: false, reason: "mdat box not found" };

  const output = new Uint8Array(fileData);
  const keyBytes = hexToBytes(hexKey);
  const decryptedMdatParts: Uint8Array[] = [];
  let readPtr = mdat.offset + 8;
  for (let index = 0; index < sampleSizes.length; index += 1) {
    const sample = fileData.subarray(readPtr, readPtr + sampleSizes[index]);
    decryptedMdatParts.push(index < ivs.length ? await decryptAesCtr(sample, keyBytes, ivs[index]) : sample);
    readPtr += sampleSizes[index];
  }

  const decryptedMdat = concatBytes(...decryptedMdatParts);
  if (decryptedMdat.length === mdat.size - 8) output.set(decryptedMdat, mdat.offset + 8);

  const stsd = findBox(output, "stsd", stbl.offset + 8, stbl.offset + stbl.size);
  if (stsd) {
    const originalStsd = output.subarray(stsd.offset, stsd.offset + stsd.size);
    const encaIndex = indexOfBytes(originalStsd, ENCA_BYTES);
    if (encaIndex >= 0) output.set(MP4A_BYTES, stsd.offset + encaIndex);
  }

  return { data: output, decrypted: true, reason: "decrypted" };
}

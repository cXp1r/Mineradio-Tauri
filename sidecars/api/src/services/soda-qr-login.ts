import {
  ProviderLoginQrCheckSchema,
  ProviderLoginQrImageSchema,
  ProviderLoginQrKeySchema,
  type ProviderLoginQrCheck,
  type ProviderLoginQrImage,
  type ProviderLoginQrKey,
} from "@mineradio/shared";
import { setRuntimeProviderCookie } from "./auth-session";
import { ProviderNotImplementedError } from "../providers/provider-adapter";

type SodaApiResponse = {
  body?: unknown;
  cookie?: unknown;
};

type SodaApiCall = (
  query: Record<string, unknown>,
  config?: { cookie?: string }
) => Promise<SodaApiResponse>;

export type SodaQrLoginService = {
  createKey(): Promise<ProviderLoginQrKey>;
  createImage(key: string): Promise<ProviderLoginQrImage>;
  check(key: string): Promise<ProviderLoginQrCheck>;
};

export type SodaQrLoginDeps = {
  qrKey?: SodaApiCall;
  qrCreate?: SodaApiCall;
  qrCheck?: SodaApiCall;
  now?: () => number;
};

const SODA_PROVIDER = "soda";

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function responseBody(resp: SodaApiResponse): Record<string, unknown> {
  return asObj(resp.body) ?? {};
}

function responseData(resp: SodaApiResponse): Record<string, unknown> {
  const body = responseBody(resp);
  return asObj(body.data) ?? body;
}

function readQrCookie(resp: SodaApiResponse): string | undefined {
  const body = responseBody(resp);
  const data = responseData(resp);
  return (
    readString(resp.cookie) ??
    readString(body.cookie) ??
    readString(data.cookie) ??
    readString(data.cookies) ??
    readString(body.cookies)
  );
}

function readQrCode(resp: SodaApiResponse): number {
  const body = responseBody(resp);
  const data = responseData(resp);
  return (
    readNumber(body.code) ??
    readNumber(data.code) ??
    readNumber(body.status) ??
    readNumber(data.status) ??
    0
  );
}

function readQrMessage(resp: SodaApiResponse): string | undefined {
  const body = responseBody(resp);
  const data = responseData(resp);
  return readString(body.message) ?? readString(data.message) ?? readString(body.msg) ?? readString(data.msg);
}

function readQrKey(resp: SodaApiResponse): string | undefined {
  const body = responseBody(resp);
  const data = responseData(resp);
  return (
    readString(data.key) ??
    readString(data.unikey) ??
    readString(data.codekey) ??
    readString(data.qrKey) ??
    readString(body.key) ??
    readString(body.unikey) ??
    readString(body.codekey) ??
    readString(body.qrKey)
  );
}

function readQrImage(resp: SodaApiResponse): string | undefined {
  const body = responseBody(resp);
  const data = responseData(resp);
  return (
    readString(data.qrimg) ??
    readString(data.img) ??
    readString(data.image) ??
    readString(data.qrImage) ??
    readString(body.qrimg) ??
    readString(body.img) ??
    readString(body.image) ??
    readString(body.qrImage)
  );
}

function readQrUrl(resp: SodaApiResponse): string | undefined {
  const body = responseBody(resp);
  const data = responseData(resp);
  return readString(data.qrurl) ?? readString(data.url) ?? readString(body.qrurl) ?? readString(body.url);
}

function defaultFail(action: string): never {
  throw new ProviderNotImplementedError(SODA_PROVIDER, action, `soda qr login is not wired for ${action}`);
}

export function createSodaQrLoginService(deps: SodaQrLoginDeps = {}): SodaQrLoginService {
  const now = deps.now ?? Date.now;
  const qrKey = deps.qrKey ?? (async () => defaultFail("login-qr-key"));
  const qrCreate = deps.qrCreate ?? (async () => defaultFail("login-qr-create"));
  const qrCheck = deps.qrCheck ?? (async () => defaultFail("login-qr-check"));

  return {
    async createKey() {
      const resp = await qrKey({ timestamp: now() });
      const key = readQrKey(resp);
      if (!key) throw new Error("SODA_QR_KEY_MISSING");
      return ProviderLoginQrKeySchema.parse({ provider: SODA_PROVIDER, key });
    },

    async createImage(key: string) {
      const normalizedKey = key.trim();
      if (!normalizedKey) throw new Error("SODA_QR_KEY_REQUIRED");
      const resp = await qrCreate({ key: normalizedKey, qrimg: true, timestamp: now() });
      const img = readQrImage(resp);
      if (!img) throw new Error("SODA_QR_IMAGE_MISSING");
      return ProviderLoginQrImageSchema.parse({
        provider: SODA_PROVIDER,
        key: normalizedKey,
        img,
        url: readQrUrl(resp)
      });
    },

    async check(key: string) {
      const normalizedKey = key.trim();
      if (!normalizedKey) throw new Error("SODA_QR_KEY_REQUIRED");
      const resp = await qrCheck({ key: normalizedKey, noCookie: true, timestamp: now() });
      const cookie = readQrCookie(resp);
      const code = readQrCode(resp);
      const message = readQrMessage(resp);
      const loggedIn = code === 0 || code === 803 || code === 200;
      const scanned = code === 802 || code === 801 || (message ? /scan|扫码|已扫码/.test(message) : false);
      const expired = code === 800 || code === 405 || (message ? /expired|过期/.test(message) : false);
      const stored = loggedIn && !!cookie;
      if (stored && cookie) setRuntimeProviderCookie("soda", cookie);
      return ProviderLoginQrCheckSchema.parse({
        provider: SODA_PROVIDER,
        key: normalizedKey,
        code,
        message,
        loggedIn,
        scanned,
        expired,
        stored
      });
    }
  };
}

export const sodaQrLogin = createSodaQrLoginService();

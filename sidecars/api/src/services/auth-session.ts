import type { ProviderId } from "@mineradio/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const runtimeCookies = new Map<ProviderId, string>();
const SESSION_FILE_ENV = "MINERADIO_SESSION_FILE";

type ProviderCookieMap = Partial<Record<ProviderId, string>>;

type PersistedProviderSessions = {
  version?: number;
  providers?: ProviderCookieMap;
};

function envCookie(provider: ProviderId): string | undefined {
  const key =
    provider === "netease"
      ? "MINERADIO_NETEASE_COOKIE"
      : provider === "qq"
        ? "MINERADIO_QQ_COOKIE"
        : "MINERADIO_SODA_COOKIE";
  const cookie = process.env[key];
  if (typeof cookie === "string" && cookie.trim().length > 0) return cookie;
  return undefined;
}

function sessionFilePath(): string | undefined {
  const explicit = process.env[SESSION_FILE_ENV];
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const appDataDir = process.env.MINERADIO_APP_DATA_DIR;
  if (typeof appDataDir === "string" && appDataDir.trim()) {
    return join(appDataDir, "provider-sessions.json");
  }
  return undefined;
}

function parsePersistedCookies(raw: unknown): ProviderCookieMap {
  if (!raw || typeof raw !== "object") return {};
  const providers = (raw as PersistedProviderSessions).providers;
  if (!providers || typeof providers !== "object") return {};
  const out: ProviderCookieMap = {};
  for (const provider of ["netease", "qq", "soda"] as const) {
    const cookie = providers[provider];
    if (typeof cookie === "string" && cookie.trim()) out[provider] = cookie.trim();
  }
  return out;
}

function readPersistedCookies(): ProviderCookieMap {
  const file = sessionFilePath();
  if (!file || !existsSync(file)) return {};
  try {
    return parsePersistedCookies(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

function writePersistedCookies(cookies: ProviderCookieMap): void {
  const file = sessionFilePath();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, providers: cookies }, null, 2), "utf8");
  } catch {
  }
}

function setPersistedProviderCookie(provider: ProviderId, cookie: string): void {
  writePersistedCookies({
    ...readPersistedCookies(),
    [provider]: cookie,
  });
}

function clearPersistedProviderCookie(provider: ProviderId): void {
  const cookies = readPersistedCookies();
  delete cookies[provider];
  writePersistedCookies(cookies);
}

export function setRuntimeProviderCookie(provider: ProviderId, cookie: string): void {
  const normalized = String(cookie ?? "").trim();
  if (!normalized) {
    throw new Error("EMPTY_COOKIE");
  }
  runtimeCookies.set(provider, normalized);
  setPersistedProviderCookie(provider, normalized);
}

export function clearRuntimeProviderCookie(provider: ProviderId): void {
  runtimeCookies.delete(provider);
  clearPersistedProviderCookie(provider);
}

export function getProviderCookie(provider: ProviderId): string | undefined {
  return runtimeCookies.get(provider) ?? readPersistedCookies()[provider] ?? envCookie(provider);
}

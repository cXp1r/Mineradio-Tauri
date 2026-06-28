import type { ProviderId } from "@mineradio/shared";

const runtimeCookies = new Map<ProviderId, string>();

function envCookie(provider: ProviderId): string | undefined {
  const key = provider === "netease" ? "MINERADIO_NETEASE_COOKIE" : "MINERADIO_QQ_COOKIE";
  const cookie = process.env[key];
  if (typeof cookie === "string" && cookie.trim().length > 0) return cookie;
  return undefined;
}

export function setRuntimeProviderCookie(provider: ProviderId, cookie: string): void {
  const normalized = String(cookie ?? "").trim();
  if (!normalized) {
    throw new Error("EMPTY_COOKIE");
  }
  runtimeCookies.set(provider, normalized);
}

export function clearRuntimeProviderCookie(provider: ProviderId): void {
  runtimeCookies.delete(provider);
}

export function getProviderCookie(provider: ProviderId): string | undefined {
  return runtimeCookies.get(provider) ?? envCookie(provider);
}

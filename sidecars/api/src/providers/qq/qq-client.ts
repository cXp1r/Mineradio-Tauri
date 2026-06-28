// qq-client: thin wrapper around jsososo/qq-music-api (npm `qq-music-api`, GPL-3.0).
// Lazy dynamic import for CJS interop under Bun. Cookie is applied per-call
// via setCookie on the singleton instance; never logged outside getConfig().
import { getProviderCookie } from "../../services/auth-session";

export interface QqConfig {
  cookie?: string;
}

export function getConfig(): QqConfig {
  const cookie = getProviderCookie("qq");
  if (cookie) return { cookie };
  return {};
}

type QqApiModule = {
  api(path: string, query?: Record<string, unknown>): Promise<unknown>;
  setCookie(cookie: string | Record<string, string>): void;
};

let cachedModule: QqApiModule | null = null;

function getQq(): QqApiModule {
  if (cachedModule === null) {
    // Bun supports `import.meta.require` for CJS modules from ESM context;
    // avoids the @types/node `require` global we don't ship.
    const meta = import.meta as { require?: (id: string) => QqApiModule };
    if (typeof meta.require !== "function") {
      throw new Error("qq-music-api require not available in this runtime");
    }
    cachedModule = meta.require("qq-music-api");
  }
  return cachedModule;
}

export function __setQqApiModuleForTest(module: QqApiModule | null): void {
  cachedModule = module;
}

export interface QqCall {
  (
    query: Record<string, unknown>,
    config?: { cookie?: string }
  ): Promise<{ body: unknown }>;
}

function wrap(path: string): QqCall {
  return async (query, config) => {
    const qq = getQq();
    if (config && typeof config.cookie === "string" && config.cookie.length > 0) {
      qq.setCookie(config.cookie);
    } else {
      qq.setCookie("");
    }
    const data = await qq.api(path, query);
    return { body: data };
  };
}

export const qqClient = {
  search: wrap("search"),
  songDetail: wrap("song"),
  songUrl: wrap("song/url"),
  lyric: wrap("lyric"),
  playlistDetail: wrap("songlist"),
  loginStatus: wrap("user"),
  logout: wrap("user")
} as const;

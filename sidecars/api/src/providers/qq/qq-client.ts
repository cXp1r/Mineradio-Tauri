// qq-client: thin wrapper around jsososo/qq-music-api (npm `qq-music-api`, GPL-3.0).
// Cookie is applied per-call via setCookie on the singleton instance; never logged outside getConfig().
import qqMusicApi from "qq-music-api";
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

let injectedModule: QqApiModule | null = null;

function getQq(): QqApiModule {
  return injectedModule ?? qqMusicApi;
}

export function __setQqApiModuleForTest(module: QqApiModule | null): void {
  injectedModule = module;
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

async function qqVipInfo(query: Record<string, unknown>, config?: { cookie?: string }): Promise<{ body: unknown }> {
  const id = String(query.id ?? query.uin ?? "").trim();
  if (!id) return { body: {} };
  const data = {
    getVipInfo: {
      module: "userInfo.VipQueryServer",
      method: "SRFVipQuery_V2",
      param: { uin_list: [id] }
    },
    getNickHead: {
      module: "userInfo.BaseUserInfoServer",
      method: "get_user_baseinfo_v2",
      param: { vec_uin: [id] }
    },
    getVipIcon: {
      module: "music.lvz.VipIconUiShowSvr",
      method: "GetVipIconUiV2",
      param: { MusicID: id, PID: 8 }
    }
  };
  const params = new URLSearchParams({
    format: "json",
    data: JSON.stringify(data)
  });
  const headers: Record<string, string> = {
    Referer: "https://y.qq.com/m/myservice/index.html",
    "user-agent": "Mozilla/5.0"
  };
  if (config?.cookie) headers.Cookie = config.cookie;
  const res = await fetch(`https://u.y.qq.com/cgi-bin/musicu.fcg?${params.toString()}`, { headers });
  if (!res.ok) {
    throw new Error(`qq vipInfo failed with status ${res.status}`);
  }
  return { body: await res.json() };
}

export const qqClient = {
  search: wrap("search"),
  songDetail: wrap("song"),
  songUrl: wrap("song/url"),
  lyric: wrap("lyric"),
  userSonglists: wrap("user/songlist"),
  userCollectSonglists: wrap("user/collect/songlist"),
  playlistDetail: wrap("songlist"),
  playlistMap: wrap("songlist/map"),
  addSongToPlaylist: wrap("songlist/add"),
  loginStatus: wrap("user/detail"),
  vipInfo: qqVipInfo,
  logout: wrap("user")
} as const;

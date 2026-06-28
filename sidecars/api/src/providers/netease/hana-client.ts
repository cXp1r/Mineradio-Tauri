import {
  cloudsearch,
  songDetail,
  songUrlV1,
  lyric,
  lyricNew,
  playlistDetail,
  playlistCatlist,
  loginStatus,
  logout
} from "hana-music-api";
import { getProviderCookie } from "../../services/auth-session";

export interface NeteaseConfig {
  cookie?: string;
}

export function getConfig(): NeteaseConfig {
  const cookie = getProviderCookie("netease");
  if (cookie) return { cookie };
  return {};
}

export const hanaClient = {
  cloudsearch,
  songDetail,
  songUrlV1,
  lyric,
  lyricNew,
  playlistDetail,
  playlistCatlist,
  loginStatus,
  logout
} as const;

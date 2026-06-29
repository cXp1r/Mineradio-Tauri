import {
  cloudsearch,
  songDetail,
  songUrl,
  songUrlV1,
  lyric,
  lyricNew,
  playlistDetail,
  playlistCatlist,
  userPlaylist,
  loginStatus,
  logout,
  like,
  songLikeCheck,
  likelist,
  playlistTracks,
  playlistTrackAdd
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
  songUrl,
  songUrlV1,
  lyric,
  lyricNew,
  playlistDetail,
  playlistCatlist,
  userPlaylist,
  loginStatus,
  logout,
  like,
  songLikeCheck,
  likelist,
  playlistTracks,
  playlistTrackAdd
} as const;

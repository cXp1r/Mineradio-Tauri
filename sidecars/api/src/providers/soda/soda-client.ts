import { ProviderNotImplementedError } from "../provider-adapter";

const SODA_PROVIDER_ID = "soda";
const SODA_SEARCH_URL =
  "https://api.qishui.com/luna/pc/search/track?q=&aid=386088&app_name=&region=&geo_region=&os_region=&sim_region=&device_id=&cdid=&iid=&version_name=&version_code=&channel=&build_mode=&network_carrier=&ac=&tz_name=&resolution=&device_platform=&device_type=&os_version=&fp=&cursor=&search_id=&search_method=input&debug_params=&from_search_id=&search_scene=";
const SODA_LYRIC_URL = "https://api.qishui.com/luna/pc/track_v2?track_id=&media_type=track&queue_type=&aid=386088&iid=114514";
const SODA_PLAYLIST_LIST_URL = "https://api.qishui.com/luna/pc/me/playlist?aid=386088";
const SODA_PLAYLIST_DETAIL_URL = "https://api.qishui.com/luna/pc/playlist/detail?aid=386088";
const SODA_COLLECTION_MEDIA_URL = "https://api.qishui.com/luna/pc/me/collection/media?aid=386088";
const SODA_COLLECTION_MEDIA_DELETE_URL = "https://api.qishui.com/luna/pc/me/collection/media/delete?aid=386088";
const SODA_LOGOUT_URL = "https://api.qishui.com/passport/web/logout/";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SodaClientConfig {
  cookie?: string;
}

export interface SodaClientDeps {
  getConfig(): SodaClientConfig;
  fetch?: FetchLike;
}

export interface SodaClient {
  search(query: { keyword: string; limit: number }): Promise<{ body: unknown }>;
  songUrl(trackId: string): Promise<{ body: unknown }>;
  lyric(trackId: string): Promise<{ body: unknown }>;
  trackDetail(trackId: string): Promise<{ body: unknown }>;
  collectionMedia(trackId: string, liked: boolean): Promise<{ body: unknown; status: number }>;
  playlistList(): Promise<{ body: unknown }>;
  playlistDetail(id: string): Promise<{ body: unknown }>;
  loginStatus(): Promise<{ body: unknown }>;
  logout(): Promise<{ body: unknown }>;
}

function notImplemented(action: string): never {
  throw new ProviderNotImplementedError(SODA_PROVIDER_ID, action, `soda provider scaffold is not wired for ${action}`);
}

function withSearchKeyword(keyword: string): string {
  const url = new URL(SODA_SEARCH_URL);
  url.searchParams.set("q", keyword);
  return url.toString();
}

function withTrackId(trackId: string): string {
  const url = new URL(SODA_LYRIC_URL);
  url.searchParams.set("track_id", trackId);
  return url.toString();
}

function withLogoutUrl(): string {
  return SODA_LOGOUT_URL;
}

function withPlaylistListUrl(): string {
  return SODA_PLAYLIST_LIST_URL;
}

function withPlaylistDetailUrl(playlistId: string): string {
  const url = new URL(SODA_PLAYLIST_DETAIL_URL);
  url.searchParams.set("playlist_id", playlistId);
  return url.toString();
}

function withCollectionMediaUrl(liked: boolean): string {
  return liked ? SODA_COLLECTION_MEDIA_URL : SODA_COLLECTION_MEDIA_DELETE_URL;
}

function buildCollectionMediaBody(trackId: string): string {
  return JSON.stringify({
    media: [
      {
        type: "track",
        id: trackId
      }
    ],
    scene: ""
  });
}

async function readJsonBody(resp: Response, action: string): Promise<{ body: unknown }> {
  if (!resp.ok) {
    throw new Error(`SODA_${action.toUpperCase()}_HTTP_${resp.status}`);
  }
  return { body: await resp.json() };
}

export function createSodaClient(deps: SodaClientDeps): SodaClient {
  const fetcher = deps.fetch ?? fetch;
  async function fetchTrackDetail(trackId: string): Promise<{ body: unknown }> {
    const cfg = deps.getConfig();
    const headers: HeadersInit = {};
    if (cfg.cookie) headers.cookie = cfg.cookie;
    const resp = await fetcher(withTrackId(trackId), { method: "GET", headers });
    return readJsonBody(resp, "track-detail");
  }

  return {
    async search({ keyword }) {
      const cfg = deps.getConfig();
      const headers: HeadersInit = {};
      if (cfg.cookie) headers.cookie = cfg.cookie;
      const resp = await fetcher(withSearchKeyword(keyword), { method: "GET", headers });
      return readJsonBody(resp, "search");
    },
    async songUrl() { return notImplemented("songUrl"); },
    async lyric(trackId: string) {
      return fetchTrackDetail(trackId);
    },
    async trackDetail(trackId: string) {
      return fetchTrackDetail(trackId);
    },
    async collectionMedia(trackId: string, liked: boolean) {
      const cfg = deps.getConfig();
      const headers: HeadersInit = {
        "content-type": "application/json"
      };
      if (cfg.cookie) headers.cookie = cfg.cookie;
      const resp = await fetcher(withCollectionMediaUrl(liked), {
        method: "POST",
        headers,
        body: buildCollectionMediaBody(trackId)
      });
      return { body: await resp.json(), status: resp.status };
    },
    async playlistList() {
      const cfg = deps.getConfig();
      const headers: HeadersInit = {};
      if (cfg.cookie) headers.cookie = cfg.cookie;
      const resp = await fetcher(withPlaylistListUrl(), { method: "GET", headers });
      return readJsonBody(resp, "playlist-list");
    },
    async playlistDetail(id: string) {
      const cfg = deps.getConfig();
      const headers: HeadersInit = {};
      if (cfg.cookie) headers.cookie = cfg.cookie;
      const resp = await fetcher(withPlaylistDetailUrl(id), { method: "GET", headers });
      return readJsonBody(resp, "playlist-detail");
    },
    async loginStatus() { return notImplemented("loginStatus"); },
    async logout() {
      const cfg = deps.getConfig();
      const headers: HeadersInit = {};
      if (cfg.cookie) headers.cookie = cfg.cookie;
      const resp = await fetcher(withLogoutUrl(), { method: "GET", headers });
      return readJsonBody(resp, "logout");
    }
  };
}

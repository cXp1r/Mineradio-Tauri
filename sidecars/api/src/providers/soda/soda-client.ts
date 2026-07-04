const SODA_PROVIDER_ID = "soda";
const SODA_SEARCH_URL =
  "https://api.qishui.com/luna/pc/search/track?q=&aid=386088&app_name=&region=&geo_region=&os_region=&sim_region=&device_id=&cdid=&iid=&version_name=&version_code=&channel=&build_mode=&network_carrier=&ac=&tz_name=&resolution=&device_platform=&device_type=&os_version=&fp=&cursor=&search_id=&search_method=input&debug_params=&from_search_id=&search_scene=";
const SODA_LYRIC_URL = "https://api.qishui.com/luna/pc/track_v2?track_id=&media_type=track&queue_type=&aid=386088&iid=114514";
const SODA_PLAYLIST_LIST_URL = "https://api.qishui.com/luna/pc/me/playlist?aid=386088";
const SODA_PLAYLIST_DETAIL_URL = "https://api.qishui.com/luna/pc/playlist/detail?aid=386088";
const SODA_ME_URL = "https://api.qishui.com/luna/pc/me?aid=386088";
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

function withPlaylistDetailUrl(playlistId: string, cursor = 0, count = 20): string {
  const url = new URL(SODA_PLAYLIST_DETAIL_URL);
  url.searchParams.set("playlist_id", playlistId);
  url.searchParams.set("cursor", String(cursor));
  url.searchParams.set("cnt", String(count));
  return url.toString();
}

function withMeUrl(): string {
  return SODA_ME_URL;
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

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readMediaResources(body: unknown): unknown[] {
  const root = asObj(body);
  const data = asObj(root?.data);
  const list = root?.media_resources ?? data?.media_resources ?? root?.mediaResources ?? data?.mediaResources;
  return Array.isArray(list) ? list : [];
}

function readPlaylistTrackCount(body: unknown): number {
  const root = asObj(body);
  const data = asObj(root?.data);
  const playlist = asObj(root?.playlist) ?? asObj(data?.playlist);
  const raw = playlist?.count_tracks ?? playlist?.countTracks ?? playlist?.trackCount;
  const count = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function mergePlaylistDetailPages(firstBody: unknown, mediaResources: unknown[]): unknown {
  const firstRoot = asObj(firstBody);
  if (!firstRoot) return { media_resources: mediaResources };
  const data = asObj(firstRoot.data);
  if (data && !Array.isArray(firstRoot.data)) {
    return {
      ...firstRoot,
      data: {
        ...data,
        media_resources: mediaResources
      },
      media_resources: mediaResources
    };
  }
  return {
    ...firstRoot,
    media_resources: mediaResources
  };
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
    async songUrl(trackId: string) {
      return fetchTrackDetail(trackId);
    },
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
      const pageSize = 20;
      const firstResp = await fetcher(withPlaylistDetailUrl(id, 0, pageSize), { method: "GET", headers });
      const first = await readJsonBody(firstResp, "playlist-detail");
      const totalCount = readPlaylistTrackCount(first.body);
      const mediaResources = [...readMediaResources(first.body)];
      let cursor = mediaResources.length;
      while (totalCount > 0 && cursor < totalCount) {
        const resp = await fetcher(withPlaylistDetailUrl(id, cursor, pageSize), { method: "GET", headers });
        const page = await readJsonBody(resp, "playlist-detail");
        const pageResources = readMediaResources(page.body);
        if (pageResources.length === 0) break;
        mediaResources.push(...pageResources);
        cursor += pageResources.length;
      }
      return { body: mergePlaylistDetailPages(first.body, mediaResources) };
    },
    async loginStatus() {
      const cfg = deps.getConfig();
      const headers: HeadersInit = {};
      if (cfg.cookie) headers.cookie = cfg.cookie;
      const resp = await fetcher(withMeUrl(), { method: "GET", headers });
      return readJsonBody(resp, "login-status");
    },
    async logout() {
      const cfg = deps.getConfig();
      const headers: HeadersInit = {};
      if (cfg.cookie) headers.cookie = cfg.cookie;
      const resp = await fetcher(withLogoutUrl(), { method: "GET", headers });
      return readJsonBody(resp, "logout");
    }
  };
}

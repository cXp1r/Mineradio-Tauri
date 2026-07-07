import {
  DiscoverHomeResponseSchema,
  type DiscoverHomeResponse,
  type PlaylistSummary,
  type PodcastRadio,
  type ProviderId,
  type ProviderLoginStatus,
  type Track
} from "@mineradio/shared";
import type { ProviderAdapter } from "../providers/provider-adapter";
import { getProviderCookie } from "./auth-session";
import type { PodcastService } from "./podcast";

type NeteaseResponse = { body?: unknown };
type DiscoverRequestParams = Record<string, unknown>;

export type DiscoverRequester = {
  personalized(params: DiscoverRequestParams): Promise<NeteaseResponse>;
  djHot(params: DiscoverRequestParams): Promise<NeteaseResponse>;
  recommendResource(params: DiscoverRequestParams): Promise<NeteaseResponse>;
  recommendSongs(params: DiscoverRequestParams): Promise<NeteaseResponse>;
};

export type DiscoverHomeServiceOptions = {
  providerAdapters: Record<ProviderId, ProviderAdapter>;
  podcast: Pick<PodcastService, "hot">;
  discoverRequester?: DiscoverRequester;
  now?: () => number;
};

const PROVIDER_ORDER: ProviderId[] = ["netease", "qq", "soda"];

export async function buildDiscoverHome(
  options: DiscoverHomeServiceOptions
): Promise<DiscoverHomeResponse> {
  const now = options.now ?? Date.now;
  const statuses = await Promise.all(
    PROVIDER_ORDER.map(async (provider) => safeLoginStatus(provider, options.providerAdapters[provider]))
  );
  const logged = statuses.find((status) => status?.loggedIn) ?? null;

  if (!logged) {
    return DiscoverHomeResponseSchema.parse({
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [],
      podcasts: [],
      mode: "starter",
      updatedAt: now()
    });
  }

  const loggedProviders = statuses
    .filter((status): status is ProviderLoginStatus => !!status?.loggedIn)
    .map((status) => status.provider);
  const neteaseDiscover = loggedProviders.includes("netease")
    ? await loadNeteaseDiscover(options.discoverRequester, now)
    : { dailySongs: [], playlists: [], podcasts: [] };
  const adapterPlaylists = neteaseDiscover.playlists.length
    ? []
    : await loadAdapterPlaylists(options.providerAdapters, loggedProviders);
  const playlists = (neteaseDiscover.playlists.length ? neteaseDiscover.playlists : adapterPlaylists)
    .filter((playlist) => playlist.id && playlist.name)
    .slice(0, 10);
  const dailySongs = neteaseDiscover.dailySongs.length
    ? neteaseDiscover.dailySongs.slice(0, 12)
    : await firstPlaylistTracks(options.providerAdapters, playlists)
      || await firstSearchTracks(options.providerAdapters, loggedProviders);
  const podcasts = neteaseDiscover.podcasts.length
    ? neteaseDiscover.podcasts.slice(0, 6)
    : await loadPodcastFallback(options.podcast);

  return DiscoverHomeResponseSchema.parse({
    loggedIn: true,
    user: {
      provider: logged.provider,
      userId: logged.userId ?? "",
      nickname: logged.nickname ?? "",
      avatarUrl: logged.avatarUrl ?? ""
    },
    dailySongs,
    playlists,
    podcasts,
    mode: "member",
    updatedAt: now()
  });
}

async function loadNeteaseDiscover(
  requester: DiscoverRequester | undefined,
  now: () => number
): Promise<{ dailySongs: Track[]; playlists: PlaylistSummary[]; podcasts: PodcastRadio[] }> {
  const cookie = getProviderCookie("netease");
  if (!requester && !cookie) return { dailySongs: [], playlists: [], podcasts: [] };
  const api = requester ?? defaultDiscoverRequester();
  const baseParams = cookie ? { cookie, timestamp: now() } : { timestamp: now() };
  const results = await Promise.allSettled([
    api.personalized({ ...baseParams, limit: 8 }),
    api.djHot({ ...baseParams, limit: 6, offset: 0 }),
    api.recommendResource(baseParams),
    api.recommendSongs(baseParams)
  ]);

  const publicPlaylists = resultBody(results[0])
    .map((body) => arrayOf(body.result ?? body.data)
      .map((playlist) => mapDiscoverPlaylist(playlist))
      .filter((playlist) => playlist.id && playlist.name)
      .slice(0, 8))
    .unwrapOr([]);
  const podcasts = resultBody(results[1])
    .map((body) => arrayOf(body.djRadios ?? body.djradios ?? body.radios ?? body.data)
      .map(mapPodcastRadio)
      .filter((podcast) => podcast.id && podcast.name && !isLowSignalPodcastItem(podcast))
      .slice(0, 6))
    .unwrapOr([]);
  const privatePlaylists = resultBody(results[2])
    .map((body) => arrayOf(body.recommend ?? body.data)
      .map((playlist) => mapDiscoverPlaylist(playlist))
      .filter((playlist) => playlist.id && playlist.name)
      .slice(0, 6))
    .unwrapOr([]);
  const dailySongs = resultBody(results[3])
    .map((body) => {
      const data = record(body.data);
      const raw = data.dailySongs ?? data.recommend ?? body.recommend ?? [];
      return arrayOf(raw)
        .map(mapNeteaseSong)
        .filter((track) => track.id && track.title)
        .slice(0, 12);
    })
    .unwrapOr([]);

  return {
    dailySongs,
    playlists: privatePlaylists.concat(publicPlaylists).slice(0, 10),
    podcasts
  };
}

async function safeLoginStatus(
  provider: ProviderId,
  adapter: ProviderAdapter
): Promise<ProviderLoginStatus | null> {
  try {
    return await adapter.loginStatus();
  } catch {
    return { provider, loggedIn: false };
  }
}

async function loadAdapterPlaylists(
  adapters: Record<ProviderId, ProviderAdapter>,
  providers: ProviderId[]
): Promise<PlaylistSummary[]> {
  const playlistResults = await Promise.allSettled(
    providers.map((provider) => adapters[provider].playlistList())
  );
  return playlistResults
    .flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .filter((playlist) => playlist.id && playlist.name)
    .slice(0, 10);
}

async function firstPlaylistTracks(
  adapters: Record<ProviderId, ProviderAdapter>,
  playlists: PlaylistSummary[]
): Promise<Track[] | null> {
  for (const playlist of playlists) {
    try {
      const detail = await adapters[playlist.provider].playlistDetail(playlist.id);
      const tracks = detail.tracks.filter((track) => track.id && track.title).slice(0, 12);
      if (tracks.length) return tracks;
    } catch {
    }
  }
  return null;
}

async function firstSearchTracks(
  adapters: Record<ProviderId, ProviderAdapter>,
  providers: ProviderId[]
): Promise<Track[]> {
  for (const provider of providers) {
    try {
      const tracks = await adapters[provider].search({ keyword: "每日推荐", limit: 12 });
      const filtered = tracks.filter((track) => track.id && track.title).slice(0, 12);
      if (filtered.length) return filtered;
    } catch {
    }
  }
  return [];
}

async function loadPodcastFallback(podcast: Pick<PodcastService, "hot">): Promise<PodcastRadio[]> {
  const podcastResult = await Promise.allSettled([podcast.hot({ limit: 6, offset: 0 })]);
  return podcastResult[0]?.status === "fulfilled"
    ? podcastResult[0].value.podcasts.filter((item) => item.id && item.name).slice(0, 6)
    : [];
}

function defaultDiscoverRequester(): DiscoverRequester {
  let modulePromise: Promise<Record<string, (...args: any[]) => Promise<NeteaseResponse>>> | null = null;
  const load = async () => {
    modulePromise ??= import("hana-music-api") as unknown as Promise<Record<string, (...args: any[]) => Promise<NeteaseResponse>>>;
    return modulePromise;
  };
  const call = (name: string) => async (params: DiscoverRequestParams) => {
    const mod = await load();
    const fn = mod[name];
    if (!fn) throw new Error(`hana-music-api missing ${name}`);
    return fn(params);
  };
  return {
    personalized: call("personalized"),
    djHot: call("djHot"),
    recommendResource: call("recommendResource"),
    recommendSongs: call("recommendSongs")
  };
}

function resultBody(result: PromiseSettledResult<NeteaseResponse>) {
  const body = result.status === "fulfilled" ? record(result.value.body ?? result.value) : {};
  return {
    map<T>(fn: (body: Record<string, any>) => T) {
      return {
        unwrapOr(fallback: T) {
          return Object.keys(body).length ? fn(body) : fallback;
        }
      };
    }
  };
}

function mapNeteaseSong(raw: unknown): Track {
  const song = record(raw);
  const id = stringId(song.id);
  const album = record(song.al ?? song.album);
  const artists = arrayOf(song.ar ?? song.artists)
    .map((artist) => stringValue(record(artist).name))
    .filter(Boolean);
  const fee = Number(song.fee);
  return {
    provider: "netease",
    id,
    sourceId: id,
    title: stringValue(song.name),
    artists,
    album: stringValue(album.name),
    coverUrl: stringValue(album.picUrl ?? album.coverUrl),
    durationMs: numberOrUndefined(song.dt ?? song.duration),
    qualityHints: ["standard"],
    playableState:
      fee === 1 ? "vip_required" :
      fee === 4 ? "paid_required" :
      fee === 8 ? "trial_only" :
      "unknown"
  };
}

function mapDiscoverPlaylist(raw: unknown): PlaylistSummary {
  const playlist = record(raw);
  const uiElement = record(playlist.uiElement);
  const image = record(uiElement.image);
  const id = stringId(playlist.id ?? playlist.resourceId ?? playlist.creativeId);
  return {
    provider: "netease",
    id,
    name: stringValue(playlist.name ?? playlist.title),
    coverUrl: stringValue(playlist.picUrl ?? playlist.coverImgUrl ?? playlist.coverUrl ?? image.imageUrl),
    trackCount: numberOrUndefined(playlist.trackCount ?? playlist.songCount ?? playlist.programCount),
    trackIds: [],
    subscribed: playlist.subscribed === true
  };
}

function mapPodcastRadio(raw: unknown): PodcastRadio {
  const radio = record(raw);
  const dj = record(radio.dj ?? radio.djSimple ?? radio.djUser ?? radio.creator);
  const id = stringId(radio.id ?? radio.rid ?? radio.radioId);
  return {
    id,
    rid: id,
    name: stringValue(radio.name ?? radio.radioName),
    coverUrl: stringValue(radio.picUrl ?? radio.picURL ?? radio.coverUrl ?? radio.coverImgUrl ?? radio.avatarUrl),
    description: stringValue(radio.desc ?? radio.description ?? radio.rcmdText),
    djName: stringValue(dj.nickname ?? radio.djName ?? radio.nickname),
    category: stringValue(radio.category ?? radio.categoryName),
    programCount: numberOrZero(radio.programCount ?? radio.programNum ?? radio.programCnt),
    subCount: numberOrZero(radio.subCount ?? radio.subedCount ?? radio.subscriberCount)
  };
}

function isLowSignalPodcastItem(item: PodcastRadio): boolean {
  const text = `${item.name} ${item.djName} ${item.category} ${item.description}`.trim().toLowerCase();
  return /购买播客|付费精品|qzone|空间背景音乐|背景音乐|四只烤翅|试纸烤翅/i.test(text);
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringId(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function numberOrZero(value: unknown): number {
  return numberOrUndefined(value) ?? 0;
}

import {
  HealthResponseSchema,
  ProviderIdSchema,
  SongUrlRequestSchema,
  TrackSchema,
  WeatherRadioResponseSchema,
  PodcastBeatmapResponseSchema,
  PodcastDetailResponseSchema,
  PodcastHotResponseSchema,
  PodcastMyItemsResponseSchema,
  PodcastMyResponseSchema,
  PodcastProgramsResponseSchema,
  PodcastSearchResponseSchema,
  ProviderSessionCookieAckSchema,
  ProviderLoginQrCheckSchema,
  ProviderLoginQrImageSchema,
  ProviderLoginQrKeySchema,
  SongLikeAckSchema,
  SongLikeCheckAckSchema,
  PlaylistAddSongAckSchema,
  DiscoverHomeResponseSchema,
  type CapabilityMatrix,
  type ProviderId,
  type Track
} from "@mineradio/shared";
import { appVersion, apiVersion, schemaVersion, port } from "./env";
import { ok, fail, json, corsPreflight } from "./http/envelope";
import { providers, buildCapabilityMatrix, PROVIDER_IDS } from "./providers/registry";
import {
  ProviderNotImplementedError,
  type ProviderAdapter
} from "./providers/provider-adapter";
import { normalizeError } from "./services/fallback";
import { buildDiagnostics } from "./services/diagnostics";
import { createAudioProxy, type AudioProxy } from "./services/audio-proxy";
import { resolveImageProxy, type ImageProxy } from "./services/image-proxy";
import {
  createSidecarLogger,
  redactLogValue,
  type SidecarLogger
} from "./services/sidecar-log";
import {
  crossSourceResolver,
  type CrossSourceResolver
} from "./services/cross-source-resolver";
import {
  weatherRadio,
  type WeatherRadioParams,
  type WeatherRadioService
} from "./services/weather-radio";
import {
  podcastService,
  type PodcastService
} from "./services/podcast";
import { buildDiscoverHome, type DiscoverRequester } from "./services/discover-home";
import {
  clearRuntimeProviderCookie,
  getProviderCookie,
  setRuntimeProviderCookie
} from "./services/auth-session";
import { neteaseQrLogin, type NeteaseQrLoginService } from "./services/netease-qr-login";
import { qqQrLogin, type QqQrLoginService } from "./services/qq-qr-login";

export type RouteHandlerDeps = {
  crossSourceResolver?: CrossSourceResolver;
  audioProxy?: AudioProxy;
  imageProxy?: ImageProxy;
  providerAdapters?: Record<ProviderId, ProviderAdapter>;
  weatherRadio?: WeatherRadioService;
  podcast?: Partial<PodcastService>;
  discoverRequester?: DiscoverRequester;
  neteaseQrLogin?: NeteaseQrLoginService;
  qqQrLogin?: QqQrLoginService;
  logger?: SidecarLogger;
  now?: () => number;
};

export function createRouteHandler(deps: RouteHandlerDeps = {}) {
  const resolver = deps.crossSourceResolver ?? crossSourceResolver;
  const logger = deps.logger ?? createSidecarLogger();
  const audioProxy = deps.audioProxy ?? createAudioProxy({
    log: (entry) => logger.log(entry)
  });
  const imageProxy = deps.imageProxy ?? resolveImageProxy;
  const providerAdapters = deps.providerAdapters ?? providers;
  const weatherRadioService = deps.weatherRadio ?? weatherRadio;
  const podcast = { ...podcastService, ...(deps.podcast ?? {}) };
  const qrLoginByProvider: Record<ProviderId, NeteaseQrLoginService | QqQrLoginService> = {
    netease: deps.neteaseQrLogin ?? neteaseQrLogin,
    qq: deps.qqQrLogin ?? qqQrLogin
  };

  return async function handleRoute(request: Request): Promise<Response> {
    const startedAt = performance.now();
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    let response: Response;

    try {
    if (method === "OPTIONS") {
      response = corsPreflight();
      await logRequest(logger, { method, path, status: response.status, startedAt });
      return response;
    }

    if (path === "/health" && method === "GET") {
      const providerStatus = buildCapabilityMatrix();
      const body = HealthResponseSchema.parse({
        ok: true,
        appVersion: appVersion(),
        apiVersion: apiVersion(),
        schemaVersion: schemaVersion(),
        providers: PROVIDER_IDS,
        providerStatus
      });
      response = json(body);
      await logRequest(logger, { method, path, status: response.status, startedAt });
      return response;
    }

    if (path === "/providers/capabilities" && method === "GET") {
      const matrix: CapabilityMatrix = buildCapabilityMatrix();
      response = json(ok(matrix));
      await logRequest(logger, { method, path, status: response.status, startedAt });
      return response;
    }

    if (path === "/diagnostics" && method === "GET") {
      response = json(buildDiagnostics());
      await logRequest(logger, { method, path, status: response.status, startedAt });
      return response;
    }

    if (path === "/audio-proxy" && method === "GET") {
      const target = url.searchParams.get("url") ?? "";
      response = await audioProxy({ target, request });
      await logRequest(logger, { method, path, status: response.status, startedAt });
      return response;
    }

    if (path === "/image-proxy" && method === "GET") {
      const target = url.searchParams.get("url") ?? "";
      response = await imageProxy({ target, request });
      await logRequest(logger, { method, path, status: response.status, startedAt });
      return response;
    }

    if (path === "/weather/radio" && method === "GET") {
      const params = parseWeatherRadioParams(url);
      response = json(ok(WeatherRadioResponseSchema.parse(await weatherRadioService.build(params))));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "weather-radio" });
      return response;
    }

    if (path === "/discover/home" && method === "GET") {
      response = json(ok(DiscoverHomeResponseSchema.parse(await buildDiscoverHome({
        providerAdapters,
        podcast,
        discoverRequester: deps.discoverRequester,
        now: deps.now
      }))));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "discover-home" });
      return response;
    }

    if (path === "/podcast/search" && method === "GET") {
      const keywords = url.searchParams.get("keywords") ?? url.searchParams.get("keyword") ?? "";
      const limit = clampInt(url.searchParams.get("limit"), 6, 30, 18);
      response = json(ok(PodcastSearchResponseSchema.parse(await podcast.search({ keywords, limit }))));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "podcast-search" });
      return response;
    }

    if (path === "/podcast/hot" && method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 6, 30, 18);
      const offset = clampInt(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0);
      response = json(ok(PodcastHotResponseSchema.parse(await podcast.hot({ limit, offset }))));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "podcast-hot" });
      return response;
    }

    if (path === "/podcast/detail" && method === "GET") {
      const rid = url.searchParams.get("id") ?? url.searchParams.get("rid") ?? "";
      response = json(ok(PodcastDetailResponseSchema.parse(await podcast.detail({ rid }))));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "podcast-detail" });
      return response;
    }

    if (path === "/podcast/programs" && method === "GET") {
      const rid = url.searchParams.get("id") ?? url.searchParams.get("rid") ?? "";
      const limit = clampInt(url.searchParams.get("limit"), 10, 60, 30);
      const offset = clampInt(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0);
      response = json(ok(PodcastProgramsResponseSchema.parse(await podcast.programs({ rid, limit, offset }))));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "podcast-programs" });
      return response;
    }

    if (path === "/podcast/my" && method === "GET") {
      response = json(ok(PodcastMyResponseSchema.parse(await podcast.my())));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "podcast-my" });
      return response;
    }

    if (path === "/podcast/my/items" && method === "GET") {
      const key = url.searchParams.get("key") ?? "collect";
      const limit = clampInt(url.searchParams.get("limit"), 8, 60, 36);
      const offset = clampInt(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0);
      response = json(ok(PodcastMyItemsResponseSchema.parse(await podcast.myItems({ key, limit, offset }))));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "podcast-my-items" });
      return response;
    }

    if (path === "/podcast/dj-beatmap" && method === "GET") {
      const audioUrl = url.searchParams.get("url") ?? "";
      if (!/^https?:\/\//i.test(audioUrl)) {
        response = json(fail({ code: "BAD_REQUEST", message: "Invalid audio url", retryable: false }), 400);
        await logRequest(logger, { method, path, status: response.status, startedAt, action: "podcast-dj-beatmap" });
        return response;
      }
      response = json(ok(PodcastBeatmapResponseSchema.parse(await podcast.djBeatmap({
        url: audioUrl,
        durationSec: Number(url.searchParams.get("duration") ?? 0) || 0,
        introSec: Number(url.searchParams.get("intro") ?? 0) || 0
      }))));
      await logRequest(logger, { method, path, status: response.status, startedAt, action: "podcast-dj-beatmap" });
      return response;
    }

    if (path === "/search" && method === "GET") {
      const keyword = url.searchParams.get("keyword") ?? "";
      if (!keyword.trim()) {
        response = json(
          fail({
            code: "BAD_REQUEST",
            message: "keyword required",
            retryable: false
          }),
          400
        );
        await logRequest(logger, { method, path, status: response.status, startedAt });
        return response;
      }
      const providerRaw = url.searchParams.get("provider");
      const parsedProvider = providerRaw === null ? undefined : ProviderIdSchema.safeParse(providerRaw);
      if (parsedProvider && !parsedProvider.success) {
        response = json(
          fail({
            code: "NOT_FOUND",
            message: `unknown provider: ${providerRaw}`,
            retryable: false
          }),
          404
        );
        await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerRaw ?? undefined });
        return response;
      }
      const limit = parseLimit(url.searchParams.get("limit"));
      const provider = parsedProvider?.success ? parsedProvider.data : undefined;
      try {
        response = json(ok(await resolver.resolveSearch({ keyword, provider, limit })));
        await logRequest(logger, { method, path, status: response.status, startedAt, provider });
        return response;
      } catch (err) {
        response = json(normalizeError(provider ?? PROVIDER_IDS[0], err), statusFromError(err));
        await logRequest(logger, { method, path, status: response.status, startedAt, provider, error: err });
        return response;
      }
    }

    if (path === "/song-url" && method === "POST") {
      const body = await parseJsonBody(request);
      const parsedRequest = SongUrlRequestSchema.safeParse(body);
      const parsedTrack = parsedRequest.success ? { success: true as const, data: parsedRequest.data.track } : TrackSchema.safeParse(body);
      if (!parsedTrack.success) {
        response = json(
          fail({
            code: "BAD_REQUEST",
            message: "invalid or missing Track body",
            retryable: false
          }),
          400
        );
        await logRequest(logger, { method, path, status: response.status, startedAt });
        return response;
      }
      const quality = parsedRequest.success ? parsedRequest.data.quality : undefined;
      try {
        response = json(ok(await resolver.resolveSongUrl(parsedTrack.data, { quality })));
        await logRequest(logger, { method, path, status: response.status, startedAt, provider: parsedTrack.data.provider });
        return response;
      } catch (err) {
        response = json(normalizeError(parsedTrack.data.provider, err), statusFromError(err));
        await logRequest(logger, { method, path, status: response.status, startedAt, provider: parsedTrack.data.provider, error: err });
        return response;
      }
    }

    const match = path.match(/^\/providers\/([^/]+)\/(.+)$/);
    if (match) {
      const providerRaw = decodeURIComponent(match[1]);
      const sub = decodeURIComponent(match[2]);
      const parsed = ProviderIdSchema.safeParse(providerRaw);
      if (!parsed.success) {
        response = json(
          fail({
            code: "NOT_FOUND",
            message: `unknown provider: ${providerRaw}`,
            retryable: false
          }),
          404
        );
        await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerRaw });
        return response;
      }
      const providerId: ProviderId = parsed.data;
      const adapter = providerAdapters[providerId];

      try {
        if (sub === "login-qr-key" && method === "GET") {
          const qrLogin = qrLoginByProvider[providerId];
          response = json(ok(ProviderLoginQrKeySchema.parse(await qrLogin.createKey())));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "login-qr-create" && method === "GET") {
          const qrLogin = qrLoginByProvider[providerId];
          const key = url.searchParams.get("key")?.trim() ?? "";
          if (!key) {
            response = json(fail({
              code: "BAD_REQUEST",
              message: "QR key required",
              provider: providerId,
              retryable: false
            }), 400);
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          response = json(ok(ProviderLoginQrImageSchema.parse(await qrLogin.createImage(key))));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "login-qr-check" && method === "GET") {
          const qrLogin = qrLoginByProvider[providerId];
          const key = url.searchParams.get("key")?.trim() ?? "";
          if (!key) {
            response = json(fail({
              code: "BAD_REQUEST",
              message: "QR key required",
              provider: providerId,
              retryable: false
            }), 400);
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          response = json(ok(ProviderLoginQrCheckSchema.parse(await qrLogin.check(key))));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "session-cookie" && method === "POST") {
          const body = await parseJsonBody(request);
          const cookie =
            body && typeof body === "object" && "cookie" in body
              ? (body as { cookie?: unknown }).cookie
              : undefined;
          if (typeof cookie !== "string" || cookie.trim().length === 0) {
            response = json(
              fail({
                code: "BAD_REQUEST",
                message: "cookie required",
                provider: providerId,
                retryable: false
              }),
              400
            );
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          setRuntimeProviderCookie(providerId, cookie);
          response = json(ok(ProviderSessionCookieAckSchema.parse({ provider: providerId, stored: true })));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (
          (sub === "session-cookie" && method === "DELETE") ||
          (sub === "session-cookie/clear" && method === "POST")
        ) {
          clearRuntimeProviderCookie(providerId);
          response = json(ok(ProviderSessionCookieAckSchema.parse({ provider: providerId, stored: false })));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "login-status" && method === "GET") {
          response = json(ok(await adapter.loginStatus()));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "logout" && method === "POST") {
          const hadRuntimeOrEnvSession = !!getProviderCookie(providerId);
          clearRuntimeProviderCookie(providerId);
          try {
            await adapter.logout();
          } catch (err) {
            if (
              !hadRuntimeOrEnvSession ||
              !(err instanceof ProviderNotImplementedError && err.action === "no-session")
            ) {
              throw err;
            }
          }
          response = json(ok({ provider: providerId, loggedOut: true }));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "search" && method === "GET") {
          const keyword = url.searchParams.get("keyword") ?? "";
          if (!keyword.trim()) {
            response = json(
              fail({
                code: "BAD_REQUEST",
                message: "keyword required",
                provider: providerId,
                retryable: false
              }),
              400
            );
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          const limit = parseLimit(url.searchParams.get("limit"));
          response = json(ok(await adapter.search({ keyword, limit })));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "song-url" && method === "POST") {
          const body = await parseJsonBody(request);
          const parsedRequest = SongUrlRequestSchema.safeParse(body);
          const parsedTrack = parsedRequest.success ? { success: true as const, data: parsedRequest.data.track } : TrackSchema.safeParse(body);
          if (!parsedTrack.success) {
            response = json(
              fail({
                code: "BAD_REQUEST",
                message: "invalid or missing Track body",
                provider: providerId,
                retryable: false
              }),
              400
            );
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          response = json(ok(await adapter.songUrl(parsedTrack.data, { quality: parsedRequest.success ? parsedRequest.data.quality : undefined })));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "lyric" && method === "POST") {
          const body = await parseJsonBody(request);
          const parsedTrack = TrackSchema.safeParse(body);
          if (!parsedTrack.success) {
            response = json(
              fail({
                code: "BAD_REQUEST",
                message: "invalid or missing Track body",
                provider: providerId,
                retryable: false
              }),
              400
            );
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          response = json(ok(await adapter.lyric(parsedTrack.data)));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "playlists" && method === "GET") {
          response = json(ok(await adapter.playlistList()));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "like" && method === "POST") {
          const body = await parseJsonBody(request);
          const parsed = parseLikeBody(body);
          if (!parsed) {
            response = json(
              fail({
                code: "BAD_REQUEST",
                message: "invalid or missing like body",
                provider: providerId,
                retryable: false
              }),
              400
            );
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          if (!adapter.likeSong) {
            throw new ProviderNotImplementedError(providerId, "like");
          }
          response = json(ok(SongLikeAckSchema.parse(await adapter.likeSong(parsed.id, parsed.liked))));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "like-check" && method === "GET") {
          const ids = parseIds(url.searchParams.get("ids") ?? url.searchParams.get("id") ?? "");
          if (ids.length === 0) {
            response = json(
              fail({
                code: "BAD_REQUEST",
                message: "ids required",
                provider: providerId,
                retryable: false
              }),
              400
            );
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          if (!adapter.checkSongLikes) {
            throw new ProviderNotImplementedError(providerId, "like-check");
          }
          response = json(ok(SongLikeCheckAckSchema.parse(await adapter.checkSongLikes(ids))));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "playlists/add-song" && method === "POST") {
          const body = await parseJsonBody(request);
          const parsed = parsePlaylistAddSongBody(body);
          if (!parsed) {
            response = json(
              fail({
                code: "BAD_REQUEST",
                message: "invalid or missing playlist add body",
                provider: providerId,
                retryable: false
              }),
              400
            );
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          if (!adapter.addSongToPlaylist) {
            throw new ProviderNotImplementedError(providerId, "playlist-add-song");
          }
          response = json(ok(PlaylistAddSongAckSchema.parse(await adapter.addSongToPlaylist(parsed.playlistId, parsed.trackId))));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        const detailMatch = sub.match(/^playlists\/(.+)$/);
        if (detailMatch && method === "GET") {
          const id = decodeURIComponent(detailMatch[1]);
          response = json(ok(await adapter.playlistDetail(id)));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: "playlists/detail" });
          return response;
        }
        response = json(
          fail({
            code: "NOT_FOUND",
            message: `unknown route: ${method} ${path}`,
            retryable: false
          }),
          404
        );
        await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
        return response;
      } catch (err) {
        response = json(normalizeError(providerId, err), statusFromError(err));
        await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub, error: err });
        return response;
      }
    }

    response = json(
      fail({
        code: "NOT_FOUND",
        message: `unknown route: ${method} ${path}`,
        retryable: false
      }),
      404
    );
    await logRequest(logger, { method, path, status: response.status, startedAt });
    return response;
    } catch (err) {
      await logRequest(logger, { method, path, status: 500, startedAt, error: err });
      throw err;
    }
  };
}

export const routeHandler = createRouteHandler();

function parseLimit(limitRaw: string | null): number {
  const limitParsed = limitRaw === null ? NaN : Number(limitRaw);
  return Number.isFinite(limitParsed) && limitParsed > 0 ? Math.floor(limitParsed) : 20;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseWeatherRadioParams(url: URL): WeatherRadioParams {
  return {
    city: url.searchParams.get("city") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    location: url.searchParams.get("location") ?? undefined,
    lat: url.searchParams.get("lat") ?? undefined,
    lon: url.searchParams.get("lon") ?? undefined,
    timezone: url.searchParams.get("timezone") ?? undefined
  };
}

function parseIds(raw: string): string[] {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function parseLikeBody(body: unknown): { id: string; liked: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const source = body as { id?: unknown; liked?: unknown; like?: unknown };
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const likedRaw = source.liked ?? source.like;
  if (!id || typeof likedRaw !== "boolean") return null;
  return { id, liked: likedRaw };
}

function parsePlaylistAddSongBody(body: unknown): { playlistId: string; trackId: string } | null {
  if (!body || typeof body !== "object") return null;
  const source = body as { playlistId?: unknown; pid?: unknown; trackId?: unknown; id?: unknown };
  const playlistId = typeof source.playlistId === "string"
    ? source.playlistId.trim()
    : typeof source.pid === "string"
      ? source.pid.trim()
      : "";
  const trackId = typeof source.trackId === "string"
    ? source.trackId.trim()
    : typeof source.id === "string"
      ? source.id.trim()
      : "";
  if (!playlistId || !trackId) return null;
  return { playlistId, trackId };
}

function statusFromError(err: unknown): number {
  if (err instanceof ProviderNotImplementedError) return 501;
  return 500;
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    const text = await request.text();
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const logger = createSidecarLogger();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: port(),
    fetch: createRouteHandler({ logger })
  });
  void logger.log({
    event: "startup",
    hostname: server.hostname,
    port: server.port,
    appVersion: appVersion(),
    apiVersion: apiVersion(),
    schemaVersion: schemaVersion()
  });
  console.log(`[sidecar] listening on http://${server.hostname}:${server.port}`);
}

async function logRequest(
  logger: SidecarLogger,
  input: {
    method: string;
    path: string;
    status: number;
    startedAt: number;
    provider?: unknown;
    action?: unknown;
    error?: unknown;
  }
): Promise<void> {
  try {
    const entry: Record<string, unknown> = {
      event: "request",
      method: input.method,
      path: input.path,
      status: input.status,
      durationMs: Math.max(0, Math.round((performance.now() - input.startedAt) * 10) / 10)
    };
    if (input.provider !== undefined) entry.provider = input.provider;
    if (input.action !== undefined) entry.action = input.action;
    if (input.error !== undefined) {
      entry.error = errorSummary(input.error);
    }
    await logger.log(entry);
  } catch {
  }
}

function errorSummary(err: unknown): unknown {
  if (err instanceof ProviderNotImplementedError) return { name: "ProviderNotImplementedError", action: err.action };
  if (err instanceof Error) return redactLogValue({ name: err.name, message: err.message });
  return redactLogValue(err);
}

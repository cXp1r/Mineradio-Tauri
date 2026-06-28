import {
  HealthResponseSchema,
  ProviderIdSchema,
  SongUrlRequestSchema,
  TrackSchema,
  ProviderSessionCookieAckSchema,
  type CapabilityMatrix,
  type ProviderId,
  type Track
} from "@mineradio/shared";
import { appVersion, apiVersion, schemaVersion, port } from "./env";
import { ok, fail, json } from "./http/envelope";
import { providers, buildCapabilityMatrix, PROVIDER_IDS } from "./providers/registry";
import {
  ProviderNotImplementedError,
  type ProviderAdapter
} from "./providers/provider-adapter";
import { normalizeError } from "./services/fallback";
import { buildDiagnostics } from "./services/diagnostics";
import { resolveAudioProxy, type AudioProxy } from "./services/audio-proxy";
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
  clearRuntimeProviderCookie,
  setRuntimeProviderCookie
} from "./services/auth-session";

export type RouteHandlerDeps = {
  crossSourceResolver?: CrossSourceResolver;
  audioProxy?: AudioProxy;
  imageProxy?: ImageProxy;
  providerAdapters?: Record<ProviderId, ProviderAdapter>;
  logger?: SidecarLogger;
};

export function createRouteHandler(deps: RouteHandlerDeps = {}) {
  const resolver = deps.crossSourceResolver ?? crossSourceResolver;
  const audioProxy = deps.audioProxy ?? resolveAudioProxy;
  const imageProxy = deps.imageProxy ?? resolveImageProxy;
  const providerAdapters = deps.providerAdapters ?? providers;
  const logger = deps.logger ?? createSidecarLogger();

  return async function handleRoute(request: Request): Promise<Response> {
    const startedAt = performance.now();
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    let response: Response;

    try {
    if (path === "/health" && method === "GET") {
      const body = HealthResponseSchema.parse({
        ok: true,
        appVersion: appVersion(),
        apiVersion: apiVersion(),
        schemaVersion: schemaVersion(),
        providers: PROVIDER_IDS
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
          try {
            await adapter.logout();
          } finally {
            clearRuntimeProviderCookie(providerId);
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
          if (body === null) {
            response = json(
              fail({
                code: "BAD_REQUEST",
                message: "invalid or missing JSON body",
                provider: providerId,
                retryable: false
              }),
              400
            );
            await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
            return response;
          }
          response = json(ok(await adapter.lyric(body as Track)));
          await logRequest(logger, { method, path, status: response.status, startedAt, provider: providerId, action: sub });
          return response;
        }
        if (sub === "playlists" && method === "GET") {
          response = json(ok(await adapter.playlistList()));
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

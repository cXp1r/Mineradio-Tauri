import type { ProviderId, Track } from "@mineradio/shared";
import type { ProviderAdapter, SongUrlResult } from "../providers/provider-adapter";
import { ProviderError } from "../providers/provider-adapter";
import { providers as defaultProviders, PROVIDER_IDS } from "../providers/registry";

export type CrossSourceResolverDeps = {
  providers?: Record<ProviderId, ProviderAdapter>;
  providerOrder?: ProviderId[];
};

export type ResolveSearchQuery = {
  keyword: string;
  provider?: ProviderId;
  limit: number;
};

export type CrossSourceResolver = {
  resolveSearch(query: ResolveSearchQuery): Promise<Track[]>;
  resolveSongUrl(track: Track): Promise<SongUrlResult>;
};

export function createCrossSourceResolver(deps: CrossSourceResolverDeps = {}): CrossSourceResolver {
  const registry = deps.providers ?? defaultProviders;
  const providerOrder = deps.providerOrder ?? PROVIDER_IDS;

  function orderedProviders(preferred?: ProviderId): ProviderId[] {
    if (!preferred) return providerOrder;
    return [preferred, ...providerOrder.filter(id => id !== preferred)];
  }

  async function resolveSearch(query: ResolveSearchQuery): Promise<Track[]> {
    const attempts = orderedProviders(query.provider);
    let firstError: unknown;
    let firstProvider = attempts[0];

    for (const providerId of attempts) {
      const adapter = registry[providerId];
      if (!adapter) continue;
      firstProvider ??= providerId;
      try {
        const tracks = await adapter.search({ keyword: query.keyword, limit: query.limit });
        if (tracks.length > 0) return tracks;
        firstError ??= new ProviderError(providerId, "NO_RESULT", "no matching tracks found", {
          retryable: false
        });
      } catch (err) {
        firstError ??= err;
      }
    }

    if (firstError) throw firstError;
    throw new ProviderError(firstProvider, "NO_RESULT", "no matching tracks found", {
      retryable: false
    });
  }

  async function resolveSongUrl(track: Track): Promise<SongUrlResult> {
    const attempts = orderedProviders(track.provider);
    let firstError: unknown;

    for (const providerId of attempts) {
      const adapter = registry[providerId];
      if (!adapter) continue;

      try {
        if (providerId === track.provider) {
          return await adapter.songUrl(track);
        }

        const keyword = buildSwitchKeyword(track);
        const candidates = await adapter.search({ keyword, limit: 5 });
        for (const candidate of candidates) {
          try {
            return await adapter.songUrl(candidate);
          } catch (err) {
            firstError ??= err;
          }
        }
      } catch (err) {
        firstError ??= err;
      }
    }

    if (firstError) throw firstError;
    throw new ProviderError(track.provider, "NO_URL", "no playable song URL found", {
      retryable: true
    });
  }

  return { resolveSearch, resolveSongUrl };
}

function buildSwitchKeyword(track: Track): string {
  return [track.title, ...track.artists].map(part => part.trim()).filter(Boolean).join(" ");
}

export const crossSourceResolver = createCrossSourceResolver();

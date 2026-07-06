import type { PlaybackQuality, ProviderId, Track } from "@mineradio/shared";
import type { ProviderAdapter, SongUrlOptions, SongUrlResult } from "../providers/provider-adapter";
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
  resolveSongUrl(track: Track, opts?: SongUrlOptions): Promise<SongUrlResult>;
};

export function createCrossSourceResolver(deps: CrossSourceResolverDeps = {}): CrossSourceResolver {
  const registry = deps.providers ?? defaultProviders;
  const providerOrder = deps.providerOrder ?? PROVIDER_IDS;

  function orderedProviders(preferred?: ProviderId): ProviderId[] {
    if (!preferred) return providerOrder;
    return [preferred, ...providerOrder.filter(id => id !== preferred)];
  }

  async function resolveSearch(query: ResolveSearchQuery): Promise<Track[]> {
    if (!query.provider) {
      return resolveMergedSearch(query);
    }

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

  async function resolveMergedSearch(query: ResolveSearchQuery): Promise<Track[]> {
    const settled = await Promise.allSettled(providerOrder.map(async (providerId, providerIndex) => {
      const adapter = registry[providerId];
      if (!adapter) return [];
      const tracks = await adapter.search({ keyword: query.keyword, limit: mergedProviderLimit(providerId, query.limit) });
      return tracks.map((track, sourceIndex) => ({
        track,
        providerIndex,
        sourceIndex,
        score: scoreSearchTrack(track, query.keyword, sourceIndex),
      }));
    }));

    const ranked: Array<{ track: Track; providerIndex: number; sourceIndex: number; score: number }> = [];
    let firstError: unknown;
    for (const result of settled) {
      if (result.status === "fulfilled") ranked.push(...result.value);
      else firstError ??= result.reason;
    }

    const seen = new Set<string>();
    const merged = ranked
      .filter(({ track }) => {
        const key = `${track.provider}:${track.id || track.sourceId || `${track.title}|${track.artists.join("/")}`}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff) return scoreDiff;
        const providerDiff = a.providerIndex - b.providerIndex;
        if (providerDiff) return providerDiff;
        return a.sourceIndex - b.sourceIndex;
      })
      .slice(0, mergedResultLimit(query.limit))
      .map(({ track }) => track);

    if (merged.length > 0) return merged;
    if (firstError) throw firstError;
    throw new ProviderError(providerOrder[0] ?? "netease", "NO_RESULT", "no matching tracks found", {
      retryable: false
    });
  }

  async function resolveSongUrl(track: Track, opts: { quality?: PlaybackQuality } = {}): Promise<SongUrlResult> {
    const importOnly = isImportOnlyTrack(track);
    const attempts = orderedProviders(importOnly ? undefined : track.provider);
    let firstError: unknown;

    for (const providerId of attempts) {
      const adapter = registry[providerId];
      if (!adapter) continue;

      try {
        if (!importOnly && providerId === track.provider) {
          return await adapter.songUrl(track, opts);
        }

        const keyword = buildSwitchKeyword(track);
        const candidates = await adapter.search({ keyword, limit: 5 });
        for (const candidate of candidates) {
          try {
            return await adapter.songUrl(candidate, opts);
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

function isImportOnlyTrack(track: Track): boolean {
  return /^import:/i.test(track.id) || /^import:/i.test(track.sourceId);
}

function buildSwitchKeyword(track: Track): string {
  return [track.title, ...track.artists].map(part => part.trim()).filter(Boolean).join(" ");
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, "")
    .replace(/[\s·・,，。.!！?？'"“”‘’|\-_/]+/g, "");
}

function scoreSearchTrack(track: Track, keyword: string, sourceIndex: number): number {
  const q = normalizeSearchText(keyword);
  const title = normalizeSearchText(track.title);
  const artists = normalizeSearchText(track.artists.join(""));
  const album = normalizeSearchText(track.album ?? "");
  const raw = `${track.title} ${track.artists.join(" ")} ${track.album ?? ""}`.toLowerCase();
  const asksDerivative = /(live|现场|翻唱|cover|伴奏|instrumental|remix|dj|片段|demo|女声|男声|karaoke)/i.test(keyword);
  const derivative = searchLooksLikeDerivative(raw);
  const artistMentioned = searchMentionsKnownArtist(keyword, track.artists.join(" "));
  const originalArtists = canonicalOriginalArtistsForSearch(keyword, track);
  const originalArtistMatch = songArtistMatchesAny(track, originalArtists);
  let score = 0;
  if (title === q) score += 90;
  else if (title.startsWith(q)) score += 55;
  else if (title.includes(q)) score += 32;
  if (title && q && q.includes(title)) score += title.length >= 2 ? 68 : 18;
  if (originalArtistMatch && title && q && (title === q || q.includes(title) || title.includes(q))) score += 122;
  else if (!asksDerivative && originalArtists.length && title && q && (title === q || q.includes(title) || title.includes(q))) score -= 58;
  if (artistMentioned) score += 96;
  else if (artists && q && q.includes(artists)) score += 64;
  else if (artists && artists.includes(q)) score += 22;
  if (artistMentioned && title && q.includes(title)) score += 34;
  if (/周杰伦|周杰倫|jay\s*chou/i.test(keyword) && !artistMentioned) score -= 28;
  if (album && (album.includes(q) || q.includes(album))) score += 8;
  if (track.provider === "qq") score += searchIntentPrefersQQ(keyword) ? 48 : 4;
  if (track.playableState !== "playable" && track.playableState !== "unknown" && track.playableState !== "trial_only") score -= 12;
  if (!asksDerivative) {
    if (derivative) score -= artistMentioned ? 76 : 96;
    if (/(live|现场)/i.test(raw)) score -= artistMentioned ? 28 : 42;
    if (originalArtists.length && searchLooksLikeSameTitleCover(track, q, title, album, raw, originalArtistMatch, sourceIndex)) score -= 46;
  }
  score -= sourceIndex * 0.75;
  return score;
}

function mergedProviderLimit(providerId: ProviderId, requestedLimit: number): number {
  if (requestedLimit >= 18) return providerId === "qq" ? 12 : 14;
  return requestedLimit;
}

function mergedResultLimit(requestedLimit: number): number {
  return requestedLimit >= 18 ? 18 : requestedLimit;
}

function searchIntentPrefersQQ(keyword: string): boolean {
  return /(^|\s)qq($|\s)|qq音乐|qq音樂|周杰伦|周杰倫|jay\s*chou|jay/i.test(keyword.toLowerCase());
}

function searchMentionsKnownArtist(keyword: string, artist: string): boolean {
  const rawQ = keyword.toLowerCase();
  const rawArtist = artist.toLowerCase();
  if (!rawArtist) return false;
  if (/周杰伦|周杰倫|jay\s*chou/.test(rawQ) && /周杰伦|周杰倫|jay\s*chou/.test(rawArtist)) return true;
  const q = normalizeSearchText(keyword);
  const a = normalizeSearchText(artist);
  return !!(a && a.length >= 2 && q.includes(a));
}

function searchLooksLikeDerivative(text: string): boolean {
  return /(翻唱|cover|伴奏|instrumental|remix|片段|demo|女声|男声|karaoke|完整版\s*cover|抖音版|dj版|合唱版|改编版|赵露思版|超燃|硬曲|剪辑|二创|tribute|made\s*famous\s*by)/i.test(text);
}

function canonicalOriginalArtistsForSearch(keyword: string, track: Track): string[] {
  const q = normalizeSearchText(keyword);
  const title = normalizeSearchText(track.title);
  const joined = `${q} ${title}`;
  const artists: string[] = [];
  const rules = [
    { titles: ["日落大道"], artists: ["梁博"] },
    { titles: ["beautyandabeat", "beauty and a beat"], artists: ["justin bieber", "nicki minaj"] },
  ];
  for (const rule of rules) {
    const matched = rule.titles.some((candidate) => {
      const normalizedTitle = normalizeSearchText(candidate);
      const titleMatches = !!(title && (title === normalizedTitle || title.includes(normalizedTitle)));
      return !!(normalizedTitle && (joined.includes(normalizedTitle) || titleMatches));
    });
    if (!matched) continue;
    for (const artist of rule.artists) {
      if (!artists.includes(artist)) artists.push(artist);
    }
  }
  return artists;
}

function songArtistMatchesAny(track: Track, artists: string[]): boolean {
  const trackArtist = normalizeSearchText(track.artists.join(""));
  if (!trackArtist || artists.length === 0) return false;
  return artists.some((artist) => {
    const normalized = normalizeSearchText(artist);
    return !!(normalized && (trackArtist.includes(normalized) || normalized.includes(trackArtist)));
  });
}

function searchLooksLikeSameTitleCover(
  track: Track,
  q: string,
  title: string,
  album: string,
  raw: string,
  originalArtistMatch: boolean,
  sourceIndex: number,
): boolean {
  if (!q || !title || originalArtistMatch) return false;
  const sameTitle = title === q || q.includes(title) || title.startsWith(q);
  if (!sameTitle) return false;
  const selfTitledSingle = !!(album && (album === title || album === q || album.includes(title) || title.includes(album)));
  return selfTitledSingle || searchLooksLikeDerivative(raw) || sourceIndex > 0 || track.playableState === "unavailable";
}

export const crossSourceResolver = createCrossSourceResolver();

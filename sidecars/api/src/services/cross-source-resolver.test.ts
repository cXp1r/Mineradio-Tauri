import { expect, test } from "bun:test";
import type { ProviderId, Track } from "@mineradio/shared";
import { ProviderError, type ProviderAdapter } from "../providers/provider-adapter";
import { createCrossSourceResolver } from "./cross-source-resolver";

type Calls = string[];

const baseTrack: Track = {
  provider: "netease",
  id: "n-1",
  sourceId: "n-1",
  title: "夜航",
  artists: ["星野"],
  album: "",
  coverUrl: "",
  qualityHints: [],
  playableState: "playable"
};

function adapter(
  id: ProviderId,
  overrides: Partial<ProviderAdapter>,
  calls: Calls
): ProviderAdapter {
  return {
    id,
    async search(query) {
      calls.push(`${id}:search:${query.keyword}:${query.limit}`);
      return [];
    },
    async songUrl(track) {
      calls.push(`${id}:songUrl:${track.id}`);
      throw new ProviderError(id, "NO_URL", `${id} no url`);
    },
    async lyric() {
      throw new ProviderError(id, "NO_LYRIC", `${id} no lyric`);
    },
    async playlistList() {
      throw new ProviderError(id, "NO_PLAYLISTS", `${id} no playlists`);
    },
    async playlistDetail() {
      throw new ProviderError(id, "NO_PLAYLIST", `${id} no playlist`);
    },
    async loginStatus() {
      return { provider: id, loggedIn: false };
    },
    async logout() {},
    ...overrides
  };
}

test("resolveSearch returns first successful non-empty preferred provider result", async () => {
  const calls: Calls = [];
  const resolver = createCrossSourceResolver({
    providers: {
      netease: adapter(
        "netease",
        {
          async search(query) {
            calls.push(`netease:search:${query.keyword}:${query.limit}`);
            return [{ ...baseTrack, title: query.keyword }];
          }
        },
        calls
      ),
      qq: adapter("qq", {}, calls)
    },
    providerOrder: ["netease", "qq"]
  });

  const result = await resolver.resolveSearch({ keyword: "夜航", provider: "netease", limit: 5 });

  expect(result).toEqual([{ ...baseTrack, title: "夜航" }]);
  expect(calls).toEqual(["netease:search:夜航:5"]);
});

test("resolveSearch falls back when preferred provider fails or returns empty", async () => {
  const calls: Calls = [];
  const qqTrack: Track = { ...baseTrack, provider: "qq", id: "q-1", sourceId: "q-1" };
  const resolver = createCrossSourceResolver({
    providers: {
      netease: adapter(
        "netease",
        {
          async search(query) {
            calls.push(`netease:search:${query.keyword}:${query.limit}`);
            return [];
          }
        },
        calls
      ),
      qq: adapter(
        "qq",
        {
          async search(query) {
            calls.push(`qq:search:${query.keyword}:${query.limit}`);
            return [qqTrack];
          }
        },
        calls
      )
    },
    providerOrder: ["netease", "qq"]
  });

  const result = await resolver.resolveSearch({ keyword: "夜航", provider: "netease", limit: 3 });

  expect(result).toEqual([qqTrack]);
  expect(calls).toEqual(["netease:search:夜航:3", "qq:search:夜航:3"]);
});

test("resolveSearch throws the preferred provider normalized error when every provider fails", async () => {
  const resolver = createCrossSourceResolver({
    providers: {
      netease: adapter(
        "netease",
        {
          async search() {
            throw new ProviderError("netease", "LOGIN_REQUIRED", "netease login", {
              retryable: true,
              action: "login"
            });
          }
        },
        []
      ),
      qq: adapter(
        "qq",
        {
          async search() {
            throw new ProviderError("qq", "NO_RESULT", "qq fail");
          }
        },
        []
      )
    },
    providerOrder: ["netease", "qq"]
  });

  let caught: unknown;
  try {
    await resolver.resolveSearch({ keyword: "夜航", provider: "netease", limit: 20 });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProviderError);
  const providerError = caught as ProviderError;
  expect(providerError.provider).toBe("netease");
  expect(providerError.code).toBe("LOGIN_REQUIRED");
  expect(providerError.action).toBe("login");
});

test("resolveSearch keeps preferred provider error when preferred is empty and fallback throws", async () => {
  const resolver = createCrossSourceResolver({
    providers: {
      netease: adapter(
        "netease",
        {
          async search() {
            return [];
          }
        },
        []
      ),
      qq: adapter(
        "qq",
        {
          async search() {
            throw new ProviderError("qq", "UPSTREAM", "qq upstream");
          }
        },
        []
      )
    },
    providerOrder: ["netease", "qq"]
  });

  let caught: unknown;
  try {
    await resolver.resolveSearch({ keyword: "夜航", provider: "netease", limit: 20 });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProviderError);
  const providerError = caught as ProviderError;
  expect(providerError.provider).toBe("netease");
  expect(providerError.code).toBe("NO_RESULT");
});

test("resolveSongUrl tries direct provider first and returns its URL", async () => {
  const calls: Calls = [];
  const resolver = createCrossSourceResolver({
    providers: {
      netease: adapter(
        "netease",
        {
          async songUrl(track) {
            calls.push(`netease:songUrl:${track.id}`);
            return { url: "https://n.example/song.mp3", proxied: false };
          }
        },
        calls
      ),
      qq: adapter("qq", {}, calls)
    },
    providerOrder: ["netease", "qq"]
  });

  const result = await resolver.resolveSongUrl(baseTrack);

  expect(result).toEqual({ url: "https://n.example/song.mp3", proxied: false });
  expect(calls).toEqual(["netease:songUrl:n-1"]);
});

test("resolveSongUrl searches fallback provider by title and artists before calling fallback songUrl", async () => {
  const calls: Calls = [];
  const qqCandidate: Track = {
    ...baseTrack,
    provider: "qq",
    id: "q-9",
    sourceId: "q-9"
  };
  const resolver = createCrossSourceResolver({
    providers: {
      netease: adapter(
        "netease",
        {
          async songUrl(track) {
            calls.push(`netease:songUrl:${track.id}`);
            throw new ProviderError("netease", "NO_URL", "netease no url");
          }
        },
        calls
      ),
      qq: adapter(
        "qq",
        {
          async search(query) {
            calls.push(`qq:search:${query.keyword}:${query.limit}`);
            return [qqCandidate];
          },
          async songUrl(track) {
            calls.push(`qq:songUrl:${track.id}`);
            return { url: "https://q.example/song.mp3", proxied: false };
          }
        },
        calls
      )
    },
    providerOrder: ["netease", "qq"]
  });

  const result = await resolver.resolveSongUrl(baseTrack);

  expect(result).toEqual({ url: "https://q.example/song.mp3", proxied: false });
  expect(calls).toEqual(["netease:songUrl:n-1", "qq:search:夜航 星野:5", "qq:songUrl:q-9"]);
});

import { expect, test } from "bun:test";
import { ProviderNotImplementedError } from "../provider-adapter";
import { createSodaAdapter } from "./soda-adapter";
import { createSodaClient } from "./soda-client";
import { mapSodaSongToTrack, mapSodaPlaylistToSummary } from "./map";

test("soda mapping helpers produce provider-shaped objects", () => {
  const track = mapSodaSongToTrack({
    id: 123,
    title: "Demo Song",
    artist: "Alice / Bob",
    albumName: "Demo Album",
    coverUrl: "//cdn.example.com/cover.jpg",
    durationMs: 215000
  });
  expect(track.provider).toBe("soda");
  expect(track.id).toBe("123");
  expect(track.artists).toEqual(["Alice", "Bob"]);
  expect(track.coverUrl).toBe("https://cdn.example.com/cover.jpg");
  expect(track.qualityHints).toEqual(["standard"]);

  const playlist = mapSodaPlaylistToSummary({
    id: "pl-1",
    name: "Favorites",
    trackCount: 12,
    trackIds: ["1", 2, 3]
  });
  expect(playlist.provider).toBe("soda");
  expect(playlist.trackIds).toEqual(["1", "2", "3"]);
});

test("soda client search requests qishui track search with keyword", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createSodaClient({
    getConfig() {
      return { cookie: "soda_session=abc123" };
    },
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ data: { list: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.search({ keyword: "hectopascal", limit: 10 });
  const url = new URL(calls[0]?.input ?? "");
  expect(url.origin + url.pathname).toBe("https://api.qishui.com/luna/pc/search/track");
  expect(url.searchParams.get("q")).toBe("hectopascal");
  expect(url.searchParams.get("aid")).toBe("386088");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.headers).toMatchObject({ cookie: "soda_session=abc123" });
});

test("soda adapter maps search results from client", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    },
    client: {
      search: async () => ({
        body: {
          result_groups: [
            {
              data: [
                {
                  meta: { item_type: "track" },
                  entity: {
                    track: {
                      id: "soda-1",
                      name: "Hectopascal",
                      artists: [{ id: "artist-1", name: "Yui" }],
                      album: { id: "album-1", name: "Bloom" },
                      duration: 180000,
                      preview: { start: 30000, duration: 60000 }
                    }
                  }
                }
              ]
            }
          ]
        }
      }),
      songUrl: async () => ({ body: {} }),
      lyric: async () => ({ body: {} }),
      playlistList: async () => ({ body: {} }),
      playlistDetail: async () => ({ body: {} }),
      loginStatus: async () => ({ body: {} }),
      logout: async () => ({ body: {} })
    }
  });

  const tracks = await adapter.search({ keyword: "hectopascal", limit: 10 });
  expect(tracks).toEqual([
    {
      provider: "soda",
      id: "soda-1",
      sourceId: "soda-1",
      mediaMid: undefined,
      title: "Hectopascal",
      artists: ["Yui"],
      album: "Bloom",
      coverUrl: "",
      durationMs: 180000,
      qualityHints: ["standard"],
      playableState: "trial_only"
    }
  ]);
});

test("soda adapter keeps non-search actions scaffolded as not yet implemented", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    }
  });

  try {
    await adapter.logout();
    throw new Error("expected logout to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderNotImplementedError);
  }
});

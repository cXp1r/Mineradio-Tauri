import { expect, test } from "bun:test";
import { ProviderNotImplementedError } from "../provider-adapter";
import { createSodaAdapter } from "./soda-adapter";
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

  const playlist = mapSodaPlaylistToSummary({
    id: "pl-1",
    name: "Favorites",
    trackCount: 12,
    trackIds: ["1", 2, 3]
  });
  expect(playlist.provider).toBe("soda");
  expect(playlist.trackIds).toEqual(["1", "2", "3"]);
});

test("soda adapter is scaffolded as not yet implemented", async () => {
  const adapter = createSodaAdapter({
    getConfig() {
      return {};
    }
  });

  try {
    await adapter.search({ keyword: "demo", limit: 10 });
    throw new Error("expected search to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderNotImplementedError);
  }

  try {
    await adapter.logout();
    throw new Error("expected logout to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderNotImplementedError);
  }
});

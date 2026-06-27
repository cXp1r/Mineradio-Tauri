import { expect, test } from "bun:test";
import { TrackSchema } from "./track";

test("track schema parses unified provider track", () => {
  const track = TrackSchema.parse({
    provider: "netease",
    id: "123",
    sourceId: "123",
    title: "Song",
    artists: ["Artist"],
    album: "Album",
    coverUrl: "https://example.com/cover.jpg",
    durationMs: 210000,
    qualityHints: ["standard", "lossless"],
    playableState: "unknown"
  });
  expect(track.provider).toBe("netease");
});
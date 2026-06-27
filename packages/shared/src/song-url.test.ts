import { expect, test } from "bun:test";
import { SongUrlResultSchema } from "./song-url";

test("SongUrlResultSchema parses a valid url result", () => {
	const parsed = SongUrlResultSchema.parse({
		url: "https://example.com/audio.mp3",
		proxied: true,
	});
	expect(parsed.url).toBe("https://example.com/audio.mp3");
	expect(parsed.proxied).toBe(true);
});

test("SongUrlResultSchema rejects missing url", () => {
	const result = SongUrlResultSchema.safeParse({ proxied: false });
	expect(result.success).toBe(false);
});

test("SongUrlResultSchema rejects missing proxied flag", () => {
	const result = SongUrlResultSchema.safeParse({ url: "https://example.com/a.mp3" });
	expect(result.success).toBe(false);
});

test("SongUrlResultSchema rejects wrong proxied type", () => {
	const result = SongUrlResultSchema.safeParse({ url: "https://example.com/a.mp3", proxied: "yes" });
	expect(result.success).toBe(false);
});
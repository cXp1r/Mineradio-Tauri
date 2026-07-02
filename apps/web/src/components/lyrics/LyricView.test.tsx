import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LyricView } from "./LyricView";
import type { LyricPayload } from "@mineradio/shared";

function payload(lines: Array<{ timeMs: number; text: string }>): LyricPayload {
	return {
		provider: "netease",
		trackId: "t1",
		lines: lines.map((l) => ({ timeMs: l.timeMs, text: l.text })),
		hasTranslation: false,
		isWordByWord: false,
	};
}

test("LyricView renders no-lyrics placeholder for empty payload", () => {
	const html = renderToStaticMarkup(<LyricView payload={null} positionMs={0} />);
	expect(html).toContain("no lyrics");
});

test("LyricView renders all lines and highlights current line", () => {
	const p = payload([
		{ timeMs: 0, text: "first" },
		{ timeMs: 2000, text: "second" },
		{ timeMs: 4000, text: "third" },
	]);
	const html = renderToStaticMarkup(<LyricView payload={p} positionMs={2200} />);
	expect(html).toContain("first");
	expect(html).toContain("second");
	expect(html).toContain("third");
	const matches = html.match(/lyric-current/g);
	expect(matches?.length).toBe(1);
	expect(html).toContain('data-index="1"');
	expect(html).toContain("lyric-current");
});

test("LyricView virtualizes long lyric payloads while preserving visible current line", () => {
	const p = payload(Array.from({ length: 180 }, (_, index) => ({
		timeMs: index * 1000,
		text: `line-${index}`,
	})));
	const html = renderToStaticMarkup(<LyricView payload={p} positionMs={2200} />);
	const renderedLines = html.match(/class="lyric-line/g) ?? [];

	expect(html).toContain('data-virtualized="true"');
	expect(renderedLines.length).toBeLessThan(60);
	expect(html).toContain("line-0");
	expect(html).toContain("line-2");
	expect(html).toContain('data-index="2"');
	expect(html).toContain("lyric-current");
	expect(html).not.toContain("line-179");
});

test("LyricView highlights index 0 at position 0", () => {
	const p = payload([
		{ timeMs: 0, text: "a" },
		{ timeMs: 1000, text: "b" },
	]);
	const html = renderToStaticMarkup(<LyricView payload={p} positionMs={0} />);
	const matches = html.match(/lyric-current/g);
	expect(matches?.length).toBe(1);
	expect(html).toContain('data-index="0"');
});

test("LyricView defends against interleaved NCM lrc order defensively sorted", () => {
	const p = payload([
		{ timeMs: 4000, text: "third" },
		{ timeMs: 0, text: "first" },
		{ timeMs: 2000, text: "second" },
	]);
	const html = renderToStaticMarkup(<LyricView payload={p} positionMs={2200} />);
	expect(html).toContain("lyric-current");
	expect(html).toContain('data-index="1"');
});

import { expect, test } from "bun:test";
import { SidecarClient, SidecarClientError } from "./sidecar-client";
import type { Track } from "@mineradio/shared";

const BASE = "http://127.0.0.1:65535";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function withFetch<T>(fake: typeof fetch, fn: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = fake;
	return fn().finally(() => {
		globalThis.fetch = original;
	});
}

test("health parses a valid HealthResponse", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		jsonResponse({
			ok: true,
			appVersion: "0.9.0",
			apiVersion: "0.1.0",
			schemaVersion: "0.1.0",
			providers: [],
		})) as typeof fetch;
	try {
		const client = new SidecarClient(BASE);
		const h = await client.health();
		expect(h.ok).toBe(true);
		expect(h.apiVersion).toBe("0.1.0");
		expect(h.providers).toEqual([]);
	} finally {
		globalThis.fetch = original;
	}
});

test("health 500 throws SidecarClientError", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
	try {
		const client = new SidecarClient(BASE);
		let caught: unknown = null;
		try {
			await client.health();
		} catch (e) {
			caught = e;
		}
		expect(caught instanceof SidecarClientError).toBe(true);
		expect((caught as SidecarClientError).code).toBe("HTTP_500");
		expect((caught as SidecarClientError).retryable).toBe(true);
	} finally {
		globalThis.fetch = original;
	}
});

test("capabilities parses a valid success envelope", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		jsonResponse({
			ok: true,
			data: {
				version: "0.1.0",
				providers: [
					{
						providerId: "netease",
						available: false,
						capabilities: [],
						message: "pending",
					},
				],
			},
		})) as typeof fetch;
	try {
		const client = new SidecarClient(BASE);
		const matrix = await client.capabilities();
		expect(matrix.version).toBe("0.1.0");
		expect(matrix.providers.length).toBe(1);
		expect(matrix.providers[0].providerId).toBe("netease");
	} finally {
		globalThis.fetch = original;
	}
});

const SAMPLE_TRACK: Track = {
	provider: "netease",
	id: "t1",
	sourceId: "t1",
	title: "Song",
	artists: ["Artist"],
	album: "Album",
	coverUrl: "https://example.com/cover.jpg",
	qualityHints: ["standard"],
	playableState: "playable",
};

test("search parses a success envelope of Track[]", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/search");
		expect(url).toContain("keyword=hello");
		expect(url).toContain("limit=30");
		void init;
		return jsonResponse({
			ok: true,
			data: [SAMPLE_TRACK, { ...SAMPLE_TRACK, id: "t2", title: "Two" }],
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const tracks = await client.search("netease", "hello", 30);
		expect(tracks.length).toBe(2);
		expect(tracks[0].id).toBe("t1");
		expect(tracks[1].title).toBe("Two");
	});
});

test("search throws SidecarClientError on ok:false", async () => {
	const fake = (async () =>
		jsonResponse({
			ok: false,
			error: { code: "PROVIDER_ERROR", message: "boom", retryable: false },
		})) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		let caught: unknown = null;
		try {
			await client.search("netease", "x", 5);
		} catch (e) {
			caught = e;
		}
		expect(caught instanceof SidecarClientError).toBe(true);
		expect((caught as SidecarClientError).code).toBe("PROVIDER_ERROR");
	});
});

test("songUrl POSTs the Track body and parses the SongUrlResult envelope", async () => {
	let receivedBody: unknown = null;
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/song-url");
		expect(init?.method).toBe("POST");
		receivedBody = JSON.parse(String(init?.body ?? "{}"));
		return jsonResponse({
			ok: true,
			data: { url: "https://proxied/a.mp3", proxied: true },
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const result = await client.songUrl(SAMPLE_TRACK);
		expect(result.url).toBe("https://proxied/a.mp3");
		expect(result.proxied).toBe(true);
		expect((receivedBody as { id: string }).id).toBe("t1");
	});
});

test("lyric POSTs the Track body and parses the LyricPayload envelope", async () => {
	let called = false;
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/lyric");
		expect(init?.method).toBe("POST");
		called = true;
		return jsonResponse({
			ok: true,
			data: {
				provider: "netease",
				trackId: "t1",
				lines: [{ timeMs: 0, text: "hello" }],
				hasTranslation: false,
				isWordByWord: false,
			},
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const lyric = await client.lyric(SAMPLE_TRACK);
		expect(lyric.trackId).toBe("t1");
		expect(lyric.lines.length).toBe(1);
		expect(lyric.lines[0].text).toBe("hello");
	});
	expect(called).toBe(true);
});

test("playlistDetail GETs the playlist by id", async () => {
	const fake = (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/playlists/p10");
		return jsonResponse({
			ok: true,
			data: {
				provider: "netease",
				id: "p10",
				name: "Hot",
				trackCount: 2,
				trackIds: ["t1", "t2"],
				tracks: [SAMPLE_TRACK],
			},
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const detail = await client.playlistDetail("netease", "p10");
		expect(detail.name).toBe("Hot");
		expect(detail.tracks.length).toBe(1);
		expect(detail.tracks[0].id).toBe("t1");
	});
});

test("setProviderSessionCookie POSTs cookie and accepts ack without retaining cookie", async () => {
	let receivedBody: unknown = null;
	const secret = "MUSIC_U=web-secret";
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/session-cookie");
		expect(init?.method).toBe("POST");
		receivedBody = JSON.parse(String(init?.body ?? "{}"));
		return jsonResponse({
			ok: true,
			data: { provider: "netease", stored: true },
		});
	}) as typeof fetch;

	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const ack = await client.setProviderSessionCookie("netease", secret);
		expect(ack).toEqual({ provider: "netease", stored: true });
		expect(receivedBody).toEqual({ cookie: secret });
		expect(JSON.stringify(ack)).not.toContain(secret);
	});
});

test("clearProviderSessionCookie DELETEs cookie and accepts clear ack", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/qq/session-cookie");
		expect(init?.method).toBe("DELETE");
		return jsonResponse({
			ok: true,
			data: { provider: "qq", stored: false },
		});
	}) as typeof fetch;

	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const ack = await client.clearProviderSessionCookie("qq");
		expect(ack).toEqual({ provider: "qq", stored: false });
	});
});

test("songUrl 500 throws SidecarClientError", async () => {
	const fake = (async () => new Response("", { status: 500 })) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		let caught: unknown = null;
		try {
			await client.songUrl(SAMPLE_TRACK);
		} catch (e) {
			caught = e;
		}
		expect(caught instanceof SidecarClientError).toBe(true);
		expect((caught as SidecarClientError).code).toBe("HTTP_500");
	});
});

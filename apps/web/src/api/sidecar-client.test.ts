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

test("searchAll uses the cross-source search endpoint", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/search");
		expect(url).toContain("keyword=hello");
		expect(url).toContain("limit=30");
		expect(url).not.toContain("/providers/");
		void init;
		return jsonResponse({ ok: true, data: [SAMPLE_TRACK] });
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const tracks = await client.searchAll("hello", 30);
		expect(tracks[0].id).toBe("t1");
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

test("resolveSongUrl POSTs to the cross-source song-url endpoint", async () => {
	let receivedBody: unknown = null;
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/song-url");
		expect(url).not.toContain("/providers/");
		expect(init?.method).toBe("POST");
		receivedBody = JSON.parse(String(init?.body ?? "{}"));
		return jsonResponse({
			ok: true,
			data: { url: "https://media.example/a.mp3", proxied: false, requestedQuality: "lossless" },
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const result = await client.resolveSongUrl(SAMPLE_TRACK, "lossless");
		expect(result.proxied).toBe(false);
		expect(result.requestedQuality).toBe("lossless");
		expect(receivedBody).toEqual({ track: SAMPLE_TRACK, quality: "lossless" });
		expect(client.audioProxyUrl(result.url)).toBe(`${BASE}/audio-proxy?url=https%3A%2F%2Fmedia.example%2Fa.mp3`);
	});
});

test("imageProxyUrl mirrors baseline cover proxy URL construction for remote covers only", () => {
	const client = new SidecarClient(BASE);
	expect(client.imageProxyUrl("https://img.example/a.jpg")).toBe(`${BASE}/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg`);
	expect(client.imageProxyUrl("http://img.example/a.jpg")).toBe(`${BASE}/image-proxy?url=http%3A%2F%2Fimg.example%2Fa.jpg`);
	expect(client.imageProxyUrl("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
	expect(client.imageProxyUrl("blob:http://local/abc")).toBe("blob:http://local/abc");
	expect(client.imageProxyUrl("file:///tmp/a.jpg")).toBe("");
	expect(client.imageProxyUrl("")).toBe("");
});

test("imageProxyUrl supports baseline cache-bust parameter", () => {
	const client = new SidecarClient(BASE);
	expect(client.imageProxyUrl("https://img.example/a.jpg", true, 12345)).toBe(`${BASE}/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg&v=12345`);
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

test("loginStatus parses a cookie-free provider profile summary", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/login-status");
		expect(init?.method).toBe("GET");
		return jsonResponse({
			ok: true,
			data: {
				provider: "netease",
				loggedIn: true,
				nickname: "tester",
				userId: "42",
			},
		});
	}) as typeof fetch;

	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const status = await client.loginStatus("netease");
		expect(status.loggedIn).toBe(true);
		expect(status.nickname).toBe("tester");
		expect(JSON.stringify(status)).not.toContain("MUSIC_U");
		expect(JSON.stringify(status)).not.toContain("cookie");
	});
});

test("logout posts to provider logout and parses ack", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/logout");
		expect(init?.method).toBe("POST");
		return jsonResponse({
			ok: true,
			data: { provider: "netease", loggedOut: true },
		});
	}) as typeof fetch;

	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const ack = await client.logout("netease");
		expect(ack).toEqual({ provider: "netease", loggedOut: true });
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

test("request preserves provider failure envelope on non-2xx response", async () => {
	const fake = (async () =>
		jsonResponse({
			ok: false,
			error: {
				code: "LOGIN_REQUIRED",
				message: "需要登录后播放",
				provider: "qq",
				retryable: true,
				action: "login",
			},
		}, 401)) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		let caught: unknown = null;
		try {
			await client.resolveSongUrl({ ...SAMPLE_TRACK, provider: "qq" });
		} catch (e) {
			caught = e;
		}
		expect(caught instanceof SidecarClientError).toBe(true);
		expect((caught as SidecarClientError).code).toBe("LOGIN_REQUIRED");
		expect((caught as SidecarClientError).provider).toBe("qq");
		expect((caught as SidecarClientError).retryable).toBe(true);
		expect((caught as SidecarClientError).action).toBe("login");
	});
});

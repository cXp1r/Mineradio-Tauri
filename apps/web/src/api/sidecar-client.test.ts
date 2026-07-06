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

test("default fetch keeps the Window/global binding required by WebView2", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async function (this: typeof globalThis) {
		expect(this).toBe(globalThis);
		return jsonResponse({
			ok: true,
			appVersion: "0.9.0",
			apiVersion: "0.1.0",
			schemaVersion: "0.1.0",
			providers: [],
		});
	}) as typeof fetch;
	try {
		const client = new SidecarClient(BASE);
		const h = await client.health();
		expect(h.ok).toBe(true);
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

test("network fetch failure is normalized instead of leaking browser TypeError text", async () => {
	const fake = (async () => {
		throw new TypeError("Failed to fetch");
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		let caught: unknown = null;
		try {
			await client.search("netease", "x", 5);
		} catch (e) {
			caught = e;
		}
		expect(caught instanceof SidecarClientError).toBe(true);
		expect((caught as SidecarClientError).code).toBe("NETWORK");
		expect((caught as SidecarClientError).message).toBe("sidecar 连接失败，请稍后重试");
		expect((caught as SidecarClientError).retryable).toBe(true);
		expect((caught as SidecarClientError).rawMessage).toBe("Failed to fetch");
	});
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

test("weatherRadio calls sidecar weather radio endpoint with location params", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/weather/radio");
		expect(url).toContain("city=%E4%B8%8A%E6%B5%B7");
		expect(url).toContain("lat=31.23");
		void init;
		return jsonResponse({
			ok: true,
			data: {
				ok: true,
				weather: {
					provider: "open-meteo",
					location: {
						name: "上海",
						country: "中国",
						admin1: "",
						latitude: 31.23,
						longitude: 121.47,
						timezone: "Asia/Shanghai",
						fallback: false,
					},
					label: "雨",
					weatherCode: 61,
					temperature: 22,
					apparentTemperature: 21,
					humidity: 88,
					precipitation: 1,
					cloudCover: 90,
					windSpeed: 6,
					windGusts: 10,
					isDay: 1,
					time: "",
					updatedAt: 1,
					error: "",
					mood: {
						key: "rain",
						title: "雨天电台",
						tagline: "留一点潮湿的空间给旋律",
						energy: 0.38,
						warmth: 0.42,
						focus: 0.64,
						melancholy: 0.66,
						keywords: ["雨天 R&B"],
					},
				},
				radio: {
					title: "雨天电台",
					subtitle: "留一点潮湿的空间给旋律",
					seedQueries: ["陈奕迅 阴天快乐"],
					songs: [SAMPLE_TRACK],
					updatedAt: 1,
				},
			},
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const radio = await client.weatherRadio({ city: "上海", lat: 31.23, lon: 121.47 });
		expect(radio.weather.mood.title).toBe("雨天电台");
		expect(radio.radio.songs[0].id).toBe("t1");
	});
});

test("discoverHome GETs the baseline Home discover endpoint", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/discover/home");
		expect(init?.method).toBe("GET");
		return jsonResponse({
			ok: true,
			data: {
				loggedIn: true,
				mode: "member",
				user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
				dailySongs: [SAMPLE_TRACK],
				playlists: [{
					provider: "netease",
					id: "p1",
					name: "我的歌单",
					coverUrl: "",
					trackCount: 1,
					trackIds: ["t1"],
					subscribed: false,
				}],
				podcasts: [],
				updatedAt: 1782656256000,
			},
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const discover = await client.discoverHome();
		expect(discover.mode).toBe("member");
		expect(discover.dailySongs[0].id).toBe("t1");
		expect(discover.playlists[0].name).toBe("我的歌单");
	});
});

test("podcastSearch GETs baseline podcast search endpoint", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/podcast/search");
		expect(url).toContain("keywords=%E6%95%85%E4%BA%8B");
		expect(url).toContain("limit=18");
		expect(init?.method).toBe("GET");
		return jsonResponse({
			ok: true,
			data: {
				podcasts: [{
					id: "r1",
					rid: "r1",
					name: "故事电台",
					coverUrl: "",
					description: "",
					djName: "",
					category: "",
					programCount: 0,
					subCount: 0,
				}],
				total: 1,
			},
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const result = await client.podcastSearch("故事", 18);
		expect(result.podcasts[0].name).toBe("故事电台");
		expect(result.total).toBe(1);
	});
});

test("podcast library methods call hot detail programs and my endpoints", async () => {
	const seen: string[] = [];
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		seen.push(url.replace(BASE, ""));
		expect(init?.method).toBe("GET");
		if (url.includes("/podcast/hot")) {
			return jsonResponse({ ok: true, data: { podcasts: [], more: false } });
		}
		if (url.includes("/podcast/detail")) {
			return jsonResponse({
				ok: true,
				data: {
					podcast: {
						id: "r1",
						rid: "r1",
						name: "电台",
						coverUrl: "",
						description: "",
						djName: "",
						category: "",
						programCount: 0,
						subCount: 0,
					},
				},
			});
		}
		if (url.includes("/podcast/programs")) {
			return jsonResponse({
				ok: true,
				data: { radio: { id: "r1", rid: "r1", name: "电台" }, programs: [], more: false, total: 0 },
			});
		}
		if (url.includes("/podcast/my/items")) {
			return jsonResponse({
				ok: true,
				data: {
					loggedIn: false,
					key: "liked",
					title: "喜欢的声音",
					sub: "收藏或最近喜欢的声音",
					itemType: "voice",
					count: 0,
					coverUrl: "",
					items: [],
				},
			});
		}
		if (url.includes("/podcast/my")) {
			return jsonResponse({ ok: true, data: { loggedIn: false, collections: [] } });
		}
		throw new Error(`unexpected ${url}`);
	}) as typeof fetch;

	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		expect((await client.podcastHot(12, 24)).more).toBe(false);
		expect((await client.podcastDetail("r1")).podcast.name).toBe("电台");
		expect((await client.podcastPrograms("r1", 30, 0)).total).toBe(0);
		expect((await client.podcastMy()).loggedIn).toBe(false);
		expect((await client.podcastMyItems("liked", 36, 12)).key).toBe("liked");
	});

	expect(seen).toEqual([
		"/podcast/hot?limit=12&offset=24",
		"/podcast/detail?id=r1",
		"/podcast/programs?id=r1&limit=30&offset=0",
		"/podcast/my",
		"/podcast/my/items?key=liked&limit=36&offset=12",
	]);
});

test("podcastDjBeatmap GETs analyzer endpoint with encoded audio URL", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/podcast/dj-beatmap");
		expect(url).toContain("url=https%3A%2F%2Fmedia.example%2Fdj.mp3");
		expect(url).toContain("duration=120");
		expect(url).toContain("intro=18");
		expect(init?.method).toBe("GET");
		return jsonResponse({ ok: true, data: { ok: true, map: { beats: [1, 2] } } });
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const result = await client.podcastDjBeatmap("https://media.example/dj.mp3", 120, 18);
		expect(result.ok).toBe(true);
		expect(Array.isArray(result.map.beats)).toBe(true);
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
		if (!result.url) throw new Error("expected playable test url");
		expect(client.audioProxyUrl(result.url)).toBe(`${BASE}/audio-proxy?url=https%3A%2F%2Fmedia.example%2Fa.mp3`);
  });
});

test("trackQualities POSTs the Track body and parses native quality options", async () => {
  let receivedBody: unknown = null;
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    expect(url).toContain("/providers/netease/qualities");
    expect(init?.method).toBe("POST");
    receivedBody = JSON.parse(String(init?.body ?? "{}"));
    return jsonResponse({
      ok: true,
      data: {
        provider: "netease",
        trackId: "t1",
        defaultQuality: "exhigh",
        qualities: [{
          provider: "netease",
          id: "exhigh",
          label: "极高",
          short: "HQ",
          requestQuality: "exhigh",
          level: "exhigh",
          br: 999000,
          source: "resolved"
        }]
      },
    });
  }) as typeof fetch;
  await withFetch(fake, async () => {
    const client = new SidecarClient(BASE);
    const result = await client.trackQualities(SAMPLE_TRACK);
    expect(receivedBody).toEqual(SAMPLE_TRACK);
    expect(result.defaultQuality).toBe("exhigh");
    expect(result.qualities[0].requestQuality).toBe("exhigh");
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

test("playlistList GETs provider playlists and parses playlist summaries", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/qq/playlists");
		expect(init?.method).toBe("GET");
		return jsonResponse({
			ok: true,
			data: [
				{
					provider: "qq",
					id: "201",
					name: "我喜欢",
					coverUrl: "http://cover/like.jpg",
					trackCount: 8,
					trackIds: [],
				},
			],
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const playlists = await client.playlistList("qq");
		expect(playlists.length).toBe(1);
		expect(playlists[0].provider).toBe("qq");
		expect(playlists[0].id).toBe("201");
		expect(playlists[0].name).toBe("我喜欢");
	});
});

test("likeSong POSTs provider like mutation and parses ack", async () => {
	let receivedBody: unknown = null;
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/like");
		expect(init?.method).toBe("POST");
		receivedBody = JSON.parse(String(init?.body ?? "{}"));
		return jsonResponse({
			ok: true,
			data: { provider: "netease", id: "100", liked: true, code: 200 },
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const ack = await client.likeSong("netease", "100", true);
		expect(receivedBody).toEqual({ id: "100", liked: true });
		expect(ack).toEqual({ provider: "netease", id: "100", liked: true, code: 200 });
	});
});

test("checkSongLikes GETs comma-separated ids and parses liked map", async () => {
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/like-check?ids=100%2C200");
		expect(init?.method).toBe("GET");
		return jsonResponse({
			ok: true,
			data: { provider: "netease", ids: ["100", "200"], liked: { "100": true, "200": false } },
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const ack = await client.checkSongLikes("netease", ["100", "200"]);
		expect(ack.liked["100"]).toBe(true);
		expect(ack.liked["200"]).toBe(false);
	});
});

test("addSongToPlaylist POSTs playlist add mutation and parses ack", async () => {
	let receivedBody: unknown = null;
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/playlists/add-song");
		expect(init?.method).toBe("POST");
		receivedBody = JSON.parse(String(init?.body ?? "{}"));
		return jsonResponse({
			ok: true,
			data: { provider: "netease", playlistId: "p1", trackId: "100", success: true, code: 200 },
		});
	}) as typeof fetch;
	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const ack = await client.addSongToPlaylist("netease", "p1", "100");
		expect(receivedBody).toEqual({ playlistId: "p1", trackId: "100" });
		expect(ack.success).toBe(true);
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

test("Netease QR login helpers parse key image and check responses", async () => {
	const seen: string[] = [];
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		seen.push(url);
		expect(init?.method).toBe("GET");
		if (url.includes("/providers/netease/login-qr-key")) {
			return jsonResponse({ ok: true, data: { provider: "netease", key: "qr-key-1" } });
		}
		if (url.includes("/providers/netease/login-qr-create")) {
			expect(url).toContain("key=qr-key-1");
			return jsonResponse({
				ok: true,
				data: { provider: "netease", key: "qr-key-1", img: "data:image/png;base64,abc" },
			});
		}
		if (url.includes("/providers/netease/login-qr-check")) {
			expect(url).toContain("key=qr-key-1");
			return jsonResponse({
				ok: true,
				data: { provider: "netease", key: "qr-key-1", code: 801, loggedIn: false },
			});
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;

	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		expect(await client.createProviderLoginQrKey("netease")).toEqual({
			provider: "netease",
			key: "qr-key-1",
		});
		expect(await client.createProviderLoginQrImage("netease", "qr-key-1")).toEqual({
			provider: "netease",
			key: "qr-key-1",
			img: "data:image/png;base64,abc",
		});
		expect(await client.checkProviderLoginQr("netease", "qr-key-1")).toEqual({
			provider: "netease",
			key: "qr-key-1",
			code: 801,
			loggedIn: false,
		});
	});
	expect(seen.length).toBe(3);
});

test("QQ QR login helpers call QQ provider routes and parse responses", async () => {
	const seen: string[] = [];
	const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		seen.push(url);
		expect(init?.method).toBe("GET");
		if (url.includes("/providers/qq/login-qr-key")) {
			return jsonResponse({ ok: true, data: { provider: "qq", key: "qr_sig_1|1987342677" } });
		}
		if (url.includes("/providers/qq/login-qr-create")) {
			expect(url).toContain("key=qr_sig_1%7C1987342677");
			return jsonResponse({
				ok: true,
				data: { provider: "qq", key: "qr_sig_1|1987342677", img: "data:image/png;base64,qq" },
			});
		}
		if (url.includes("/providers/qq/login-qr-check")) {
			expect(url).toContain("key=qr_sig_1%7C1987342677");
			return jsonResponse({
				ok: true,
				data: { provider: "qq", key: "qr_sig_1|1987342677", code: 67, loggedIn: false, scanned: true },
			});
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;

	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		expect(await client.createProviderLoginQrKey("qq")).toEqual({
			provider: "qq",
			key: "qr_sig_1|1987342677",
		});
		expect(await client.createProviderLoginQrImage("qq", "qr_sig_1|1987342677")).toEqual({
			provider: "qq",
			key: "qr_sig_1|1987342677",
			img: "data:image/png;base64,qq",
		});
		expect(await client.checkProviderLoginQr("qq", "qr_sig_1|1987342677")).toEqual({
			provider: "qq",
			key: "qr_sig_1|1987342677",
			code: 67,
			loggedIn: false,
			scanned: true,
		});
	});
	expect(seen.length).toBe(3);
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

test("loginStatus parses Netease VIP profile metadata", async () => {
	const fake = (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toContain("/providers/netease/login-status");
		return jsonResponse({
			ok: true,
			data: {
				provider: "netease",
				loggedIn: true,
				nickname: "tester",
				userId: "42",
				vipType: 11,
				vipLevel: "svip",
				isVip: true,
				isSvip: true,
				vipLabel: "黑胶SVIP·陆",
				vipIcon: "netease-svip",
				vipIconUrl: "https://example.com/vip.png",
				vipTier: 6,
				vipLevelName: "陆",
			},
		});
	}) as typeof fetch;

	await withFetch(fake, async () => {
		const client = new SidecarClient(BASE);
		const status = await client.loginStatus("netease");
		expect(status.vipType).toBe(11);
		expect(status.vipLevel).toBe("svip");
		expect(status.isVip).toBe(true);
		expect(status.isSvip).toBe(true);
		expect(status.vipLabel).toBe("黑胶SVIP·陆");
		expect(status.vipIcon).toBe("netease-svip");
		expect(status.vipIconUrl).toBe("https://example.com/vip.png");
		expect(status.vipTier).toBe(6);
		expect(status.vipLevelName).toBe("陆");
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
				playbackKeyReady: false,
				reason: "login_required",
				qqCode: 104003,
				rawMessage: "no vkey",
				tried: ["无损 FLAC · F000abc.flac"],
				restriction: {
					provider: "qq",
					category: "login_required",
					action: "login",
					message: "需要登录后播放",
					code: 104003,
					rawMessage: "no vkey",
					missingPlaybackKey: true,
				},
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
		expect((caught as SidecarClientError).playbackKeyReady).toBe(false);
		expect((caught as SidecarClientError).reason).toBe("login_required");
		expect((caught as SidecarClientError).qqCode).toBe(104003);
		expect((caught as SidecarClientError).rawMessage).toBe("no vkey");
		expect((caught as SidecarClientError).tried).toEqual(["无损 FLAC · F000abc.flac"]);
	});
});

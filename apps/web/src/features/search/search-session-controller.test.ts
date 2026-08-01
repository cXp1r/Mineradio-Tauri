import { expect, test } from "bun:test";
import type {
	PodcastProgram,
	PodcastRadio,
	ProviderId,
	Track,
} from "@mineradio/shared";
import {
	SearchSessionController,
	createMemorySearchSessionState,
} from "./search-session-controller";
import { MemoryPreferencesRepository } from "../../adapters/storage/memory-preferences-repository";
import type {
	PreferenceKey,
	PreferencesRepository,
} from "../../ports/preferences-repository";
import { SEARCH_HISTORY_PREFERENCE } from "../../preferences/keys";

function makeTrack(id: string, provider: ProviderId = "netease"): Track {
	return {
		provider,
		id,
		sourceId: id,
		title: `Song ${id}`,
		artists: ["Artist"],
		album: "Album",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
	};
}

function makePodcast(id: string): PodcastRadio {
	return {
		id,
		rid: id,
		name: `Podcast ${id}`,
		coverUrl: "",
		description: "",
		djName: "DJ",
		category: "Music",
		programCount: 1,
		subCount: 0,
	};
}

function makeProgram(id: string, radioId = "radio-1"): PodcastProgram {
	return {
		...makeTrack(`track-${id}`),
		type: "podcast",
		programId: id,
		radioId,
		radioName: "Podcast",
		djName: "DJ",
		description: "",
		createTime: 0,
		serialNum: Number(id),
	};
}

test("compact and detail share one exact-intent request while a failed same-query search can retry", async () => {
	let attempts = 0;
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const port = {
		async searchAll() {
			attempts += 1;
			if (attempts === 1) {
				await firstGate;
				throw new Error("temporary failure");
			}
			return [makeTrack("recovered")];
		},
	} as never;
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort(port);

	const compact = controller.search("晴天", "song");
	const detail = controller.openDetail("晴天", "song");
	expect(attempts).toBe(1);

	releaseFirst();
	await Promise.all([compact, detail]);
	expect(controller.getSnapshot().error).toBe("temporary failure");

	await controller.openDetail("晴天", "song");
	expect(attempts).toBe(2);
	expect(controller.getSnapshot().results.map((track) => track.id)).toEqual([
		"recovered",
	]);
});

test("returning to an intent after draft invalidation starts a fresh generation", async () => {
	let calls = 0;
	let releaseStale!: () => void;
	const staleGate = new Promise<void>((resolve) => {
		releaseStale = resolve;
	});
	const port = {
		async searchAll() {
			calls += 1;
			if (calls === 1) {
				await staleGate;
				return [makeTrack("stale")];
			}
			return [makeTrack("fresh")];
		},
	} as never;
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort(port);

	const stale = controller.search("A", "song");
	controller.updateDraft("B");
	controller.updateDraft("A");
	const fresh = controller.search("A", "song");
	expect(calls).toBe(2);

	releaseStale();
	await Promise.all([stale, fresh]);
	expect(controller.getSnapshot().results.map((track) => track.id)).toEqual([
		"fresh",
	]);
});

test("returning to a successful provider intent rebinds pagination to the new generation", async () => {
	const limits: number[] = [];
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort({
		async search(_provider: ProviderId, _keyword: string, limit: number) {
			limits.push(limit);
			return Array.from({ length: limit }, (_, index) => makeTrack(String(index)));
		},
	} as never);

	await controller.search("A", "netease");
	controller.updateDraft("AB");
	controller.updateDraft("A");
	await controller.search("A", "netease");
	const revealed = await controller.loadNext();
	const loaded = await controller.loadNext();

	expect(revealed).toBe(true);
	expect(loaded).toBe(true);
	expect(limits).toEqual([30, 60]);
	expect(controller.getSnapshot().results.length).toBe(60);
});

test("shared playlist import stays under the search generation owner", async () => {
	let releaseImport!: () => void;
	const importGate = new Promise<void>((resolve) => {
		releaseImport = resolve;
	});
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});

	const pending = controller.importSharedPlaylist(
		"https://music.example/playlist/1",
		"song",
		async () => importGate,
	);
	expect(controller.getSnapshot().loading).toBe(true);

	controller.updateDraft("新的搜索");
	releaseImport();
	await pending;

	const snapshot = controller.getSnapshot();
	expect(snapshot.keyword).toBe("新的搜索");
	expect(snapshot.generation).toBeGreaterThan(1);
	expect(snapshot.loading).toBe(false);
	expect(snapshot.error).toBeNull();
});

test("All mode clamps an oversized frozen-port response to its local eighteen-result budget", async () => {
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort({
		async searchAll() {
			return Array.from({ length: 200 }, (_, index) => makeTrack(String(index)));
		},
	} as never);

	await controller.search("有界", "song");

	expect(controller.getSnapshot().results.length).toBe(18);
	expect(controller.getSnapshot().visibleCount).toBe(18);
	expect(controller.getSnapshot().exhausted).toBe(true);
});

test("provider pagination reveals the bounded local window before issuing one cumulative single-flight request", async () => {
	const calls: number[] = [];
	let releaseNext!: () => void;
	const nextGate = new Promise<void>((resolve) => {
		releaseNext = resolve;
	});
	const port = {
		async search(_provider: ProviderId, _keyword: string, limit: number) {
			calls.push(limit);
			if (limit > 30) await nextGate;
			return Array.from(
				{ length: limit > 30 ? 40 : 30 },
				(_, index) => makeTrack(String(index)),
			);
		},
	} as never;
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort(port);

	await controller.search("晴天", "netease");
	expect(controller.getSnapshot().visibleCount).toBe(18);
	expect(calls).toEqual([30]);

	await controller.loadNext();
	expect(controller.getSnapshot().visibleCount).toBe(30);
	expect(calls).toEqual([30]);

	const first = controller.loadNext();
	const second = controller.loadNext();
	expect(calls).toEqual([30, 60]);
	releaseNext();
	await Promise.all([first, second]);

	expect(controller.getSnapshot().results.length).toBe(40);
	expect(controller.getSnapshot().visibleCount).toBe(40);
	expect(controller.getSnapshot().exhausted).toBe(true);
});

test("an append response from an older generation cannot overwrite a newer query", async () => {
	let releaseStale!: () => void;
	const staleGate = new Promise<void>((resolve) => {
		releaseStale = resolve;
	});
	const port = {
		async search(_provider: ProviderId, keyword: string, limit: number) {
			if (keyword === "旧查询" && limit > 30) {
				await staleGate;
				return Array.from({ length: 60 }, (_, index) => makeTrack(`old-${index}`));
			}
			if (keyword === "旧查询") {
				return Array.from({ length: 30 }, (_, index) => makeTrack(`old-${index}`));
			}
			return [makeTrack("new-only")];
		},
	} as never;
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort(port);

	await controller.search("旧查询", "netease");
	await controller.loadNext();
	const staleAppend = controller.loadNext();
	await controller.search("新查询", "netease");
	releaseStale();
	await staleAppend;

	expect(controller.getSnapshot().committedKeyword).toBe("新查询");
	expect(controller.getSnapshot().results.map((track) => track.id)).toEqual([
		"new-only",
	]);
});

test("a cumulative provider page with no novel tracks marks pagination exhausted", async () => {
	const calls: number[] = [];
	const sameThirty = Array.from({ length: 30 }, (_, index) => makeTrack(String(index)));
	const port = {
		async search(_provider: ProviderId, _keyword: string, limit: number) {
			calls.push(limit);
			return sameThirty;
		},
	} as never;
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort(port);

	await controller.search("重复", "qq");
	await controller.loadNext();
	await controller.loadNext();
	await controller.loadNext();

	expect(calls).toEqual([30, 60]);
	expect(controller.getSnapshot().results.length).toBe(30);
	expect(controller.getSnapshot().exhausted).toBe(true);
});

test("podcast hot pagination uses the frozen offset port and appends one page at a time", async () => {
	const calls: string[] = [];
	const port = {
		async podcastHot(limit: number, offset: number) {
			calls.push(`${limit}:${offset}`);
			return {
				podcasts: Array.from({ length: limit }, (_, index) =>
					makePodcast(String(offset + index)),
				),
				more: offset === 0,
			};
		},
	} as never;
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort(port);

	await controller.search("", "podcast");
	expect(calls).toEqual(["18:0"]);
	expect(controller.getSnapshot().exhausted).toBe(false);

	await controller.loadNext();
	expect(calls).toEqual(["18:0", "18:18"]);
	expect(controller.getSnapshot().podcasts.length).toBe(36);
	expect(controller.getSnapshot().visibleCount).toBe(36);
	expect(controller.getSnapshot().exhausted).toBe(true);
});

test("podcast program drill-in keeps offset pagination under the same generation owner", async () => {
	const calls: string[] = [];
	const port = {
		async podcastHot() {
			return { podcasts: [makePodcast("radio-1")], more: false };
		},
		async podcastPrograms(id: string, limit: number, offset: number) {
			calls.push(`${id}:${limit}:${offset}`);
			return {
				radio: makePodcast(id),
				programs: Array.from({ length: limit }, (_, index) =>
					makeProgram(String(offset + index), id),
				),
				more: offset === 0,
				total: 72,
			};
		},
	} as never;
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
	});
	controller.setPort(port);
	await controller.search("", "podcast");

	await controller.openPodcastPrograms(makePodcast("radio-1"));
	expect(calls).toEqual(["radio-1:36:0"]);
	expect(controller.getSnapshot().visibleCount).toBe(18);

	await controller.loadNext();
	expect(calls).toEqual(["radio-1:36:0"]);
	await controller.loadNext();
	expect(calls).toEqual(["radio-1:36:0", "radio-1:36:36"]);
	expect(controller.getSnapshot().programs.length).toBe(72);
	expect(controller.getSnapshot().visibleCount).toBe(54);
});

test("history is persisted only after a non-empty successful result", async () => {
	const preferences = new MemoryPreferencesRepository();
	const port = {
		async searchAll(keyword: string) {
			if (keyword === "失败") throw new Error("failed");
			return keyword === "空结果" ? [] : [makeTrack(keyword)];
		},
	} as never;
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
		preferences,
	});
	controller.setPort(port);

	await controller.search("空结果", "song");
	expect(await preferences.get(SEARCH_HISTORY_PREFERENCE)).toEqual([]);
	await controller.search("失败", "song");
	expect(await preferences.get(SEARCH_HISTORY_PREFERENCE)).toEqual([]);
	await controller.search("晴天", "song");

	expect(await preferences.get(SEARCH_HISTORY_PREFERENCE)).toEqual(["晴天"]);
	expect(controller.getSnapshot().recentQueries).toEqual([
		{ keyword: "晴天", mode: "song" },
	]);
});

test("history hydration migrates legacy envelopes and later success deduplicates case-insensitively", async () => {
	const preferences = new MemoryPreferencesRepository({
		[SEARCH_HISTORY_PREFERENCE.name]: {
			schemaVersion: SEARCH_HISTORY_PREFERENCE.schemaVersion,
			value: { items: ["Alpha", "Beta", "alpha"] },
		},
	});
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
		preferences,
	});
	controller.setPort({
		async searchAll() {
			return [makeTrack("hit")];
		},
	} as never);

	await controller.hydrateHistory();
	expect(controller.getSnapshot().recentQueries).toEqual([
		{ keyword: "Alpha", mode: "song" },
		{ keyword: "Beta", mode: "song" },
	]);

	await controller.search("beta", "song");
	expect(controller.getSnapshot().recentQueries).toEqual([
		{ keyword: "beta", mode: "song" },
		{ keyword: "Alpha", mode: "song" },
	]);
	expect(await preferences.get(SEARCH_HISTORY_PREFERENCE)).toEqual([
		"beta",
		"Alpha",
	]);
});

test("history remains bounded to ten entries and supports delete plus clear persistence", async () => {
	const preferences = new MemoryPreferencesRepository();
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState(),
		preferences,
	});
	controller.setPort({
		async searchAll(keyword: string) {
			return [makeTrack(keyword)];
		},
	} as never);

	for (let index = 0; index < 11; index += 1) {
		await controller.search(`Query ${index}`, "song");
	}
	expect(controller.getSnapshot().recentQueries.length).toBe(10);
	expect(controller.getSnapshot().recentQueries[0]?.keyword).toBe("Query 10");
	expect(controller.getSnapshot().recentQueries.at(-1)?.keyword).toBe("Query 1");

	await controller.removeHistory("query 5");
	expect(
		controller.getSnapshot().recentQueries.some((item) => item.keyword === "Query 5"),
	).toBe(false);

	await controller.clearHistory();
	expect(controller.getSnapshot().recentQueries).toEqual([]);
	expect(await preferences.get(SEARCH_HISTORY_PREFERENCE)).toEqual([]);
});

test("a failed history write keeps the last canonical history without failing search", async () => {
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState({
			recentQueries: [{ keyword: "旧查询", mode: "song" }],
		}),
		preferences: {
			async get<T>() {
				return ["旧查询"] as unknown as T;
			},
			async set<T>(_key: PreferenceKey<T>, _value: T) {
				throw new Error("history unavailable");
			},
		} satisfies Pick<PreferencesRepository, "get" | "set">,
	});
	controller.setPort({
		async searchAll(keyword: string) {
			return [makeTrack(keyword)];
		},
	} as never);

	await controller.search("新查询", "song");

	expect(controller.getSnapshot().results.length).toBe(1);
	expect(controller.getSnapshot().error).toBeNull();
	expect(controller.getSnapshot().recentQueries).toEqual([
		{ keyword: "旧查询", mode: "song" },
	]);
});

test("failed history deletion and clearing do not publish uncommitted UI state", async () => {
	const originalHistory = [
		{ keyword: "Alpha", mode: "song" as const },
		{ keyword: "Beta", mode: "qq" as const },
	];
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState({ recentQueries: originalHistory }),
		preferences: {
			async get<T>() {
				return originalHistory.map((item) => item.keyword) as unknown as T;
			},
			async set<T>(_key: PreferenceKey<T>, _value: T) {
				throw new Error("history unavailable");
			},
		} satisfies Pick<PreferencesRepository, "get" | "set">,
	});

	await controller.removeHistory("Alpha");
	expect(controller.getSnapshot().recentQueries).toEqual(originalHistory);

	await controller.clearHistory();
	expect(controller.getSnapshot().recentQueries).toEqual(originalHistory);
});

test("concurrent history removals rebase when each mutation owns the canonical state", async () => {
	let releaseFirstWrite!: () => void;
	const firstWriteGate = new Promise<void>((resolve) => {
		releaseFirstWrite = resolve;
	});
	const writes: string[][] = [];
	const controller = new SearchSessionController({
		state: createMemorySearchSessionState({
			recentQueries: [
				{ keyword: "Alpha", mode: "song" },
				{ keyword: "Beta", mode: "qq" },
			],
		}),
		preferences: {
			async get<T>() {
				return ["Alpha", "Beta"] as unknown as T;
			},
			async set<T>(_key: PreferenceKey<T>, value: T) {
				writes.push([...(value as string[])]);
				if (writes.length === 1) await firstWriteGate;
			},
		} satisfies Pick<PreferencesRepository, "get" | "set">,
	});

	const removeAlpha = controller.removeHistory("Alpha");
	const removeBeta = controller.removeHistory("Beta");
	await Promise.resolve();
	expect(controller.getSnapshot().recentQueries).toEqual([
		{ keyword: "Alpha", mode: "song" },
		{ keyword: "Beta", mode: "qq" },
	]);

	releaseFirstWrite();
	await Promise.all([removeAlpha, removeBeta]);
	expect(writes).toEqual([["Beta"], []]);
	expect(controller.getSnapshot().recentQueries).toEqual([]);
});

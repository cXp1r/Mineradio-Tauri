import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import { MemoryPreferencesRepository } from "../../adapters/storage/memory-preferences-repository";
import { HOME_LISTEN_LEDGER_PREFERENCE } from "../../preferences/keys";
import {
	createHomeListenLegacyPreferenceMapping,
	createPreferencesHomeListenRepository,
} from "./home-preferences-adapter";
import {
	createEmptyHomeListenLedger,
	recordHomeListenSession,
} from "./home-listen-ledger";

const track: Track = {
	provider: "netease",
	id: "home-preference-track",
	sourceId: "home-preference-track",
	title: "迁移歌曲",
	artists: ["迁移歌手"],
	album: "",
	coverUrl: "",
	qualityHints: [],
	playableState: "playable",
};

test("Home repository 先提交 typed preference，再更新同步读取快照", async () => {
	const preferences = new MemoryPreferencesRepository();
	const repository = await createPreferencesHomeListenRepository(preferences);
	const ledger = recordHomeListenSession(createEmptyHomeListenLedger(), {
		track,
		startedAt: 1_000,
		endedAt: 61_000,
		listenMs: 60_000,
		completed: true,
	});

	await repository.save(ledger);

	expect(repository.read()).toEqual(ledger);
	expect(await preferences.get(HOME_LISTEN_LEDGER_PREFERENCE)).toEqual(ledger);
});

test("Home legacy mapping 将 v1 lifetime 迁移到 v2 且不伪造 daily", () => {
	const mapping = createHomeListenLegacyPreferenceMapping();
	const decoded = mapping.decode(JSON.stringify({
		history: [{
			track,
			plays: 3,
			lastPlayedAt: 61_000,
			listenMs: 120_000,
			completed: 1,
		}],
	}));

	const ledger = decoded as {
		version?: number;
		daily?: unknown[];
		songs?: Array<{ plays?: number; listenMs?: number }>;
	};
	expect(ledger.version).toBe(2);
	expect(ledger.daily).toEqual([]);
	expect(ledger.songs?.[0]?.plays).toBe(3);
	expect(ledger.songs?.[0]?.listenMs).toBe(120_000);
});

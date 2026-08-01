import { expect, test } from "bun:test";
import {
	M8_PREFERENCE_KEYS,
	PLAYBACK_AUDIO_PREFERENCE,
	SEARCH_HISTORY_PREFERENCE,
	VISUAL_WORKSHOP_PREFERENCE,
	normalizeSearchHistory,
} from "./keys";
import { createJsonPreferenceKey } from "../ports/preferences-repository";

test("search history accepts legacy shapes and keeps ten unique recent queries", () => {
	expect(
		normalizeSearchHistory({
			song: ["  周杰伦  ", "Taylor Swift", "周杰伦"],
			qq: ["林俊杰", "陈奕迅", "五月天", "孙燕姿", "王菲", "张学友"],
			podcast: ["科技", "历史", "音乐", "多余"],
		}),
	).toEqual([
		"周杰伦",
		"Taylor Swift",
		"林俊杰",
		"陈奕迅",
		"五月天",
		"孙燕姿",
		"王菲",
		"张学友",
		"科技",
		"历史",
	]);
	expect(SEARCH_HISTORY_PREFERENCE.parse({ items: ["A", "a", "B"] })).toEqual([
		"A",
		"B",
	]);
	expect(
		SEARCH_HISTORY_PREFERENCE.parse({
			modes: { song: ["嵌套歌曲"], qq: ["嵌套 QQ"] },
		}),
	).toEqual(["嵌套歌曲", "嵌套 QQ"]);
});

test("M8 preference catalog contains only unique typed keys", () => {
	const names = M8_PREFERENCE_KEYS.map((key) => key.name);
	expect(new Set(names).size).toBe(names.length);
	expect(names).toContain("search.history");
	expect(names).toContain("home.listenLedger.v2");
	expect(names).toContain("visual.workshop.v1");
});

test("Workshop preference requires its stable activation id and returns complete normalized settings", () => {
	const preference = VISUAL_WORKSHOP_PREFERENCE.parse({
		version: 1,
		activationId: "sonic-workshop-v1",
		active: true,
		settings: { audioIntensity: 99 },
	});
	expect(preference?.version).toBe(1);
	expect(preference?.activationId).toBe("sonic-workshop-v1");
	expect(preference?.active).toBe(true);
	expect(preference?.settings.active).toBe(true);
	expect(preference?.settings.audioIntensity).toBe(2.5);
	expect(preference?.settings.inputGain).toBe(82);
	expect(preference?.settings.theme).toBe("coral-mirage");
	expect(
		VISUAL_WORKSHOP_PREFERENCE.parse({
			version: 1,
			activationId: "legacy-numeric-8",
			active: true,
			settings: {},
		}),
	).toBe(undefined);
});

test("typed preference rejects a default that does not satisfy its schema", () => {
	let message = "";
	try {
		createJsonPreferenceKey<number>({
			name: "invalid.default",
			schemaVersion: 1,
			defaultValue: "not-a-number" as unknown as number,
			parse: (value) => (typeof value === "number" ? value : undefined),
		});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toContain("PREFERENCE_DEFAULT_INVALID");
});

test("启用且具有设备 ID 的虚拟桥接会成为有效主输出并从镜像中移除", () => {
	const preference = PLAYBACK_AUDIO_PREFERENCE.parse({
		fadeInMs: 460,
		fadeOutMs: 420,
		gaplessEnabled: true,
		crossfadeEnabled: true,
		primaryOutputId: "speaker-main",
		mirrorOutputIds: ["virtual-cable", "monitor-a"],
		inputBridge: {
			enabled: true,
			deviceId: "virtual-cable",
		},
	});

	expect(preference?.primaryOutputId).toBe("virtual-cable");
	expect(preference?.mirrorOutputIds).toEqual(["monitor-a"]);
});

test("镜像在剔除有效主输出后仍可保留最多四个设备", () => {
	const preference = PLAYBACK_AUDIO_PREFERENCE.parse({
		...PLAYBACK_AUDIO_PREFERENCE.defaultValue(),
		primaryOutputId: "speaker-main",
		mirrorOutputIds: [
			"virtual-cable",
			"monitor-a",
			"monitor-b",
			"monitor-c",
			"monitor-d",
		],
		inputBridge: {
			enabled: true,
			deviceId: "virtual-cable",
		},
	});

	expect(preference?.mirrorOutputIds).toEqual([
		"monitor-a",
		"monitor-b",
		"monitor-c",
		"monitor-d",
	]);
});

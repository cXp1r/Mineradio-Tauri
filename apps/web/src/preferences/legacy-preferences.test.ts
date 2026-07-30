import { expect, test } from "bun:test";
import {
	DEFAULT_LEGACY_PREFERENCE_MAPPINGS,
	stagePlaybackAudioLegacyAggregate,
} from "./legacy-preferences";

test("Electron v3 search history migrates from its real legacy key and mirrors an items envelope", () => {
	const mapping = DEFAULT_LEGACY_PREFERENCE_MAPPINGS.find(
		(candidate) => candidate.legacyKey === "mineradio-search-history",
	);

	expect(mapping?.decode(JSON.stringify({
		version: 3,
		modes: { song: ["周杰伦"], qq: ["林俊杰"] },
	}))).toEqual(["周杰伦", "林俊杰"]);
	expect(mapping?.encode(["周杰伦", "林俊杰"])).toBe(
		JSON.stringify({ version: 3, items: ["周杰伦", "林俊杰"] }),
	);
});

test("Electron 2.0.2 的四个音频 key 会先合成为单一 typed migration", () => {
	const values = new Map<string, string>([
		["mineradio-audio-fade-v1", JSON.stringify({ fadeInMs: 9_999, fadeOutMs: 380 })],
		["mineradio-audio-output-device-v1", "speaker-main"],
		["mineradio-audio-output-mirror-v1", JSON.stringify([
			"speaker-main",
			"virtual-cable",
			"monitor-a",
			"monitor-a",
			"monitor-b",
		])],
		["mineradio-audio-input-bridge-v1", JSON.stringify({
			enabled: true,
			deviceId: "virtual-cable",
		})],
	]);
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};

	stagePlaybackAudioLegacyAggregate(storage);
	const aggregate = JSON.parse(values.get("mineradio-playback-audio-v2") ?? "null");
	expect(aggregate.fadeInMs).toBe(3_000);
	expect(aggregate.fadeOutMs).toBe(380);
	expect(aggregate.primaryOutputId).toBe("virtual-cable");
	expect(aggregate.mirrorOutputIds).toEqual([
		"speaker-main",
		"monitor-a",
		"monitor-b",
	]);
	expect(aggregate.inputBridge).toEqual({
		enabled: true,
		deviceId: "virtual-cable",
	});
});

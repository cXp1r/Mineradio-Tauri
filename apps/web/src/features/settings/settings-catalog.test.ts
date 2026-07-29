import { expect, test } from "bun:test";
import { buildLowSpecChanges, SETTINGS_TABS } from "./settings-catalog";

test("低配模式形成一条有界且可逆的多路径设置变化", () => {
	const changes = buildLowSpecChanges({
		performanceQuality: "high",
		performanceBackground: "auto",
		coverResolution: 1.55,
		aiDepth: true,
		bloom: true,
		backCover: true,
		lyricGlowParticles: true,
		particleLyrics: true,
	});

	expect(Object.keys(changes).length).toBe(8);
	expect(changes["performanceQuality"]).toEqual({
		before: "high",
		after: "eco",
	});
	expect(changes["performanceBackground"]?.after).toBe("release");
	expect(changes["coverResolution"]?.after).toBe(0.9);
	expect(changes["aiDepth"]?.after).toBe(false);
});

test("设置工作台固定为六个面向任务的分类", () => {
	expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
		"common",
		"interface",
		"lyrics",
		"motion",
		"shelf",
		"system",
	]);
});

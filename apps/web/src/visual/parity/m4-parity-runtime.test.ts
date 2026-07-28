import { expect, test } from "bun:test";
import {
	advanceM4ParityFrames,
	createM4ParitySceneSettings,
} from "./m4-parity-runtime";

test("M4 parity 的 stage 场景启用真实舞台歌词，其他场景保持隔离", () => {
	const stage = createM4ParitySceneSettings("stage");
	expect(stage.fx.particleLyrics).toBe(true);
	expect(stage.fx.stageLyrics?.textureClarity).toBe(2);
	expect(createM4ParitySceneSettings("sonic").fx.particleLyrics).toBe(false);
	expect(createM4ParitySceneSettings("shelf").fx.particleLyrics).toBe(false);
});

test("M4 parity 的确定性帧推进会在相邻帧之间让出 cooperative commit", async () => {
	const events: string[] = [];
	let clockMs = 0;
	await advanceM4ParityFrames({
		frameCount: 2,
		frameMs: 16,
		readClockMs: () => clockMs,
		writeClockMs: (value) => { clockMs = value; },
		stepFrame: (value) => {
			events.push(`frame:${value}`);
			queueMicrotask(() => events.push(`commit:${value}`));
		},
	});

	expect(events).toEqual([
		"frame:16",
		"commit:16",
		"frame:32",
		"commit:32",
	]);
});

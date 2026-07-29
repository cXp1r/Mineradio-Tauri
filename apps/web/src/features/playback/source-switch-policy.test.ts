import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import { selectStrictSourceCandidate } from "./source-switch-policy";

function track(input: Partial<Track> & Pick<Track, "provider" | "id" | "title">): Track {
	return {
		sourceId: input.id,
		artists: ["周杰伦"],
		album: "叶惠美",
		coverUrl: "",
		durationMs: 240_000,
		qualityHints: [],
		playableState: "playable",
		...input,
	};
}

test("手动音源切换只接受同标题且歌手集合一致的候选", () => {
	const original = track({ provider: "netease", id: "origin", title: "晴天" });
	const candidates = [
		track({ provider: "qq", id: "cover", title: "晴天", artists: ["翻唱歌手"] }),
		track({ provider: "qq", id: "remix", title: "晴天 (Remix)" }),
		track({ provider: "qq", id: "extra", title: "晴天", artists: ["周杰伦", "嘉宾"] }),
		track({ provider: "qq", id: "exact", title: "晴天" }),
	];

	expect(selectStrictSourceCandidate(original, candidates)?.id).toBe("exact");
});

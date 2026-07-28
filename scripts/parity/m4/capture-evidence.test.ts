import { expect, test } from "bun:test";
import path from "node:path";
import { parseArguments } from "./capture-evidence.mjs";

test("release runner 默认显式选择 high，quick runner 保持 eco", () => {
	expect(parseArguments(["--profile", "release"])?.sonicQuality).toBe("high");
	expect(parseArguments([])?.sonicQuality).toBe("eco");
});

test("release runner 将 baseline 数值、source commit 与 manifest 路径保留为可追溯输入", () => {
	const options = parseArguments([
		"--profile", "release",
		"--strict",
		"--baseline-frame-p95-ms", "0.4000000022351742",
		"--baseline-gpu-p95-ms", "0.136416",
		"--baseline-source-commit", "3de93016082fa4e468a07b2ff7582189919a2e17",
		"--baseline-source-manifest", "output/playwright/m4-high-baseline/manifest.json",
	]);

	expect(options).toMatchObject({
		profile: "release",
		strict: true,
		sonicQuality: "high",
		performanceBaseline: {
			frameP95Ms: 0.4000000022351742,
			gpuP95Ms: 0.136416,
			sourceCommit: "3de93016082fa4e468a07b2ff7582189919a2e17",
			sourceManifest: path.resolve("output/playwright/m4-high-baseline/manifest.json"),
		},
	});
});

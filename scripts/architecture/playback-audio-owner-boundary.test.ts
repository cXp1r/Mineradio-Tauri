import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const webSourceRoot = resolve(repositoryRoot, "apps/web/src");
const playbackAudioOwner = "apps/web/src/audio/playback-audio-runtime.ts";

function listProductionSources(root: string): string[] {
	const sources: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const absolutePath = resolve(root, entry.name);
		if (entry.isDirectory()) {
			sources.push(...listProductionSources(absolutePath));
			continue;
		}
		if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) continue;
		sources.push(absolutePath);
	}
	return sources;
}

function repositoryPath(absolutePath: string): string {
	return relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
}

test("PlaybackAudioRuntime 是 Web 播放 MediaElementSource 的唯一 owner", () => {
	const owners = listProductionSources(webSourceRoot)
		.filter((file) => readFileSync(file, "utf8").includes("createMediaElementSource"))
		.map(repositoryPath);

	expect(owners).toEqual([playbackAudioOwner]);
});

test("生产 Visual Module 只取得 Readonly Audio Frame Source", () => {
	const useVisualEngine = readFileSync(resolve(webSourceRoot, "visual/useVisualEngine.ts"), "utf8");
	const visualEngineHost = readFileSync(resolve(webSourceRoot, "visual/VisualEngineHost.tsx"), "utf8");
	const legacyComposition = readFileSync(
		resolve(webSourceRoot, "visual/runtime/create-legacy-visual-composition.ts"),
		"utf8",
	);
	const visualSources = listProductionSources(resolve(webSourceRoot, "visual"));

	expect(useVisualEngine).toContain("readonly audioFrameSource: AudioFrameSource");
	expect(useVisualEngine).toContain("getAudioFrame: input.audioFrameSource");
	expect(visualEngineHost).toContain("audioFrameSource: AudioFrameSource");
	expect(legacyComposition).toContain("readonly audioFrameSource: AudioFrameSource");
	for (const file of visualSources) {
		const source = readFileSync(file, "utf8");
		for (const forbidden of [
			"PlayerController",
			"HTMLAudioElement",
			"audioElementRef",
			"controllerRef",
			"getActiveElement",
		]) {
			expect(source.includes(forbidden)).toBe(false);
		}
	}
	expect(useVisualEngine.includes("createPlaybackAudioFrameAdapter")).toBe(false);
	expect(useVisualEngine.includes("createPlaybackAudioFrameProxy")).toBe(false);
	expect(legacyComposition.includes("initAudioSource")).toBe(false);
	expect(legacyComposition.includes("createMediaElementSource")).toBe(false);
	expect(legacyComposition.includes("setSinkId")).toBe(false);
	expect(legacyComposition.includes("enumerateDevices")).toBe(false);
});

test("App 不创建或读取 playback HTMLAudioElement，Runtime Host 发布只读输出", () => {
	const app = readFileSync(resolve(webSourceRoot, "app/App.tsx"), "utf8");
	const runtimeHost = readFileSync(
		resolve(webSourceRoot, "features/playback/PlaybackRuntimeHost.tsx"),
		"utf8",
	);
	const directAudioConstructors = listProductionSources(webSourceRoot)
		.filter((file) => /\bnew\s+(?:window\.)?Audio\s*\(/.test(readFileSync(file, "utf8")))
		.map(repositoryPath);

	expect(directAudioConstructors).toEqual([]);
	for (const forbidden of ["HTMLAudioElement", "audioElementRef", "new Audio(", "getActiveElement("]) {
		expect(app.includes(forbidden)).toBe(false);
	}
	expect(runtimeHost).toContain("new PlayerController()");
	expect(runtimeHost).toContain("audioFrameSourceRef.current = ownedFrameSource");
	expect(runtimeHost).toContain("playbackRateRef.current = controller.getActiveElement()?.playbackRate || 1");
	expect(app).toContain("audioFrameSource: playbackAudioFrameSource");
	expect(app).toContain("playbackRate: playbackRateRef.current");
});

test("Playback session 与 App composition 不得取得 Audio Graph 或设备路由 ownership", () => {
	const forbiddenTokens = ["AudioContext", "createMediaElementSource", "setSinkId", "enumerateDevices"];
	for (const relativePath of [
		"features/playback/usePlaybackSessionRuntime.ts",
		"app/App.tsx",
	]) {
		const source = readFileSync(resolve(webSourceRoot, relativePath), "utf8");
		for (const token of forbiddenTokens) {
			expect(source.includes(token)).toBe(false);
		}
	}
});

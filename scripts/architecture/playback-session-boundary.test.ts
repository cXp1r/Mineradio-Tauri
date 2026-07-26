import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("App delegates current-track session ownership to the playback runtime", () => {
	const appSource = readFileSync(
		fileURLToPath(new URL("../../apps/web/src/app/App.tsx", import.meta.url)),
		"utf8",
	);
	const runtimeSource = readFileSync(
		fileURLToPath(new URL("../../apps/web/src/features/playback/usePlaybackSessionRuntime.ts", import.meta.url)),
		"utf8",
	);
	const coordinatorSource = readFileSync(
		fileURLToPath(new URL("../../apps/web/src/features/playback/playback-session-coordinator.ts", import.meta.url)),
		"utf8",
	);

	expect(appSource).toContain("usePlaybackSessionRuntime({");
	expect(appSource).toMatch(/usePlaybackSessionRuntime\(\{[\s\S]*?\n\s+playbackIntentId,\n/);
	expect(appSource).not.toContain("playback-state-machine");
	for (const forbidden of [
		"playbackRequestSeqRef",
		"lyricRequestSeqRef",
		"mediaErrorRecoveryTrackKeyRef",
		"loadedPlaybackUrlRef",
		"pausedAtMsRef",
		"resolvePlayableAudio({",
		"trackQualities(",
		"music.lyrics.lyric(",
		"podcastDjBeatmap(",
	]) {
		expect(appSource).not.toContain(forbidden);
	}

	expect(runtimeSource).toContain('from "./playback-session-coordinator"');
	expect(runtimeSource).toContain("new PlaybackSessionCoordinator()");
	expect(coordinatorSource).toContain('from "./playback-state-machine"');
	expect(runtimeSource).toContain("resolvePlayableAudio({");
	expect(runtimeSource).toContain("services.music.lyrics.lyric(currentTrack)");
	expect(runtimeSource).toContain("services.music.discover.podcastDjBeatmap(");
});

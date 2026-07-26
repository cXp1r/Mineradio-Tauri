import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("App playback session depends on application ports instead of SidecarClient methods", () => {
	const appSource = readFileSync(
		fileURLToPath(new URL("../../apps/web/src/app/App.tsx", import.meta.url)),
		"utf8",
	);

	expect(appSource).not.toContain("client.resolveSongUrl(");
	expect(appSource).not.toContain("client.audioProxyUrl(");
	expect(appSource).not.toContain("client.lyric(currentTrack)");
	expect(appSource).not.toContain("sidecarClient?.resolveSongUrl");
	expect(appSource).toContain("resolvePlayableAudio({");
	expect(appSource).toContain("services.music.lyrics.lyric(currentTrack)");
});

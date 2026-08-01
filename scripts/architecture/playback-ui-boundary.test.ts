import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(
	resolve(import.meta.dir, "../../apps/web/src/app/App.tsx"),
	"utf8",
);

test("App delegates playback UI events and track customization", () => {
	expect(appSource).toContain("usePlaybackUiController");
	expect(appSource).toContain("useTrackCustomizationController");
	expect(appSource).not.toContain("URL.createObjectURL");
	expect(appSource).not.toContain("URL.revokeObjectURL");
	expect(appSource).not.toContain("saveCustomCoverForTrack");
	expect(appSource).not.toContain("saveCustomLyricForTrack");
	expect(appSource).not.toContain("lastRuntimeDurationRef");
	expect(appSource).not.toContain("const handleRuntimeTimeUpdate");
	expect(appSource).not.toContain("const handleRuntimeEnded");
});

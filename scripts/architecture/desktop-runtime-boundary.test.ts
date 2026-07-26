import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("App delegates desktop listeners and lyric lifecycle to the desktop runtime", () => {
	const appSource = readFileSync(
		fileURLToPath(new URL("../../apps/web/src/app/App.tsx", import.meta.url)),
		"utf8",
	);
	const runtimeSource = readFileSync(
		fileURLToPath(new URL(
			"../../apps/web/src/features/desktop/useDesktopRuntime.ts",
			import.meta.url,
		)),
		"utf8",
	);

	expect(appSource).toContain("useDesktopRuntime({");
	for (const forbidden of [
		"listenWindowState(",
		"listenGlobalHotkey(",
		"configureGlobalHotkeys(",
		"desktopLyricsPushStateRef",
		"shouldPushDesktopLyricsPayload(",
	]) {
		expect(appSource).not.toContain(forbidden);
	}

	expect(runtimeSource).toContain("DesktopRuntimePort");
	expect(runtimeSource).toContain("listenWindowState(");
	expect(runtimeSource).toContain("listenGlobalHotkey(");
});

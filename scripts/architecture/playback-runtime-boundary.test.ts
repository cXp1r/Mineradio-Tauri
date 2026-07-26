import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readRepositoryFile(relativePath: string): string {
	return readFileSync(
		fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
		"utf8",
	);
}

test("PlaybackRuntimeHost owns PlayerController construction and event subscriptions", () => {
	const appSource = readRepositoryFile("apps/web/src/app/App.tsx");
	const runtimeSource = readRepositoryFile(
		"apps/web/src/features/playback/PlaybackRuntimeHost.tsx",
	);

	expect(appSource).not.toContain("new PlayerController(");
	expect(appSource).not.toContain('controller.on("timeupdate"');
	expect(appSource).not.toContain('controller.on("error"');
	expect(runtimeSource).toContain("export function PlaybackRuntimeHost");
	expect(runtimeSource).toContain('controller.on("timeupdate"');
	expect(runtimeSource).toContain('controller.on("error"');
});

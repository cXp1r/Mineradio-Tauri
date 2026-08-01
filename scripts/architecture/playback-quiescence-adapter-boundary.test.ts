import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("production bootstrap installs playback quiescence before render and disposes it on pagehide", () => {
	const bootstrap = read("apps/web/src/main.tsx");
	const createIndex = bootstrap.indexOf("createProductionTauriPlaybackQuiescenceAdapter()");
	const renderIndex = bootstrap.indexOf("createRoot(");
	expect(createIndex).toBeGreaterThan(0);
	expect(renderIndex).toBeGreaterThan(createIndex);
	expect(bootstrap).toContain("playbackQuiescenceAdapter={playbackQuiescenceAdapter}");
	expect(bootstrap).toContain("playbackQuiescenceAdapter?.dispose()");
});

test("playback quiescence transport stays a narrow implementation-private adapter", () => {
	const source = read(
		"apps/web/src/adapters/tauri/tauri-playback-quiescence-adapter.ts",
	);
	const nativeBridge = read(
		"apps/desktop/src-tauri/src/app/update_web_quiescence.rs",
	);
	const commands = read("apps/desktop/src-tauri/src/commands/updater.rs");
	for (const event of ["prepare", "confirm", "rollback", "release"]) {
		expect(source).toContain(`mineradio-update-web-quiescence-${event}`);
	}
	expect(source).toContain("updater_web_quiescence_acknowledge");
	expect(source).toContain("updater_web_quiescence_reconcile");
	expect(source).not.toContain("UpdateExperienceController");
	expect(source).not.toContain("UpdateRuntimePort");
	expect(source).not.toContain("dispatchUpdateIntent");
	expect(nativeBridge).toContain("emit_to(window_labels::MAIN");
	expect(nativeBridge).not.toContain("self.app.emit(event, payload)");
	expect(commands).toContain("caller: tauri::WebviewWindow");
	expect(commands).toContain("!is_main_update_caller(caller.label())");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("dormant Update Runtime is not wired into the production bootstrap", () => {
	const app = read("apps/web/src/app/App.tsx");
	const shell = read("apps/web/src/app/AppShell.tsx");
	const desktop = read("apps/desktop/src-tauri/src/lib.rs");

	expect(app).not.toContain("createTauriUpdateRuntimePort");
	expect(shell).not.toContain("createTauriUpdateRuntimePort");
	expect(desktop).not.toContain("get_update_runtime_snapshot");
	expect(desktop).not.toContain("dispatch_update_runtime_intent");
	expect(desktop).toContain("commands::get_updater_status");
	expect(desktop).toContain("commands::check_for_update");
	expect(desktop).toContain("commands::install_update");
});

test("dormant Update Runtime stays independent from Sidecar application ports", () => {
	const port = read("apps/web/src/ports/update-runtime-port.ts");
	const adapter = read("apps/web/src/adapters/tauri/tauri-update-runtime.ts");

	expect(port).not.toContain("ApplicationRuntimePort");
	expect(port).not.toContain("Sidecar");
	expect(adapter).not.toContain("ApplicationRuntimePort");
	expect(adapter).not.toContain("Sidecar");
});

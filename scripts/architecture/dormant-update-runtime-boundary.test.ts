import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function filesUnder(path: string, extensions: ReadonlySet<string>) {
	const files: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
			} else if (
				entry.isFile() &&
				[...extensions].some((extension) => entry.name.endsWith(extension))
			) {
				files.push(entryPath);
			}
		}
	};
	visit(resolve(root, path));
	return files;
}

function forbiddenReferences(files: readonly string[], forbidden: readonly string[]) {
	return files.flatMap((file) => {
		const content = readFileSync(file, "utf8");
		return forbidden
			.filter((value) => content.includes(value))
			.map((value) => `${relative(root, file).replaceAll("\\", "/")}: ${value}`);
	});
}

test("dormant Update Runtime is not wired into the production bootstrap", () => {
	const app = read("apps/web/src/app/App.tsx");
	const shell = read("apps/web/src/app/AppShell.tsx");
	const desktop = read("apps/desktop/src-tauri/src/lib.rs");
	const state = read("apps/desktop/src-tauri/src/app/state.rs");
	const updaterCommands = read("apps/desktop/src-tauri/src/commands/updater.rs");

	expect(app).not.toContain("createTauriUpdateRuntimePort");
	expect(shell).not.toContain("createTauriUpdateRuntimePort");
	expect(desktop).not.toContain("get_update_runtime_snapshot");
	expect(desktop).not.toContain("dispatch_update_runtime_intent");
	expect(desktop).not.toContain("GitHubReleaseSource");
	expect(desktop).not.toContain("UpdateRuntime::new");
	expect(state).not.toContain("GitHubReleaseSource");
	expect(state).not.toContain("UpdateRuntime");
	expect(desktop).toContain("commands::get_updater_status");
	expect(desktop).toContain("commands::check_for_update");
	expect(desktop).toContain("commands::install_update");
	expect(updaterCommands).toContain("download_and_install");
	expect(updaterCommands).not.toContain("GitHubReleaseSource");
});

test("dormant Update Runtime cannot move into another production module", () => {
	const rustFiles = [
		resolve(root, "apps/desktop/src-tauri/src/lib.rs"),
		resolve(root, "apps/desktop/src-tauri/src/main.rs"),
		...filesUnder("apps/desktop/src-tauri/src/app", new Set([".rs"])),
		...filesUnder("apps/desktop/src-tauri/src/commands", new Set([".rs"])),
		...filesUnder("apps/desktop/src-tauri/src/platform", new Set([".rs"])),
	];
	const webAdapter = resolve(
		root,
		"apps/web/src/adapters/tauri/tauri-update-runtime.ts",
	);
	const webPort = resolve(root, "apps/web/src/ports/update-runtime-port.ts");
	const webFiles = filesUnder("apps/web/src", new Set([".ts", ".tsx"])).filter(
		(file) =>
			file !== webAdapter &&
			file !== webPort &&
			!file.endsWith(".test.ts") &&
			!file.endsWith(".test.tsx") &&
			!file.endsWith(".spec.ts") &&
			!file.endsWith(".spec.tsx"),
	);

	expect(
		forbiddenReferences(rustFiles, [
			"runtime::updater",
			"GitHubReleaseSource",
			"UpdateRuntime",
			"get_update_runtime_snapshot",
			"dispatch_update_runtime_intent",
		]),
	).toEqual([]);
	expect(
		forbiddenReferences(webFiles, [
			"createTauriUpdateRuntimePort",
			"get_update_runtime_snapshot",
			"dispatch_update_runtime_intent",
		]),
	).toEqual([]);
});

test("dormant Update Runtime stays independent from Sidecar application ports", () => {
	const port = read("apps/web/src/ports/update-runtime-port.ts");
	const adapter = read("apps/web/src/adapters/tauri/tauri-update-runtime.ts");

	expect(port).not.toContain("ApplicationRuntimePort");
	expect(port).not.toContain("Sidecar");
	expect(adapter).not.toContain("ApplicationRuntimePort");
	expect(adapter).not.toContain("Sidecar");
});

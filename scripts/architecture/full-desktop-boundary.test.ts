import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rustRoot = fileURLToPath(new URL("../../apps/desktop/src-tauri/src/", import.meta.url));

function source(relativePath: string) {
	return readFileSync(`${rustRoot}/${relativePath}`, "utf8");
}

test("M6 full-desktop command remains a thin transport adapter", () => {
	const commandPath = `${rustRoot}/commands/full_desktop.rs`;
	expect(existsSync(commandPath)).toBe(true);
	const command = readFileSync(commandPath, "utf8");
	expect(command.split(/\r?\n/).length).toBeLessThan(130);
	expect(command).toContain("full_desktop");
	for (const forbidden of ["windows_sys", "HWND", "SetParent", "EnumWindows", "sidecar::"]) {
		expect(command).not.toContain(forbidden);
	}
});

test("M6 core has no Tauri, command or sidecar ownership", () => {
	const core = source("runtime/full_desktop/mod.rs");
	// 文件日志可使用平台原子替换；核心不能取得 Tauri/command/sidecar ownership。
	for (const forbidden of ["tauri::", "commands::", "sidecar::", "AppHandle"]) {
		expect(core).not.toContain(forbidden);
	}
	expect(core).toContain("trait FullDesktopPlatform");
	expect(core).toContain("trait RecoveryJournalStore");
	expect(core).toContain("write_before_mutation");
});

test("M6 sources do not leak sidecar/API or M7/M9 implementation", () => {
	const platform = source("platform/windows/full_desktop.rs");
	const command = source("commands/full_desktop.rs");
	const combined = `${source("runtime/full_desktop/mod.rs")}\n${platform}\n${command}`;
	for (const forbidden of [
		"sidecar::",
		"mineradio_api",
		"MineRadioApi",
		"Wallpaper Engine",
		"WallpaperEngine",
		"Dwm",
		"WGC",
		"Windows.Graphics.Capture",
	]) {
		expect(combined).not.toContain(forbidden);
	}
	expect(platform).toContain("impl FullDesktopPlatform for TauriFullDesktopPlatform");
});

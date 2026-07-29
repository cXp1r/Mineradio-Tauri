import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	M7_ADDITIVE_DESKTOP_COMMANDS,
	M7_DESKTOP_COMMAND_INTERFACES,
	M7_DESKTOP_SERIALIZATION_CONTRACTS,
	parseRustSerializationContracts,
	parseTauriCommandInterfaces,
} from "./desktop-command-manifest.mjs";

const sourceRoot = fileURLToPath(new URL("../../apps/desktop/src-tauri/src/", import.meta.url));

test("M7 exposes exactly the approved Wallpaper Engine command interfaces", () => {
	const source = readFileSync(`${sourceRoot}/commands/wallpaper_engine.rs`, "utf8");
	const interfaces = parseTauriCommandInterfaces(source);
	expect(Object.keys(interfaces)).toEqual([...M7_ADDITIVE_DESKTOP_COMMANDS]);
	for (const [command, expected] of Object.entries(M7_DESKTOP_COMMAND_INTERFACES)) {
		expect(interfaces[command]).toBe(expected);
	}
});

test("M7 freezes Tauri-only request and runtime serialization without shared DTOs", () => {
	const appSource = readFileSync(`${sourceRoot}/app/wallpaper_engine_runtime.rs`, "utf8");
	const coreSource = readFileSync(`${sourceRoot}/runtime/wallpaper_engine/mod.rs`, "utf8");
	const contracts = parseRustSerializationContracts(`${appSource}\n${coreSource}`);
	for (const [name, expected] of Object.entries(M7_DESKTOP_SERIALIZATION_CONTRACTS)) {
		expect(contracts[name]).toEqual(expected);
	}
	expect(appSource).not.toContain("packages/shared");
	expect(appSource).not.toContain("sidecar::");
});

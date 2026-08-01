import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DESKTOP_COMMAND_REGISTRATION_ORDER,
	M6_ADDITIVE_DESKTOP_COMMANDS,
	M6_DESKTOP_COMMAND_INTERFACES,
	M6_DESKTOP_SERIALIZATION_CONTRACTS,
	parseDesktopCommandManifest,
	parseRustSerializationContracts,
	parseTauriCommandInterfaces,
} from "./desktop-command-manifest.mjs";

const sourceRoot = fileURLToPath(new URL("../../apps/desktop/src-tauri/src/", import.meta.url));

test("M6 registers exactly five additive full-desktop commands in the frozen order", () => {
	const commands = parseDesktopCommandManifest(readFileSync(`${sourceRoot}/lib.rs`, "utf8"));
	expect(commands).toEqual(DESKTOP_COMMAND_REGISTRATION_ORDER);
	const start = commands.indexOf(M6_ADDITIVE_DESKTOP_COMMANDS[0]);
	expect(commands.slice(start, start + M6_ADDITIVE_DESKTOP_COMMANDS.length)).toEqual(M6_ADDITIVE_DESKTOP_COMMANDS);
});

test("M6 full-desktop commands preserve narrow parameters and transport return state", () => {
	const commandSource = readdirSync(`${sourceRoot}/commands`)
		.filter((name) => name.endsWith(".rs"))
		.map((name) => readFileSync(join(sourceRoot, "commands", name), "utf8"))
		.join("\n");
	const interfaces = parseTauriCommandInterfaces(commandSource);
	for (const [command, expected] of Object.entries(M6_DESKTOP_COMMAND_INTERFACES)) {
		expect(interfaces[command]).toBe(expected);
	}
});

test("M6 DTO keeps the camelCase state contract out of shared/API DTOs", () => {
	const commandSource = readFileSync(`${sourceRoot}/commands/full_desktop.rs`, "utf8");
	const runtimeSource = readFileSync(`${sourceRoot}/runtime/full_desktop/mod.rs`, "utf8");
	const contracts = parseRustSerializationContracts(`${commandSource}\n${runtimeSource}`);
	for (const [name, expected] of Object.entries(M6_DESKTOP_SERIALIZATION_CONTRACTS)) {
		expect(contracts[name]).toEqual(expected);
	}
	expect(commandSource).not.toContain("packages/shared");
	expect(commandSource).not.toContain("sidecar::");
});

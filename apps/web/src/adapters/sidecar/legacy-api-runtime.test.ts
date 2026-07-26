import { expect, test } from "bun:test";
import type { SidecarClient } from "../../api/sidecar-client";
import { createLegacyApiRuntime } from "./legacy-api-runtime";

test("legacy API runtime hides transport addresses and delegates health checks", async () => {
	const calls: string[] = [];
	const client = {
		async health() {
			calls.push("health");
			return { ok: true };
		},
		async capabilities() {
			calls.push("capabilities");
			return { providers: {} };
		},
	} as unknown as Pick<SidecarClient, "health" | "capabilities">;
	const runtime = createLegacyApiRuntime(client, {
		getRuntimeConfig: async () => ({
			sidecarBaseUrl: "http://127.0.0.1:39999",
			appDataDir: "D:/app-data",
			appVersion: "0.1.0",
			schemaVersion: "1",
			updaterPublicKeyConfigured: true,
		}),
		getSidecarStatus: async () => ({
			phase: "ready",
			baseUrl: "http://127.0.0.1:39999",
			pid: 1234,
			restarts: 1,
			lastError: null,
			lastHealthOkMs: 99,
			providers: ["netease", "qq", "soda"],
			logPath: "D:/logs/sidecar.log",
		}),
	});

	const config = await runtime.getConfig();
	const status = await runtime.getStatus();
	await runtime.health();
	await runtime.capabilities();

	expect(config).toEqual({
		appDataDir: "D:/app-data",
		appVersion: "0.1.0",
		schemaVersion: "1",
		updaterPublicKeyConfigured: true,
	});
	expect(status).toEqual({
		phase: "ready",
		pid: 1234,
		restarts: 1,
		lastError: null,
		lastHealthOkMs: 99,
		providers: ["netease", "qq", "soda"],
		logPath: "D:/logs/sidecar.log",
	});
	expect("sidecarBaseUrl" in config).toBe(false);
	expect("baseUrl" in status).toBe(false);
	expect(calls).toEqual(["health", "capabilities"]);
});

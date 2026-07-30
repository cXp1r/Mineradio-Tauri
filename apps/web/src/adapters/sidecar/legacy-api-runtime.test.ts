import { expect, test } from "bun:test";
import { SidecarClientError, type SidecarClient } from "../../api/sidecar-client";
import { createLegacyApiRuntime } from "./legacy-api-runtime";

const runtimeDependencies = {
	getRuntimeConfig: async () => ({
		sidecarBaseUrl: "http://127.0.0.1:39999",
		appDataDir: "D:/app-data",
		appVersion: "0.1.0",
		schemaVersion: "1",
		updaterPublicKeyConfigured: true,
	}),
	getSidecarStatus: async () => ({
		phase: "ready" as const,
		baseUrl: "http://127.0.0.1:39999",
		pid: 1234,
		restarts: 1,
		lastError: null,
		lastHealthOkMs: 99,
		providers: ["netease", "qq", "soda"],
		logPath: "D:/logs/sidecar.log",
	}),
};

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
	const runtime = createLegacyApiRuntime(client, runtimeDependencies);

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

for (const operation of ["health", "capabilities"] as const) {
	test(`legacy API runtime preserves ${operation} result and error identity`, async () => {
		const result = Object.freeze({ operation });
		const successCalls: string[] = [];
		const successClient = new Proxy({}, {
			get(_target, property) {
				return () => {
					successCalls.push(String(property));
					return Promise.resolve(result);
				};
			},
		}) as Pick<SidecarClient, "health" | "capabilities">;
		const successRuntime = createLegacyApiRuntime(successClient, runtimeDependencies);

		expect(await successRuntime[operation]()).toBe(result);
		expect(successCalls).toEqual([operation]);

		const error = new SidecarClientError({
			code: "NETWORK",
			message: "sidecar 连接失败，请稍后重试",
			retryable: true,
			rawMessage: "Failed to fetch",
		});
		const failureCalls: string[] = [];
		const failureClient = new Proxy({}, {
			get(_target, property) {
				return () => {
					failureCalls.push(String(property));
					return Promise.reject(error);
				};
			},
		}) as Pick<SidecarClient, "health" | "capabilities">;
		const failureRuntime = createLegacyApiRuntime(failureClient, runtimeDependencies);
		let caught: unknown;
		try {
			await failureRuntime[operation]();
		} catch (caughtError) {
			caught = caughtError;
		}

		expect(caught).toBe(error);
		expect(failureCalls).toEqual([operation]);
	});
}

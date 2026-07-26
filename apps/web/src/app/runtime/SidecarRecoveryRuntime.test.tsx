import { expect, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { CapabilityMatrix, ProviderLoginStatus } from "@mineradio/shared";
import type { SidecarClient } from "../../api/sidecar-client";
import type { AppServices } from "../app-services";
import type { SidecarRecoveryNoticeState } from "../../components/shell/SidecarRecoveryNotice";
import { SidecarRecoveryRuntime } from "./SidecarRecoveryRuntime";

test("SidecarRecoveryRuntime preserves bootstrap, account restore and recovery callbacks", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const statuses: SidecarRecoveryNoticeState[] = [];
	const capabilityMatrix = { providers: {} } as CapabilityMatrix;
	const loginStatus = {
		provider: "netease",
		loggedIn: true,
	} as ProviderLoginStatus;
	const client = {} as SidecarClient;
	const services = {
		apiRuntime: {
			getConfig: async () => {
				throw new Error("测试不应重新读取配置");
			},
			getStatus: async () => ({
				phase: "recovering",
				pid: 99,
				restarts: 1,
				lastError: "temporary",
				lastHealthOkMs: null,
				providers: ["netease"],
				logPath: "",
			}),
			health: async () => {
				calls.push("health");
				return { ok: true } as never;
			},
			capabilities: async () => {
				calls.push("capabilities");
				return capabilityMatrix;
			},
		},
		music: {
			accounts: {
				loginStatus: async (provider: string) => {
					calls.push(`login:${provider}`);
					return loginStatus;
				},
			},
		},
	} as unknown as AppServices;
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(
			<SidecarRecoveryRuntime
				initialRuntimeConfig={{
					sidecarBaseUrl: "http://127.0.0.1:39999",
					appDataDir: "",
					appVersion: "0.1.0",
					schemaVersion: "1",
					updaterPublicKeyConfigured: false,
				}}
				createSidecarClient={() => client}
				servicesFactory={() => services}
				loginProviders={["netease"]}
				onConnection={() => { calls.push("connection"); }}
				onCapabilities={() => { calls.push("matrix"); }}
				onProviderStatus={() => { calls.push("provider-status"); }}
				onRefreshLibrary={() => { calls.push("library"); }}
				onRecoveryState={(state) => { statuses.push(state); }}
			/>,
		));
		for (let index = 0; index < 12; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(calls).toContain("connection");
		expect(calls).toContain("health");
		expect(calls).toContain("capabilities");
		expect(calls).toContain("matrix");
		expect(calls).toContain("login:netease");
		expect(calls).toContain("provider-status");
		expect(calls).toContain("library");
		expect(statuses[0]?.phase).toBe("recovering");
		expect(statuses[0]?.restarts).toBe(1);
	} finally {
		flushSync(() => root.unmount());
		host.remove();
	}
});

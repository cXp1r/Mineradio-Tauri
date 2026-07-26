import { expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useUpdateStore } from "../../stores/update-store";
import type { UpdateCheckResult } from "../../tauri/updater";
import {
	useUpdaterController,
	type UpdaterControllerResult,
} from "./useUpdaterController";

test("updater controller performs startup status check and opens dev preview", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	useUpdateStore.getState().reset();
	const calls: string[] = [];
	const resultRef: { current: UpdaterControllerResult | null } = { current: null };
	const result: UpdateCheckResult = {
		available: false,
		version: null,
		currentVersion: "0.1.0",
		body: null,
		message: null,
		date: null,
		error: null,
		requiresSignature: true,
		signatureGate: false,
		installState: "not-available",
	};

	function Harness() {
		resultRef.current = useUpdaterController({
			showToast: (message) => calls.push(`toast:${message}`),
			dependencies: {
				async checkForUpdate() {
					calls.push("check");
					return result;
				},
				async getUpdaterStatus() {
					calls.push("status");
					return result;
				},
				async installUpdate() {
					return result;
				},
				shouldOpenDevUpdatePreview: () => true,
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let index = 0; index < 40 && !resultRef.current?.modalOpen; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(calls).toEqual(["status"]);
	expect(resultRef.current?.modalOpen).toBe(true);
	expect(useUpdateStore.getState().status).toBe("not-available");

	root.unmount();
	host.remove();
});

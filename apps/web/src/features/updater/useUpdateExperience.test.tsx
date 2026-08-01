import { expect, test } from "bun:test";
import React, { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
	UpdateIntent,
	UpdateReceipt,
	UpdateRuntimePort,
	UpdateSnapshot,
} from "../../ports/update-runtime-port";
import { createUpdateExperienceController } from "./update-experience-controller";
import { useUpdateExperience } from "./useUpdateExperience";
import type { UpdateViewModel } from "./update-view-model";

test("StrictMode 重挂订阅不会重复创建运行时监听或重复提示", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let snapshot: UpdateSnapshot = {
		revision: 1,
		phase: "available",
		currentVersion: "0.9.0",
		candidate: {
			id: "candidate-1.0.0",
			version: "1.0.0",
			notes: [],
			publishedAt: null,
		},
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
	};
	let runtimeSubscriptions = 0;
	const listeners = new Set<() => void>();
	const runtime: UpdateRuntimePort = {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			runtimeSubscriptions += 1;
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async dispatch(_intent: UpdateIntent): Promise<UpdateReceipt> {
			return "accepted";
		},
	};
	const controller = createUpdateExperienceController(runtime);
	const latest: { current: UpdateViewModel | null } = { current: null };

	function Harness() {
		latest.current = useUpdateExperience(controller, "normal").viewModel;
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<StrictMode><Harness /></StrictMode>));
	expect(runtimeSubscriptions).toBe(1);
	expect(latest.current?.modalOpen).toBe(true);

	controller.closeModal();
	snapshot = { ...snapshot, revision: 2 };
	for (const listener of listeners) listener();
	flushSync(() => root.render(<StrictMode><Harness /></StrictMode>));
	expect(latest.current?.modalOpen).toBe(false);
	expect(runtimeSubscriptions).toBe(1);

	root.unmount();
	controller.dispose();
	host.remove();
});

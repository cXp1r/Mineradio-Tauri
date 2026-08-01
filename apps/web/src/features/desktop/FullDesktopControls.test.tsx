import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { FullDesktopRuntimeState } from "../../ports/full-desktop-runtime-port";
import { FullDesktopControls } from "./FullDesktopControls";
import type { FullDesktopRuntimeController } from "./useFullDesktopRuntime";

function recoveryState(): FullDesktopRuntimeState {
	return {
		phase: "recoveryRequired",
		requestedMode: "disabled",
		effectiveMode: "disabled",
		iconsVisible: true,
		interactionLocked: false,
		recoveryRequired: true,
		autoResumeSuppressed: true,
		explorerGeneration: 3,
		lastError: "需要恢复桌面宿主",
	};
}

function controller(
	overrides: Partial<FullDesktopRuntimeController> = {},
): FullDesktopRuntimeController {
	const noop = async () => undefined;
	return {
		state: recoveryState(),
		busy: false,
		error: null,
		refresh: noop,
		setMode: async () => undefined,
		setIconsVisible: async () => undefined,
		setInteractionLocked: async () => undefined,
		recover: noop,
		...overrides,
	};
}

test("full desktop recovery action is exposed only for native recoveryRequired state", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	let recoverCalls = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(FullDesktopControls, controller({
			recover: async () => {
				recoverCalls += 1;
			},
		})));
	});

	const recoveryButton = host.querySelector<HTMLButtonElement>("[data-full-desktop-recover]");
	expect(recoveryButton).not.toBeNull();
	expect(host.textContent).toContain("自动恢复已暂停");
	await act(async () => {
		recoveryButton!.click();
		await Promise.resolve();
	});
	expect(recoverCalls).toBe(1);

	await act(async () => {
		root.render(React.createElement(FullDesktopControls, controller({
			state: { ...recoveryState(), phase: "disabled", recoveryRequired: false },
		})));
	});
	expect(host.querySelector("[data-full-desktop-recover]")).toBeNull();

	await act(async () => root.unmount());
	host.remove();
});

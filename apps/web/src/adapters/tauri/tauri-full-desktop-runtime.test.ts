import { expect, test } from "bun:test";
import type { FullDesktopRuntimeState } from "../../ports/full-desktop-runtime-port";
import {
	createTauriFullDesktopRuntime,
	type TauriFullDesktopRuntimeDependencies,
} from "./tauri-full-desktop-runtime";

function state(): FullDesktopRuntimeState {
	return {
		phase: "disabled",
		requestedMode: "disabled",
		effectiveMode: "disabled",
		iconsVisible: true,
		interactionLocked: false,
		recoveryRequired: false,
		autoResumeSuppressed: false,
		explorerGeneration: 0,
	};
}

test("Tauri full desktop adapter delegates only the five additive command wrappers", async () => {
	const calls: string[] = [];
	const dependencies = {
		getFullDesktopRuntimeState: async () => {
			calls.push("get");
			return state();
		},
		setFullDesktopMode: async (mode) => {
			calls.push(`mode:${mode}`);
			return { ...state(), requestedMode: mode, effectiveMode: mode };
		},
		setDesktopIconsVisible: async (visible) => {
			calls.push(`icons:${visible}`);
			return { ...state(), iconsVisible: visible };
		},
		setFullDesktopInteractionLocked: async (locked) => {
			calls.push(`locked:${locked}`);
			return { ...state(), interactionLocked: locked };
		},
		recoverFullDesktopRuntime: async () => {
			calls.push("recover");
			return state();
		},
	} satisfies TauriFullDesktopRuntimeDependencies;
	const runtime = createTauriFullDesktopRuntime(dependencies);

	await runtime.getRuntimeState();
	await runtime.setMode("passive");
	await runtime.setIconsVisible(false);
	await runtime.setInteractionLocked(true);
	await runtime.recover();

	expect(calls).toEqual([
		"get",
		"mode:passive",
		"icons:false",
		"locked:true",
		"recover",
	]);
});

import { expect, test } from "bun:test";
import {
	createTauriDesktopRuntime,
	type TauriDesktopRuntimeDependencies,
} from "./tauri-desktop-runtime";

test("Tauri desktop runtime delegates current command wrapper arguments", async () => {
	const calls: string[] = [];
	const dependencies = {
		getWindowState: async () => ({
			isMaximized: false,
			isNativeFullScreen: false,
			isHtmlFullScreen: false,
			isWindowFullScreen: false,
			isFullScreen: false,
			isMinimized: false,
			isVisible: true,
			isFocused: true,
			isPrimaryDisplay: true,
			hasDisplayOnLeft: false,
			hasDisplayOnRight: false,
			displayBounds: null,
		}),
		listenWindowState: async () => () => undefined,
		minimizeWindow: async () => { calls.push("minimize"); },
		toggleWindowMaximize: async () => { calls.push("maximize"); },
		toggleWindowFullscreen: async () => { calls.push("fullscreen"); },
		closeWindow: async () => { calls.push("close"); },
		openExternalUrl: async (url) => {
			calls.push(`external:${url}`);
			return true;
		},
		showDesktopLyricsWindow: async () => { calls.push("lyrics:show"); },
		closeDesktopLyricsWindow: async () => { calls.push("lyrics:close"); },
		updateDesktopLyricsPayload: async (payload) => {
			calls.push(`lyrics:update:${JSON.stringify(payload)}`);
		},
		configureGlobalHotkeys: async (bindings) => ({
			ok: true,
			results: bindings.map((binding) => ({ ...binding, ok: true })),
		}),
		listenGlobalHotkey: async () => () => undefined,
		openProviderLoginWindow: async (provider) => ({
			provider,
			stored: true,
			reused: false,
			partial: false,
		}),
	} satisfies TauriDesktopRuntimeDependencies;
	const runtime = createTauriDesktopRuntime(dependencies);

	await runtime.minimizeWindow();
	await runtime.openExternalUrl("https://example.com");
	await runtime.showDesktopLyricsWindow();
	await runtime.updateDesktopLyricsPayload({ title: "测试歌曲" });
	const hotkeys = await runtime.configureGlobalHotkeys([
		{ action: "play-pause", accelerator: "Space" },
	]);
	const login = await runtime.openProviderLoginWindow("qq");

	expect(calls).toEqual([
		"minimize",
		"external:https://example.com",
		"lyrics:show",
		'lyrics:update:{"title":"测试歌曲"}',
	]);
	expect(hotkeys).toEqual({
		ok: true,
		results: [{ action: "play-pause", accelerator: "Space", ok: true }],
	});
	expect(login).toEqual({ provider: "qq", stored: true, reused: false, partial: false });
});

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	DesktopGlobalHotkeyBinding,
	DesktopJsonValue,
	DesktopRuntimePort,
	DesktopWindowState,
} from "../../ports/desktop-runtime-port";
import {
	createDesktopLyricsPushState,
	shouldPushDesktopLyricsPayload,
	type DesktopLyricsPushPayload,
} from "../../desktop-lyrics/desktop-lyrics-push";

export const DEFAULT_DESKTOP_HOTKEYS: DesktopGlobalHotkeyBinding[] = [
	{ action: "togglePlay", accelerator: "Control+Alt+Space" },
	{ action: "prevTrack", accelerator: "Control+Alt+ArrowLeft" },
	{ action: "nextTrack", accelerator: "Control+Alt+ArrowRight" },
	{ action: "volumeUp", accelerator: "Control+Alt+ArrowUp" },
	{ action: "volumeDown", accelerator: "Control+Alt+ArrowDown" },
	{ action: "toggleFullscreen", accelerator: "Control+Alt+KeyF" },
	{ action: "toggleDesktopLyrics", accelerator: "Control+Alt+KeyL" },
];

export interface DesktopRuntimeOptions {
	desktop: DesktopRuntimePort;
	buildLyricsPayload(force: boolean): DesktopLyricsPushPayload;
	lyricsPayloadVersion: unknown;
	hotkeyActions: Record<string, () => void>;
	onWindowState?(state: DesktopWindowState): void;
	onWindowCleanup?(): void;
}

export interface DesktopRuntimeResult {
	desktopLyricsEnabled: boolean;
	desktopWindowState: DesktopWindowState | null;
	toggleDesktopLyrics(): Promise<void>;
	setDesktopLyricsEnabled(enabled: boolean): Promise<void>;
}

export function useDesktopRuntime({
	desktop,
	buildLyricsPayload,
	lyricsPayloadVersion,
	hotkeyActions,
	onWindowState,
	onWindowCleanup,
}: DesktopRuntimeOptions): DesktopRuntimeResult {
	const [desktopLyricsEnabled, setDesktopLyricsEnabledState] = useState(false);
	const [desktopWindowState, setDesktopWindowState] =
		useState<DesktopWindowState | null>(null);
	const lyricsEnabledRef = useRef(false);
	const pushStateRef = useRef(createDesktopLyricsPushState());
	const dependenciesRef = useRef({
		desktop,
		buildLyricsPayload,
		hotkeyActions,
		onWindowState,
		onWindowCleanup,
	});
	dependenciesRef.current = {
		desktop,
		buildLyricsPayload,
		hotkeyActions,
		onWindowState,
		onWindowCleanup,
	};

	const publishWindowState = useCallback((state: DesktopWindowState) => {
		setDesktopWindowState(state);
		dependenciesRef.current.onWindowState?.(state);
	}, []);

	const setDesktopLyricsEnabled = useCallback(async (enabled: boolean) => {
		const dependencies = dependenciesRef.current;
		if (!enabled) {
			await dependencies.desktop.closeDesktopLyricsWindow();
			lyricsEnabledRef.current = false;
			setDesktopLyricsEnabledState(false);
			return;
		}
		const payload = dependencies.buildLyricsPayload(true);
		if (
			shouldPushDesktopLyricsPayload(
				pushStateRef.current,
				payload,
				performance.now(),
				true,
			)
		) {
			await dependencies.desktop.updateDesktopLyricsPayload(payload as DesktopJsonValue);
		}
		await dependencies.desktop.showDesktopLyricsWindow();
		lyricsEnabledRef.current = true;
		setDesktopLyricsEnabledState(true);
	}, []);

	const toggleDesktopLyrics = useCallback(async () => {
		await setDesktopLyricsEnabled(!lyricsEnabledRef.current);
	}, [setDesktopLyricsEnabled]);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		const currentDesktop = dependenciesRef.current.desktop;
		void currentDesktop.configureGlobalHotkeys(DEFAULT_DESKTOP_HOTKEYS);
		void currentDesktop.listenGlobalHotkey((payload) => {
			if (disposed || !payload?.action) return;
			if (payload.action === "toggleDesktopLyrics") {
				void toggleDesktopLyrics();
				return;
			}
			dependenciesRef.current.hotkeyActions[payload.action]?.();
		}).then((dispose) => {
			if (disposed) dispose();
			else unlisten = dispose;
		});
		return () => {
			disposed = true;
			unlisten?.();
			void currentDesktop.configureGlobalHotkeys([]);
		};
	}, [desktop, toggleDesktopLyrics]);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		const currentDesktop = dependenciesRef.current.desktop;
		void currentDesktop.getWindowState().then((state) => {
			if (!disposed) publishWindowState(state);
		});
		void currentDesktop.listenWindowState((state) => {
			if (!disposed) publishWindowState(state);
		}).then((dispose) => {
			if (disposed) dispose();
			else unlisten = dispose;
		});
		return () => {
			disposed = true;
			unlisten?.();
			dependenciesRef.current.onWindowCleanup?.();
		};
	}, [desktop, publishWindowState]);

	useEffect(() => {
		if (!desktopLyricsEnabled) return;
		const dependencies = dependenciesRef.current;
		const payload = dependencies.buildLyricsPayload(false);
		if (
			!shouldPushDesktopLyricsPayload(
				pushStateRef.current,
				payload,
				performance.now(),
				false,
			)
		) {
			return;
		}
		void dependencies.desktop.updateDesktopLyricsPayload(payload as DesktopJsonValue);
	}, [desktopLyricsEnabled, lyricsPayloadVersion]);

	return {
		desktopLyricsEnabled,
		desktopWindowState,
		toggleDesktopLyrics,
		setDesktopLyricsEnabled,
	};
}

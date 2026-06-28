import { DesktopLyricsPayloadSchema, type DesktopLyricsPayload } from "@mineradio/shared";
import { invokeTauriCommand, listenTauriEvent, type Unlisten } from "../tauri/runtime";

export interface DesktopLyricsBridge {
	listenPayload(onPayload: (payload: DesktopLyricsPayload) => void): Promise<Unlisten>;
	listenLockChanged(onLockChanged: (clickThrough: boolean) => void): Promise<Unlisten>;
	overlayReady(): Promise<void>;
	setClickThrough(clickThrough: boolean): Promise<void>;
	moveBy(dx: number, dy: number): Promise<void>;
}

export function normalizeDesktopLyricsEventPayload(payload: unknown): DesktopLyricsPayload {
	return DesktopLyricsPayloadSchema.parse(payload ?? {});
}

export function normalizeDesktopLyricsLockEvent(payload: unknown): boolean {
	return typeof payload === "boolean" ? payload : DesktopLyricsPayloadSchema.shape.clickThrough.parse(payload);
}

export const desktopLyricsBridge: DesktopLyricsBridge = {
	async listenPayload(onPayload) {
		return listenTauriEvent<unknown>("desktop-lyrics-payload", (payload) => {
			onPayload(normalizeDesktopLyricsEventPayload(payload));
		});
	},
	async listenLockChanged(onLockChanged) {
		return listenTauriEvent<unknown>("desktop-lyrics-lock-changed", (payload) => {
			onLockChanged(normalizeDesktopLyricsLockEvent(payload));
		});
	},
	async overlayReady() {
		await invokeTauriCommand("desktop_lyrics_overlay_ready");
	},
	async setClickThrough(clickThrough) {
		await invokeTauriCommand("desktop_lyrics_set_click_through", { clickThrough });
	},
	async moveBy(dx, dy) {
		await invokeTauriCommand("desktop_lyrics_move_by", { dx, dy });
	}
};

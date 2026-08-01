import type {
	ShelfOpenDetailContentPayload,
	ShelfPane,
	StageLyricsMotionSnapshot,
} from "@mineradio/visual-engine";
import type { ShelfDetailContentListController } from "../shelf-detail-data";
import type {
	ShelfDetailRowClickPayload,
	ShelfPlayPlaylistPayload,
} from "../shelf-pointer-interactions";

export interface LegacyVisualEventHandlers {
	readonly reportError?: (error: unknown) => void;
	readonly onShelfModeChange?: (mode: "side") => void;
	readonly onShelfPlayQueueIndex?: (index: number) => void;
	readonly onShelfPlayPlaylist?: (payload: ShelfPlayPlaylistPayload) => void;
	readonly onShelfDetailRowClick?: (payload: ShelfDetailRowClickPayload) => void;
	readonly onShelfOpenDetailContent?: (
		payload: ShelfOpenDetailContentPayload,
		writer: ShelfDetailContentListController,
	) => void;
	readonly onShelfOpenContentChange?: (open: boolean) => void;
	readonly onShelfPaneChange?: (pane: ShelfPane) => void;
	readonly onDesktopLyricsMotion?: (snapshot: StageLyricsMotionSnapshot) => void;
	readonly desktopLyricsMotionRef?: { current: StageLyricsMotionSnapshot | null };
}

export interface LegacyVisualEventSink {
	update(handlers?: LegacyVisualEventHandlers): void;
	onShelfModeChange(mode: "side"): void;
	onShelfPlayQueueIndex(index: number): void;
	onShelfPlayPlaylist(payload: ShelfPlayPlaylistPayload): void;
	onShelfDetailRowClick(payload: ShelfDetailRowClickPayload): void;
	onShelfOpenDetailContent(
		payload: ShelfOpenDetailContentPayload,
		writer: ShelfDetailContentListController,
	): void;
	onShelfOpenContentChange(open: boolean): void;
	onShelfPaneChange(pane: ShelfPane): void;
	onDesktopLyricsMotion(snapshot: StageLyricsMotionSnapshot): void;
}

export function createLegacyVisualEventBridge(
	initialHandlers: LegacyVisualEventHandlers = {},
): LegacyVisualEventSink {
	let handlers = initialHandlers;
	let reportingError = false;
	const reportHandlerError = (error: unknown) => {
		if (reportingError || !handlers.reportError) return;
		reportingError = true;
		try {
			handlers.reportError(error);
		} catch {
			// 事件桥不能让错误上浮到渲染循环。
		} finally {
			reportingError = false;
		}
	};
	const invoke = (callback: (() => void) | undefined) => {
		if (!callback) return;
		try {
			callback();
		} catch (error) {
			reportHandlerError(error);
		}
	};
	return {
		update(nextHandlers = {}) {
			handlers = nextHandlers;
		},
		onShelfModeChange(mode) {
			invoke(() => handlers.onShelfModeChange?.(mode));
		},
		onShelfPlayQueueIndex(index) {
			invoke(() => handlers.onShelfPlayQueueIndex?.(index));
		},
		onShelfPlayPlaylist(payload) {
			invoke(() => handlers.onShelfPlayPlaylist?.(payload));
		},
		onShelfDetailRowClick(payload) {
			invoke(() => handlers.onShelfDetailRowClick?.(payload));
		},
		onShelfOpenDetailContent(payload, writer) {
			invoke(() => handlers.onShelfOpenDetailContent?.(payload, writer));
		},
		onShelfOpenContentChange(open) {
			invoke(() => handlers.onShelfOpenContentChange?.(open));
		},
		onShelfPaneChange(pane) {
			invoke(() => handlers.onShelfPaneChange?.(pane));
		},
		onDesktopLyricsMotion(snapshot) {
			invoke(() => {
				if (handlers.desktopLyricsMotionRef) handlers.desktopLyricsMotionRef.current = snapshot;
			});
			invoke(() => handlers.onDesktopLyricsMotion?.(snapshot));
		},
	};
}

import type { CSSProperties, PointerEvent } from "react";
import React, { useRef } from "react";
import { DesktopLyricsPayloadSchema, type DesktopLyricsPayload } from "@mineradio/shared";

export type DesktopLyricsInput = Partial<DesktopLyricsPayload>;

export interface DesktopLyricsDragCallbacks {
	onToggleLock?: () => void;
	onMoveBy?: (dx: number, dy: number) => void;
}

export interface DesktopLyricsOverlayProps extends DesktopLyricsDragCallbacks {
	payload: DesktopLyricsInput | null | undefined;
}

export type DesktopLyricsStyle = CSSProperties & Record<`--desktop-lyrics-${string}`, string>;

export function normalizeDesktopLyricsPayload(payload: DesktopLyricsInput | null | undefined): DesktopLyricsPayload {
	return DesktopLyricsPayloadSchema.parse(payload ?? {});
}

export function shouldRenderDesktopLyrics(payload: DesktopLyricsInput | null | undefined): boolean {
	const normalized = normalizeDesktopLyricsPayload(payload);
	return normalized.enabled && normalized.text.trim().length > 0;
}

export function computeDesktopLyricsStyle(payload: DesktopLyricsPayload): DesktopLyricsStyle {
	return {
		left: `${payload.position.x}px`,
		top: `${payload.position.y}px`,
		"--desktop-lyrics-progress": `${Math.round(payload.progress * 100)}%`,
		"--desktop-lyrics-primary": payload.colors.primary,
		"--desktop-lyrics-secondary": payload.colors.secondary,
		"--desktop-lyrics-background": payload.colors.background,
		"--desktop-lyrics-glow": payload.colors.glow,
		"--desktop-lyrics-opacity": String(payload.opacity),
		"--desktop-lyrics-font-family": payload.font.family,
		"--desktop-lyrics-font-weight": String(payload.font.weight),
		"--desktop-lyrics-min-font": `${payload.font.fit.minPx}px`,
		"--desktop-lyrics-max-font": `${payload.font.fit.maxPx}px`,
		"--desktop-lyrics-lines": String(payload.font.fit.maxLines)
	};
}

export function createDesktopLyricsPointerHandlers(
	payload: DesktopLyricsPayload,
	callbacks: DesktopLyricsDragCallbacks,
	drag: { current: { x: number; y: number } | null }
) {
	return {
		onPointerDown(event: PointerEvent<HTMLDivElement>) {
			if (event.button === 1) {
				if (!payload.clickThrough) {
					callbacks.onToggleLock?.();
				}
				return;
			}
			if (event.button !== 0 || payload.clickThrough) {
				return;
			}
			drag.current = { x: event.clientX, y: event.clientY };
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		onPointerMove(event: PointerEvent<HTMLDivElement>) {
			if (!drag.current || payload.clickThrough) {
				return;
			}
			const dx = event.clientX - drag.current.x;
			const dy = event.clientY - drag.current.y;
			drag.current = { x: event.clientX, y: event.clientY };
			if (dx !== 0 || dy !== 0) {
				callbacks.onMoveBy?.(dx, dy);
			}
		},
		onPointerUp() {
			drag.current = null;
		}
	};
}

export function DesktopLyricsOverlay({ payload, onToggleLock, onMoveBy }: DesktopLyricsOverlayProps) {
	const normalized = normalizeDesktopLyricsPayload(payload);
	const drag = useRef<{ x: number; y: number } | null>(null);

	if (!shouldRenderDesktopLyrics(normalized)) {
		return null;
	}

	const handlers = createDesktopLyricsPointerHandlers(normalized, { onToggleLock, onMoveBy }, drag);

	return (
		<div
			className={[
				"desktop-lyrics-overlay",
				normalized.clickThrough ? "desktop-lyrics-locked" : "desktop-lyrics-unlocked"
			].join(" ")}
			data-click-through={normalized.clickThrough ? "true" : "false"}
			style={computeDesktopLyricsStyle(normalized)}
			onPointerDown={handlers.onPointerDown}
			onPointerMove={handlers.onPointerMove}
			onPointerUp={handlers.onPointerUp}
			onPointerCancel={handlers.onPointerUp}
		>
			<span className="desktop-lyrics-text">{normalized.text}</span>
		</div>
	);
}

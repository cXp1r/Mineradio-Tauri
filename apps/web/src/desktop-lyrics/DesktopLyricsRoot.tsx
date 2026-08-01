import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopLyricsHotBounds, DesktopLyricsPayload } from "@mineradio/shared";
import { DesktopLyricsOverlay } from "./DesktopLyricsOverlay";
import { desktopLyricsBridge, type DesktopLyricsBridge } from "./desktop-lyrics-bridge";
import "./DesktopLyricsOverlay.css";

const DEFAULT_PAYLOAD: Partial<DesktopLyricsPayload> = {
	enabled: true,
	text: "MineRadio-Tauri",
	progress: 0,
	clickThrough: true
};

export function isDesktopLyricsRoute(location: Pick<Location, "pathname" | "search">): boolean {
	return location.pathname.includes("desktop-lyrics") || location.search.includes("view=desktop-lyrics");
}

export interface DesktopLyricsRootProps {
	bridge?: DesktopLyricsBridge;
}

export type DesktopLyricsPayloadSetter = (
	updater: Partial<DesktopLyricsPayload> | ((current: Partial<DesktopLyricsPayload>) => Partial<DesktopLyricsPayload>)
) => void;

export function mergeDesktopLyricsPayload(
	current: Partial<DesktopLyricsPayload>,
	next: Partial<DesktopLyricsPayload>
): Partial<DesktopLyricsPayload> {
	if (
		next.beatMap === undefined
		&& current.beatMap !== undefined
		&& next.beatMapKey === current.beatMapKey
	) {
		return { ...next, beatMap: current.beatMap };
	}
	return next;
}

export function subscribeDesktopLyricsBridge(
	bridge: DesktopLyricsBridge,
	setPayload: DesktopLyricsPayloadSetter
): () => void {
	let active = true;
	const unlisten: Array<() => void> = [];

	const payloadListener = bridge.listenPayload((nextPayload) => {
		if (active) {
			setPayload((current) => mergeDesktopLyricsPayload(current, nextPayload));
		}
	}).then((dispose) => {
		if (active) {
			unlisten.push(dispose);
		} else {
			dispose();
		}
		return true;
	}).catch(() => false);

	const lockListener = bridge.listenLockChanged((clickThrough) => {
		if (active) {
			setPayload((current) => ({ ...current, clickThrough }));
		}
	}).then((dispose) => {
		if (active) {
			unlisten.push(dispose);
		} else {
			dispose();
		}
		return true;
	}).catch(() => false);

	void Promise.all([payloadListener, lockListener]).then(([payloadAttached, lockAttached]) => {
		if (active && payloadAttached && lockAttached) {
			return bridge.overlayReady();
		}
		return undefined;
	}).catch(() => {});

	return () => {
		active = false;
		for (const dispose of unlisten) dispose();
	};
}

export function createDesktopLyricsOverlayActions(
	bridge: DesktopLyricsBridge,
	getPayload: () => Partial<DesktopLyricsPayload>,
	setPayload: DesktopLyricsPayloadSetter
) {
	return {
		onToggleLock() {
			const clickThrough = !(getPayload().clickThrough ?? true);
			setPayload((current) => ({ ...current, clickThrough }));
			void bridge.setClickThrough(clickThrough).catch(() => {
				setPayload((current) => ({ ...current, clickThrough: !clickThrough }));
			});
		},
		onMoveBy(dx: number, dy: number) {
			setPayload((current) => ({
				...current,
				position: {
					x: (current.position?.x ?? 80) + dx,
					y: (current.position?.y ?? 80) + dy
				}
			}));
			void bridge.moveBy(dx, dy);
		},
		onHotBoundsChange(bounds: DesktopLyricsHotBounds) {
			void bridge.setHotBounds(bounds);
		}
	};
}

export function DesktopLyricsRoot({ bridge = desktopLyricsBridge }: DesktopLyricsRootProps) {
	const initial = useMemo(() => DEFAULT_PAYLOAD, []);
	const [payload, setPayload] = useState<Partial<DesktopLyricsPayload>>(initial);
	const payloadRef = useRef<Partial<DesktopLyricsPayload>>(initial);

	useEffect(() => {
		payloadRef.current = payload;
	}, [payload]);

	useEffect(() => {
		return subscribeDesktopLyricsBridge(bridge, setPayload);
	}, [bridge]);

	const actions = useMemo(
		() => createDesktopLyricsOverlayActions(bridge, () => payloadRef.current, setPayload),
		[bridge]
	);
	const handleToggleLock = useCallback(() => actions.onToggleLock(), [actions]);
	const handleMoveBy = useCallback((dx: number, dy: number) => actions.onMoveBy(dx, dy), [actions]);
	const handleHotBoundsChange = useCallback(
		(bounds: DesktopLyricsHotBounds) => actions.onHotBoundsChange(bounds),
		[actions]
	);

	return (
		<DesktopLyricsOverlay
			payload={payload}
			onToggleLock={handleToggleLock}
			onMoveBy={handleMoveBy}
			onHotBoundsChange={handleHotBoundsChange}
		/>
	);
}

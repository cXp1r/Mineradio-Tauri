import { useEffect, useMemo, useRef, type ReactElement, type RefObject } from "react";
import type { LyricPayload, LyricLine as SharedLyricLine, Track } from "@mineradio/shared";
import {
	type FxState,
	type LyricLine as VisualLyricLine,
	type ShelfItem,
	type StageLyricsLifecycle,
} from "@mineradio/visual-engine";
import { useVisualEngine } from "./useVisualEngine";
import { PlayerController } from "../audio/player-controller";
import { mapQueueToShelfItems } from "./shelf-items";
import { isWallpaperSafeShelfPreset } from "./shelf-focus-zone";

export interface VisualEngineHostProps {
	audioElementRef: RefObject<HTMLAudioElement | null>;
	controllerRef: RefObject<PlayerController | null>;
	lyricsPayload: LyricPayload | null;
	positionMs: number;
	isPlaying: boolean;
	queue?: Track[];
	currentTrack?: Track | null;
	coverResolution?: number;
	fxDefaults?: Partial<FxState>;
	splashActive?: boolean;
	onShelfPlayQueueIndex?: (index: number) => void;
}

function mapLyricPayload(payload: LyricPayload | null): VisualLyricLine[] {
	if (!payload || !Array.isArray(payload.lines)) return [];
	return payload.lines.map((line: SharedLyricLine): VisualLyricLine => ({
		t: Math.max(0, line.timeMs) / 1000,
		text: line.text ?? "",
	}));
}

export function VisualEngineHost(props: VisualEngineHostProps): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const positionRef = useRef<number>(props.positionMs);
	const isPlayingRef = useRef<boolean>(props.isPlaying);
	const lyricLinesRef = useRef<VisualLyricLine[]>(mapLyricPayload(props.lyricsPayload));
	const shelfItemsRef = useRef<ShelfItem[]>([]);
	const shelfItemsVersionRef = useRef<number>(0);
	const splashActiveRef = useRef<boolean>(props.splashActive ?? false);
	const shelfCameraModeRef = useRef<string>(props.fxDefaults?.shelfCameraMode ?? "static");
	const shelfPresenceRef = useRef<string>(props.fxDefaults?.shelfPresence ?? "always");
	const wallpaperSafeRef = useRef<boolean>(isWallpaperSafeShelfPreset(props.fxDefaults?.preset));
	const onShelfPlayQueueIndexRef = useRef<((index: number) => void) | undefined>(props.onShelfPlayQueueIndex);
	const lifecycleRef = useRef<StageLyricsLifecycle | null>(null);

	positionRef.current = props.positionMs;
	isPlayingRef.current = props.isPlaying;
	splashActiveRef.current = props.splashActive ?? false;
	shelfCameraModeRef.current = props.fxDefaults?.shelfCameraMode ?? "static";
	shelfPresenceRef.current = props.fxDefaults?.shelfPresence ?? "always";
	wallpaperSafeRef.current = isWallpaperSafeShelfPreset(props.fxDefaults?.preset);
	onShelfPlayQueueIndexRef.current = props.onShelfPlayQueueIndex;

	const nextShelfItems = useMemo(
		() => mapQueueToShelfItems(props.queue ?? [], props.currentTrack ?? null),
		[props.queue, props.currentTrack],
	);

	useEffect(() => {
		shelfItemsRef.current = nextShelfItems;
		shelfItemsVersionRef.current += 1;
	}, [nextShelfItems]);

	useEffect(() => {
		lyricLinesRef.current = mapLyricPayload(props.lyricsPayload);
		const lifecycle = lifecycleRef.current;
		if (lifecycle) {
			try {
				lifecycle.setLyricLines(lyricLinesRef.current);
			} catch {
			}
		}
	}, [props.lyricsPayload]);

	useVisualEngine({
		hostRef,
		audioElementRef: props.audioElementRef,
		positionRef,
		isPlayingRef,
		lyricLinesRef,
		shelfItemsRef,
		shelfItemsVersionRef,
		splashActiveRef,
		shelfCameraModeRef,
		shelfPresenceRef,
		wallpaperSafeRef,
		onShelfPlayQueueIndexRef,
		lifecycleRef,
		coverResolution: props.coverResolution ?? 1.55,
		fxDefaults: props.fxDefaults,
	});

	return <div id="visual-host" className="visual-host" ref={hostRef} />;
}

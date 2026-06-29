import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import type { LyricPayload, LyricLine as SharedLyricLine, PlaylistSummary, PodcastCollection, Track } from "@mineradio/shared";
import {
	type FxState,
	type LyricLine as VisualLyricLine,
	type ShelfItem,
	type ShelfOpenDetailContentPayload,
	type ShelfPane,
	type StageLyricsLifecycle,
	type StageLyricsMotionSnapshot,
} from "@mineradio/visual-engine";
import { resolveRuntimeWallpaperSafe, useVisualEngine } from "./useVisualEngine";
import type { ShelfDetailRowClickPayload, ShelfPlayPlaylistPayload } from "./shelf-pointer-interactions";
import type { ShelfDetailContentListController } from "./shelf-detail-data";
import { PlayerController } from "../audio/player-controller";
import { resolveShelfItems } from "./shelf-items";
import type { ShelfCameraMode, ShelfMode, ShelfPresence, ShelfSettings } from "../stores/shelf-store";

export interface VisualEngineHostProps {
	audioElementRef: RefObject<HTMLAudioElement | null>;
	controllerRef: RefObject<PlayerController | null>;
	lyricsPayload: LyricPayload | null;
	positionMs: number;
	durationMs?: number | null;
	isPlaying: boolean;
	queue?: Track[];
	playlists?: PlaylistSummary[];
	podcastCollections?: PodcastCollection[];
	currentTrack?: Track | null;
	currentCoverUrl?: string | null;
	beatMapKey?: string | null;
	beatMap?: unknown;
	sidecarBaseUrl?: string | null;
	coverResolution?: number;
	fxDefaults?: Partial<FxState>;
	fxState?: Partial<FxState>;
	shelfSettings?: Pick<ShelfSettings, "mode" | "cameraMode" | "presence" | "showPodcasts" | "mergeCollections"> | null;
	splashActive?: boolean;
	homeActive?: boolean;
	secondaryLeftDisplaySeamGuardActive?: boolean;
	onShelfModeChange?: (mode: ShelfMode) => void;
	onShelfPlayQueueIndex?: (index: number) => void;
	onShelfPlayPlaylist?: (payload: ShelfPlayPlaylistPayload) => void;
	onShelfDetailRowClick?: (payload: ShelfDetailRowClickPayload) => void;
	onShelfOpenDetailContent?: (payload: ShelfOpenDetailContentPayload, writer: ShelfDetailContentListController) => void;
	onShelfOpenContentChange?: (open: boolean) => void;
	desktopLyricsMotionRef?: RefObject<DesktopLyricsMotionSnapshot>;
}

export type DesktopLyricsMotionSnapshot = StageLyricsMotionSnapshot;

export { createStageLyricsHostSuppliers } from "./useVisualEngine";

export function resolveVisualShelfSettings(
	fxDefaults: Partial<FxState> | undefined,
	settings: Pick<ShelfSettings, "mode" | "cameraMode" | "presence" | "showPodcasts" | "mergeCollections"> | null | undefined,
): { mode: ShelfMode; cameraMode: ShelfCameraMode; presence: ShelfPresence; showPodcasts: boolean; mergeCollections: boolean } {
	return {
		mode: settings?.mode ?? (fxDefaults?.shelf as ShelfMode | undefined) ?? "side",
		cameraMode: settings?.cameraMode ?? (fxDefaults?.shelfCameraMode as ShelfCameraMode | undefined) ?? "static",
		presence: settings?.presence ?? (fxDefaults?.shelfPresence as ShelfPresence | undefined) ?? "always",
		showPodcasts: settings?.showPodcasts ?? (fxDefaults?.shelfShowPodcasts !== false),
		mergeCollections: settings?.mergeCollections ?? (fxDefaults?.shelfMergeCollections === true),
	};
}

export function resolveVisualWallpaperSafe(
	fxDefaults: Partial<FxState> | undefined,
	fxState: Partial<FxState> | undefined,
): boolean {
	return resolveRuntimeWallpaperSafe({
		fxDefaults,
		fxRef: { current: fxState },
	});
}

export function mapLyricPayload(payload: LyricPayload | null): VisualLyricLine[] {
	if (!payload || !Array.isArray(payload.lines)) return [];
	return payload.lines.map((line: SharedLyricLine): VisualLyricLine => ({
		t: Math.max(0, line.timeMs) / 1000,
		text: line.text ?? "",
		duration: typeof line.durationMs === "number" ? Math.max(0, line.durationMs) / 1000 : undefined,
		charCount: line.charCount,
		words: Array.isArray(line.words)
			? line.words.map((word) => ({
					text: word.text,
					t: Math.max(0, word.timeMs) / 1000,
					d: typeof word.durationMs === "number" ? Math.max(0, word.durationMs) / 1000 : undefined,
					c0: word.c0,
					c1: word.c1,
				}))
			: undefined,
	}));
}

export function resolveRuntimeShelfMode(
	defaultMode: string | null | undefined,
	runtimeOverride: string | null | undefined,
): string {
	if (runtimeOverride && (!defaultMode || defaultMode === "off")) return runtimeOverride;
	return defaultMode ?? "side";
}

export function syncRuntimeShelfModeOverride(
	previousDefaultRef: { current: string | undefined },
	runtimeOverrideRef: { current: string | null },
	defaultMode: string | undefined,
): void {
	if (previousDefaultRef.current !== defaultMode) {
		runtimeOverrideRef.current = null;
		previousDefaultRef.current = defaultMode;
	}
}

export function resolveVisualCoverUrl(currentCoverUrl: string | null | undefined, currentTrack: Track | null | undefined): string {
	return currentCoverUrl ?? currentTrack?.coverUrl ?? "";
}

export function resolveVisualCoverUrlForSidecar(coverUrl: string, sidecarBaseUrl: string | null | undefined): string {
	if (!coverUrl) return "";
	if (/^data:image\//i.test(coverUrl) || /^blob:/i.test(coverUrl)) return coverUrl;
	if (!/^https?:\/\//i.test(coverUrl)) return "";
	const base = String(sidecarBaseUrl ?? "").replace(/\/$/, "");
	if (!base) return coverUrl;
	const params = new URLSearchParams({ url: coverUrl });
	return `${base}/image-proxy?${params.toString()}`;
}

export function countShelfPanePlaylists(playlists: PlaylistSummary[]): { mineCount: number; favCount: number } {
	let mineCount = 0;
	let favCount = 0;
	for (const playlist of playlists) {
		if (playlist.subscribed === true) favCount += 1;
		else mineCount += 1;
	}
	return { mineCount, favCount };
}

export function syncDesktopLyricsMotionRef(
	target: RefObject<DesktopLyricsMotionSnapshot> | undefined,
	lifecycle: Pick<StageLyricsLifecycle, "getMotionSnapshot"> | null,
): void {
	if (!target || !lifecycle) return;
	target.current = lifecycle.getMotionSnapshot();
}

function trackFallbackText(track: Track | null | undefined): string {
	if (!track) return "";
	const title = String(track.title || "").trim();
	const artist = (track.artists ?? []).map((name) => String(name || "").trim()).filter(Boolean).join(" / ");
	if (title && artist) return `${title} - ${artist}`;
	return title || artist;
}

export function VisualEngineHost(props: VisualEngineHostProps): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const [shelfPane, setShelfPane] = useState<ShelfPane>("mine");
	const positionRef = useRef<number>(props.positionMs);
	const durationMsRef = useRef<number | null | undefined>(props.durationMs ?? props.currentTrack?.durationMs ?? null);
	const isPlayingRef = useRef<boolean>(props.isPlaying);
	const lyricLinesRef = useRef<VisualLyricLine[]>(mapLyricPayload(props.lyricsPayload));
	const fallbackTextRef = useRef<string>(trackFallbackText(props.currentTrack));
	const lyricsHasNativeKaraokeRef = useRef<boolean>(props.lyricsPayload?.isWordByWord === true);
	const shelfItemsRef = useRef<ShelfItem[]>([]);
	const shelfItemsVersionRef = useRef<number>(0);
	const coverUrlRef = useRef<string>(resolveVisualCoverUrlForSidecar(resolveVisualCoverUrl(props.currentCoverUrl, props.currentTrack), props.sidecarBaseUrl));
	const coverUrlVersionRef = useRef<number>(0);
	const beatMapKeyRef = useRef<string>(props.beatMapKey ?? "");
	const beatMapRef = useRef<unknown>(props.beatMap ?? null);
	const beatMapVersionRef = useRef<number>(0);
	const splashActiveRef = useRef<boolean>(props.splashActive ?? false);
	const homeActiveRef = useRef<boolean>(props.homeActive ?? false);
	const secondaryLeftDisplaySeamGuardRef = useRef<boolean>(props.secondaryLeftDisplaySeamGuardActive ?? false);
	const initialShelfSettings = resolveVisualShelfSettings(props.fxDefaults, props.shelfSettings);
	const shelfModeRef = useRef<string>(initialShelfSettings.mode);
	const runtimeShelfModeOverrideRef = useRef<string | null>(null);
	const previousDefaultShelfModeRef = useRef<string | undefined>(initialShelfSettings.mode);
	const shelfCameraModeRef = useRef<string>(initialShelfSettings.cameraMode);
	const shelfPresenceRef = useRef<string>(initialShelfSettings.presence);
	const shelfMergeCollectionsRef = useRef<boolean>(initialShelfSettings.mergeCollections);
	const shelfMineCountRef = useRef<number>(0);
	const shelfFavCountRef = useRef<number>(0);
	const wallpaperSafeRef = useRef<boolean>(resolveVisualWallpaperSafe(props.fxDefaults, props.fxState));
	const onShelfPlayQueueIndexRef = useRef<((index: number) => void) | undefined>(props.onShelfPlayQueueIndex);
	const onShelfPlayPlaylistRef = useRef<((payload: ShelfPlayPlaylistPayload) => void) | undefined>(props.onShelfPlayPlaylist);
	const onShelfDetailRowClickRef = useRef<((payload: ShelfDetailRowClickPayload) => void) | undefined>(props.onShelfDetailRowClick);
	const onShelfOpenDetailContentRef = useRef<((payload: ShelfOpenDetailContentPayload, writer: ShelfDetailContentListController) => void) | undefined>(props.onShelfOpenDetailContent);
	const onShelfOpenContentChangeRef = useRef<((open: boolean) => void) | undefined>(props.onShelfOpenContentChange);
	const onShelfPaneChangeRef = useRef<((pane: ShelfPane) => void) | undefined>(undefined);
	const lifecycleRef = useRef<StageLyricsLifecycle | null>(null);
	const fxStateRef = useRef<Partial<FxState> | undefined>(props.fxState);

	positionRef.current = props.positionMs;
	durationMsRef.current = props.durationMs ?? props.currentTrack?.durationMs ?? null;
	isPlayingRef.current = props.isPlaying;
	fallbackTextRef.current = trackFallbackText(props.currentTrack);
	lyricsHasNativeKaraokeRef.current = props.lyricsPayload?.isWordByWord === true;
	splashActiveRef.current = props.splashActive ?? false;
	homeActiveRef.current = props.homeActive ?? false;
	secondaryLeftDisplaySeamGuardRef.current = props.secondaryLeftDisplaySeamGuardActive ?? false;
	fxStateRef.current = props.fxState;
	const visualShelfSettings = resolveVisualShelfSettings(props.fxDefaults, props.shelfSettings);
	syncRuntimeShelfModeOverride(
		previousDefaultShelfModeRef,
		runtimeShelfModeOverrideRef,
		visualShelfSettings.mode,
	);
	shelfModeRef.current = resolveRuntimeShelfMode(visualShelfSettings.mode, runtimeShelfModeOverrideRef.current);
	shelfCameraModeRef.current = visualShelfSettings.cameraMode;
	shelfPresenceRef.current = visualShelfSettings.presence;
	shelfMergeCollectionsRef.current = visualShelfSettings.mergeCollections;
	wallpaperSafeRef.current = resolveVisualWallpaperSafe(props.fxDefaults, props.fxState);
	onShelfPlayQueueIndexRef.current = props.onShelfPlayQueueIndex;
	onShelfPlayPlaylistRef.current = props.onShelfPlayPlaylist;
	onShelfDetailRowClickRef.current = props.onShelfDetailRowClick;
	onShelfOpenDetailContentRef.current = props.onShelfOpenDetailContent;
	onShelfOpenContentChangeRef.current = props.onShelfOpenContentChange;
	onShelfPaneChangeRef.current = setShelfPane;

	useEffect(() => {
		if (visualShelfSettings.mergeCollections) setShelfPane("mine");
	}, [visualShelfSettings.mergeCollections]);
	const nextCoverUrl = resolveVisualCoverUrlForSidecar(
		resolveVisualCoverUrl(props.currentCoverUrl, props.currentTrack),
		props.sidecarBaseUrl,
	);
	if (coverUrlRef.current !== nextCoverUrl) {
		coverUrlRef.current = nextCoverUrl;
		coverUrlVersionRef.current += 1;
	}
	const nextBeatMapKey = props.beatMapKey ?? "";
	if (beatMapKeyRef.current !== nextBeatMapKey || beatMapRef.current !== props.beatMap) {
		beatMapKeyRef.current = nextBeatMapKey;
		beatMapRef.current = props.beatMap ?? null;
		beatMapVersionRef.current += 1;
	}

	const handleShelfModeChange = useCallback((mode: "side") => {
		runtimeShelfModeOverrideRef.current = mode;
		shelfModeRef.current = mode;
		props.onShelfModeChange?.(mode);
	}, [props.onShelfModeChange]);

	const shelfPaneCounts = useMemo(
		() => countShelfPanePlaylists(props.playlists ?? []),
		[props.playlists],
	);
	shelfMineCountRef.current = shelfPaneCounts.mineCount;
	shelfFavCountRef.current = shelfPaneCounts.favCount;

	const nextShelfItems = useMemo(
		() => resolveShelfItems({
			playlists: props.playlists ?? [],
			podcastCollections: props.podcastCollections ?? [],
			queue: props.queue ?? [],
			currentTrack: props.currentTrack ?? null,
			settings: {
				showPodcasts: visualShelfSettings.showPodcasts,
				mergeCollections: visualShelfSettings.mergeCollections,
				pane: shelfPane,
			},
		}),
		[props.playlists, props.podcastCollections, props.queue, props.currentTrack, visualShelfSettings.showPodcasts, visualShelfSettings.mergeCollections, shelfPane],
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
		durationMsRef,
		isPlayingRef,
		lyricLinesRef,
		fallbackTextRef,
		lyricsHasNativeKaraokeRef,
		shelfItemsRef,
		shelfItemsVersionRef,
		coverUrlRef,
		coverUrlVersionRef,
		beatMapKeyRef,
		beatMapRef,
		beatMapVersionRef,
		splashActiveRef,
		homeActiveRef,
		secondaryLeftDisplaySeamGuardRef,
		shelfModeRef,
		shelfCameraModeRef,
		shelfPresenceRef,
		shelfMergeCollectionsRef,
		shelfMineCountRef,
		shelfFavCountRef,
		wallpaperSafeRef,
		onShelfPlayQueueIndexRef,
		onShelfPlayPlaylistRef,
		onShelfDetailRowClickRef,
		onShelfOpenDetailContentRef,
		onShelfOpenContentChangeRef,
		onShelfPaneChangeRef,
		lifecycleRef,
		desktopLyricsMotionRef: props.desktopLyricsMotionRef,
		coverResolution: props.coverResolution ?? 1.55,
		fxDefaults: props.fxDefaults,
		fxRef: fxStateRef,
		onShelfModeChange: handleShelfModeChange,
	});

	return <div id="visual-host" className="visual-host" ref={hostRef} />;
}

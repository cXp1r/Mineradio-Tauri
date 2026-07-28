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
import { createLegacyVisualEventBridge } from "./runtime/legacy-visual-events";
import {
	buildLyricsVisualSnapshot,
	buildPlaybackVisualSnapshot,
	buildShelfVisualSnapshot,
	buildVisualSettingsSnapshot,
} from "./runtime/visual-snapshot-builders";

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
	return payload.lines
		.map((line: SharedLyricLine, originalIndex): VisualLyricLine & { originalIndex: number } => ({
			t: Math.max(0, line.timeMs) / 1000,
			text: line.text ?? "",
			duration: typeof line.durationMs === "number" ? Math.max(0, line.durationMs) / 1000 : undefined,
			charCount: line.charCount,
			words: Array.isArray(line.words)
				? line.words
						.map((word, wordIndex) => ({
							text: word.text,
							t: Math.max(0, word.timeMs) / 1000,
							d: typeof word.durationMs === "number" ? Math.max(0, word.durationMs) / 1000 : undefined,
							c0: word.c0,
							c1: word.c1,
							wordIndex,
						}))
						.sort((a, b) => a.t - b.t || a.wordIndex - b.wordIndex)
						.map((word) => ({
							text: word.text,
							t: word.t,
							d: word.d,
							c0: word.c0,
							c1: word.c1,
						}))
				: undefined,
			originalIndex,
		}))
		.sort((a, b) => a.t - b.t || a.originalIndex - b.originalIndex)
		.map((line) => ({
			t: line.t,
			text: line.text,
			duration: line.duration,
			charCount: line.charCount,
			words: line.words,
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

export function resolveVisualTrackKey(currentTrack: Track | null | undefined): string {
	return currentTrack ? `${currentTrack.provider}:${currentTrack.id}` : "";
}

export function normalizeVisualCoverUrl(coverUrl: string): string {
	const url = String(coverUrl || "").trim();
	if (!url) return "";
	if (/^\/\//.test(url)) return `https:${url}`;
	return url;
}

export function resolveVisualCoverUrlForSidecar(coverUrl: string, sidecarBaseUrl: string | null | undefined): string {
	const normalizedCoverUrl = normalizeVisualCoverUrl(coverUrl);
	if (!normalizedCoverUrl) return "";
	if (/^data:image\//i.test(normalizedCoverUrl) || /^blob:/i.test(normalizedCoverUrl)) return normalizedCoverUrl;
	if (!/^https?:\/\//i.test(normalizedCoverUrl)) return "";
	const base = String(sidecarBaseUrl ?? "").replace(/\/$/, "");
	if (!base) return normalizedCoverUrl;
	const params = new URLSearchParams({ url: normalizedCoverUrl });
	return `${base}/image-proxy?${params.toString()}`;
}

export function coverUrlToCssBackgroundImage(coverUrl: string): string | undefined {
	const url = String(coverUrl || "").trim();
	if (!url) return undefined;
	return `url("${url.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}")`;
}

export function mapShelfItemCoversForSidecar(items: ShelfItem[], sidecarBaseUrl: string | null | undefined): ShelfItem[] {
	return items.map((item) => {
		if (!item.cover) return item;
		const cover = resolveVisualCoverUrlForSidecar(item.cover, sidecarBaseUrl);
		return cover === item.cover ? item : { ...item, cover };
	});
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

function readInitialPrefersReducedMotion(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
	} catch {
		return false;
	}
}

export function VisualEngineHost(props: VisualEngineHostProps): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const [shelfPane, setShelfPane] = useState<ShelfPane>("mine");
	const visualShelfSettings = useMemo(
		() => resolveVisualShelfSettings(props.fxDefaults, props.shelfSettings),
		[props.fxDefaults, props.shelfSettings],
	);
	const runtimeShelfModeOverrideRef = useRef<string | null>(null);
	const previousDefaultShelfModeRef = useRef<string | undefined>(visualShelfSettings.mode);
	const [, bumpRuntimeShelfModeRevision] = useState(0);
	syncRuntimeShelfModeOverride(
		previousDefaultShelfModeRef,
		runtimeShelfModeOverrideRef,
		visualShelfSettings.mode,
	);
	const runtimeShelfMode = resolveRuntimeShelfMode(
		visualShelfSettings.mode,
		runtimeShelfModeOverrideRef.current,
	);

	useEffect(() => {
		if (visualShelfSettings.mergeCollections) setShelfPane("mine");
	}, [visualShelfSettings.mergeCollections]);
	// Baseline `#album-bg` uses the direct cover URL for the CSS background
	// (CSS images do not need CORS), while the WebGL cover texture goes through
	// the sidecar image proxy for crossOrigin compatibility. Using the proxy
	// URL here would make the album background depend on sidecar availability
	// even for a pure CSS property.
	const directCoverUrl = useMemo(
		() => normalizeVisualCoverUrl(resolveVisualCoverUrl(props.currentCoverUrl, props.currentTrack)),
		[props.currentCoverUrl, props.currentTrack],
	);
	const albumBgStyle = directCoverUrl ? { backgroundImage: coverUrlToCssBackgroundImage(directCoverUrl) } : undefined;
	const webglCoverUrl = useMemo(
		() => resolveVisualCoverUrlForSidecar(directCoverUrl, props.sidecarBaseUrl),
		[directCoverUrl, props.sidecarBaseUrl],
	);

	const handleShelfModeChange = useCallback((mode: "side") => {
		runtimeShelfModeOverrideRef.current = mode;
		bumpRuntimeShelfModeRevision((revision) => revision + 1);
		props.onShelfModeChange?.(mode);
	}, [props.onShelfModeChange]);

	const shelfPaneCounts = useMemo(
		() => countShelfPanePlaylists(props.playlists ?? []),
		[props.playlists],
	);
	const shelfItems = useMemo(
		() => mapShelfItemCoversForSidecar(
			resolveShelfItems({
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
			props.sidecarBaseUrl,
		),
		[props.playlists, props.podcastCollections, props.queue, props.currentTrack, props.sidecarBaseUrl, visualShelfSettings.showPodcasts, visualShelfSettings.mergeCollections, shelfPane],
	);
	const lyricLines = useMemo(() => mapLyricPayload(props.lyricsPayload), [props.lyricsPayload]);
	const fallbackText = useMemo(() => trackFallbackText(props.currentTrack), [props.currentTrack]);
	const durationMs = props.durationMs ?? props.currentTrack?.durationMs ?? null;
	const trackKey = resolveVisualTrackKey(props.currentTrack);
	const wallpaperSafe = useMemo(
		() => resolveVisualWallpaperSafe(props.fxDefaults, props.fxState),
		[props.fxDefaults, props.fxState],
	);
	const initialReducedMotionRef = useRef<boolean | null>(null);
	if (initialReducedMotionRef.current === null) {
		initialReducedMotionRef.current = readInitialPrefersReducedMotion();
	}

	const playbackSnapshot = useMemo(() => buildPlaybackVisualSnapshot({
		trackKey,
		playing: props.isPlaying,
		durationMs,
		coverUrl: webglCoverUrl,
		beatMapKey: props.beatMapKey ?? "",
		beatMap: props.beatMap ?? null,
		splashActive: props.splashActive ?? false,
		homeActive: props.homeActive ?? false,
	}), [trackKey, props.isPlaying, durationMs, webglCoverUrl, props.beatMapKey, props.beatMap, props.splashActive, props.homeActive]);
	const lyricsSnapshot = useMemo(() => buildLyricsVisualSnapshot({
		lines: lyricLines,
		fallbackText,
		hasNativeKaraoke: props.lyricsPayload?.isWordByWord === true,
	}), [lyricLines, fallbackText, props.lyricsPayload?.isWordByWord]);
	const shelfSnapshot = useMemo(() => buildShelfVisualSnapshot({
		items: shelfItems,
		pane: shelfPane,
		mode: runtimeShelfMode,
		cameraMode: visualShelfSettings.cameraMode,
		presence: visualShelfSettings.presence,
		mergeCollections: visualShelfSettings.mergeCollections,
		mineCount: shelfPaneCounts.mineCount,
		favCount: shelfPaneCounts.favCount,
		secondaryLeftDisplaySeamGuard: props.secondaryLeftDisplaySeamGuardActive ?? false,
	}), [shelfItems, shelfPane, runtimeShelfMode, visualShelfSettings.cameraMode, visualShelfSettings.presence, visualShelfSettings.mergeCollections, shelfPaneCounts.mineCount, shelfPaneCounts.favCount, props.secondaryLeftDisplaySeamGuardActive]);
	const settingsSnapshot = useMemo(() => buildVisualSettingsSnapshot({
		fxDefaults: props.fxDefaults,
		fxState: props.fxState,
		coverResolution: props.coverResolution ?? 1.55,
		wallpaperSafe,
		prefersReducedMotion: initialReducedMotionRef.current ?? false,
	}), [props.fxDefaults, props.fxState, props.coverResolution, wallpaperSafe]);

	const eventsRef = useRef<ReturnType<typeof createLegacyVisualEventBridge> | null>(null);
	if (!eventsRef.current) eventsRef.current = createLegacyVisualEventBridge();
	useEffect(() => {
		eventsRef.current?.update({
			onShelfModeChange: handleShelfModeChange,
			onShelfPlayQueueIndex: props.onShelfPlayQueueIndex,
			onShelfPlayPlaylist: props.onShelfPlayPlaylist,
			onShelfDetailRowClick: props.onShelfDetailRowClick,
			onShelfOpenDetailContent: props.onShelfOpenDetailContent,
			onShelfOpenContentChange: props.onShelfOpenContentChange,
			onShelfPaneChange: setShelfPane,
			desktopLyricsMotionRef: props.desktopLyricsMotionRef,
		});
	}, [
		handleShelfModeChange,
		props.onShelfPlayQueueIndex,
		props.onShelfPlayPlaylist,
		props.onShelfDetailRowClick,
		props.onShelfOpenDetailContent,
		props.onShelfOpenContentChange,
		props.desktopLyricsMotionRef,
	]);

	useVisualEngine({
		hostRef,
		audioElementRef: props.audioElementRef,
		positionMs: props.positionMs,
		playbackSnapshot,
		lyricsSnapshot,
		shelfSnapshot,
		settingsSnapshot,
		events: eventsRef.current,
	});

	return (
		<>
			<div id="custom-bg" aria-hidden="true">
				<video id="custom-bg-video" muted loop playsInline preload="metadata" />
			</div>
			<div id="album-bg" className={directCoverUrl ? "visible" : undefined} style={albumBgStyle} aria-hidden="true" />
			<div id="visual-host" className="visual-host" ref={hostRef} />
		</>
	);
}

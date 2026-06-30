import { useEffect, useRef, type RefObject } from "react";
import {
	createAudioReactivity,
	createBeatMapScheduler,
	createCinemaCamera,
	createConnectorParticles,
	createHomeVisual,
	createDefaultFreeCameraState,
	cloneFxState,
	createRenderLoop,
	createRenderer,
	attachRendererResizeSync,
	createShelfManagerWithThree,
	createShelfPointerContentRowRaycastHitGetter,
	createShelfPointerRaycastFocus,
	createShelfPointerRaycastHitGetter,
	createShelfPointerStrictRaycastHitGetter,
	createShelfSelectSoundPlayer,
	createShelfStep,
	createStageLyricsLifecycle,
	RenderStepSlot,
	type AudioFrameBytes,
	type AudioFrameSource,
	type AudioReactivityEngine,
	type CinemaCamera,
	type FxState,
	type HomeVisual,
	type LyricLine as VisualLyricLine,
	type LyricPalette,
	type RendererHandle,
	type RenderLoop,
	type ConnectorParticles,
	type ShelfManager,
	type ShelfItem,
	type ShelfOpenDetailContentPayload,
	type ShelfPane,
	type ShelfSelectSoundPlayer,
	type StageLyricsLifecycle,
	type StageLyricsLifecycleOpts,
	type StageLyricsMotionSnapshot,
	DEFAULT_LYRIC_PALETTE,
} from "@mineradio/visual-engine";
import {
	attachFreeCameraHost,
	createFreeCameraPoseFromPerspectiveCamera,
	updateAndApplyFreeCamera,
} from "./free-camera-host";
import { attachShelfPointerInteractionWiring } from "./shelf-pointer-interactions";
import type { ShelfDetailRowClickPayload, ShelfPlayPlaylistPayload } from "./shelf-pointer-interactions";
import type { ShelfDetailContentListController } from "./shelf-detail-data";
import { createShelfPaneWheelSwitcher } from "./shelf-pane-switch";
import { createJsDelivrAiDepthEstimator } from "./ai-depth-estimator";
import {
	attachShelfFocusZonePointerWiring,
	createSecondaryPlaylistEdgeGuard,
	isQueueFocusActive,
	isWallpaperSafeShelfPreset,
	type QueueFocusPanelInfo,
} from "./shelf-focus-zone";

export interface VisualEngineRefs {
	hostRef: RefObject<HTMLDivElement | null>;
	audioElementRef: RefObject<HTMLAudioElement | null>;
	positionRef: RefObject<number>;
	durationMsRef?: RefObject<number | null | undefined>;
	isPlayingRef: RefObject<boolean>;
	lyricLinesRef: RefObject<VisualLyricLine[]>;
	fallbackTextRef?: RefObject<string>;
	lyricsHasNativeKaraokeRef?: RefObject<boolean>;
	shelfItemsRef: RefObject<ShelfItem[]>;
	shelfItemsVersionRef: RefObject<number>;
	splashActiveRef: RefObject<boolean>;
	homeActiveRef?: RefObject<boolean>;
	shelfModeRef?: RefObject<string>;
	shelfCameraModeRef?: RefObject<string>;
	shelfPresenceRef?: RefObject<string>;
	shelfMergeCollectionsRef?: RefObject<boolean>;
	shelfMineCountRef?: RefObject<number>;
	shelfFavCountRef?: RefObject<number>;
	wallpaperSafeRef?: RefObject<boolean>;
	secondaryLeftDisplaySeamGuardRef?: RefObject<boolean>;
	coverUrlRef?: RefObject<string>;
	coverUrlVersionRef?: RefObject<number>;
	beatMapKeyRef?: RefObject<string>;
	beatMapRef?: RefObject<unknown>;
	beatMapVersionRef?: RefObject<number>;
	onShelfPlayQueueIndexRef?: RefObject<((index: number) => void) | undefined>;
	onShelfPlayPlaylistRef?: RefObject<((payload: ShelfPlayPlaylistPayload) => void) | undefined>;
	onShelfDetailRowClickRef?: RefObject<((payload: ShelfDetailRowClickPayload) => void) | undefined>;
	onShelfOpenDetailContentRef?: RefObject<((payload: ShelfOpenDetailContentPayload, writer: ShelfDetailContentListController) => void) | undefined>;
	onShelfOpenContentChangeRef?: RefObject<((open: boolean) => void) | undefined>;
	onShelfPaneChangeRef?: RefObject<((pane: ShelfPane) => void) | undefined>;
	lifecycleRef: RefObject<StageLyricsLifecycle | null>;
	desktopLyricsMotionRef?: RefObject<StageLyricsMotionSnapshot>;
	coverResolution: number;
	fxDefaults?: Partial<FxState>;
	fxRef?: RefObject<Partial<FxState> | undefined>;
	onShelfModeChange?: (mode: "side") => void;
}

interface MountedHandles {
	renderer: RendererHandle;
	audioEngine: AudioReactivityEngine;
	cinema: CinemaCamera;
	homeVisual: HomeVisual;
	shelfManager: ShelfManager;
	connectorParticles: ConnectorParticles;
	lifecycle: StageLyricsLifecycle;
	renderLoop: RenderLoop;
	shelfSelectSound: ShelfSelectSoundPlayer | null;
	audioContext: AudioContext | null;
	offHome: () => void;
	offCamera: () => void;
	offShelf: () => void;
	offLyrics: () => void;
	offAudio: () => void;
	offHomeAudio: () => void;
	offResize: () => void;
	offShelfFocus: () => void;
	offShelfPointerInteractions: () => void;
	offFreeCamera: () => void;
	offCanvasPointer: () => void;
}

function prefersReducedMotion(): boolean {
	if (typeof window === "undefined") return false;
	const m = (window as unknown as { matchMedia?: (q: string) => { matches: boolean } | null }).matchMedia;
	if (typeof m !== "function") return false;
	try {
		return m.call(window, "(prefers-reduced-motion: reduce)")?.matches ?? false;
	} catch {
		return false;
	}
}

function mergeFxState(target: FxState, source: Partial<FxState> | undefined): FxState {
	if (!source) return target;
	Object.assign(target, source);
	if (source.mouseXy) target.mouseXy = { ...target.mouseXy, ...source.mouseXy };
	return target;
}

export interface StageLyricsHostSupplierRefs {
	durationMsRef?: RefObject<number | null | undefined>;
	fallbackTextRef?: RefObject<string>;
	lyricsHasNativeKaraokeRef?: RefObject<boolean>;
	fxDefaults?: Partial<FxState>;
	fxRef?: RefObject<Partial<FxState> | undefined>;
}

export function createStageLyricsHostSuppliers(input: StageLyricsHostSupplierRefs): Required<Pick<
	StageLyricsLifecycleOpts,
	"audioDurationSupplier" | "fallbackTextSupplier" | "particleLyricsFlagSupplier" | "lyricGlowParticlesSupplier" | "lyricGlowStrengthSupplier" | "lyricGlowBeatFlagSupplier" | "lyricsHasNativeKaraokeSupplier"
>> {
	const readFx = (): FxState => mergeFxState(mergeFxState(cloneFxState(), input.fxDefaults), input.fxRef?.current);
	return {
		audioDurationSupplier: () => {
			const ms = input.durationMsRef?.current;
			return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms / 1000 : NaN;
		},
		fallbackTextSupplier: () => input.fallbackTextRef?.current ?? "",
		particleLyricsFlagSupplier: () => readFx().particleLyrics !== false,
		lyricGlowParticlesSupplier: () => readFx().lyricGlowParticles === true,
		lyricGlowStrengthSupplier: () => {
			const fx = readFx();
			return fx.lyricGlow ? Math.min(0.85, Math.max(0, Number(fx.lyricGlowStrength) || 0)) : 0;
		},
		lyricGlowBeatFlagSupplier: () => {
			const fx = readFx();
			return fx.lyricGlow === true && fx.lyricGlowBeat === true;
		},
		lyricsHasNativeKaraokeSupplier: () => input.lyricsHasNativeKaraokeRef?.current === true,
	};
}

export interface StageLyricsShelfSupplierInput {
	shelfManager: Pick<ShelfManager, "getShelfVisibility" | "getMode" | "hasOpenContent" | "getShelfPinnedOpen" | "getShelfHoverCueValue">;
	shelfModeRef?: RefObject<string>;
	shelfPresenceRef?: RefObject<string>;
	fxDefaults?: Partial<FxState>;
	fxRef?: RefObject<Partial<FxState> | undefined>;
}

export function createStageLyricsShelfSuppliers(input: StageLyricsShelfSupplierInput): Required<Pick<
	StageLyricsLifecycleOpts,
	"getShelfVisibility" | "getShelfMode" | "getShelfHasOpenContent" | "getShelfPinnedOpen" | "getShelfAlwaysVisible" | "getShelfHoverCueValue" | "getSkullShelfOpen"
>> {
	const readFx = (): FxState => mergeFxState(mergeFxState(cloneFxState(), input.fxDefaults), input.fxRef?.current);
	const getShelfMode = () => input.shelfModeRef?.current ?? input.fxDefaults?.shelf ?? input.shelfManager.getMode();
	const getShelfPresence = () => input.shelfPresenceRef?.current ?? input.fxDefaults?.shelfPresence ?? "always";
	return {
		getShelfVisibility: () => input.shelfManager.getShelfVisibility(),
		getShelfMode,
		getShelfHasOpenContent: () => input.shelfManager.hasOpenContent(),
		getShelfPinnedOpen: () => input.shelfManager.getShelfPinnedOpen(),
		getShelfAlwaysVisible: () => getShelfPresence() === "always",
		getShelfHoverCueValue: () => input.shelfManager.getShelfHoverCueValue(),
		getSkullShelfOpen: () => resolveSkullShelfCompositionActive({
			preset: readFx().preset,
			shelfMode: getShelfMode(),
			shelfVisibility: input.shelfManager.getShelfVisibility(),
			pinnedOpen: input.shelfManager.getShelfPinnedOpen(),
			hasOpenContent: input.shelfManager.hasOpenContent(),
		}),
	};
}

async function initAudioSource(el: HTMLAudioElement | null): Promise<AudioFrameSource> {
	if (typeof window === "undefined") return makeFallbackFrameSource();
	const AudioCtor =
		(window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (typeof AudioCtor !== "function") return makeFallbackFrameSource();

	let ctx: AudioContext;
	try {
		ctx = new AudioCtor();
	} catch {
		return makeFallbackFrameSource();
	}

	const mainAnalyser = ctx.createAnalyser();
	mainAnalyser.fftSize = 2048;
	mainAnalyser.smoothingTimeConstant = 0.58;
	const beatAnalyser = ctx.createAnalyser();
	beatAnalyser.fftSize = 2048;
	beatAnalyser.smoothingTimeConstant = 0.10;

	let source: MediaElementAudioSourceNode | null = null;
	if (el) {
		try {
			source = ctx.createMediaElementSource(el);
			source.connect(mainAnalyser);
			source.connect(beatAnalyser);
			mainAnalyser.connect(ctx.destination);
			beatAnalyser.connect(ctx.destination);
		} catch {
			source = null;
		}
	}

	const mainFreq = new Uint8Array(mainAnalyser.frequencyBinCount);
	const mainTime = new Uint8Array(mainAnalyser.fftSize);
	const beatFreq = new Uint8Array(beatAnalyser.frequencyBinCount);
	const beatTime = new Uint8Array(beatAnalyser.fftSize);

	return function frameSource(): AudioFrameBytes {
		try {
			mainAnalyser.getByteFrequencyData(mainFreq);
			mainAnalyser.getByteTimeDomainData(mainTime);
			beatAnalyser.getByteFrequencyData(beatFreq);
			beatAnalyser.getByteTimeDomainData(beatTime);
		} catch {
			return makeFallbackFrameSource()() ?? {
				mainFreqData: new Uint8Array(0),
				mainTimeData: new Uint8Array(0),
				mainSampleRate: 0,
				mainFftSize: 0,
				beatFreqData: new Uint8Array(0),
				beatTimeData: new Uint8Array(0),
				beatSampleRate: 0,
				beatFftSize: 0,
				playing: false,
				currentTimeSeconds: 0,
			};
		}
		const playing = !!(el && !el.paused && !el.ended);
		const currentTimeSeconds = el ? el.currentTime : 0;
		return {
			mainFreqData: mainFreq,
			mainTimeData: mainTime,
			mainSampleRate: ctx.sampleRate,
			mainFftSize: mainAnalyser.fftSize,
			beatFreqData: beatFreq,
			beatTimeData: beatTime,
			beatSampleRate: ctx.sampleRate,
			beatFftSize: beatAnalyser.fftSize,
			playing,
			currentTimeSeconds,
		};
	};
}

function makeFallbackFrameSource(): AudioFrameSource {
	const empty = new Uint8Array(0);
	return function fallbackFrame(): AudioFrameBytes {
		return {
			mainFreqData: empty,
			mainTimeData: empty,
			mainSampleRate: 0,
			mainFftSize: 0,
			beatFreqData: empty,
			beatTimeData: empty,
			beatSampleRate: 0,
			beatFftSize: 0,
			playing: false,
			currentTimeSeconds: 0,
		};
	};
}

export function readVisualCurrentTimeSeconds(audio: HTMLAudioElement | null | undefined, fallbackPositionMs: number): number {
	const audioTime = Number(audio?.currentTime);
	if (Number.isFinite(audioTime) && audioTime >= 0) return audioTime;
	const fallback = Number(fallbackPositionMs);
	return Number.isFinite(fallback) && fallback > 0 ? fallback / 1000 : 0;
}

function attachBaselineCanvasPointerInput(input: {
	target: HTMLElement;
	windowTarget: Window;
	homeVisual: HomeVisual;
	cinema: CinemaCamera;
	freeCamera: ReturnType<typeof createDefaultFreeCameraState>;
	pointerTarget: { x: number; y: number };
	isPointerOverUi: (event: MouseEvent | WheelEvent) => boolean;
}): () => void {
	let rotating = false;
	let lastX = 0;
	let lastY = 0;
	let lastT = 0;

	const updatePointerTarget = (clientX: number, clientY: number) => {
		const width = Math.max(1, input.windowTarget.innerWidth || input.target.clientWidth || 1);
		const height = Math.max(1, input.windowTarget.innerHeight || input.target.clientHeight || 1);
		const ndcX = (clientX / width) * 2 - 1;
		const ndcY = -(clientY / height) * 2 + 1;
		input.pointerTarget.x = ndcX;
		input.pointerTarget.y = ndcY;
		const fx = input.homeVisual.getFx();
		fx.mouseActive = true;
		fx.mouseXy = { x: ndcX * 2.4, y: ndcY * 2.4 };
	};

	const clearPointer = () => {
		const fx = input.homeVisual.getFx();
		fx.mouseActive = false;
		fx.mouseXy = { x: -999, y: -999 };
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button === 2 || input.isPointerOverUi(event)) return;
		rotating = true;
		lastX = event.clientX;
		lastY = event.clientY;
		lastT = performance.now();
		input.cinema.getState().orbit.rotating = true;
		updatePointerTarget(event.clientX, event.clientY);
	};

	const onMouseMove = (event: MouseEvent) => {
		if (input.isPointerOverUi(event) && !rotating) {
			clearPointer();
			return;
		}
		updatePointerTarget(event.clientX, event.clientY);
		if (!rotating || input.freeCamera.active) return;
		const now = performance.now();
		const dt = Math.max(1 / 120, Math.min(0.08, (now - lastT) / 1000 || 1 / 60));
		input.homeVisual.applyPointerSpinDrag(event.clientX - lastX, event.clientY - lastY, dt);
		const orbit = input.cinema.getState().orbit;
		orbit.centerLocked = false;
		orbit.rotating = true;
		lastX = event.clientX;
		lastY = event.clientY;
		lastT = now;
	};

	const endDrag = () => {
		rotating = false;
		input.cinema.getState().orbit.rotating = false;
	};

	const onMouseLeave = () => {
		clearPointer();
		endDrag();
	};

	const onWheel = (event: WheelEvent) => {
		if (input.isPointerOverUi(event) || input.freeCamera.active) return;
		event.preventDefault();
		const orbit = input.cinema.getState().orbit;
		orbit.centerLocked = false;
		orbit.userRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + event.deltaY * 0.005));
	};

	input.target.addEventListener("mousedown", onMouseDown);
	input.windowTarget.addEventListener("mousemove", onMouseMove);
	input.windowTarget.addEventListener("mouseup", endDrag);
	input.windowTarget.addEventListener("blur", endDrag);
	input.target.addEventListener("mouseleave", onMouseLeave);
	input.target.addEventListener("wheel", onWheel, { passive: false });
	return () => {
		input.target.removeEventListener("mousedown", onMouseDown);
		input.windowTarget.removeEventListener("mousemove", onMouseMove);
		input.windowTarget.removeEventListener("mouseup", endDrag);
		input.windowTarget.removeEventListener("blur", endDrag);
		input.target.removeEventListener("mouseleave", onMouseLeave);
		input.target.removeEventListener("wheel", onWheel);
	};
}

function getPlaylistPanelFocusInfo(doc: Document): QueueFocusPanelInfo | null {
	const panel = doc.querySelector("#playlist-panel");
	if (!(panel instanceof HTMLElement)) return null;
	const rect = panel.getBoundingClientRect();
	return {
		active: panel.classList.contains("peek") || panel.classList.contains("show"),
		peek: panel.classList.contains("peek"),
		rect: {
			left: rect.left,
			right: rect.right,
			top: rect.top,
			bottom: rect.bottom,
		},
	};
}

export function isRuntimeShelfPreviewActive(
	presence: string | null | undefined,
	shelfVisibility: number,
): boolean {
	return presence === "auto" && shelfVisibility > 0.16;
}

export interface SkullShelfCompositionInput {
	preset: number | null | undefined;
	shelfMode: string | null | undefined;
	shelfVisibility: number;
	pinnedOpen: boolean;
	hasOpenContent: boolean;
}

export function resolveSkullShelfCompositionActive(input: SkullShelfCompositionInput): boolean {
	if (Number(input.preset) !== 6) return false;
	if (input.shelfMode !== "side") return false;
	return input.pinnedOpen || input.shelfVisibility > 0.18 || input.hasOpenContent;
}

export interface WallpaperShelfDimInput {
	preset: number | null | undefined;
	shelfMode: string | null | undefined;
	pinnedOpen: boolean;
	hasOpenContent: boolean;
	shelfVisibility?: number;
	hoverCueValue?: number;
}

export function shouldDimWallpaperParticlesForShelf(input: WallpaperShelfDimInput): boolean {
	if (Number(input.preset) !== 5) return false;
	if (input.shelfMode !== "side") return false;
	return input.pinnedOpen || input.hasOpenContent;
}

export function resolveSkullMouthLyricsActive(input: {
	preset: number | null | undefined;
	skullParticlesVisible?: boolean;
}): boolean {
	return Number(input.preset) === 6 && input.skullParticlesVisible === true;
}

export function resolveRuntimeWallpaperSafe(input: {
	fxDefaults?: Partial<FxState>;
	fxRef?: RefObject<Partial<FxState> | undefined>;
}): boolean {
	const fx = mergeFxState(mergeFxState(cloneFxState(), input.fxDefaults), input.fxRef?.current);
	return isWallpaperSafeShelfPreset(fx.preset);
}

function clampRange(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function hexToRgbValue(hex: string): { r: number; g: number; b: number } {
	const raw = String(hex || "").trim().replace(/^#/, "");
	const normalized = /^[0-9a-f]{3}$/i.test(raw)
		? raw.split("").map((c) => c + c).join("")
		: raw;
	const valid = /^[0-9a-f]{6}$/i.test(normalized) ? normalized : "a9b8c8";
	const n = parseInt(valid, 16);
	return {
		r: (n >> 16) & 255,
		g: (n >> 8) & 255,
		b: n & 255,
	};
}

function rgbToHslValue(r: number, g: number, b: number): { h: number; s: number; l: number } {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	let h = 0;
	let s = 0;
	const l = (max + min) / 2;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h /= 6;
	}
	return { h, s, l };
}

function hueToRgbValue(p: number, q: number, t: number): number {
	let v = t;
	if (v < 0) v += 1;
	if (v > 1) v -= 1;
	if (v < 1 / 6) return p + (q - p) * 6 * v;
	if (v < 1 / 2) return q;
	if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
	return p;
}

function hslToRgbCss(h: number, s: number, l: number): string {
	let r: number;
	let g: number;
	let b: number;
	if (s === 0) {
		r = g = b = l;
	} else {
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hueToRgbValue(p, q, h + 1 / 3);
		g = hueToRgbValue(p, q, h);
		b = hueToRgbValue(p, q, h - 1 / 3);
	}
	return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

export function lyricPaletteFromHex(hex: string): LyricPalette {
	const c = hexToRgbValue(hex);
	const hsl = rgbToHslValue(c.r, c.g, c.b);
	const neutral = hsl.s < 0.035;
	const s = neutral ? 0 : clampRange(hsl.s * 1.08, 0.14, 0.92);
	let l = hsl.l;
	if (l < 0.11) l = 0.15 + l * 1.18;
	else if (l < 0.28) l = 0.21 + (l - 0.11) * 1.18;
	else l = clampRange(l, 0.30, 0.82);
	l = clampRange(l, 0.14, 0.84);
	const primary = hslToRgbCss(hsl.h, s, l);
	const secondary = hslToRgbCss(
		(hsl.h + 0.055) % 1,
		neutral ? 0 : clampRange(s * 0.88, 0.12, 0.78),
		clampRange(l + (l < 0.38 ? 0.10 : -0.08), 0.18, 0.76),
	);
	const highlight = hslToRgbCss(
		(hsl.h + 0.018) % 1,
		neutral ? 0 : clampRange(s * 0.72, 0.10, 0.70),
		clampRange(l + 0.22, 0.38, 0.92),
	);
	return {
		primary,
		secondary,
		highlight,
		glowColor: secondary,
	};
}

export function resolveStageLyricPalette(
	fxInput: Partial<FxState>,
	coverPalette?: LyricPalette | null,
): LyricPalette {
	const fx = mergeFxState(cloneFxState(), fxInput);
	const base = fx.lyricColorMode === "custom"
		? lyricPaletteFromHex(fx.lyricColor)
		: coverPalette ?? DEFAULT_LYRIC_PALETTE;
	const primary = base.primary;
	const highlightPalette = fx.lyricHighlightMode === "custom"
		? lyricPaletteFromHex(fx.lyricHighlightColor)
		: null;
	const glowPalette = fx.lyricGlowLinked === false
		? lyricPaletteFromHex(fx.lyricGlowColor)
		: null;
	const highlight = highlightPalette?.primary ?? base.highlight;
	const glowColor = glowPalette?.primary ?? highlightPalette?.secondary ?? base.glowColor;
	return {
		primary,
		secondary: base.secondary,
		highlight,
		glowColor,
	};
}

export function setRuntimeShelfMode(
	shelfModeRef: RefObject<string> | undefined,
	mode: "side",
	onShelfModeChange?: (mode: "side") => void,
): void {
	if (shelfModeRef) shelfModeRef.current = mode;
	onShelfModeChange?.(mode);
}

const HOME_WALLPAPER_PRESET = 5;

export function resolveHomeVisualPreset(
	homeActive: boolean,
	currentPreset: number,
	defaultPreset: number,
	previousPreset: number | null,
	opts: { playbackActive?: boolean; playbackPreset?: number | null } = {},
): { preset: number; previousPreset: number | null; changed: boolean } {
	if (homeActive) {
		const nextPreviousPreset = previousPreset ?? currentPreset;
		return {
			preset: HOME_WALLPAPER_PRESET,
			previousPreset: nextPreviousPreset,
			changed: currentPreset !== HOME_WALLPAPER_PRESET || previousPreset === null,
		};
	}
	const target = previousPreset ?? (
		opts.playbackActive && typeof opts.playbackPreset === "number"
			? opts.playbackPreset
			: defaultPreset
	);
	return {
		preset: target,
		previousPreset: null,
		changed: currentPreset !== target,
	};
}

export function resolveStageLyricLayoutOptions(
	fx: Partial<FxState>,
	orbitState: { orbitCenterLocked?: boolean; orbitRecentering?: boolean } = {},
	opts: { skullParticlesVisible?: boolean } = {},
) {
	return {
		lyricCameraLock: !!fx.lyricCameraLock,
		lyricScale: fx.lyricScale,
		lyricOffsetX: fx.lyricOffsetX,
		lyricOffsetY: fx.lyricOffsetY,
		lyricOffsetZ: fx.lyricOffsetZ,
		lyricTiltX: fx.lyricTiltX,
		lyricTiltY: fx.lyricTiltY,
		preset: fx.preset,
		skullLyricEdgeGuard: Number(fx.preset) === 6 && !!(orbitState.orbitCenterLocked || orbitState.orbitRecentering),
		skullMouthLyrics: resolveSkullMouthLyricsActive({
			preset: fx.preset,
			skullParticlesVisible: opts.skullParticlesVisible,
		}),
	};
}

function disposeHandles(handles: MountedHandles | null): void {
	if (!handles) return;
	try {
		handles.renderLoop.stop();
	} catch {
	}
	try {
		handles.offHome();
	} catch {
	}
	try {
		handles.offCamera();
	} catch {
	}
	try {
		handles.offShelf();
	} catch {
	}
	try {
		handles.offLyrics();
	} catch {
	}
	try {
		handles.offAudio();
	} catch {
	}
	try {
		handles.offHomeAudio();
	} catch {
	}
	try {
		handles.offResize();
	} catch {
	}
	try {
		handles.offShelfFocus();
	} catch {
	}
	try {
		handles.offShelfPointerInteractions();
	} catch {
	}
	try {
		handles.offFreeCamera();
	} catch {
	}
	try {
		handles.offCanvasPointer();
	} catch {
	}
	try {
		handles.lifecycle.dispose();
	} catch {
	}
	try {
		handles.homeVisual.dispose();
	} catch {
	}
	try {
		handles.shelfManager.dispose();
	} catch {
	}
	try {
		handles.connectorParticles.dispose();
	} catch {
	}
	try {
		handles.cinema.dispose();
	} catch {
	}
	try {
		handles.audioEngine.dispose();
	} catch {
	}
	try {
		handles.renderLoop.dispose();
	} catch {
	}
	try {
		handles.renderer.dispose();
	} catch {
	}
	try {
		if (handles.audioContext && handles.audioContext.state !== "closed") {
			void handles.audioContext.close();
		}
	} catch {
	}
}

export function useVisualEngine(refs: VisualEngineRefs): void {
	const disposedRef = useRef(false);
	const aiDepthEstimatorRef = useRef<ReturnType<typeof createJsDelivrAiDepthEstimator> | null>(null);
	if (!aiDepthEstimatorRef.current) aiDepthEstimatorRef.current = createJsDelivrAiDepthEstimator();
	useEffect(() => {
		disposedRef.current = false;
		const host = refs.hostRef.current;
		if (typeof window === "undefined" || !host) return;
		let handles: MountedHandles | null = null;
		let cancelled = false;

		void (async () => {
			const frameSource = await initAudioSource(refs.audioElementRef.current);
			if (cancelled || disposedRef.current) {
				return;
			}
			const audioEngine = createAudioReactivity({
				frameSource,
				prefersReducedMotion,
			});
			const renderer = await createRenderer(host, {});
			if (cancelled || disposedRef.current) {
				audioEngine.dispose();
				renderer.dispose();
				return;
			}
			const resizeAwareRenderer = {
				...renderer,
				resize: (opts?: Parameters<typeof renderer.resize>[0]) => {
					renderer.resize(opts);
					refs.lifecycleRef.current?.requestCameraSnap(10);
				},
			};
			const offResize = attachRendererResizeSync(host, resizeAwareRenderer);
			renderer.resize();
			const cinema = createCinemaCamera({
				camera: renderer.camera,
				getCurrentTime: () => refs.positionRef.current / 1000,
			});
			const shelfSelectSound = createShelfSelectSoundPlayer({
				window,
				volume: () => {
					const audio = refs.audioElementRef.current;
					if (!audio || audio.muted) return 0;
					return Number.isFinite(audio.volume) ? audio.volume : 0.65;
				},
			});
			const freeCamera = createDefaultFreeCameraState();
			const runtimeFx = mergeFxState(mergeFxState(cloneFxState(), refs.fxDefaults), refs.fxRef?.current);
			let latestCoverLyricPalette: LyricPalette | null = null;
			let lastAppliedLyricPaletteKey = "";
			const applyStageLyricPalette = () => {
				const fx = mergeFxState(mergeFxState(cloneFxState(), refs.fxDefaults), refs.fxRef?.current);
				const palette = resolveStageLyricPalette(fx, latestCoverLyricPalette);
				const key = `${palette.primary}|${palette.secondary}|${palette.highlight}|${palette.glowColor}`;
				if (key === lastAppliedLyricPaletteKey) return;
				lastAppliedLyricPaletteKey = key;
				refs.lifecycleRef.current?.setPalette(palette);
			};
			const homeVisual = await createHomeVisual({
				scene: renderer.scene,
				coverResolution: refs.coverResolution,
				fx: runtimeFx,
				estimateAiDepth: aiDepthEstimatorRef.current ?? undefined,
				onCoverLyricPalette: (palette) => {
					latestCoverLyricPalette = palette;
					lastAppliedLyricPaletteKey = "";
					applyStageLyricPalette();
				},
			});
			let homeVisualPreviousPreset: number | null = null;
			let homeVisualPreviewActive = false;
			let syncedCoverUrlVersion = refs.coverUrlVersionRef?.current ?? 0;
			const syncHomeVisualPixelRatio = () => {
				const pixelRatio = renderer.renderer.getPixelRatio?.() ?? 1;
				const uniforms = homeVisual.getField().materialUniforms;
				if (uniforms.uPixel) uniforms.uPixel.value = pixelRatio;
			};
			syncHomeVisualPixelRatio();
			homeVisual.setCoverUrl(refs.coverUrlRef?.current ?? "");
			if (cancelled || disposedRef.current) {
				homeVisual.dispose();
				audioEngine.dispose();
				cinema.dispose();
				offResize();
				renderer.dispose();
				return;
			}
			let shelfManagerForCallback: ShelfManager | null = null;
			const shelfManager = await createShelfManagerWithThree({
				scene: renderer.scene,
				document,
				onOpenDetailContent: (payload) => {
					const contentList = shelfManagerForCallback?.getContentList();
					if (contentList) {
						refs.onShelfOpenDetailContentRef?.current?.(payload, contentList);
					}
				},
			});
			shelfManagerForCallback = shelfManager;
			if (cancelled || disposedRef.current) {
				shelfManager.dispose();
				homeVisual.dispose();
				audioEngine.dispose();
				cinema.dispose();
				offResize();
				renderer.dispose();
				return;
			}
			const connectorParticles = await createConnectorParticles({
				scene: renderer.scene,
				dotTexture: homeVisual.getField().materialUniforms.uDotTex?.value ?? null,
			});
			if (connectorParticles.object) {
				connectorParticles.object.visible = false;
				connectorParticles.object.renderOrder = 49;
			}
			if (cancelled || disposedRef.current) {
				connectorParticles.dispose();
				shelfManager.dispose();
				homeVisual.dispose();
				audioEngine.dispose();
				cinema.dispose();
				offResize();
				renderer.dispose();
				return;
			}
			const lifecycle = createStageLyricsLifecycle({
				scene: renderer.scene,
				currentTimeSupplier: () => readVisualCurrentTimeSeconds(refs.audioElementRef.current, refs.positionRef.current),
				isPlayingSupplier: () => refs.isPlayingRef.current,
				lyricLinesSupplier: () => refs.lyricLinesRef.current,
				...createStageLyricsHostSuppliers(refs),
				...createStageLyricsShelfSuppliers({
					shelfManager,
					shelfModeRef: refs.shelfModeRef,
					shelfPresenceRef: refs.shelfPresenceRef,
					fxDefaults: refs.fxDefaults,
					fxRef: refs.fxRef,
				}),
				lyricTextOptionsSupplier: () => {
					const fx = mergeFxState(mergeFxState(cloneFxState(), refs.fxDefaults), refs.fxRef?.current);
					return {
						lyricFont: fx.lyricFont,
						lyricLetterSpacing: fx.lyricLetterSpacing,
						lyricLineHeight: fx.lyricLineHeight,
						lyricWeight: fx.lyricWeight,
					};
				},
				lyricLayoutOptionsSupplier: () => {
					const fx = mergeFxState(mergeFxState(cloneFxState(), refs.fxDefaults), refs.fxRef?.current);
					const orbit = cinema.getState().orbit;
					return resolveStageLyricLayoutOptions(fx, {
						orbitCenterLocked: orbit.centerLocked,
					}, {
						skullParticlesVisible: homeVisual.getSkullParticles()?.visible === true,
					});
				},
				skullMouthTransformSupplier: () => homeVisual.getSkullMouthTransform(),
				skullBeatFlashSupplier: () => homeVisual.getSkullBeatFlash(),
				coverWorldTransformSupplier: () => {
					const points = homeVisual.getField().points;
					return {
						position: points.position,
						quaternion: points.quaternion,
						updateMatrixWorld: (force?: boolean) => points.updateMatrixWorld(force),
						getWorldPosition: (target: { x: number; y: number; z: number }) => {
							const worldPosition = points.position.clone();
							points.getWorldPosition(worldPosition);
							target.x = worldPosition.x;
							target.y = worldPosition.y;
							target.z = worldPosition.z;
							return target;
						},
						getWorldQuaternion: (target: { x: number; y: number; z: number; w: number }) => {
							const worldQuaternion = points.quaternion.clone();
							points.getWorldQuaternion(worldQuaternion);
							target.x = worldQuaternion.x;
							target.y = worldQuaternion.y;
							target.z = worldQuaternion.z;
							target.w = worldQuaternion.w;
							return target;
						},
					};
				},
				cameraSupplier: () => renderer.camera,
				pixelScale: 1,
				maxAnisotropy: Math.min(8, renderer.renderer.capabilities.getMaxAnisotropy?.() ?? 1),
				reduceMotion: prefersReducedMotion,
			});
			let syncedShelfItemsVersion = refs.shelfItemsVersionRef.current;
			let syncedBeatMapVersion = refs.beatMapVersionRef?.current ?? 0;
			let syncedShelfContentOpen = false;
			const pointerTarget = { x: 0, y: 0 };
			const pointerParallax = { x: 0, y: 0 };
			shelfManager.setData(refs.shelfItemsRef.current);
			const beatMapScheduler = createBeatMapScheduler({
				scheduleCameraBeat: (beat) => cinema.applyBeat(Math.max(Number(beat.strength) || 0, Number(beat.impact) || 0), true),
				triggerScheduledBeat: (beat) => audioEngine.triggerScheduledBeat(beat),
				setBeatMapReady: (ready) => audioEngine.setBeatMapReady(ready),
				setWaitingForBeatMap: (waiting) => audioEngine.setWaitingForBeatMap(waiting),
			});
			beatMapScheduler.setBeatMap(
				refs.beatMapKeyRef?.current ?? "",
				refs.beatMapRef?.current ?? null,
			);
			void lifecycle.mount(renderer.scene);
			refs.lifecycleRef.current = lifecycle;
			lifecycle.requestCameraSnap(10);
			try {
				lifecycle.setLyricLines(refs.lyricLinesRef.current);
			} catch {
			}
			applyStageLyricPalette();
			const renderLoop = createRenderLoop({
				renderer: renderer.renderer,
				scene: renderer.scene,
				camera: renderer.camera,
				audio: audioEngine,
				pointerTarget,
				pointerParallax,
				isMainSceneCoveredBySplash: () => refs.splashActiveRef.current,
				getAdaptiveFps: () => 0,
				prefersReducedMotion,
				onCacheTrim: () => {},
			});
			const offHomeAudio = renderLoop.registerStep(RenderStepSlot.Ripples, (ctx) => {
				if (refs.beatMapVersionRef && syncedBeatMapVersion !== refs.beatMapVersionRef.current) {
					syncedBeatMapVersion = refs.beatMapVersionRef.current;
					beatMapScheduler.setBeatMap(
						refs.beatMapKeyRef?.current ?? "",
						refs.beatMapRef?.current ?? null,
					);
				}
				audioEngine.update(ctx.dt);
				beatMapScheduler.update(readVisualCurrentTimeSeconds(refs.audioElementRef.current, refs.positionRef.current));
			});
			const offHome = renderLoop.registerStep(RenderStepSlot.HomeVisual, (ctx) => {
				mergeFxState(homeVisual.getFx(), refs.fxRef?.current);
				syncHomeVisualPixelRatio();
				if (refs.coverUrlVersionRef && syncedCoverUrlVersion !== refs.coverUrlVersionRef.current) {
					syncedCoverUrlVersion = refs.coverUrlVersionRef.current;
					homeVisual.setCoverUrl(refs.coverUrlRef?.current ?? "");
				}
				applyStageLyricPalette();
				const homeActive = refs.homeActiveRef?.current === true;
				const enteringHomePreview = homeActive && !homeVisualPreviewActive;
				const preset = resolveHomeVisualPreset(
					homeActive,
					homeVisual.getPreset(),
					homeVisual.getFx().preset ?? refs.fxDefaults?.preset ?? 0,
					homeVisualPreviousPreset,
					{
						playbackActive: refs.isPlayingRef.current,
						playbackPreset: homeVisual.getFx().preset ?? refs.fxDefaults?.preset ?? 0,
					},
				);
				if (preset.changed) {
					homeVisual.setPreset(preset.preset, {
						silent: true,
						preserveCamera: false,
						skipTransition: homeActive,
						noSave: true,
					});
					cinema.setPresetCameraBaseline(preset.preset);
				} else if (enteringHomePreview) {
					cinema.setPresetCameraBaseline(preset.preset);
				}
				homeVisualPreviousPreset = preset.previousPreset;
				homeVisualPreviewActive = homeActive;
				const uniforms = homeVisual.getField().materialUniforms as Record<string, { value: unknown }>;
				if (homeVisualPreviewActive) {
					if (typeof uniforms.uAlpha?.value === "number" && uniforms.uAlpha.value < 0.96) {
						uniforms.uAlpha.value = 0.96;
					}
					if (uniforms.uFloatAlpha) uniforms.uFloatAlpha.value = 0;
				}
				homeVisual.setSkullShelfCompositionActive(resolveSkullShelfCompositionActive({
					preset: homeVisual.getFx().preset,
					shelfMode: shelfManager.getMode(),
					shelfVisibility: shelfManager.getShelfVisibility(),
					pinnedOpen: shelfManager.getShelfPinnedOpen(),
					hasOpenContent: shelfManager.hasOpenContent(),
				}));
				homeVisual.setWallpaperShelfDimActive(shouldDimWallpaperParticlesForShelf({
					preset: homeVisual.getFx().preset,
					shelfMode: shelfManager.getMode(),
					pinnedOpen: shelfManager.getShelfPinnedOpen(),
					hasOpenContent: shelfManager.hasOpenContent(),
				}));
				homeVisual.update(ctx);
			});
			const offCamera = renderLoop.registerStep(RenderStepSlot.CameraCinematic, (ctx) => {
				if (updateAndApplyFreeCamera(freeCamera, renderer.camera, ctx.dt, ctx.now, {
					cameraShake: homeVisual.getFx().cinemaShake,
					beatCam: cinema.getState().beatCam,
					camPunch: cinema.getState().cameraPunch,
				})) {
					return;
				}
				cinema.update(ctx);
				const fx = homeVisual.getFx();
				if (Number(fx.preset) === 6) {
					cinema.applySkullCameraPose(ctx, {
						active: true,
						portrait: window.innerHeight > window.innerWidth * 1.08,
						shelfComposition: resolveSkullShelfCompositionActive({
							preset: fx.preset,
							shelfMode: shelfManager.getMode(),
							shelfVisibility: shelfManager.getShelfVisibility(),
							pinnedOpen: shelfManager.getShelfPinnedOpen(),
							hasOpenContent: shelfManager.hasOpenContent(),
						}),
						zoom: 0,
					});
				}
			});
			const shelfStep = createShelfStep(shelfManager, {
				getShelfMode: () => refs.shelfModeRef?.current ?? refs.fxDefaults?.shelf ?? "side",
				getShelfPresence: () => refs.shelfPresenceRef?.current ?? refs.fxDefaults?.shelfPresence ?? "always",
				getSplashActive: () => refs.splashActiveRef.current,
			});
			const offShelf = renderLoop.registerStep(RenderStepSlot.Shelf, (ctx) => {
				if (syncedShelfItemsVersion !== refs.shelfItemsVersionRef.current) {
					syncedShelfItemsVersion = refs.shelfItemsVersionRef.current;
					shelfManager.setData(refs.shelfItemsRef.current);
				}
				shelfStep(ctx);
				const shelfContentOpen = shelfManager.hasOpenContent();
				if (shelfContentOpen !== syncedShelfContentOpen) {
					syncedShelfContentOpen = shelfContentOpen;
					refs.onShelfOpenContentChangeRef?.current?.(shelfContentOpen);
					lifecycle.requestCameraSnap(10);
				}
				const connectorVisible =
					shelfManager.getMode() === "stage" &&
					shelfManager.getShelfVisibility() > 0 &&
					shelfManager.getData().length > 0;
				if (connectorParticles.object) {
					connectorParticles.object.visible = connectorVisible;
				}
				if (connectorParticles.floorMirror) {
					connectorParticles.floorMirror.visible = connectorVisible;
				}
				connectorParticles.setIntensity(connectorVisible ? shelfManager.getShelfVisibility() : 0);
				connectorParticles.update(ctx);
			});
			const offLyrics = renderLoop.registerStep(RenderStepSlot.StageLyrics, (ctx) => {
				lifecycle.update(ctx);
				if (refs.desktopLyricsMotionRef) {
					refs.desktopLyricsMotionRef.current = lifecycle.getMotionSnapshot();
				}
			});
			const offAudio = audioEngine.subscribeBeat((burst, isScheduled) => {
				cinema.applyBeat(burst, isScheduled);
			});
			const getSideShelfFocusHit = await createShelfPointerRaycastFocus({
				camera: renderer.camera,
				shelfManager,
				getScreenPad: () => {
					const presence = refs.shelfPresenceRef?.current ?? refs.fxDefaults?.shelfPresence ?? "always";
					return presence === "always" ? 18 : 24;
				},
			});
			const getShelfPointerHit = await createShelfPointerRaycastHitGetter({
				camera: renderer.camera,
				shelfManager,
			});
			const getStrictShelfPointerHit = await createShelfPointerStrictRaycastHitGetter({
				camera: renderer.camera,
				shelfManager,
			});
			const getStrictShelfDetailRowHit = await createShelfPointerContentRowRaycastHitGetter({
				camera: renderer.camera,
				shelfManager,
			});
			const shelfPaneWheelSwitcher = createShelfPaneWheelSwitcher({
				getPane: () => shelfManager.getShelfPane(),
				getMergeCollections: () => refs.shelfMergeCollectionsRef?.current === true,
				getMineCount: () => refs.shelfMineCountRef?.current ?? shelfManager.getData().length,
				getFavCount: () => refs.shelfFavCountRef?.current ?? 0,
				getCenterTarget: () => shelfManager.getState().centerTarget,
				setPane: (pane) => {
					shelfManager.setShelfPane(pane);
					refs.onShelfPaneChangeRef?.current?.(pane);
				},
			});
			const secondaryPlaylistEdgeGuard = createSecondaryPlaylistEdgeGuard();
			if (cancelled || disposedRef.current) {
				offAudio();
				offLyrics();
				offShelf();
				offCamera();
				offHome();
				offHomeAudio();
				offResize();
				renderLoop.dispose();
				lifecycle.dispose();
				connectorParticles.dispose();
				shelfManager.dispose();
				homeVisual.dispose();
				audioEngine.dispose();
				cinema.dispose();
				renderer.dispose();
				return;
			}
			const offShelfFocus = attachShelfFocusZonePointerWiring({
				target: window,
				cinema,
				shelfManager,
				getSplashActive: () => refs.splashActiveRef.current,
				getShelfCameraMode: () => refs.shelfCameraModeRef?.current ?? refs.fxDefaults?.shelfCameraMode ?? "static",
				getPortrait: () => window.innerHeight > window.innerWidth,
				getWallpaperSafe: () => refs.wallpaperSafeRef?.current ?? resolveRuntimeWallpaperSafe(refs),
				getViewportWidth: () => window.innerWidth || host.clientWidth || 0,
				getViewportHeight: () => window.innerHeight || host.clientHeight || 0,
				getQueueFocusActive: (pointer) => {
					const panel = getPlaylistPanelFocusInfo(document);
					return isQueueFocusActive(pointer, panel, {
						secondaryLeftDisplaySeamGuardActive: refs.secondaryLeftDisplaySeamGuardRef?.current === true,
						secondaryEdgeGuard: secondaryPlaylistEdgeGuard,
					});
				},
				getSideShelfFocusHit,
				onFocusZoneChange: (result) => {
					if (result.wallpaperSafe && (result.type === "shelf-side" || result.type === "shelf-detail")) {
						lifecycle.requestCameraSnap(10);
					}
				},
			});
			const offShelfPointerInteractions = attachShelfPointerInteractionWiring({
				target: window,
				cinema,
				shelfManager,
				getHit: getShelfPointerHit,
				getStrictHit: getStrictShelfPointerHit,
				getStrictDetailRowHit: getStrictShelfDetailRowHit,
				getSplashActive: () => refs.splashActiveRef.current,
				getPortrait: () => window.innerHeight > window.innerWidth,
				getWallpaperSafe: () => refs.wallpaperSafeRef?.current ?? resolveRuntimeWallpaperSafe(refs),
				getViewportWidth: () => window.innerWidth || host.clientWidth || 0,
				getViewportHeight: () => window.innerHeight || host.clientHeight || 0,
				getShelfPresence: () => refs.shelfPresenceRef?.current ?? refs.fxDefaults?.shelfPresence ?? "always",
				getShelfPreviewActive: () => {
					const presence = refs.shelfPresenceRef?.current ?? refs.fxDefaults?.shelfPresence ?? "always";
					return isRuntimeShelfPreviewActive(presence, shelfManager.getShelfVisibility());
				},
				isDetailWheelTarget: (event) => {
					return shelfManager.getContentList()?.hasScreenTargetAt({ x: event.clientX, y: event.clientY }) === true;
				},
				setShelfMode: (mode) => setRuntimeShelfMode(refs.shelfModeRef, mode, refs.onShelfModeChange),
				onBeforeShelfWheelScroll: (direction) => shelfPaneWheelSwitcher.step(direction),
				onShelfPlayQueueIndex: (index) => refs.onShelfPlayQueueIndexRef?.current?.(index),
				onShelfPlayPlaylist: (payload) => refs.onShelfPlayPlaylistRef?.current?.(payload),
				onShelfDetailRowClick: (payload) => refs.onShelfDetailRowClickRef?.current?.(payload),
				onShelfSelectFeedback: (direction, variant) => {
					shelfSelectSound.play(direction, variant);
				},
				onFocusZoneChange: (type, opts) => {
					if (opts?.wallpaperSafe && (type === "shelf-side" || type === "shelf-detail")) {
						lifecycle.requestCameraSnap(10);
					}
				},
			});
			const isPointerOverRuntimeUi = (event: MouseEvent | WheelEvent) => {
				const el = document.elementFromPoint(event.clientX, event.clientY);
				return !!(el && el.closest?.("#search-area,#top-right,#fullscreen-diy-zone,#fx-panel,#fx-fab,#fx-fab-hide-btn,#playlist-panel,#bottom-bar,#thumb-wrap,#empty-home,#visual-guide,#trial-banner,#source-fallback-notice,.modal-mask,#toast,#ai-depth-chip,#beat-chip,#drop-overlay"));
			};
			const offCanvasPointer = attachBaselineCanvasPointerInput({
				target: renderer.renderer.domElement,
				windowTarget: window,
				homeVisual,
				cinema,
				freeCamera,
				pointerTarget,
				isPointerOverUi: isPointerOverRuntimeUi,
			});
			const offFreeCamera = attachFreeCameraHost({
				target: window,
				wheelTarget: renderer.renderer.domElement,
				state: freeCamera,
				getCameraPose: () => createFreeCameraPoseFromPerspectiveCamera(renderer.camera),
				getNowMs: () => performance.now(),
				isPointerOverUi: isPointerOverRuntimeUi,
			});
			handles = {
				renderer,
				audioEngine,
				cinema,
				homeVisual,
				shelfManager,
				connectorParticles,
				lifecycle,
				renderLoop,
				shelfSelectSound,
				audioContext: null,
				offHome,
				offCamera,
				offShelf,
				offLyrics,
				offAudio,
				offHomeAudio,
				offResize,
				offShelfFocus,
				offShelfPointerInteractions,
				offFreeCamera,
				offCanvasPointer,
			};
			renderLoop.start();
		})();

		return () => {
			cancelled = true;
			disposedRef.current = true;
			disposeHandles(handles);
			handles = null;
			refs.lifecycleRef.current = null;
		};
	}, [refs.hostRef, refs.audioElementRef, refs.positionRef, refs.isPlayingRef, refs.lyricLinesRef, refs.shelfItemsRef, refs.shelfItemsVersionRef, refs.splashActiveRef, refs.homeActiveRef, refs.shelfModeRef, refs.shelfCameraModeRef, refs.shelfPresenceRef, refs.shelfMergeCollectionsRef, refs.shelfMineCountRef, refs.shelfFavCountRef, refs.wallpaperSafeRef, refs.secondaryLeftDisplaySeamGuardRef, refs.coverUrlRef, refs.coverUrlVersionRef, refs.beatMapKeyRef, refs.beatMapRef, refs.beatMapVersionRef, refs.onShelfPlayQueueIndexRef, refs.onShelfPlayPlaylistRef, refs.onShelfDetailRowClickRef, refs.onShelfOpenDetailContentRef, refs.onShelfOpenContentChangeRef, refs.onShelfPaneChangeRef, refs.lifecycleRef, refs.coverResolution, refs.onShelfModeChange]);
}

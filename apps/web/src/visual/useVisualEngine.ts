import { useEffect, useRef, type RefObject } from "react";
import {
	createAudioReactivity,
	createCinemaCamera,
	createConnectorParticles,
	createHomeVisual,
	createDefaultFreeCameraState,
	cloneFxState,
	createRenderLoop,
	createRenderer,
	createShelfManagerWithThree,
	createShelfPointerRaycastFocus,
	createShelfPointerRaycastHitGetter,
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
	type RendererHandle,
	type RenderLoop,
	type ConnectorParticles,
	type ShelfManager,
	type ShelfItem,
	type ShelfOpenDetailContentPayload,
	type ShelfPane,
	type ShelfSelectSoundPlayer,
	type StageLyricsLifecycle,
} from "@mineradio/visual-engine";
import {
	attachFreeCameraHost,
	createFreeCameraPoseFromPerspectiveCamera,
	updateAndApplyFreeCamera,
} from "./free-camera-host";
import { attachShelfPointerInteractionWiring } from "./shelf-pointer-interactions";
import type { ShelfDetailRowClickPayload } from "./shelf-pointer-interactions";
import type { ShelfDetailContentListController } from "./shelf-detail-data";
import { createShelfPaneWheelSwitcher } from "./shelf-pane-switch";
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
	isPlayingRef: RefObject<boolean>;
	lyricLinesRef: RefObject<VisualLyricLine[]>;
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
	onShelfPlayQueueIndexRef?: RefObject<((index: number) => void) | undefined>;
	onShelfDetailRowClickRef?: RefObject<((payload: ShelfDetailRowClickPayload) => void) | undefined>;
	onShelfOpenDetailContentRef?: RefObject<((payload: ShelfOpenDetailContentPayload, writer: ShelfDetailContentListController) => void) | undefined>;
	onShelfPaneChangeRef?: RefObject<((pane: ShelfPane) => void) | undefined>;
	lifecycleRef: RefObject<StageLyricsLifecycle | null>;
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
	offShelfFocus: () => void;
	offShelfPointerInteractions: () => void;
	offFreeCamera: () => void;
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
		skullMouthLyrics: Number(fx.preset) === 6,
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
			const homeVisual = await createHomeVisual({
				scene: renderer.scene,
				coverResolution: refs.coverResolution,
				fx: runtimeFx,
			});
			let homeVisualPreviousPreset: number | null = null;
			let homeVisualPreviewActive = false;
			let syncedCoverUrlVersion = refs.coverUrlVersionRef?.current ?? 0;
			homeVisual.setCoverUrl(refs.coverUrlRef?.current ?? "");
			if (cancelled || disposedRef.current) {
				homeVisual.dispose();
				audioEngine.dispose();
				cinema.dispose();
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
				renderer.dispose();
				return;
			}
			const connectorParticles = await createConnectorParticles({
				scene: renderer.scene,
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
				renderer.dispose();
				return;
			}
			const lifecycle = createStageLyricsLifecycle({
				scene: renderer.scene,
				currentTimeSupplier: () => refs.positionRef.current / 1000,
				isPlayingSupplier: () => refs.isPlayingRef.current,
				lyricLinesSupplier: () => refs.lyricLinesRef.current,
				getShelfVisibility: () => shelfManager.getShelfVisibility(),
				getShelfMode: () => refs.shelfModeRef?.current ?? refs.fxDefaults?.shelf ?? "side",
				getShelfHasOpenContent: () => shelfManager.hasOpenContent(),
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
					});
				},
				skullMouthTransformSupplier: () => homeVisual.getSkullMouthTransform(),
				cameraSupplier: () => renderer.camera,
				pixelScale: 1,
				reduceMotion: prefersReducedMotion,
			});
			let syncedShelfItemsVersion = refs.shelfItemsVersionRef.current;
			shelfManager.setData(refs.shelfItemsRef.current);
			void lifecycle.mount(renderer.scene);
			refs.lifecycleRef.current = lifecycle;
			try {
				lifecycle.setLyricLines(refs.lyricLinesRef.current);
			} catch {
			}
			const renderLoop = createRenderLoop({
				renderer: renderer.renderer,
				scene: renderer.scene,
				camera: renderer.camera,
				audio: audioEngine,
				isMainSceneCoveredBySplash: () => refs.splashActiveRef.current,
				getAdaptiveFps: () => 0,
				prefersReducedMotion,
				onCacheTrim: () => {},
			});
			const offHomeAudio = renderLoop.registerStep(RenderStepSlot.Ripples, (ctx) => {
				audioEngine.update(ctx.dt);
			});
			const offHome = renderLoop.registerStep(RenderStepSlot.HomeVisual, (ctx) => {
				mergeFxState(homeVisual.getFx(), refs.fxRef?.current);
				if (refs.coverUrlVersionRef && syncedCoverUrlVersion !== refs.coverUrlVersionRef.current) {
					syncedCoverUrlVersion = refs.coverUrlVersionRef.current;
					homeVisual.setCoverUrl(refs.coverUrlRef?.current ?? "");
				}
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
				const connectorVisible =
					shelfManager.getMode() === "stage" &&
					shelfManager.getShelfVisibility() > 0 &&
					shelfManager.getData().length > 0;
				if (connectorParticles.object) {
					connectorParticles.object.visible = connectorVisible;
				}
				connectorParticles.setIntensity(connectorVisible ? shelfManager.getShelfVisibility() : 0);
				connectorParticles.update(ctx);
			});
			const offLyrics = renderLoop.registerStep(RenderStepSlot.StageLyrics, (ctx) => {
				lifecycle.update(ctx);
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
				getWallpaperSafe: () => refs.wallpaperSafeRef?.current ?? isWallpaperSafeShelfPreset(refs.fxDefaults?.preset),
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
			});
			const offShelfPointerInteractions = attachShelfPointerInteractionWiring({
				target: window,
				cinema,
				shelfManager,
				getHit: getShelfPointerHit,
				getSplashActive: () => refs.splashActiveRef.current,
				getPortrait: () => window.innerHeight > window.innerWidth,
				getWallpaperSafe: () => refs.wallpaperSafeRef?.current ?? isWallpaperSafeShelfPreset(refs.fxDefaults?.preset),
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
				onShelfDetailRowClick: (payload) => refs.onShelfDetailRowClickRef?.current?.(payload),
				onShelfSelectFeedback: (direction, variant) => {
					shelfSelectSound.play(direction, variant);
				},
			});
			const offFreeCamera = attachFreeCameraHost({
				target: window,
				wheelTarget: renderer.renderer.domElement,
				state: freeCamera,
				getCameraPose: () => createFreeCameraPoseFromPerspectiveCamera(renderer.camera),
				getNowMs: () => performance.now(),
				isPointerOverUi: (event) => {
					const el = document.elementFromPoint(event.clientX, event.clientY);
					return !!(el && el.closest?.("#search-area,#top-right,#fullscreen-diy-zone,#fx-panel,#fx-fab,#fx-fab-hide-btn,#playlist-panel,#bottom-bar,#thumb-wrap,#empty-home,#visual-guide,#trial-banner,#source-fallback-notice,.modal-mask,#toast,#ai-depth-chip,#beat-chip,#drop-overlay"));
				},
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
				offShelfFocus,
				offShelfPointerInteractions,
				offFreeCamera,
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
	}, [refs.hostRef, refs.audioElementRef, refs.positionRef, refs.isPlayingRef, refs.lyricLinesRef, refs.shelfItemsRef, refs.shelfItemsVersionRef, refs.splashActiveRef, refs.homeActiveRef, refs.shelfModeRef, refs.shelfCameraModeRef, refs.shelfPresenceRef, refs.shelfMergeCollectionsRef, refs.shelfMineCountRef, refs.shelfFavCountRef, refs.wallpaperSafeRef, refs.secondaryLeftDisplaySeamGuardRef, refs.coverUrlRef, refs.coverUrlVersionRef, refs.onShelfPlayQueueIndexRef, refs.onShelfDetailRowClickRef, refs.onShelfOpenDetailContentRef, refs.onShelfPaneChangeRef, refs.lifecycleRef, refs.coverResolution, refs.onShelfModeChange]);
}

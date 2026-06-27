import { useEffect, useRef, type RefObject } from "react";
import {
	createAudioReactivity,
	createCinemaCamera,
	createConnectorParticles,
	createHomeVisual,
	createRenderLoop,
	createRenderer,
	createShelfManagerWithThree,
	createShelfPointerRaycastFocus,
	createShelfPointerRaycastHitGetter,
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
	type StageLyricsLifecycle,
} from "@mineradio/visual-engine";
import { attachShelfPointerInteractionWiring } from "./shelf-pointer-interactions";
import {
	attachShelfFocusZonePointerWiring,
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
	shelfCameraModeRef?: RefObject<string>;
	shelfPresenceRef?: RefObject<string>;
	wallpaperSafeRef?: RefObject<boolean>;
	onShelfPlayQueueIndexRef?: RefObject<((index: number) => void) | undefined>;
	lifecycleRef: RefObject<StageLyricsLifecycle | null>;
	coverResolution: number;
	fxDefaults?: Partial<FxState>;
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
	audioContext: AudioContext | null;
	offHome: () => void;
	offCamera: () => void;
	offShelf: () => void;
	offLyrics: () => void;
	offAudio: () => void;
	offHomeAudio: () => void;
	offShelfFocus: () => void;
	offShelfPointerInteractions: () => void;
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
			const homeVisual = await createHomeVisual({
				scene: renderer.scene,
				coverResolution: refs.coverResolution,
				fx: refs.fxDefaults as FxState | undefined,
			});
			if (cancelled || disposedRef.current) {
				homeVisual.dispose();
				audioEngine.dispose();
				cinema.dispose();
				renderer.dispose();
				return;
			}
			const shelfManager = await createShelfManagerWithThree({
				scene: renderer.scene,
				document,
			});
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
				pixelScale: 1,
				reduceMotion: prefersReducedMotion,
			});
			let syncedShelfItemsVersion = refs.shelfItemsVersionRef.current;
			shelfManager.setData(refs.shelfItemsRef.current);
			shelfManager.setShelfVisibility(0);
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
				homeVisual.update(ctx);
			});
			const offCamera = renderLoop.registerStep(RenderStepSlot.CameraCinematic, (ctx) => {
				cinema.update(ctx);
			});
			const shelfStep = createShelfStep(shelfManager);
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
					return isQueueFocusActive(pointer, panel);
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
				onShelfPlayQueueIndex: (index) => refs.onShelfPlayQueueIndexRef?.current?.(index),
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
				audioContext: null,
				offHome,
				offCamera,
				offShelf,
				offLyrics,
				offAudio,
				offHomeAudio,
				offShelfFocus,
				offShelfPointerInteractions,
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
	}, [refs.hostRef, refs.audioElementRef, refs.positionRef, refs.isPlayingRef, refs.lyricLinesRef, refs.shelfItemsRef, refs.shelfItemsVersionRef, refs.splashActiveRef, refs.shelfCameraModeRef, refs.shelfPresenceRef, refs.wallpaperSafeRef, refs.onShelfPlayQueueIndexRef, refs.lifecycleRef, refs.coverResolution]);
}

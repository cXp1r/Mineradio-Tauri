export type VisualEngineSnapshot = {
	preset: string;
	playing: boolean;
};

export type VisualEngine = {
	update(snapshot: VisualEngineSnapshot): void;
	resize(size: { width: number; height: number }): void;
	dispose(): void;
};

export function createVisualEngine(): VisualEngine {
	return {
		update() {},
		resize() {},
		dispose() {},
	};
}

export { createSplashEngine } from "./splash/splash-engine";
export type { SplashEngine, SplashEngineOptions } from "./splash/splash-engine";
export { createSplashWebgl, SPLASH_VERTEX_SHADER, SPLASH_FRAGMENT_SHADER } from "./splash/splash-webgl";
export { createSplashCanvas } from "./splash/splash-canvas";
export { SPLASH_CSS, injectSplashStyle } from "./splash/splash-style";
export { createIntroSoundPlayer } from "./splash/intro-sound";
export type {
	IntroSoundPlayer,
	IntroSoundPlayerOptions,
	WindowLike as IntroSoundWindowLike,
	DocumentLike as IntroSoundDocumentLike,
} from "./splash/intro-sound";

export { CONTROL_GLASS_CSS, injectControlGlassStyle } from "./control/control-glass-style";
export {
	generateControlGlassDisplacementMap,
	createControlGlassSvg,
	supportsControlGlassSvgFilter,
	CONTROL_GLASS_FILTER_MARKUP,
	CONTROL_GLASS_SVG_ID,
} from "./control/control-glass-svg";
export { attachControlGlassNode } from "./control/control-glass-node";
export type { ControlGlassNodeOptions } from "./control/control-glass-node";
export {
	createControlConsoleMotion,
} from "./control/control-console-motion";
export type {
	GsapLike,
	GsapTweenLike,
	GsapTimelineLike,
	GsapProvider,
	ButtonKind,
	ConsoleMotionRoot,
	ConsoleMotionDeps,
	ControlConsoleMotion,
	ListAnimateOptions,
	CreateControlConsoleMotionOptions,
} from "./control/control-console-motion";

export { createAudioReactivity } from "./audio/audio-reactivity";
export type {
	AudioSnapshot,
	AudioFrameBytes,
	AudioFrameSource,
	BeatHandler,
	AudioReactivityOptions,
	AudioReactivityEngine,
} from "./audio/audio-snapshot";
export { createPeakFollower } from "./audio/peak-followers";
export type { PeakFollower, PeakFollowerParams } from "./audio/peak-followers";
export {
	analyzeMainFrame,
	analyzeBeatFrame,
	beatBandRms,
	DEFAULT_BIN_RANGES,
	DEFAULT_BEAT_BAND_HZ,
} from "./audio/frequency-bands";
export type {
	MainBinRanges,
	MainBandAverages,
	BeatBandHz,
	BeatBandSamples,
} from "./audio/frequency-bands";
export {
	createBeatEngine,
	DEFAULT_BEAT_ENGINE_OPTS,
} from "./audio/beat-engine";
export type {
	BeatSamples,
	BeatEngineFrame,
	BeatEngineOpts,
	BeatEngine,
	BeatOnsetCallback,
	RtStateView,
} from "./audio/beat-engine";

export { createRenderer } from "./runtime/renderer-setup";
export type { RendererHandle, RendererSetupOptions, ThreeModule, ThreeFactory } from "./runtime/renderer-setup";
export { createRenderLoop } from "./runtime/render-loop";
export type { RenderLoop, RenderLoopOptions } from "./runtime/render-loop";
export { createCinemaCamera } from "./runtime/cinema-camera";
export type {
	CinemaCamera,
	CinemaCameraOptions,
	CinemaProfile,
	CinemaState,
	CinemaTrackProfile,
	BeatCamState,
	BeatCameraEvent,
	OrbitState,
	FocusTimers,
	SetFocusZoneOptions,
} from "./runtime/cinema-camera";
export {
	FOCUS_ZONE_ACTIVATE_DELAY_MS,
	FOCUS_ZONE_EXIT_DELAY_MS,
	FOCUS_ZONE_QUEUE_EXIT_DELAY_MS,
	focusTargetForZone,
} from "./runtime/focus-zone";
export type {
	FocusZoneOptions,
	FocusZoneTarget,
	FocusZoneType,
} from "./runtime/focus-zone";
export { createRuntimeUniforms } from "./runtime/uniforms";
export type { RuntimeUniforms, UniformValue } from "./runtime/uniforms";
export { RenderStepSlot, RENDER_STEP_ORDER } from "./runtime/render-step-slot";
export type { RenderStepSlot as RenderStepSlotName } from "./runtime/render-step-slot";
export { createPerfState } from "./runtime/perf-state";
export type { PerfState, PerfStateSnapshot, RenderPerfMode } from "./runtime/perf-state";
export type { FrameContext } from "./runtime/frame-context";

export { FX_DEFAULTS, cloneFxState } from "./home-visual/fx-defaults";
export type { FxState } from "./home-visual/fx-defaults";
export { applyPreset, clampPreset, PRESET_COUNT, SKULL_PRESET_INDEX } from "./home-visual/preset-state";
export type { PresetOpts } from "./home-visual/preset-state";
export { syncFxUniforms, lerp } from "./home-visual/sync-uniforms";
export type { SyncUniformsOpts, UniformContainer, UniformSlot } from "./home-visual/sync-uniforms";
export {
	createHomeParticleField,
	coverParticleGridForResolution,
	normalizeCoverResolution,
} from "./home-visual/home-particle-field";
export type { HomeParticleField, HomeParticleFieldOptions } from "./home-visual/home-particle-field";
export { createHomeCoverTextureController } from "./home-visual/cover-texture";
export type {
	HomeCoverImage,
	HomeCoverCanvasFactory,
	HomeCoverLoader,
	HomeCoverTextureController,
	HomeCoverTextureControllerOptions,
	HomeCoverTextureUniforms,
} from "./home-visual/cover-texture";
export {
	buildEdgeAndDepthCanvas,
	createCoverDepthTween,
	visualEase,
} from "./home-visual/cover-depth";
export type {
	CoverDepthCanvas,
	CoverDepthCanvasFactory,
	CoverDepthTween,
	CoverDepthUniforms,
} from "./home-visual/cover-depth";
export {
	createHomeRipples,
	RIPPLE_MAX,
	RIPPLE_PLANE_SIZE,
} from "./home-visual/ripples";
export type {
	HomeRippleUniforms,
	HomeRipples,
	HomeRipplesOptions,
} from "./home-visual/ripples";
export {
	HOME_VISUAL_VERTEX_SHADER,
	HOME_VISUAL_FRAGMENT_SHADER,
	HOME_VISUAL_BLOOM_FRAGMENT_SHADER,
	buildHomeVisualBloomVertexShader,
} from "./home-visual/home-visual-shaders";
export { createHomeVisual } from "./home-visual/home-visual";
export type { HomeVisual, HomeVisualOptions } from "./home-visual/home-visual";

export { createLyricParticles, LYRIC_PARTICLE_COUNT } from "./particles/lyric-particles";
export type { LyricParticles, LyricParticlesOptions } from "./particles/lyric-particles";
export { createConnectorParticles, CONNECTOR_PARTICLE_COUNT } from "./particles/connector-particles";
export type { ConnectorParticles, ConnectorParticlesOptions } from "./particles/connector-particles";

export {
	DEFAULT_LYRIC_PALETTE,
	resolveLyricPalette,
} from "./stage-lyrics/palette";
export type { LyricPalette } from "./stage-lyrics/palette";
export {
	cssColorToThreeColor,
	lyricThreeColor,
} from "./stage-lyrics/color-utils";
export type { RGB } from "./stage-lyrics/color-utils";
export {
	STAGE_LYRIC_MAX_LINES,
	LYRIC_MASK_W,
	LYRIC_MASK_H,
	makeLyricMask,
} from "./stage-lyrics/lyric-mask";
export type { LyricMaskResult, MakeLyricMaskOptions } from "./stage-lyrics/lyric-mask";
export {
	getLyricSunBloomTexture,
	resetLyricSunBloomCache,
} from "./stage-lyrics/lyric-sun-bloom";
export { makeLyricGlowTexture } from "./stage-lyrics/lyric-glow";
export type { LyricGlowTextureOptions } from "./stage-lyrics/lyric-glow";
export { makeLyricReadabilityTexture } from "./stage-lyrics/lyric-readability";
export type { LyricReadabilityTextureOptions } from "./stage-lyrics/lyric-readability";
export {
	makeLyricShaderMaterial,
	LYRIC_FRAGMENT_SHADER,
	LYRIC_VERTEX_SHADER,
} from "./stage-lyrics/lyric-shader-material";
export type { LyricShaderMaterialOptions, LyricShaderMaterialResult } from "./stage-lyrics/lyric-shader-material";
export { makeDotTexture as makeLyricDotTexture } from "./stage-lyrics/lyric-dot-texture";
export {
	buildLyricGroup,
	updateLyricGroupProgress,
	disposeLyricGroup,
} from "./stage-lyrics/lyric-builder";
export type { LyricGroup, LyricGroupOptions } from "./stage-lyrics/lyric-builder";

export {
	getLyricLineProgress,
} from "./stage-lyrics/lyric-line-progress";
export type { LyricLine, LyricWord } from "./stage-lyrics/lyric-line-progress";

export {
	createStageLyricsLifecycle,
} from "./stage-lyrics/lifecycle";
export type {
	StageLyricsLifecycle,
	StageLyricsLifecycleOpts,
} from "./stage-lyrics/lifecycle";

export {
	LYRIC_TRANSITION_DURATIONS,
	LYR_IN_EASE_NAME,
	LYR_OUT_EASE_NAME,
	LYR_IN_EASE_FALLBACK,
	LYR_OUT_EASE_FALLBACK,
	LYR_BOB_EASE,
	LYR_IN_BEZIER_PATH,
	LYR_OUT_BEZIER_PATH,
	defaultTransitionEasings,
	createTransitionEasings,
	playStageLineInTimeline,
	playStageLineBobTimeline,
	playStageLineOutTimeline,
} from "./stage-lyrics/transitions";
export type {
	LyricTransitionEasings,
	LyricTransitionOpts,
	CustomEaseCreator,
} from "./stage-lyrics/transitions";

export { LyricPaletteRuntime } from "./stage-lyrics/palette-runtime";
export { createLyricPaletteDriver } from "./stage-lyrics/palette-driver";
export type { PaletteDriver } from "./stage-lyrics/palette-driver";

export { SHELF_SETTINGS } from "./shelf/shelf-settings";
export type { ShelfSettings } from "./shelf/shelf-settings";
export {
	getDefaultShelfLayoutProfile,
} from "./shelf/shelf-layout-profile";
export type {
	SideProfile,
	StageProfile,
	DetailProfile,
	ShelfLayoutProfile,
	ShelfLayoutProfileOverrides,
} from "./shelf/shelf-layout-profile";
export {
	createShelfState,
} from "./shelf/shelf-state";
export type {
	ShelfMode,
	ShelfPresence,
	ShelfPane,
	ShelfState,
} from "./shelf/shelf-state";
export {
	SHELF_VISIBLE_RADIUS,
	SHELF_MAX_RENDER,
	computeCardLayout,
} from "./shelf/card-position";
export type {
	CardLayoutInput,
	CardLayoutOutput,
	CardLayoutMode,
} from "./shelf/card-position";
export { computeBreathPulse } from "./shelf/breath";
export {
	computeRevealRaw,
	computePaneRaw,
	smoothstep01,
} from "./shelf/reveal";
export { updateHoverFloatMix } from "./shelf/hover-float";
export {
	CONTENT_VISIBLE_RADIUS,
	CONTENT_MAX_RENDER,
	SHELF_CONTENT_PANEL_SCREEN_HEIGHT,
	SHELF_CONTENT_PANEL_SCREEN_PAD,
	SHELF_CONTENT_PANEL_SCREEN_WIDTH,
	SHELF_CONTENT_ROW_SCREEN_HEIGHT,
	SHELF_CONTENT_ROW_SCREEN_PAD_X,
	SHELF_CONTENT_ROW_SCREEN_PAD_Y,
	SHELF_CONTENT_ROW_SCREEN_WIDTH,
	computeContentPanelOpacity,
	computeContentRowLayout,
	createShelfContentList,
	isShelfContentLoadingRow,
	pickShelfContentRowAtScreen,
	screenContainsShelfContentPanel,
} from "./shelf/shelf-content-list";
export type {
	ComputeContentRowLayoutInput,
	PickShelfContentRowAtScreenOptions,
	ScreenContainsShelfContentPanelOptions,
	ShelfContentKind,
	ShelfContentList,
	ShelfContentListOptions,
	ShelfContentOpenOptions,
	ShelfContentPanelOpacityInputs,
	ShelfContentPlaceholderKind,
	ShelfContentRenderWindow,
	ShelfContentRow,
	ShelfContentRowLayout,
	ShelfContentRowLayoutInputs,
	ShelfContentScreenBounds,
	ShelfContentScreenPanel,
	ShelfContentScreenPoint,
	ShelfContentScreenRow,
	ShelfContentScreenRowPick,
	ShelfContentScreenTargets,
	ShelfContentSnapshot,
	ShelfContentSourceCard,
} from "./shelf/shelf-content-list";
export { createShelfManager, createShelfManagerWithThree } from "./shelf/shelf-animate";
export type {
	ShelfItem,
	ShelfManagerOptions,
	ShelfOpenDetailContentPayload,
	ShelfSnapshot,
	ShelfRaycastCardHit,
	ShelfManager,
} from "./shelf/shelf-animate";
export { createShelfPointerRaycastFocus, createShelfPointerRaycastHitGetter } from "./shelf/shelf-raycast-focus";
export type {
	ShelfPointerRaycastFocusGetter,
	ShelfPointerRaycastHitGetter,
	ShelfPointerRaycastFocusOptions,
	ShelfPointerRaycastHitOptions,
	ShelfPointerRaycastInfo,
} from "./shelf/shelf-raycast-focus";
export {
	activateShelfPrimaryHit,
	getShelfCardAction,
} from "./shelf/shelf-activation";
export type {
	ShelfPrimaryActivationOptions,
	ShelfPrimaryActivationResult,
	ShelfPrimaryHit,
} from "./shelf/shelf-activation";
export { createShelfStep, SHELF_RENDER_STEP_SLOT } from "./shelf/shelf-step";
export type { ShelfStepOptions } from "./shelf/shelf-step";
export {
	SHELF_CARD_CANVAS_WIDTH,
	SHELF_CARD_CANVAS_HEIGHT,
	SHELF_CARD_GEOMETRY_WIDTH,
	SHELF_CARD_GEOMETRY_HEIGHT,
	createShelfCardMesh,
	drawShelfCard,
	makeShelfCardAction,
} from "./shelf/shelf-card-sprite";
export type {
	ShelfCardAction,
	ShelfCardDrawState,
	ShelfCardSprite,
	CreateShelfCardMeshOptions,
} from "./shelf/shelf-card-sprite";

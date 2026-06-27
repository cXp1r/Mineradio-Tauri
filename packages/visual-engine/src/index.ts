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
} from "./runtime/cinema-camera";
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
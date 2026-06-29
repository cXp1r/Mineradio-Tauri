import type * as THREE from "three";
import type { FrameContext } from "../runtime/frame-context";
import type { ThreeFactory } from "../runtime/renderer-setup";
import type { FxState } from "./fx-defaults";
import { cloneFxState } from "./fx-defaults";
import { applyPreset, SKULL_PRESET_INDEX, type PresetOpts } from "./preset-state";
import { syncFxUniforms, type UniformContainer } from "./sync-uniforms";
import {
	createHomeParticleField,
	type HomeParticleField,
	type HomeParticleFieldOptions,
} from "./home-particle-field";
import {
	createHomeCoverTextureController,
	type HomeAiDepthEstimator,
	type HomeAiDepthMerger,
	type HomeCoverCanvasFactory,
	type HomeCoverImage,
	type HomeCoverLoader,
	type HomeCoverTextureController,
} from "./cover-texture";
import { createHomeRipples, type HomeRipples } from "./ripples";
import { deriveLyricPaletteFromCover, type CoverCanvasLike } from "./cover-colors";
import type { LyricPalette } from "../stage-lyrics/palette";
import type { SkullMouthTransform } from "../stage-lyrics/lifecycle";
import { createBackCoverLayer, type BackCoverLayer } from "./back-cover-layer";
import { createSkullParticleController, type SkullParticleController } from "./skull-particles";

export interface HomeVisualOptions {
	scene: THREE.Scene;
	threeFactory?: ThreeFactory;
	coverResolution?: number;
	fx?: FxState;
	loadCoverImage?: HomeCoverLoader;
	createCoverCanvas?: HomeCoverCanvasFactory;
	buildCoverEdgeDepth?: (image: HomeCoverImage) => HomeCoverImage | null;
	estimateAiDepth?: HomeAiDepthEstimator;
	mergeAiDepth?: HomeAiDepthMerger;
	onCoverLyricPalette?: (palette: LyricPalette) => void;
	backCoverRandom?: () => number;
	skullAssetData?: Float32Array | null;
	loadSkullAsset?: () => Promise<Float32Array | null>;
}

export interface HomeVisual {
	update(ctx: FrameContext): void;
	dispose(): void;
	getPreset(): number;
	setPreset(p: number, opts?: PresetOpts): void;
	getFx(): FxState;
	getField(): HomeParticleField;
	setCoverUrl(url: string | null | undefined): void;
	getCoverController(): HomeCoverTextureController;
	getRipples(): HomeRipples;
	getSkullParticles(): THREE.Points | null;
	getSkullMouthTransform(): SkullMouthTransform | null;
	getSkullBeatFlash(): number;
	setSkullShelfCompositionActive(active: boolean): void;
	whenIdle(): Promise<void>;
}

let skullAssetCache: Float32Array | null | undefined;

async function defaultLoadSkullAssetData(): Promise<Float32Array | null> {
	if (skullAssetCache !== undefined) return skullAssetCache;
	if (
		typeof window === "undefined" ||
		typeof fetch !== "function" ||
		!window.location ||
		window.location.href.startsWith("about:")
	) {
		skullAssetCache = null;
		return skullAssetCache;
	}
	try {
		const url = new URL("assets/skull-decimation-points.bin?v=regular-surface-teeth-soften-20260621", window.location.href);
		const res = await fetch(url, { cache: "reload" });
		if (!res.ok) throw new Error("skull asset unavailable");
		const buf = await res.arrayBuffer();
		skullAssetCache = buf.byteLength >= 20 && buf.byteLength % 20 === 0 ? new Float32Array(buf) : null;
		return skullAssetCache;
	} catch {
		skullAssetCache = null;
		return skullAssetCache;
	}
}

export async function createHomeVisual(opts: HomeVisualOptions): Promise<HomeVisual> {
	const fx: FxState = opts.fx ?? cloneFxState();
	const fieldOpts: HomeParticleFieldOptions = {
		threeFactory: opts.threeFactory,
		coverResolution: opts.coverResolution ?? fx.coverResolution,
	};
	const field = await createHomeParticleField(opts.scene, fieldOpts);
	const skullAssetData = opts.skullAssetData !== undefined
		? opts.skullAssetData
		: await (opts.loadSkullAsset ?? defaultLoadSkullAssetData)();
	const skullParticles: SkullParticleController = await createSkullParticleController({
		scene: opts.scene,
		threeFactory: opts.threeFactory,
		uniforms: field.materialUniforms,
		assetData: skullAssetData,
	});
	const coverController = createHomeCoverTextureController({
		uniforms: field.materialUniforms as never,
		loadImage: opts.loadCoverImage,
		coverResolution: fieldOpts.coverResolution,
		createCanvas: opts.createCoverCanvas,
		buildEdgeDepth: opts.buildCoverEdgeDepth,
		aiDepthEnabled: fx.aiDepth,
		estimateAiDepth: opts.estimateAiDepth,
		mergeAiDepth: opts.mergeAiDepth,
		onCoverPrepared(image) {
			latestPreparedCover = image;
			backCoverLayer?.refreshColorsFromCover(image as CoverCanvasLike);
			if (!opts.onCoverLyricPalette) return;
			const palette = deriveLyricPaletteFromCover(image as CoverCanvasLike);
			if (!palette) return;
			opts.onCoverLyricPalette({
				primary: palette.primary,
				secondary: palette.secondary,
				highlight: palette.highlight,
				glowColor: palette.glow,
			});
		},
	});
	const ripples = createHomeRipples(field.materialUniforms as never);
	let backCoverLayer: BackCoverLayer | null = null;
	let backCoverPending: Promise<void> | null = null;
	let latestPreparedCover: HomeCoverImage | null = null;
	field.applyFxState(fx);
	field.bloomPoints.visible = !!(fx.bloom && fx.bloomStrength > 0.01) && fx.preset !== SKULL_PRESET_INDEX;
	field.points.visible = fx.preset !== SKULL_PRESET_INDEX;

	function syncBackCoverLayer(): void {
		if (fx.backCover) {
			if (!backCoverLayer && !backCoverPending) {
				backCoverPending = createBackCoverLayer({
					scene: opts.scene,
					threeFactory: opts.threeFactory,
					uniforms: field.materialUniforms as never,
					random: opts.backCoverRandom,
				}).then((layer) => {
					backCoverLayer = layer;
					backCoverPending = null;
					if (latestPreparedCover) layer.refreshColorsFromCover(latestPreparedCover as CoverCanvasLike);
					if (!fx.backCover) {
						layer.dispose();
						if (backCoverLayer === layer) backCoverLayer = null;
					}
				});
			}
			return;
		}
		if (backCoverLayer) {
			backCoverLayer.dispose();
			backCoverLayer = null;
		}
	}

	function stepBody(ctx: FrameContext): void {
		field.applyFxState(fx);
		coverController.setAiDepthEnabled(fx.aiDepth);
		field.points.visible = fx.preset !== SKULL_PRESET_INDEX;
		const bloomAllowed = !!(fx.bloom && fx.bloomStrength > 0.01) && fx.preset !== SKULL_PRESET_INDEX;
		field.bloomPoints.visible = bloomAllowed;
		syncBackCoverLayer();

		syncFxUniforms(fx, ctx.snapshot, ctx.uniforms as unknown as UniformContainer, { dt: ctx.dt });
		syncFxUniforms(fx, ctx.snapshot, field.materialUniforms as unknown as UniformContainer, { dt: ctx.dt });

		const tU = field.materialUniforms.uTime as { value: unknown } | undefined;
		if (tU && typeof ctx.uniforms.uTime.value === "number") tU.value = ctx.uniforms.uTime.value;
		ripples.update(ctx.dt);
		const alphaUniform = field.materialUniforms.uAlpha as { value: unknown } | undefined;
		if (alphaUniform && typeof alphaUniform.value === "number") {
			const target = 0.96;
			const dt = Number.isFinite(ctx.dt) ? Math.max(0, ctx.dt) : 0;
			const ease = Math.min(1, dt * 4.8);
			alphaUniform.value += (target - alphaUniform.value) * ease;
		}
		coverController.advanceColorMix(ctx.dt);
		coverController.advanceDepth(ctx.dt);
		skullParticles.update(ctx, fx);
	}

	return {
		update: stepBody,
		dispose() {
			backCoverLayer?.dispose();
			skullParticles.dispose();
			field.dispose();
		},
		getPreset() {
			return fx.preset;
		},
		setPreset(p, setOpts) {
			const next = applyPreset(fx, p, setOpts);
			fx.preset = next.preset;
			field.applyFxState(fx);
			field.points.visible = fx.preset !== SKULL_PRESET_INDEX;
			field.bloomPoints.visible = !!(fx.bloom && fx.bloomStrength > 0.01) && fx.preset !== SKULL_PRESET_INDEX;
		},
		getFx() {
			return fx;
		},
		getField() {
			return field;
		},
		setCoverUrl(url) {
			coverController.setCoverUrl(url);
		},
		getCoverController() {
			return coverController;
		},
		getRipples() {
			return ripples;
		},
		getSkullParticles() {
			return skullParticles.getObject();
		},
		getSkullMouthTransform() {
			return skullParticles.getMouthTransform();
		},
		getSkullBeatFlash() {
			return skullParticles.getBeatFlash();
		},
		setSkullShelfCompositionActive(active) {
			skullParticles.setShelfCompositionActive(active);
		},
		whenIdle() {
			return backCoverPending ?? Promise.resolve();
		},
	};
}

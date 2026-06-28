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
	type HomeCoverCanvasFactory,
	type HomeCoverImage,
	type HomeCoverLoader,
	type HomeCoverTextureController,
} from "./cover-texture";
import { createHomeRipples, type HomeRipples } from "./ripples";

export interface HomeVisualOptions {
	scene: THREE.Scene;
	threeFactory?: ThreeFactory;
	coverResolution?: number;
	fx?: FxState;
	loadCoverImage?: HomeCoverLoader;
	createCoverCanvas?: HomeCoverCanvasFactory;
	buildCoverEdgeDepth?: (image: HomeCoverImage) => HomeCoverImage | null;
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
}

export async function createHomeVisual(opts: HomeVisualOptions): Promise<HomeVisual> {
	const fx: FxState = opts.fx ?? cloneFxState();
	const fieldOpts: HomeParticleFieldOptions = {
		threeFactory: opts.threeFactory,
		coverResolution: opts.coverResolution ?? fx.coverResolution,
	};
	const field = await createHomeParticleField(opts.scene, fieldOpts);
	const coverController = createHomeCoverTextureController({
		uniforms: field.materialUniforms as never,
		loadImage: opts.loadCoverImage,
		coverResolution: fieldOpts.coverResolution,
		createCanvas: opts.createCoverCanvas,
		buildEdgeDepth: opts.buildCoverEdgeDepth,
	});
	const ripples = createHomeRipples(field.materialUniforms as never);
	field.applyFxState(fx);
	field.bloomPoints.visible = !!(fx.bloom && fx.bloomStrength > 0.01) && fx.preset !== SKULL_PRESET_INDEX;
	field.points.visible = fx.preset !== SKULL_PRESET_INDEX;

	function stepBody(ctx: FrameContext): void {
		field.applyFxState(fx);
		field.points.visible = fx.preset !== SKULL_PRESET_INDEX;
		const bloomAllowed = !!(fx.bloom && fx.bloomStrength > 0.01) && fx.preset !== SKULL_PRESET_INDEX;
		field.bloomPoints.visible = bloomAllowed;

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
	}

	return {
		update: stepBody,
		dispose() {
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
	};
}

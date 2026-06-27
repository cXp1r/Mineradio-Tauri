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

export interface HomeVisualOptions {
	scene: THREE.Scene;
	threeFactory?: ThreeFactory;
	coverResolution?: number;
	fx?: FxState;
}

export interface HomeVisual {
	update(ctx: FrameContext): void;
	dispose(): void;
	getPreset(): number;
	setPreset(p: number, opts?: PresetOpts): void;
	getFx(): FxState;
	getField(): HomeParticleField;
}

export async function createHomeVisual(opts: HomeVisualOptions): Promise<HomeVisual> {
	const fx: FxState = opts.fx ?? cloneFxState();
	const fieldOpts: HomeParticleFieldOptions = {
		threeFactory: opts.threeFactory,
		coverResolution: opts.coverResolution ?? fx.coverResolution,
	};
	const field = await createHomeParticleField(opts.scene, fieldOpts);
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
	};
}
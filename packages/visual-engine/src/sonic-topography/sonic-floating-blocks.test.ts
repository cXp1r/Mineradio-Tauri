import { expect, test } from "bun:test";
import { Matrix4, NormalBlending, Quaternion, Vector3 } from "three";
import { createVisualResourceScope } from "../runtime/resource-scope";
import type { SonicAudioSnapshot } from "./sonic-audio-profile";
import {
	createSonicFloatingBlocksLayer,
	SONIC_FLOATING_CAP,
} from "./sonic-floating-blocks";
import { resolveSonicPalette } from "./sonic-palette";
import { createSonicTerrainMaterial } from "./sonic-shaders";
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";

const SILENT_AUDIO: SonicAudioSnapshot = Object.freeze({
	spectrum: null,
	bands: Object.freeze({ subBass: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, presence: 0, brilliance: 0, air: 0 }),
	kickSub: 0,
	kickCore: 0,
	kickPunch: 0,
	body: 0,
	vocal: 0,
	snap: 0,
	lowDrive: 0,
	dominance: 0,
	energy: 0,
	warmth: 0,
	brightness: 0,
	sharpness: 0,
	smoothness: 0,
	density: 0,
	onset: 0,
	flux: 0,
	confidence: 0,
	triggerPulse: 0,
	kickEnvelope: 0,
});

function readTransform(layer: ReturnType<typeof createSonicFloatingBlocksLayer>, index: number) {
	const matrix = new Matrix4();
	const position = new Vector3();
	const rotation = new Quaternion();
	const scale = new Vector3();
	layer.mesh.getMatrixAt(index, matrix);
	matrix.decompose(position, rotation, scale);
	return { position, scale };
}

test("floating blocks use the dedicated normal-blended terrain lighting material", () => {
	const resources = createVisualResourceScope("sonic-floating-material");
	const settings = SONIC_TOPOGRAPHY_DEFAULTS;
	const palette = resolveSonicPalette(settings.colors);
	const layer = createSonicFloatingBlocksLayer({
		owner: "floating-material",
		resources,
		settings,
		palette,
		random: () => 0.5,
	});
	const terrainMaterial = createSonicTerrainMaterial(palette);

	expect(layer.material.blending).toBe(NormalBlending);
	expect(layer.material.depthWrite).toBe(false);
	expect(layer.material.fragmentShader).toBe(terrainMaterial.fragmentShader);

	terrainMaterial.dispose();
	resources.dispose();
});

test("floating settings synchronize the complete terrain palette and EQ contract", () => {
	const resources = createVisualResourceScope("sonic-floating-settings");
	const settings = {
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: {
			...SONIC_TOPOGRAPHY_DEFAULTS.terrain,
			amplitude: 100,
			motionSpeed: 100,
		},
		eq: {
			subBass: 11,
			bass: 22,
			lowMid: 33,
			mid: 44,
			highMid: 55,
			presence: 66,
			brilliance: 77,
			air: 88,
		},
		colors: {
			mode: "custom" as const,
			base: "#102030",
			cool: "#204080",
			warm: "#a04020",
			accent: "#30c0d0",
			glow: 100,
		},
	};
	const palette = resolveSonicPalette(settings.colors);
	const layer = createSonicFloatingBlocksLayer({
		owner: "floating-settings",
		resources,
		settings: SONIC_TOPOGRAPHY_DEFAULTS,
		palette: resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors),
		random: () => 0.5,
	});

	layer.applySettings(settings, palette);
	const uniforms = layer.material.uniforms;

	expect(uniforms.uAmplitude.value).toBe(15);
	expect(uniforms.uMotionSpeed.value).toBeCloseTo(2.15, 8);
	expect(Array.from(uniforms.uEq.value)).toEqual([11, 22, 33, 44, 55, 66, 77, 88]);
	expect(uniforms.uBaseColor1.value.equals(palette.base)).toBe(true);
	expect(uniforms.uBaseColor2.value.equals(palette.base2)).toBe(true);
	expect(uniforms.uFogColor.value.equals(palette.base)).toBe(true);
	expect(uniforms.uCoolCore.value.equals(palette.cool)).toBe(true);
	expect(uniforms.uCoolEdge.value.equals(palette.cool.clone().lerp(palette.base, 0.34))).toBe(true);
	expect(uniforms.uWarmCore.value.equals(palette.warm)).toBe(true);
	expect(uniforms.uWarmEdge.value.equals(palette.warm.clone().lerp(palette.base, 0.26))).toBe(true);
	expect(uniforms.uRippleColor.value.equals(palette.accent)).toBe(true);
	expect(uniforms.uGlowIntensity.value).toBeCloseTo(1.95, 8);

	resources.dispose();
});

test("floating blocks keep the upstream spiral layout and never exceed the fixed pool", () => {
	const resources = createVisualResourceScope("sonic-floating-layout");
	const settings = {
		...SONIC_TOPOGRAPHY_DEFAULTS,
		floating: {
			...SONIC_TOPOGRAPHY_DEFAULTS.floating,
			count: 140,
		},
	};
	const layer = createSonicFloatingBlocksLayer({
		owner: "floating-layout",
		resources,
		settings,
		palette: resolveSonicPalette(settings.colors),
		random: () => 0.5,
	});

	expect(layer.instanceCount).toBe(SONIC_FLOATING_CAP);
	expect(layer.fillRange(0, SONIC_FLOATING_CAP)).toBe(SONIC_FLOATING_CAP);
	layer.finalize();
	layer.update(0, SILENT_AUDIO);

	const first = readTransform(layer, 0);
	expect(first.position.x).toBeCloseTo(14, 5);
	expect(first.position.y).toBeCloseTo(6, 5);
	expect(first.position.z).toBeCloseTo(0, 5);
	expect(layer.mesh.count).toBe(SONIC_FLOATING_CAP);

	resources.dispose();
});

test("EQ-adjusted high frequencies feed fragment twinkle and flash without fabricating a kick pulse", () => {
	const resources = createVisualResourceScope("sonic-floating-flash");
	const settings = {
		...SONIC_TOPOGRAPHY_DEFAULTS,
		floating: {
			...SONIC_TOPOGRAPHY_DEFAULTS.floating,
			count: 1,
		},
	};
	const palette = resolveSonicPalette(settings.colors);
	const layer = createSonicFloatingBlocksLayer({
		owner: "floating-flash",
		resources,
		settings,
		palette,
		random: () => 0,
	});
	layer.fillRange(0, 1);
	layer.finalize();
	layer.applySettings(settings, palette);
	const eqBands = new Float32Array([0.2, 0.2, 0.1, 0.1, 0.3, 0.8, 0.9, 1]);
	const audio = Object.freeze({
		...SILENT_AUDIO,
		energy: 0.7,
		sharpness: 0.85,
		smoothness: 0.25,
		density: 0.6,
	});

	layer.update(1 / 60, audio, eqBands);
	const uniforms = layer.material.uniforms;

	expect(Array.from(uniforms.uBands.value)).toEqual(Array.from(eqBands));
	expect(uniforms.uBands.value[5]).toBeCloseTo(0.8, 6);
	expect(uniforms.uBands.value[6]).toBeCloseTo(0.9, 6);
	expect(uniforms.uBands.value[7]).toBe(1);
	expect(uniforms.uTime.value).toBeCloseTo(1 / 60, 8);
	expect(uniforms.uKickEnvelope.value).toBe(0);
	expect(uniforms.uEnergy.value).toBe(0.7);
	expect(uniforms.uWarmth.value).toBeCloseTo(0.6 / 3.3, 6);
	expect(uniforms.uBrightness.value).toBeCloseTo(2.7 / 3.3, 6);
	expect(uniforms.uSharpness.value).toBe(0.85);
	expect(uniforms.uSmoothness.value).toBe(0.25);
	expect(uniforms.uDensity.value).toBe(0.6);
	expect(uniforms.uPulse.value).toBe(0);
	resources.dispose();
});

test("floating blocks follow the dedicated kick envelope instead of sustained raw bass", () => {
	const resources = createVisualResourceScope("sonic-floating-envelope");
	const settings = {
		...SONIC_TOPOGRAPHY_DEFAULTS,
		floating: { ...SONIC_TOPOGRAPHY_DEFAULTS.floating, count: 1 },
	};
	const palette = resolveSonicPalette(settings.colors);
	const layer = createSonicFloatingBlocksLayer({
		owner: "floating-envelope",
		resources,
		settings,
		palette,
		random: () => 0,
	});
	layer.fillRange(0, 1);
	layer.finalize();
	layer.update(0, SILENT_AUDIO);
	layer.update(1 / 60, Object.freeze({
		...SILENT_AUDIO,
		kickSub: 1,
		kickCore: 1,
		kickPunch: 1,
		lowDrive: 1,
		kickEnvelope: 0,
	}));
	const sustainedRawPulse = layer.material.uniforms.uPulse.value;
	layer.update(2 / 60, Object.freeze({
		...SILENT_AUDIO,
		kickEnvelope: 1,
	}));

	expect(sustainedRawPulse).toBe(0);
	expect(layer.material.uniforms.uPulse.value).toBeGreaterThan(0);
	resources.dispose();
});

import { expect, test } from "bun:test";
import { Color, NormalBlending, Vector4 } from "three";
import { createVisualResourceScope } from "../runtime/resource-scope";
import type { SonicAudioSnapshot } from "./sonic-audio-profile";
import {
	createSonicImpulseLayer,
	SONIC_IMPULSE_RIPPLE_CAP,
	SONIC_METEOR_CAP,
	SONIC_TRAIL_CAP,
} from "./sonic-impulses";
import { resolveSonicPalette } from "./sonic-palette";
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function audio(signal: number): SonicAudioSnapshot {
	return Object.freeze({
		spectrum: null,
		bands: Object.freeze({ subBass: signal, bass: signal, lowMid: 0, mid: 0, highMid: 0, presence: 0, brilliance: 0, air: 0 }),
		kickSub: signal,
		kickCore: signal,
		kickPunch: signal,
		body: 0,
		vocal: 0,
		snap: 0,
		lowDrive: signal,
		dominance: signal,
		energy: signal,
		warmth: signal,
		brightness: 0,
		sharpness: 0,
		smoothness: 0,
		density: signal,
		onset: signal,
		flux: signal,
		confidence: signal,
		triggerPulse: signal,
		kickEnvelope: signal,
	});
}

function highFrequencyAudio(): SonicAudioSnapshot {
	return Object.freeze({
		...audio(0),
		bands: Object.freeze({
			subBass: 0,
			bass: 0,
			lowMid: 0,
			mid: 0,
			highMid: 0,
			presence: 1,
			brilliance: 1,
			air: 0.8,
		}),
		snap: 1,
		brightness: 1,
		sharpness: 1,
		energy: 0.45,
	});
}

test("meteor and trail materials preserve the upstream basic-material contract", () => {
	const resources = createVisualResourceScope("sonic-impulses-materials");
	const palette = resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors);
	const layer = createSonicImpulseLayer({
		owner: "materials",
		resources,
		palette,
		random: () => 0.5,
	});

	expect(layer.meteorsMaterial.isMeshBasicMaterial).toBe(true);
	expect(layer.trailsMaterial.isMeshBasicMaterial).toBe(true);
	for (const material of [layer.meteorsMaterial, layer.trailsMaterial]) {
		expect(material.blending).toBe(NormalBlending);
		expect(material.transparent).toBe(true);
		expect(material.depthWrite).toBe(false);
		expect(material.toneMapped).toBe(false);
	}
	expect(layer.meteorsMaterial.opacity).toBe(1);
	expect(layer.trailsMaterial.opacity).toBe(0.6);

	const nextPalette = resolveSonicPalette({
		...SONIC_TOPOGRAPHY_DEFAULTS.colors,
		mode: "custom",
		warm: "#224466",
		accent: "#88aacc",
	});
	layer.applyPalette(nextPalette);
	expect(layer.meteorsMaterial.color.getHex()).toBe(
		nextPalette.warm.clone().lerp(new Color(0xffffff), 0.7).getHex(),
	);
	expect(layer.trailsMaterial.color.getHex()).toBe(nextPalette.accent.getHex());

	resources.dispose();
});

test("colored and white ripples coexist in the bounded terrain ripple pool", () => {
	const resources = createVisualResourceScope("sonic-impulses-dual-ripple");
	const layer = createSonicImpulseLayer({
		owner: "dual-ripple",
		resources,
		palette: resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors),
		random: () => 0,
	});
	layer.initialize();
	layer.pointerRipple(2, -3, 1.2);
	layer.update(1 / 60, 0.1, highFrequencyAudio(), SONIC_TOPOGRAPHY_DEFAULTS);
	const ripples = Array.from(
		{ length: SONIC_IMPULSE_RIPPLE_CAP },
		() => new Vector4(),
	);

	expect(layer.writeTerrainRipples(ripples)).toBe(2);
	expect(ripples.some((entry) => entry.w > 0)).toBe(true);
	expect(ripples.some((entry) => entry.w < 0)).toBe(true);
	resources.dispose();
});

test("a falling meteor creates a white impact ripple and a bounded trail burst", () => {
	const resources = createVisualResourceScope("sonic-impulses-meteor-impact");
	const layer = createSonicImpulseLayer({
		owner: "meteor-impact",
		resources,
		palette: resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors),
		random: () => 0,
	});
	layer.initialize();
	layer.update(0, 0, audio(1), SONIC_TOPOGRAPHY_DEFAULTS);
	for (let index = 1; index <= 3; index += 1) {
		layer.update(0.1, index * 0.1, audio(0), SONIC_TOPOGRAPHY_DEFAULTS);
	}
	const ripples = Array.from(
		{ length: SONIC_IMPULSE_RIPPLE_CAP },
		() => new Vector4(),
	);
	layer.writeTerrainRipples(ripples);
	const diagnostics = layer.getDiagnostics();

	expect(ripples.some((entry) => entry.w < 0)).toBe(true);
	expect(diagnostics.trails).toBeGreaterThanOrEqual(10);
	expect(diagnostics.trails).toBeLessThanOrEqual(SONIC_TRAIL_CAP);
	resources.dispose();
});

test("manual trigger envelopes still drive impulses and trigger settings are not applied twice", () => {
	const firstResources = createVisualResourceScope("sonic-impulses-manual-first");
	const secondResources = createVisualResourceScope("sonic-impulses-manual-second");
	const palette = resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors);
	const first = createSonicImpulseLayer({ owner: "manual-first", resources: firstResources, palette, random: () => 0.8 });
	const second = createSonicImpulseLayer({ owner: "manual-second", resources: secondResources, palette, random: () => 0.8 });
	first.initialize();
	second.initialize();
	const manualSettings = {
		...SONIC_TOPOGRAPHY_DEFAULTS,
		trigger: {
			...SONIC_TOPOGRAPHY_DEFAULTS.trigger,
			monitorEnabled: false,
			autoTrack: false,
			threshold: 100,
			pulseStrength: 0,
		},
	};
	const signal = Object.freeze({ ...audio(0), kickEnvelope: 0.7 });
	first.update(1 / 60, 1, signal, manualSettings);
	second.update(1 / 60, 1, signal, SONIC_TOPOGRAPHY_DEFAULTS);
	const firstRipples = Array.from({ length: SONIC_IMPULSE_RIPPLE_CAP }, () => new Vector4());
	const secondRipples = Array.from({ length: SONIC_IMPULSE_RIPPLE_CAP }, () => new Vector4());

	expect(first.writeTerrainRipples(firstRipples)).toBe(1);
	expect(second.writeTerrainRipples(secondRipples)).toBe(1);
	expect(firstRipples.map((entry) => entry.toArray())).toEqual(secondRipples.map((entry) => entry.toArray()));
	firstResources.dispose();
	secondResources.dispose();
});

test("injected RNG makes impulses deterministic while all ring buffers stay bounded", () => {
	const firstResources = createVisualResourceScope("sonic-impulses-first");
	const secondResources = createVisualResourceScope("sonic-impulses-second");
	const palette = resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors);
	const first = createSonicImpulseLayer({
		owner: "first",
		resources: firstResources,
		palette,
		random: seededRandom(12),
	});
	const second = createSonicImpulseLayer({
		owner: "second",
		resources: secondResources,
		palette,
		random: seededRandom(12),
	});
	first.initialize();
	second.initialize();
	first.update(0, 1, audio(1), SONIC_TOPOGRAPHY_DEFAULTS);
	second.update(0, 1, audio(1), SONIC_TOPOGRAPHY_DEFAULTS);
	expect(first.getDiagnostics().meteors).toBe(1);
	expect(second.getDiagnostics().meteors).toBe(1);
	expect(Array.from(first.meteorsMesh.instanceMatrix.array)).toEqual(
		Array.from(second.meteorsMesh.instanceMatrix.array),
	);

	for (let index = 0; index < 32; index += 1) first.pointerRipple(index, -index, 9);
	const rippleUniforms = Array.from(
		{ length: SONIC_IMPULSE_RIPPLE_CAP },
		() => new Vector4(),
	);
	expect(first.writeTerrainRipples(rippleUniforms)).toBe(SONIC_IMPULSE_RIPPLE_CAP);
	expect(Math.max(...rippleUniforms.map((entry) => entry.w))).toBe(3);

	for (let index = 0; index < 120; index += 1) {
		first.update(0.1, index * 0.2 + 2, audio(0), SONIC_TOPOGRAPHY_DEFAULTS);
		first.update(0.1, index * 0.2 + 2.1, audio(1), SONIC_TOPOGRAPHY_DEFAULTS);
	}
	const diagnostics = first.getDiagnostics();
	expect(diagnostics.ripples).toBeLessThanOrEqual(SONIC_IMPULSE_RIPPLE_CAP);
	expect(diagnostics.meteors).toBeLessThanOrEqual(SONIC_METEOR_CAP);
	expect(diagnostics.trails).toBeLessThanOrEqual(SONIC_TRAIL_CAP);
	expect(first.meteorsMesh.count).toBe(SONIC_METEOR_CAP);
	expect(first.trailsMesh.count).toBe(SONIC_TRAIL_CAP);

	firstResources.dispose();
	secondResources.dispose();
});

import { expect, test } from "bun:test";
import { Vector4 } from "three";
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
	});
}

test("injected RNG makes impulses deterministic while all ring buffers stay bounded", () => {
	const firstResources = createVisualResourceScope("sonic-impulses-first");
	const secondResources = createVisualResourceScope("sonic-impulses-second");
	const palette = resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors);
	const first = createSonicImpulseLayer({
		owner: "first",
		resources: firstResources,
		palette,
		random: seededRandom(42),
	});
	const second = createSonicImpulseLayer({
		owner: "second",
		resources: secondResources,
		palette,
		random: seededRandom(42),
	});
	first.initialize();
	second.initialize();
	first.update(0, 1, audio(1), SONIC_TOPOGRAPHY_DEFAULTS);
	second.update(0, 1, audio(1), SONIC_TOPOGRAPHY_DEFAULTS);
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

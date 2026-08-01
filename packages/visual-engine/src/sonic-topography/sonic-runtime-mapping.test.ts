import { expect, test } from "bun:test";
import {
	resolveSonicGroundLayout,
	smoothSonicGroundBands,
	writeSonicGroundEqTarget,
} from "./sonic-runtime-mapping";
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";

test("Sonic 地形布局保持 Electron 2.0.2 的 range/lower/depth 映射", () => {
	expect(resolveSonicGroundLayout(SONIC_TOPOGRAPHY_DEFAULTS.terrain)).toEqual({
		scale: 0.15504,
		y: -6.362,
		z: -7.61,
	});
	expect(resolveSonicGroundLayout({
		...SONIC_TOPOGRAPHY_DEFAULTS.terrain,
		range: 0,
		lower: 0,
		depth: 0,
	})).toEqual({
		scale: 0.096,
		y: -4.05,
		z: -4.2,
	});
});

test("Sonic EQ applies all eight Electron bands before runtime smoothing", () => {
	const target = new Float32Array(8);
	const bands = new Float32Array(8).fill(0.5);
	writeSonicGroundEqTarget(target, bands, 0, {
		...SONIC_TOPOGRAPHY_DEFAULTS.eq,
		presence: 0,
		brilliance: 100,
		air: 100,
	});

	expect(target[5]).toBeCloseTo(0.0975, 6);
	expect(target[6]).toBe(1);
	expect(target[7]).toBe(1);
});

test("Sonic motion-speed response smoothing converges consistently at 30 and 60 FPS", () => {
	const target = new Float32Array(8).fill(1);
	const run = (dt: number) => {
		const current = new Float32Array(8);
		for (let elapsed = 0; elapsed < 0.1 - 1e-9; elapsed += dt) {
			smoothSonicGroundBands(current, target, 50, dt);
		}
		return current;
	};

	const at30 = run(1 / 30);
	const at60 = run(1 / 60);
	expect(at30[0]).toBeCloseTo(at60[0] ?? 0, 6);
	expect(at60[7]).toBeGreaterThan(0.9);
});

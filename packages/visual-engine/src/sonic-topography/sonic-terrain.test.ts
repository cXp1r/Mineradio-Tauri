import { expect, test } from "bun:test";
import { createVisualResourceScope } from "../runtime/resource-scope";
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";
import {
	createSonicTerrainLayer,
	resolveSonicTerrainCellTransform,
} from "./sonic-terrain";
import { resolveSonicPalette } from "./sonic-palette";

test("static terrain preserves the Electron 2.0.2 168-unit local grid contract", () => {
	const resources = createVisualResourceScope("sonic-terrain-test");
	const layer = createSonicTerrainLayer({
		owner: "terrain",
		resources,
		settings: SONIC_TOPOGRAPHY_DEFAULTS,
		quality: "eco",
		palette: resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors),
	});

	expect(layer.mesh.isInstancedMesh).toBe(true);
	expect(layer.grid).toBe(112);
	expect(layer.instanceCount).toBe(112 * 112);
	expect(layer.mesh.count).toBe(0);
	expect(layer.material.uniforms.uBands.value).toBeInstanceOf(Float32Array);
	expect(layer.material.uniforms.uBands.value.length).toBe(8);
	expect(layer.material.uniforms.uRipples.value.length).toBe(10);
	expect(layer.material.uniforms.uTexture).toBeUndefined();

	const first = resolveSonicTerrainCellTransform(
		0,
		layer.grid,
		SONIC_TOPOGRAPHY_DEFAULTS.terrain,
	);
	const second = resolveSonicTerrainCellTransform(
		1,
		layer.grid,
		SONIC_TOPOGRAPHY_DEFAULTS.terrain,
	);
	const last = resolveSonicTerrainCellTransform(
		layer.instanceCount - 1,
		layer.grid,
		SONIC_TOPOGRAPHY_DEFAULTS.terrain,
	);
	const spacing = 168 / layer.grid;
	const boxWidth = spacing * (0.9 / 1.05);
	expect(first).toEqual({
		x: -84,
		y: 0.5,
		z: -84,
		scaleX: boxWidth,
		scaleY: 1,
		scaleZ: boxWidth,
	});
	expect(second.x).toBe(first.x);
	expect(second.z).toBeCloseTo(first.z + spacing, 8);
	expect(last.x).toBeCloseTo(84 - spacing, 8);
	expect(last.z).toBeCloseTo(84 - spacing, 8);

	let next = 0;
	while (next < layer.instanceCount) next = layer.fillRange(next, 997);
	layer.finalize();
	expect(layer.mesh.count).toBe(layer.instanceCount);
	expect(layer.mesh.instanceMatrix.version).toBeGreaterThan(0);

	let geometryDisposals = 0;
	let materialDisposals = 0;
	layer.geometry.addEventListener("dispose", () => geometryDisposals += 1);
	layer.material.addEventListener("dispose", () => materialDisposals += 1);
	resources.dispose();
	resources.dispose();
	expect(geometryDisposals).toBe(1);
	expect(materialDisposals).toBe(1);
});

test("terrain settings map to the Electron 2.0.2 shader controls", () => {
	const resources = createVisualResourceScope("sonic-terrain-settings-test");
	const layer = createSonicTerrainLayer({
		owner: "terrain-settings",
		resources,
		settings: SONIC_TOPOGRAPHY_DEFAULTS,
		quality: "eco",
		palette: resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors),
	});
	const uniforms = layer.material.uniforms;

	expect(Array.from(uniforms.uEq.value)).toEqual([90, 92, 50, 50, 50, 25, 50, 48]);
	expect(uniforms.uMotionSpeed.value).toBeCloseTo(1.3, 8);
	expect(uniforms.uAmplitude.value).toBe(1);
	expect(uniforms.uGlowIntensity.value).toBeCloseTo(0.83, 8);

	const maximum = {
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: {
			...SONIC_TOPOGRAPHY_DEFAULTS.terrain,
			amplitude: 100,
			motionSpeed: 100,
		},
		colors: {
			...SONIC_TOPOGRAPHY_DEFAULTS.colors,
			mode: "custom" as const,
			glow: 100,
		},
	};
	layer.applySettings(maximum, resolveSonicPalette(maximum.colors));
	expect(uniforms.uMotionSpeed.value).toBeCloseTo(2.15, 8);
	expect(uniforms.uAmplitude.value).toBe(15);
	expect(uniforms.uGlowIntensity.value).toBeCloseTo(1.95, 8);

	resources.dispose();
});

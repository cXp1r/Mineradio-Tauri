import { expect, test } from "bun:test";
import { createVisualResourceScope } from "../runtime/resource-scope";
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";
import {
	createSonicTerrainLayer,
	resolveSonicTerrainCellTransform,
} from "./sonic-terrain";
import { resolveSonicPalette } from "./sonic-palette";

test("static terrain builds a centered instanced grid with the clean-room material contract", () => {
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
	const last = resolveSonicTerrainCellTransform(
		layer.instanceCount - 1,
		layer.grid,
		SONIC_TOPOGRAPHY_DEFAULTS.terrain,
	);
	expect(first.x).toBeCloseTo(-last.x, 6);
	expect(first.z).toBeCloseTo(-last.z, 6);
	expect(first.scaleX).toBeGreaterThan(0);
	expect(first.scaleZ).toBeGreaterThan(0);

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

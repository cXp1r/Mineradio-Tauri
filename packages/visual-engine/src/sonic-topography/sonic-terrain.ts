import {
	BoxGeometry,
	DynamicDrawUsage,
	InstancedMesh,
	Matrix4,
	Quaternion,
	Vector3,
	type BufferGeometry,
} from "three";
import type { SonicPalette } from "./sonic-palette";
import {
	createSonicTerrainMaterial,
	type SonicTerrainMaterial,
} from "./sonic-shaders";
import {
	mapSonicTerrainAmplitude,
	resolveSonicTerrainGrid,
	type SonicPerformanceQuality,
	type SonicTerrainSettings,
	type SonicTopographySettings,
} from "./sonic-settings";
import type { VisualResourceScope } from "../runtime/resource-scope";

export interface SonicTerrainCellTransform {
	readonly x: number;
	readonly y: number;
	readonly z: number;
	readonly scaleX: number;
	readonly scaleY: number;
	readonly scaleZ: number;
}

export interface SonicTerrainLayer {
	readonly mesh: InstancedMesh<BufferGeometry, SonicTerrainMaterial>;
	readonly geometry: BufferGeometry;
	readonly material: SonicTerrainMaterial;
	readonly grid: number;
	readonly instanceCount: number;
	readonly estimatedGeometryBytes: number;
	fillRange(startInclusive: number, maximumInstances: number): number;
	finalize(): void;
	applySettings(settings: SonicTopographySettings, palette: SonicPalette): void;
}

export interface CreateSonicTerrainLayerOptions {
	readonly owner: string;
	readonly resources: VisualResourceScope;
	readonly settings: SonicTopographySettings;
	readonly quality: SonicPerformanceQuality;
	readonly palette: SonicPalette;
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function resolveSonicTerrainCellTransform(
	index: number,
	grid: number,
	settings: SonicTerrainSettings,
): SonicTerrainCellTransform {
	const safeGrid = Math.max(2, Math.round(grid));
	const safeIndex = Math.max(0, Math.min(safeGrid * safeGrid - 1, Math.floor(index)));
	const row = Math.floor(safeIndex / safeGrid);
	const column = safeIndex % safeGrid;
	const range = clamp01(settings.range / 100);
	const depth = clamp01(settings.depth / 100);
	const lower = clamp01(settings.lower / 100);
	const spanX = 10 + range * 6;
	const spanZ = 7 + depth * 6;
	const stepX = spanX / Math.max(1, safeGrid - 1);
	const stepZ = spanZ / Math.max(1, safeGrid - 1);
	return Object.freeze({
		x: -spanX / 2 + column * stepX,
		y: -0.72 + lower * 0.42,
		z: -spanZ / 2 + row * stepZ,
		scaleX: stepX * 0.72,
		scaleY: 1,
		scaleZ: stepZ * 0.72,
	});
}

function estimateGeometryBytes(geometry: BufferGeometry, mesh: InstancedMesh): number {
	let bytes = mesh.instanceMatrix.array.byteLength;
	for (const attribute of Object.values(geometry.attributes)) {
		bytes += attribute.array.byteLength;
	}
	if (geometry.index) bytes += geometry.index.array.byteLength;
	return bytes;
}

export function createSonicTerrainLayer(
	options: CreateSonicTerrainLayerOptions,
): SonicTerrainLayer {
	const grid = resolveSonicTerrainGrid(options.settings.terrain.density, options.quality);
	const instanceCount = grid * grid;
	const geometry = new BoxGeometry(1, 1, 1);
	geometry.translate(0, 0.5, 0);
	const material = createSonicTerrainMaterial(options.palette);
	const mesh = new InstancedMesh(geometry, material, instanceCount);
	mesh.name = "sonic-terrain";
	mesh.count = 0;
	mesh.frustumCulled = false;
	mesh.instanceMatrix.setUsage(DynamicDrawUsage);
	const estimatedGeometryBytes = estimateGeometryBytes(geometry, mesh);
	const layerResources = options.resources.createChild(`${options.owner}:resources`);
	let geometryRegistered = false;
	let materialRegistered = false;
	let meshRegistered = false;
	try {
		layerResources.register({
			owner: `${options.owner}:geometry`,
			kind: "geometry",
			retention: "rebuildable",
			estimatedBytes: estimatedGeometryBytes,
			dispose: () => geometry.dispose(),
		});
		geometryRegistered = true;
		layerResources.register({
			owner: `${options.owner}:material`,
			kind: "material",
			retention: "rebuildable",
			dispose: () => material.dispose(),
		});
		materialRegistered = true;
		layerResources.register({
			owner: `${options.owner}:mesh`,
			kind: "mesh",
			retention: "rebuildable",
			dispose: () => mesh.removeFromParent(),
		});
		meshRegistered = true;
	} catch (error) {
		layerResources.dispose();
		if (!meshRegistered) mesh.removeFromParent();
		if (!materialRegistered) material.dispose();
		if (!geometryRegistered) geometry.dispose();
		throw error;
	}

	const matrix = new Matrix4();
	const position = new Vector3();
	const scale = new Vector3();
	const rotation = new Quaternion();

	const layer: SonicTerrainLayer = {
		mesh,
		geometry,
		material,
		grid,
		instanceCount,
		estimatedGeometryBytes,
		fillRange(startInclusive, maximumInstances) {
			const start = Math.max(0, Math.min(instanceCount, Math.floor(startInclusive)));
			const count = Math.max(1, Math.floor(maximumInstances));
			const end = Math.min(instanceCount, start + count);
			for (let index = start; index < end; index += 1) {
				const transform = resolveSonicTerrainCellTransform(
					index,
					grid,
					options.settings.terrain,
				);
				position.set(transform.x, transform.y, transform.z);
				scale.set(transform.scaleX, transform.scaleY, transform.scaleZ);
				matrix.compose(position, rotation, scale);
				mesh.setMatrixAt(index, matrix);
			}
			return end;
		},
		finalize() {
			mesh.count = instanceCount;
			mesh.instanceMatrix.needsUpdate = true;
		},
		applySettings(settings, palette) {
			const uniforms = material.uniforms;
			uniforms.uAmplitude.value = mapSonicTerrainAmplitude(settings.terrain.amplitude);
			uniforms.uMotionSpeed.value = 0.12 + settings.terrain.motionSpeed / 100 * 1.88;
			uniforms.uBaseColor.value.copy(palette.base);
			uniforms.uCoolColor.value.copy(palette.cool);
			uniforms.uWarmColor.value.copy(palette.warm);
			uniforms.uAccentColor.value.copy(palette.accent);
			uniforms.uGlow.value = palette.glow;
		},
	};
	layer.applySettings(options.settings, options.palette);
	return layer;
}

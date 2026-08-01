/**
 * Sonic Topography 视觉层的 Tauri 修改版本。
 * 直接上游：XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224，public/sonic-topography-preset.js。
 * 原始项目：yin-yizhen/sonic-topography@3ff303e，作者 Ajin；适用 Non-Commercial Learning License。
 * 完整来源、许可范围与修改告知见 THIRD_PARTY_NOTICES.md。
 */
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

const SONIC_TERRAIN_BASE_SIZE = 168;
const SONIC_TERRAIN_CELL_FILL = 0.9 / 1.05;

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

export function resolveSonicTerrainCellTransform(
	index: number,
	grid: number,
	_settings: SonicTerrainSettings,
): SonicTerrainCellTransform {
	const safeGrid = Math.max(2, Math.round(grid));
	const safeIndex = Math.max(0, Math.min(safeGrid * safeGrid - 1, Math.floor(index)));
	const gridX = Math.floor(safeIndex / safeGrid);
	const gridZ = safeIndex % safeGrid;
	const spacing = SONIC_TERRAIN_BASE_SIZE / safeGrid;
	const offset = safeGrid * spacing / 2;
	const boxWidth = spacing * SONIC_TERRAIN_CELL_FILL;
	return Object.freeze({
		x: gridX * spacing - offset,
		y: 0.5,
		z: gridZ * spacing - offset,
		scaleX: boxWidth,
		scaleY: 1,
		scaleZ: boxWidth,
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
			uniforms.uMotionSpeed.value = 0.45 + settings.terrain.motionSpeed * 0.017;
			uniforms.uEq.value.set([
				settings.eq.subBass,
				settings.eq.bass,
				settings.eq.lowMid,
				settings.eq.mid,
				settings.eq.highMid,
				settings.eq.presence,
				settings.eq.brilliance,
				settings.eq.air,
			]);
			uniforms.uBaseColor1.value.copy(palette.base);
			uniforms.uBaseColor2.value.copy(palette.base2);
			uniforms.uFogColor.value.copy(palette.base);
			uniforms.uCoolCore.value.copy(palette.cool);
			uniforms.uCoolEdge.value.copy(palette.cool).lerp(palette.base, 0.34);
			uniforms.uWarmCore.value.copy(palette.warm);
			uniforms.uWarmEdge.value.copy(palette.warm).lerp(palette.base, 0.26);
			uniforms.uRippleColor.value.copy(palette.accent);
			uniforms.uGlowIntensity.value = Math.max(
				0.45,
				Math.min(2.2, 0.55 + settings.colors.glow * 0.014),
			);
		},
	};
	layer.applySettings(options.settings, options.palette);
	return layer;
}

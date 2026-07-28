/**
 * Sonic Topography 视觉层的 Tauri 修改版本。
 * 直接上游：XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224，public/sonic-topography-preset.js。
 * 原始项目：yin-yizhen/sonic-topography@3ff303e，作者 Ajin；适用 Non-Commercial Learning License。
 * 完整来源、许可范围与修改告知见 THIRD_PARTY_NOTICES.md。
 */
import {
	BoxGeometry,
	DynamicDrawUsage,
	Euler,
	InstancedMesh,
	Matrix4,
	Quaternion,
	Vector3,
	type BufferGeometry,
} from "three";
import type { VisualResourceScope } from "../runtime/resource-scope";
import type { SonicAudioSnapshot } from "./sonic-audio-profile";
import type { SonicPalette } from "./sonic-palette";
import {
	createSonicFloatingMaterial,
	type SonicFloatingMaterial,
} from "./sonic-shaders";
import {
	mapSonicTerrainAmplitude,
	type SonicTopographySettings,
} from "./sonic-settings";

export const SONIC_FLOATING_CAP = 100 as const;

export type SonicRandomSource = () => number;

export interface SonicFloatingBlocksLayer {
	readonly mesh: InstancedMesh<BufferGeometry, SonicFloatingMaterial>;
	readonly geometry: BufferGeometry;
	readonly material: SonicFloatingMaterial;
	readonly instanceCount: number;
	readonly estimatedGeometryBytes: number;
	fillRange(startInclusive: number, maximumInstances: number): number;
	finalize(): void;
	applySettings(settings: SonicTopographySettings, palette: SonicPalette): void;
	update(timeSeconds: number, audio: SonicAudioSnapshot, groundBands?: Float32Array): void;
}

export interface CreateSonicFloatingBlocksOptions {
	readonly owner: string;
	readonly resources: VisualResourceScope;
	readonly settings: SonicTopographySettings;
	readonly palette: SonicPalette;
	readonly random: SonicRandomSource;
}

function randomUnit(random: SonicRandomSource): number {
	const value = random();
	if (!Number.isFinite(value)) return 0.5;
	return value - Math.floor(value);
}

function estimateGeometryBytes(geometry: BufferGeometry, mesh: InstancedMesh): number {
	let bytes = mesh.instanceMatrix.array.byteLength;
	for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
	if (geometry.index) bytes += geometry.index.array.byteLength;
	return bytes;
}

export function createSonicFloatingBlocksLayer(
	options: CreateSonicFloatingBlocksOptions,
): SonicFloatingBlocksLayer {
	const instanceCount = Math.min(
		SONIC_FLOATING_CAP,
		Math.max(0, Math.round(options.settings.floating.count)),
	);
	const geometry = new BoxGeometry(1, 1, 1);
	const material = createSonicFloatingMaterial(options.palette);
	const mesh = new InstancedMesh(geometry, material, SONIC_FLOATING_CAP);
	mesh.name = "sonic-floating-blocks";
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

	const seeds = new Float32Array(SONIC_FLOATING_CAP * 7);
	for (let index = 0; index < SONIC_FLOATING_CAP; index += 1) {
		const offset = index * 7;
		const ring = index / Math.max(1, instanceCount);
		const angle = ring * Math.PI * 2 * 5 + Math.sin(index * 12.9898) * 0.7;
		const radius = 14 + index * 37 % 62;
		seeds[offset] = Math.cos(angle) * radius;
		seeds[offset + 1] = 6 + index * 17 % 19;
		seeds[offset + 2] = Math.sin(angle) * radius;
		seeds[offset + 3] = index * 0.73;
		seeds[offset + 4] = 0.75 + (index * 11 % 9) * 0.05;
		seeds[offset + 5] = 0.18 + (index * 7 % 10) * 0.035;
		seeds[offset + 6] = randomUnit(options.random) * Math.PI * 2;
	}
	const matrix = new Matrix4();
	const position = new Vector3();
	const scale = new Vector3();
	const rotation = new Quaternion();
	const euler = new Euler();
	let currentSettings = options.settings;
	let floatingPulse = 0;
	let previousTimeSeconds: number | null = null;

	function writeInstance(index: number, timeSeconds: number): void {
		const offset = index * 7;
		const intensity = currentSettings.floating.intensity / 100;
		const phase = seeds[offset + 3] ?? 0;
		const rotationSpeed = seeds[offset + 5] ?? 0.18;
		const bob = Math.sin(timeSeconds * (0.55 + rotationSpeed) + phase) * 0.45;
		position.set(
			seeds[offset] ?? 0,
			(seeds[offset + 1] ?? 0) + bob + floatingPulse * intensity * 1.4,
			seeds[offset + 2] ?? 0,
		);
		const minVisualScale = 0.12 + (0.75 - 0.12) * currentSettings.floating.minSize / 100;
		const maxVisualScale = Math.max(
			minVisualScale + 0.05,
			0.45 + (3.2 - 0.45) * currentSettings.floating.maxSize / 100,
		);
		const sizeMix = Math.max(0, Math.min(1, floatingPulse * (0.5 + intensity * 1.7)));
		const pulseScale = minVisualScale + (maxVisualScale - minVisualScale) * sizeMix;
		const instanceScale = (seeds[offset + 4] ?? 0.75) * pulseScale;
		scale.setScalar(currentSettings.floating.enabled ? instanceScale : 0);
		euler.set(
			timeSeconds * rotationSpeed + phase,
			timeSeconds * rotationSpeed * 0.7 + phase,
			timeSeconds * rotationSpeed * 0.45,
		);
		rotation.setFromEuler(euler);
		matrix.compose(position, rotation, scale);
		mesh.setMatrixAt(index, matrix);
	}

	return {
		mesh,
		geometry,
		material,
		instanceCount,
		estimatedGeometryBytes,
		fillRange(startInclusive, maximumInstances) {
			const start = Math.max(0, Math.min(instanceCount, Math.floor(startInclusive)));
			const end = Math.min(instanceCount, start + Math.max(1, Math.floor(maximumInstances)));
			for (let index = start; index < end; index += 1) writeInstance(index, 0);
			return end;
		},
		finalize() {
			mesh.count = currentSettings.floating.enabled ? instanceCount : 0;
			mesh.instanceMatrix.needsUpdate = true;
		},
		applySettings(settings, palette) {
			currentSettings = settings;
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
			mesh.count = settings.floating.enabled ? instanceCount : 0;
		},
		update(timeSeconds, audio, groundBands) {
			if (!currentSettings.floating.enabled) return;
			const dt = previousTimeSeconds === null
				? 1 / 60
				: Math.max(0.001, Math.min(0.1, timeSeconds - previousTimeSeconds));
			previousTimeSeconds = timeSeconds;
			const speedRate = 3 + (36 - 3) * currentSettings.floating.speed / 100;
			const pulseBlend = Math.max(0, Math.min(1, 1 - Math.exp(-speedRate * dt)));
			const kickEnvelope = audio.kickEnvelope;
			floatingPulse += (Math.max(0, Math.min(1, kickEnvelope)) - floatingPulse) * pulseBlend;
			const uniforms = material.uniforms;
			const bands = uniforms.uBands.value;
			bands[0] = groundBands?.[0] ?? audio.bands.subBass;
			bands[1] = groundBands?.[1] ?? audio.bands.bass;
			bands[2] = groundBands?.[2] ?? audio.bands.lowMid;
			bands[3] = groundBands?.[3] ?? audio.bands.mid;
			bands[4] = groundBands?.[4] ?? audio.bands.highMid;
			bands[5] = groundBands?.[5] ?? audio.bands.presence;
			bands[6] = groundBands?.[6] ?? audio.bands.brilliance;
			bands[7] = groundBands?.[7] ?? audio.bands.air;
			const low = bands[0] + bands[1] + bands[2] + bands[3];
			const high = bands[5] + bands[6] + bands[7];
			const total = Math.max(0.001, low + high);
			uniforms.uTime.value = timeSeconds;
			uniforms.uKickEnvelope.value = kickEnvelope;
			uniforms.uEnergy.value = audio.energy;
			uniforms.uWarmth.value = Math.max(0, Math.min(1, low / total));
			uniforms.uBrightness.value = Math.max(0, Math.min(1, high / total));
			uniforms.uSharpness.value = audio.sharpness;
			uniforms.uSmoothness.value = audio.smoothness;
			uniforms.uDensity.value = audio.density;
			uniforms.uPulse.value = floatingPulse;
			for (let index = 0; index < instanceCount; index += 1) writeInstance(index, timeSeconds);
			mesh.instanceMatrix.needsUpdate = true;
		},
	};
}

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
	createSonicSimpleMaterial,
	type SonicSimpleMaterial,
} from "./sonic-shaders";
import type { SonicTopographySettings } from "./sonic-settings";

export const SONIC_FLOATING_CAP = 100 as const;

export type SonicRandomSource = () => number;

export interface SonicFloatingBlocksLayer {
	readonly mesh: InstancedMesh<BufferGeometry, SonicSimpleMaterial>;
	readonly geometry: BufferGeometry;
	readonly material: SonicSimpleMaterial;
	readonly instanceCount: number;
	readonly estimatedGeometryBytes: number;
	fillRange(startInclusive: number, maximumInstances: number): number;
	finalize(): void;
	applySettings(settings: SonicTopographySettings, palette: SonicPalette): void;
	update(timeSeconds: number, audio: SonicAudioSnapshot): void;
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
	const material = createSonicSimpleMaterial(options.palette.accent, 0.58, true);
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
		seeds[offset] = randomUnit(options.random) * 2 - 1;
		seeds[offset + 1] = randomUnit(options.random);
		seeds[offset + 2] = randomUnit(options.random) * 2 - 1;
		seeds[offset + 3] = randomUnit(options.random) * Math.PI * 2;
		seeds[offset + 4] = randomUnit(options.random) * 0.7 + 0.65;
		seeds[offset + 5] = randomUnit(options.random) * 0.7 + 0.65;
		seeds[offset + 6] = randomUnit(options.random) * 0.7 + 0.65;
	}
	const matrix = new Matrix4();
	const position = new Vector3();
	const scale = new Vector3();
	const rotation = new Quaternion();
	const euler = new Euler();
	let currentSettings = options.settings;

	function writeInstance(index: number, timeSeconds: number, audio: SonicAudioSnapshot): void {
		const offset = index * 7;
		const intensity = currentSettings.floating.intensity / 100;
		const speed = 0.12 + currentSettings.floating.speed / 100 * 0.88;
		const phase = seeds[offset + 3] ?? 0;
		const radialX = (seeds[offset] ?? 0) * (4.2 + intensity * 2.4);
		const radialZ = (seeds[offset + 2] ?? 0) * (3.4 + intensity * 2.0);
		const lift = 0.55 + (seeds[offset + 1] ?? 0) * (2.4 + intensity * 1.8);
		position.set(
			radialX + Math.sin(timeSeconds * speed + phase) * 0.18 * intensity,
			lift + Math.sin(timeSeconds * speed * 1.3 + phase) * 0.16,
			radialZ + Math.cos(timeSeconds * speed * 0.9 + phase) * 0.18 * intensity,
		);
		const minSize = currentSettings.floating.minSize / 100;
		const maxSize = Math.max(minSize, currentSettings.floating.maxSize / 100);
		const baseSize = 0.10 + (minSize + (maxSize - minSize) * (seeds[offset + 4] ?? 0.5)) * 0.72;
		const audioScale = 1 + audio.energy * intensity * 0.42;
		scale.set(
			baseSize * (seeds[offset + 4] ?? 1) * audioScale,
			baseSize * (seeds[offset + 5] ?? 1) * audioScale,
			baseSize * (seeds[offset + 6] ?? 1) * audioScale,
		);
		euler.set(
			phase + timeSeconds * speed * 0.13,
			phase * 0.7 + timeSeconds * speed * 0.19,
			phase * 0.31,
		);
		rotation.setFromEuler(euler);
		matrix.compose(position, rotation, scale);
		mesh.setMatrixAt(index, matrix);
	}

	const emptyAudio: SonicAudioSnapshot = Object.freeze({
		spectrum: null,
		bands: Object.freeze({ subBass: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, presence: 0, brilliance: 0, air: 0 }),
		kickSub: 0, kickCore: 0, kickPunch: 0, body: 0, vocal: 0, snap: 0,
		lowDrive: 0, dominance: 0, energy: 0, warmth: 0, brightness: 0,
		sharpness: 0, smoothness: 0, density: 0, onset: 0, flux: 0,
		confidence: 0, triggerPulse: 0,
	});

	return {
		mesh,
		geometry,
		material,
		instanceCount,
		estimatedGeometryBytes,
		fillRange(startInclusive, maximumInstances) {
			const start = Math.max(0, Math.min(instanceCount, Math.floor(startInclusive)));
			const end = Math.min(instanceCount, start + Math.max(1, Math.floor(maximumInstances)));
			for (let index = start; index < end; index += 1) writeInstance(index, 0, emptyAudio);
			return end;
		},
		finalize() {
			mesh.count = currentSettings.floating.enabled ? instanceCount : 0;
			mesh.instanceMatrix.needsUpdate = true;
		},
		applySettings(settings, palette) {
			currentSettings = settings;
			material.uniforms.uColor.value.copy(palette.accent);
			material.uniforms.uOpacity.value = 0.18 + settings.floating.intensity / 100 * 0.62;
			mesh.count = settings.floating.enabled ? instanceCount : 0;
		},
		update(timeSeconds, audio) {
			if (!currentSettings.floating.enabled) return;
			material.uniforms.uTime.value = timeSeconds;
			material.uniforms.uPulse.value = Math.max(audio.triggerPulse, audio.energy * 0.45);
			for (let index = 0; index < instanceCount; index += 1) writeInstance(index, timeSeconds, audio);
			mesh.instanceMatrix.needsUpdate = true;
		},
	};
}

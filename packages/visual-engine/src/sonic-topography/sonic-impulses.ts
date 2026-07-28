import {
	DynamicDrawUsage,
	Euler,
	InstancedMesh,
	Matrix4,
	Quaternion,
	RingGeometry,
	TetrahedronGeometry,
	Vector3,
	type BufferGeometry,
	type Vector4,
} from "three";
import type { VisualResourceScope } from "../runtime/resource-scope";
import type { SonicAudioSnapshot } from "./sonic-audio-profile";
import type { SonicRandomSource } from "./sonic-floating-blocks";
import type { SonicPalette } from "./sonic-palette";
import {
	createSonicSimpleMaterial,
	type SonicSimpleMaterial,
} from "./sonic-shaders";
import type { SonicTopographySettings } from "./sonic-settings";

export const SONIC_METEOR_CAP = 20 as const;
export const SONIC_TRAIL_CAP = 200 as const;
export const SONIC_IMPULSE_RIPPLE_CAP = 10 as const;

interface SonicRippleState {
	active: boolean;
	x: number;
	z: number;
	strength: number;
	age: number;
	duration: number;
}

interface SonicMeteorState {
	active: boolean;
	position: Vector3;
	velocity: Vector3;
	age: number;
	duration: number;
	emissionRemainder: number;
}

interface SonicTrailState {
	active: boolean;
	position: Vector3;
	scale: number;
	age: number;
	duration: number;
}

export interface SonicImpulseDiagnostics {
	readonly ripples: number;
	readonly meteors: number;
	readonly trails: number;
}

export interface SonicImpulseLayer {
	readonly meteorsMesh: InstancedMesh<BufferGeometry, SonicSimpleMaterial>;
	readonly trailsMesh: InstancedMesh<BufferGeometry, SonicSimpleMaterial>;
	readonly meteorsGeometry: BufferGeometry;
	readonly trailsGeometry: BufferGeometry;
	readonly meteorsMaterial: SonicSimpleMaterial;
	readonly trailsMaterial: SonicSimpleMaterial;
	readonly estimatedGeometryBytes: number;
	initialize(): void;
	applyPalette(palette: SonicPalette): void;
	pointerRipple(x: number, z: number, strength: number): void;
	update(
		dtSeconds: number,
		timeSeconds: number,
		audio: SonicAudioSnapshot,
		settings: SonicTopographySettings,
	): void;
	writeTerrainRipples(target: readonly Vector4[]): number;
	getDiagnostics(): SonicImpulseDiagnostics;
}

export interface CreateSonicImpulseLayerOptions {
	readonly owner: string;
	readonly resources: VisualResourceScope;
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

export function createSonicImpulseLayer(
	options: CreateSonicImpulseLayerOptions,
): SonicImpulseLayer {
	const meteorsGeometry = new TetrahedronGeometry(0.16, 0);
	const trailsGeometry = new RingGeometry(0.72, 0.82, 20);
	const meteorsMaterial = createSonicSimpleMaterial(options.palette.warm, 0.88, true);
	const trailsMaterial = createSonicSimpleMaterial(options.palette.accent, 0.52, true);
	const meteorsMesh = new InstancedMesh(
		meteorsGeometry,
		meteorsMaterial,
		SONIC_METEOR_CAP,
	);
	const trailsMesh = new InstancedMesh(
		trailsGeometry,
		trailsMaterial,
		SONIC_TRAIL_CAP,
	);
	meteorsMesh.name = "sonic-meteors";
	trailsMesh.name = "sonic-trails";
	meteorsMesh.count = SONIC_METEOR_CAP;
	trailsMesh.count = SONIC_TRAIL_CAP;
	meteorsMesh.frustumCulled = false;
	trailsMesh.frustumCulled = false;
	meteorsMesh.instanceMatrix.setUsage(DynamicDrawUsage);
	trailsMesh.instanceMatrix.setUsage(DynamicDrawUsage);
	const meteorsBytes = estimateGeometryBytes(meteorsGeometry, meteorsMesh);
	const trailsBytes = estimateGeometryBytes(trailsGeometry, trailsMesh);
	const layerResources = options.resources.createChild(`${options.owner}:resources`);
	const resources = [
		{
			owner: `${options.owner}:meteors:geometry`,
			kind: "geometry" as const,
			estimatedBytes: meteorsBytes,
			dispose: () => meteorsGeometry.dispose(),
		},
		{
			owner: `${options.owner}:meteors:material`,
			kind: "material" as const,
			dispose: () => meteorsMaterial.dispose(),
		},
		{
			owner: `${options.owner}:meteors:mesh`,
			kind: "mesh" as const,
			dispose: () => meteorsMesh.removeFromParent(),
		},
		{
			owner: `${options.owner}:trails:geometry`,
			kind: "geometry" as const,
			estimatedBytes: trailsBytes,
			dispose: () => trailsGeometry.dispose(),
		},
		{
			owner: `${options.owner}:trails:material`,
			kind: "material" as const,
			dispose: () => trailsMaterial.dispose(),
		},
		{
			owner: `${options.owner}:trails:mesh`,
			kind: "mesh" as const,
			dispose: () => trailsMesh.removeFromParent(),
		},
	];
	let registered = 0;
	try {
		for (const resource of resources) {
			layerResources.register({ ...resource, retention: "rebuildable" });
			registered += 1;
		}
	} catch (error) {
		layerResources.dispose();
		for (let index = registered; index < resources.length; index += 1) resources[index]?.dispose();
		throw error;
	}

	const ripples = Array.from({ length: SONIC_IMPULSE_RIPPLE_CAP }, (): SonicRippleState => ({
		active: false,
		x: 0,
		z: 0,
		strength: 0,
		age: 0,
		duration: 1,
	}));
	const meteors = Array.from({ length: SONIC_METEOR_CAP }, (): SonicMeteorState => ({
		active: false,
		position: new Vector3(),
		velocity: new Vector3(),
		age: 0,
		duration: 1,
		emissionRemainder: 0,
	}));
	const trails = Array.from({ length: SONIC_TRAIL_CAP }, (): SonicTrailState => ({
		active: false,
		position: new Vector3(),
		scale: 0,
		age: 0,
		duration: 1,
	}));
	let rippleCursor = 0;
	let meteorCursor = 0;
	let trailCursor = 0;
	let triggerLatched = false;
	let meteorCooldown = 0;
	const matrix = new Matrix4();
	const position = new Vector3();
	const scale = new Vector3();
	const rotation = new Quaternion();
	const horizontal = new Euler(-Math.PI / 2, 0, 0);
	const horizontalQuaternion = new Quaternion().setFromEuler(horizontal);
	const identityQuaternion = new Quaternion();

	function hideMatrix(mesh: InstancedMesh, index: number): void {
		matrix.compose(position.set(0, -1000, 0), identityQuaternion, scale.setScalar(0.0001));
		mesh.setMatrixAt(index, matrix);
	}

	function addTrail(source: Vector3, size: number, duration: number): void {
		const trail = trails[trailCursor];
		trailCursor = (trailCursor + 1) % trails.length;
		trail.active = true;
		trail.position.copy(source);
		trail.scale = Math.max(0.01, size);
		trail.age = 0;
		trail.duration = Math.max(0.05, duration);
	}

	function addRipple(x: number, z: number, strength: number): void {
		const ripple = ripples[rippleCursor];
		rippleCursor = (rippleCursor + 1) % ripples.length;
		ripple.active = true;
		ripple.x = Number.isFinite(x) ? x : 0;
		ripple.z = Number.isFinite(z) ? z : 0;
		ripple.strength = Math.max(0, Math.min(3, Number.isFinite(strength) ? strength : 0));
		ripple.age = 0;
		ripple.duration = 0.9 + ripple.strength * 0.22;
	}

	function spawnMeteor(strength: number): void {
		const meteor = meteors[meteorCursor];
		meteorCursor = (meteorCursor + 1) % meteors.length;
		const angle = randomUnit(options.random) * Math.PI * 2;
		const radius = 2.8 + randomUnit(options.random) * 4.2;
		meteor.active = true;
		meteor.position.set(Math.cos(angle) * radius, 3.4 + randomUnit(options.random) * 2.5, Math.sin(angle) * radius);
		meteor.velocity.set(
			-Math.cos(angle) * (1.3 + strength * 0.7),
			-(2.0 + randomUnit(options.random) * 1.6),
			-Math.sin(angle) * (1.3 + strength * 0.7),
		);
		meteor.age = 0;
		meteor.duration = 0.85 + randomUnit(options.random) * 0.65;
		meteor.emissionRemainder = 0;
		addRipple(meteor.position.x * 0.18, meteor.position.z * 0.18, Math.max(0.45, strength));
	}

	function updateMatrices(timeSeconds: number, pulse: number): void {
		for (let index = 0; index < meteors.length; index += 1) {
			const meteor = meteors[index];
			if (!meteor.active) {
				hideMatrix(meteorsMesh, index);
				continue;
			}
			const life = 1 - meteor.age / meteor.duration;
			matrix.compose(
				meteor.position,
				identityQuaternion,
				scale.setScalar(Math.max(0.01, life * (0.6 + pulse * 0.5))),
			);
			meteorsMesh.setMatrixAt(index, matrix);
		}

		let trailIndex = 0;
		for (const ripple of ripples) {
			if (!ripple.active || trailIndex >= SONIC_TRAIL_CAP) continue;
			const progress = ripple.age / ripple.duration;
			matrix.compose(
				position.set(ripple.x, -0.34, ripple.z),
				horizontalQuaternion,
				scale.setScalar(0.2 + progress * (2.2 + ripple.strength * 0.8)),
			);
			trailsMesh.setMatrixAt(trailIndex, matrix);
			trailIndex += 1;
		}
		for (const trail of trails) {
			if (!trail.active || trailIndex >= SONIC_TRAIL_CAP) continue;
			const life = 1 - trail.age / trail.duration;
			matrix.compose(
				trail.position,
				horizontalQuaternion,
				scale.setScalar(Math.max(0.01, trail.scale * life)),
			);
			trailsMesh.setMatrixAt(trailIndex, matrix);
			trailIndex += 1;
		}
		for (; trailIndex < SONIC_TRAIL_CAP; trailIndex += 1) hideMatrix(trailsMesh, trailIndex);
		meteorsMesh.instanceMatrix.needsUpdate = true;
		trailsMesh.instanceMatrix.needsUpdate = true;
		meteorsMaterial.uniforms.uTime.value = timeSeconds;
		meteorsMaterial.uniforms.uPulse.value = pulse;
		trailsMaterial.uniforms.uTime.value = timeSeconds;
		trailsMaterial.uniforms.uPulse.value = pulse;
	}

	return {
		meteorsMesh,
		trailsMesh,
		meteorsGeometry,
		trailsGeometry,
		meteorsMaterial,
		trailsMaterial,
		estimatedGeometryBytes: meteorsBytes + trailsBytes,
		initialize() {
			for (let index = 0; index < SONIC_METEOR_CAP; index += 1) hideMatrix(meteorsMesh, index);
			for (let index = 0; index < SONIC_TRAIL_CAP; index += 1) hideMatrix(trailsMesh, index);
			meteorsMesh.instanceMatrix.needsUpdate = true;
			trailsMesh.instanceMatrix.needsUpdate = true;
		},
		applyPalette(palette) {
			meteorsMaterial.uniforms.uColor.value.copy(palette.warm);
			trailsMaterial.uniforms.uColor.value.copy(palette.accent);
		},
		pointerRipple(x, z, strength) {
			addRipple(x, z, strength);
		},
		update(dtSeconds, timeSeconds, audio, settings) {
			const dt = Math.max(0, Math.min(0.1, Number.isFinite(dtSeconds) ? dtSeconds : 0));
			meteorCooldown = Math.max(0, meteorCooldown - dt);
			const threshold = settings.trigger.threshold / 100;
			const sensitivity = 0.5 + settings.trigger.sensitivity / 200;
			const signal = Math.max(audio.onset, audio.triggerPulse) * sensitivity;
			const triggerHigh = signal >= threshold;
			if (
				settings.trigger.autoTrack &&
				triggerHigh &&
				!triggerLatched &&
				meteorCooldown <= 0
			) {
				const strength = Math.max(0.2, signal * (0.5 + settings.trigger.pulseStrength / 100 * 1.5));
				spawnMeteor(strength);
				meteorCooldown = 0.18;
			}
			if (!triggerHigh || signal < threshold * 0.62) triggerLatched = false;
			else triggerLatched = true;

			for (const ripple of ripples) {
				if (!ripple.active) continue;
				ripple.age += dt;
				if (ripple.age >= ripple.duration) ripple.active = false;
			}
			for (const meteor of meteors) {
				if (!meteor.active) continue;
				meteor.age += dt;
				if (meteor.age >= meteor.duration) {
					meteor.active = false;
					continue;
				}
				meteor.position.addScaledVector(meteor.velocity, dt);
				meteor.emissionRemainder += dt * 30;
				while (meteor.emissionRemainder >= 1) {
					addTrail(meteor.position, 0.16 + audio.energy * 0.14, 0.32);
					meteor.emissionRemainder -= 1;
				}
			}
			for (const trail of trails) {
				if (!trail.active) continue;
				trail.age += dt;
				if (trail.age >= trail.duration) trail.active = false;
			}
			updateMatrices(timeSeconds, Math.max(audio.triggerPulse, audio.energy * 0.45));
		},
		writeTerrainRipples(target) {
			let count = 0;
			for (const ripple of ripples) {
				if (!ripple.active || count >= target.length) continue;
				const progress = ripple.age / ripple.duration;
				target[count]?.set(
					ripple.x,
					ripple.z,
					progress * (4.0 + ripple.strength * 1.2),
					ripple.strength * (1 - progress),
				);
				count += 1;
			}
			for (let index = count; index < target.length; index += 1) target[index]?.set(0, 0, 0, 0);
			return count;
		},
		getDiagnostics() {
			return Object.freeze({
				ripples: ripples.filter((entry) => entry.active).length,
				meteors: meteors.filter((entry) => entry.active).length,
				trails: trails.filter((entry) => entry.active).length,
			});
		},
	};
}

/**
 * Sonic Topography 视觉层的 Tauri 修改版本。
 * 直接上游：XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224，public/sonic-topography-preset.js。
 * 原始项目：yin-yizhen/sonic-topography@3ff303e，作者 Ajin；适用 Non-Commercial Learning License。
 * 完整来源、许可范围与修改告知见 THIRD_PARTY_NOTICES.md。
 */
import {
	BoxGeometry,
	Color,
	DynamicDrawUsage,
	InstancedMesh,
	Matrix4,
	MeshBasicMaterial,
	NormalBlending,
	Quaternion,
	Vector3,
	type BufferGeometry,
	type Vector4,
} from "three";
import type { VisualResourceScope } from "../runtime/resource-scope";
import type { SonicAudioSnapshot } from "./sonic-audio-profile";
import type { SonicRandomSource } from "./sonic-floating-blocks";
import type { SonicPalette } from "./sonic-palette";
import type { SonicTopographySettings } from "./sonic-settings";

export const SONIC_METEOR_CAP = 20 as const;
export const SONIC_TRAIL_CAP = 200 as const;
export const SONIC_IMPULSE_RIPPLE_CAP = 10 as const;

const RIPPLE_LIFETIME_SECONDS = 4.8;
const RIPPLE_SOFT_FADE_START_SECONDS = 2.1;
const COLORED_RIPPLE_SPEED = 13;
const WHITE_RIPPLE_SPEED = 18;
const WHITE = new Color(0xffffff);

interface SonicRippleState {
	active: boolean;
	x: number;
	z: number;
	strength: number;
	white: boolean;
	age: number;
	duration: number;
}

interface SonicMeteorState {
	active: boolean;
	position: Vector3;
	speed: number;
	strength: number;
}

interface SonicTrailState {
	active: boolean;
	position: Vector3;
	velocity: Vector3;
	scale: number;
	life: number;
	maxLife: number;
}

export interface SonicImpulseDiagnostics {
	readonly ripples: number;
	readonly meteors: number;
	readonly trails: number;
}

export interface SonicImpulseLayer {
	readonly meteorsMesh: InstancedMesh<BufferGeometry, MeshBasicMaterial>;
	readonly trailsMesh: InstancedMesh<BufferGeometry, MeshBasicMaterial>;
	readonly meteorsGeometry: BufferGeometry;
	readonly trailsGeometry: BufferGeometry;
	readonly meteorsMaterial: MeshBasicMaterial;
	readonly trailsMaterial: MeshBasicMaterial;
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

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep01(value: number): number {
	const normalized = clamp(value, 0, 1);
	return normalized * normalized * (3 - 2 * normalized);
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
	const meteorsGeometry = new BoxGeometry(0.4, 1.2, 0.4);
	const trailsGeometry = new BoxGeometry(0.8, 0.8, 0.8);
	const meteorColor = options.palette.warm.clone().lerp(WHITE, 0.7);
	const meteorsMaterial = new MeshBasicMaterial({
		color: meteorColor,
		transparent: true,
		opacity: 1,
		depthWrite: false,
		toneMapped: false,
		blending: NormalBlending,
	});
	const trailsMaterial = new MeshBasicMaterial({
		color: options.palette.accent,
		transparent: true,
		opacity: 0.6,
		depthWrite: false,
		toneMapped: false,
		blending: NormalBlending,
	});
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
		white: false,
		age: 0,
		duration: 1,
	}));
	const meteors = Array.from({ length: SONIC_METEOR_CAP }, (): SonicMeteorState => ({
		active: false,
		position: new Vector3(),
		speed: 0,
		strength: 0,
	}));
	const trails = Array.from({ length: SONIC_TRAIL_CAP }, (): SonicTrailState => ({
		active: false,
		position: new Vector3(),
		velocity: new Vector3(),
		scale: 0,
		life: 0,
		maxLife: 1,
	}));
	let rippleCursor = 0;
	let meteorCursor = 0;
	let trailCursor = 0;
	let kickLatched = false;
	let snareLatched = false;
	let lastMeteorAt = Number.NEGATIVE_INFINITY;
	const matrix = new Matrix4();
	const position = new Vector3();
	const scale = new Vector3();
	const identityQuaternion = new Quaternion();

	function hideMatrix(mesh: InstancedMesh, index: number): void {
		matrix.compose(position.set(0, -1000, 0), identityQuaternion, scale.setScalar(0.0001));
		mesh.setMatrixAt(index, matrix);
	}

	function spawnTrail(source: Vector3, speedMultiplier: number): void {
		const trail = trails[trailCursor];
		trailCursor = (trailCursor + 1) % trails.length;
		trail.active = true;
		trail.position.set(
			source.x + (randomUnit(options.random) - 0.5) * 1.5,
			source.y + (randomUnit(options.random) - 0.5) * 1.5,
			source.z + (randomUnit(options.random) - 0.5) * 1.5,
		);
		trail.velocity.set(
			(randomUnit(options.random) - 0.5) * 2,
			randomUnit(options.random) * 2 + speedMultiplier * 10,
			(randomUnit(options.random) - 0.5) * 2,
		);
		trail.life = 0;
		trail.maxLife = 0.5 + randomUnit(options.random) * 0.5;
		trail.scale = randomUnit(options.random) * 0.6 + 0.2;
	}

	function addRipple(x: number, z: number, strength: number, white = false): void {
		const ripple = ripples[rippleCursor];
		rippleCursor = (rippleCursor + 1) % ripples.length;
		ripple.active = true;
		ripple.x = Number.isFinite(x) ? x : 0;
		ripple.z = Number.isFinite(z) ? z : 0;
		ripple.strength = Math.max(0.1, Math.min(3, Number.isFinite(strength) ? strength : 0.1));
		ripple.white = white;
		ripple.age = 0;
		ripple.duration = RIPPLE_LIFETIME_SECONDS;
	}

	function spawnMeteor(strength: number, timeSeconds: number): void {
		if (timeSeconds - lastMeteorAt < 0.55) return;
		lastMeteorAt = timeSeconds;
		const meteor = meteors[meteorCursor];
		meteorCursor = (meteorCursor + 1) % meteors.length;
		const angle = randomUnit(options.random) * Math.PI * 2;
		const radius = randomUnit(options.random) * 25;
		meteor.active = true;
		meteor.position.set(
			Math.cos(angle) * radius,
			30 + randomUnit(options.random) * 10,
			Math.sin(angle) * radius,
		);
		meteor.speed = 1 + randomUnit(options.random) * 0.5 + strength * 1.5;
		meteor.strength = strength;
	}

	function updateMatrices(): void {
		for (let index = 0; index < meteors.length; index += 1) {
			const meteor = meteors[index];
			if (!meteor.active) {
				hideMatrix(meteorsMesh, index);
				continue;
			}
			matrix.compose(
				meteor.position,
				identityQuaternion,
				scale.setScalar(1.5),
			);
			meteorsMesh.setMatrixAt(index, matrix);
		}

		let trailIndex = 0;
		for (const trail of trails) {
			if (!trail.active || trailIndex >= SONIC_TRAIL_CAP) continue;
			const life = 1 - trail.life / trail.maxLife;
			matrix.compose(
				trail.position,
				identityQuaternion,
				scale.setScalar(Math.max(0.01, trail.scale * life)),
			);
			trailsMesh.setMatrixAt(trailIndex, matrix);
			trailIndex += 1;
		}
		for (; trailIndex < SONIC_TRAIL_CAP; trailIndex += 1) hideMatrix(trailsMesh, trailIndex);
		meteorsMesh.instanceMatrix.needsUpdate = true;
		trailsMesh.instanceMatrix.needsUpdate = true;
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
			meteorsMaterial.color.copy(palette.warm).lerp(WHITE, 0.7);
			trailsMaterial.color.copy(palette.accent);
		},
		pointerRipple(x, z, strength) {
			addRipple(x, z, strength);
		},
		update(dtSeconds, timeSeconds, audio, settings) {
			void settings;
			const dt = Math.max(0, Math.min(0.1, Number.isFinite(dtSeconds) ? dtSeconds : 0));
			const kickEnvelope = clamp(audio.kickEnvelope, 0, 1);
			const kickActive = kickEnvelope > 0.58;
			if (kickActive && !kickLatched) {
				const angle = randomUnit(options.random) * Math.PI * 2;
				const distance = randomUnit(options.random) * 20;
				addRipple(
					Math.cos(angle) * distance,
					Math.sin(angle) * distance,
					Math.min(kickEnvelope * 2, 3),
					false,
				);
			}
			kickLatched = kickEnvelope > 0.32;

			const snareActive = audio.bands.presence > 0.52
				|| audio.bands.brilliance > 0.56;
			if (
				snareActive &&
				!snareLatched &&
				randomUnit(options.random) < 0.55
			) {
				const angle = randomUnit(options.random) * Math.PI * 2;
				const distance = 10 + randomUnit(options.random) * 35;
				addRipple(
					Math.cos(angle) * distance,
					Math.sin(angle) * distance,
					Math.min((audio.bands.presence + audio.bands.brilliance) * 1.2, 3),
					true,
				);
			}
			if (audio.bands.presence <= 0.38 && audio.bands.brilliance <= 0.42) snareLatched = false;
			else snareLatched = true;
			if (
				kickEnvelope > 0.62 &&
				randomUnit(options.random) < 0.045
			) spawnMeteor(clamp(kickEnvelope, 0.28, 0.9), timeSeconds);

			for (const ripple of ripples) {
				if (!ripple.active) continue;
				ripple.age += dt;
				if (ripple.age >= ripple.duration) ripple.active = false;
			}
			for (const meteor of meteors) {
				if (!meteor.active) continue;
				meteor.position.y -= meteor.speed * 60 * dt;
				if (meteor.position.y <= 0) {
					meteor.active = false;
					meteor.position.y = 0.5;
					addRipple(meteor.position.x, meteor.position.z, Math.min(meteor.strength, 1.2), true);
					for (let index = 0; index < 10; index += 1) {
						spawnTrail(meteor.position, meteor.speed * 1.5);
					}
					continue;
				}
				if (randomUnit(options.random) > 0.3) spawnTrail(meteor.position, meteor.speed * 0.2);
			}
			for (const trail of trails) {
				if (!trail.active) continue;
				trail.life += dt;
				if (trail.life >= trail.maxLife) {
					trail.active = false;
					continue;
				}
				trail.position.addScaledVector(trail.velocity, dt * 10);
			}
			updateMatrices();
		},
		writeTerrainRipples(target) {
			let count = 0;
			for (const ripple of ripples) {
				if (!ripple.active || count >= target.length) continue;
				const fade = 1 - smoothstep01(
					(ripple.age - RIPPLE_SOFT_FADE_START_SECONDS)
					/ (RIPPLE_LIFETIME_SECONDS - RIPPLE_SOFT_FADE_START_SECONDS),
				);
				target[count]?.set(
					ripple.x,
					ripple.z,
					ripple.age * (ripple.white ? WHITE_RIPPLE_SPEED : COLORED_RIPPLE_SPEED),
					(ripple.white ? -1 : 1) * ripple.strength * fade,
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

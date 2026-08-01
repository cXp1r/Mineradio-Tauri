import {
	AdditiveBlending,
	BoxGeometry,
	DoubleSide,
	DynamicDrawUsage,
	Group,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Quaternion,
	Vector3,
	type BufferGeometry,
	type Texture,
} from "three";
import type { SonicAudioSnapshot } from "../audio/audio-snapshot";
import type { VisualResourceScope } from "../runtime/resource-scope";
import type { SonicWorkshopPalette } from "./sonic-workshop-palette";
import {
	SONIC_WORKSHOP_RIPPLE_CAP,
	createSonicWorkshopTerrainMaterial,
	type SonicWorkshopTerrainMaterial,
} from "./sonic-workshop-shaders";
import type { SonicWorkshopSettings } from "./sonic-workshop-settings";

export const SONIC_WORKSHOP_GRID_SIZE = 160 as const;
export const SONIC_WORKSHOP_METEOR_CAP = 16 as const;
export const SONIC_WORKSHOP_PARTICLE_CAP = 160 as const;
export const SONIC_WORKSHOP_MESH_COUNT = 4 as const;
export const SONIC_WORKSHOP_DRAW_CALL_COUNT = 4 as const;

export type SonicWorkshopRandomSource = () => number;

interface WorkshopRipple {
	active: boolean;
	x: number;
	z: number;
	radius: number;
	strength: number;
	age: number;
}

interface WorkshopMeteor {
	active: boolean;
	position: Vector3;
	velocity: Vector3;
}

interface WorkshopParticle {
	active: boolean;
	position: Vector3;
	velocity: Vector3;
	age: number;
	lifetime: number;
}

export interface SonicWorkshopLayerDiagnostics {
	readonly activeRipples: number;
	readonly activeMeteors: number;
	readonly activeParticles: number;
}

export interface SonicWorkshopLayerBundle {
	readonly root: Group;
	readonly motionRoot: Group;
	readonly terrain: InstancedMesh<BufferGeometry, SonicWorkshopTerrainMaterial>;
	readonly meteors: InstancedMesh<BufferGeometry, MeshBasicMaterial>;
	readonly particles: InstancedMesh<BufferGeometry, MeshBasicMaterial>;
	readonly cover: Mesh<PlaneGeometry, MeshBasicMaterial>;
	readonly geometryBytes: number;
	readonly meshCount: typeof SONIC_WORKSHOP_MESH_COUNT;
	readonly drawCallCount: typeof SONIC_WORKSHOP_DRAW_CALL_COUNT;
	readonly terrainInstances: number;
	fillTerrain(startInclusive: number, maximumInstances: number): number;
	finalizeTerrain(): void;
	applySettings(
		settings: SonicWorkshopSettings,
		palette: SonicWorkshopPalette,
		coverTexture: Texture | null,
	): void;
	update(
		dtSeconds: number,
		timeSeconds: number,
		audio: SonicAudioSnapshot,
		settings: SonicWorkshopSettings,
	): void;
	getDiagnostics(): SonicWorkshopLayerDiagnostics;
	dispose(): void;
}

function estimateGeometryBytes(
	geometry: BufferGeometry,
	mesh?: InstancedMesh,
): number {
	let bytes = mesh?.instanceMatrix.array.byteLength ?? 0;
	for (const attribute of Object.values(geometry.attributes)) {
		bytes += attribute.array.byteLength;
	}
	if (geometry.index) bytes += geometry.index.array.byteLength;
	return bytes;
}

function normalizedRandom(random: SonicWorkshopRandomSource): number {
	const value = random();
	return Number.isFinite(value) ? value - Math.floor(value) : 0.5;
}

function clamp(value: number, minimum: number, maximum: number): number {
	const safe = Number.isFinite(value) ? value : minimum;
	return Math.max(minimum, Math.min(maximum, safe));
}

function registerGeometryMaterialMesh(
	resources: VisualResourceScope,
	owner: string,
	geometry: BufferGeometry,
	material: { dispose(): void },
	mesh: { removeFromParent(): void },
	estimatedBytes: number,
): void {
	resources.register({
		owner: `${owner}:geometry`,
		kind: "geometry",
		retention: "rebuildable",
		estimatedBytes,
		dispose: () => geometry.dispose(),
	});
	resources.register({
		owner: `${owner}:material`,
		kind: "material",
		retention: "rebuildable",
		dispose: () => material.dispose(),
	});
	resources.register({
		owner: `${owner}:mesh`,
		kind: "mesh",
		retention: "rebuildable",
		dispose: () => mesh.removeFromParent(),
	});
}

function writeHiddenMatrix(
	mesh: InstancedMesh,
	index: number,
	matrix: Matrix4,
	position: Vector3,
	quaternion: Quaternion,
	scale: Vector3,
): void {
	matrix.compose(position.set(0, -1000, 0), quaternion, scale.setScalar(0.0001));
	mesh.setMatrixAt(index, matrix);
}

export function createSonicWorkshopLayerBundle(options: {
	readonly owner: string;
	readonly resources: VisualResourceScope;
	readonly palette: SonicWorkshopPalette;
	readonly settings: SonicWorkshopSettings;
	readonly coverTexture: Texture | null;
	readonly random: SonicWorkshopRandomSource;
}): SonicWorkshopLayerBundle {
	const bundleResources = options.resources.createChild(`${options.owner}:resources`);
	const root = new Group();
	root.name = options.owner;
	const motionRoot = new Group();
	motionRoot.name = `${options.owner}:motion`;
	motionRoot.position.set(0, -4.8, -7.5);
	motionRoot.scale.setScalar(0.14);
	root.add(motionRoot);
	bundleResources.register({
		owner: `${options.owner}:root`,
		kind: "subscription",
		retention: "rebuildable",
		dispose: () => root.removeFromParent(),
	});

	const terrainGeometry = new BoxGeometry(1, 1, 1);
	const terrainMaterial = createSonicWorkshopTerrainMaterial(options.palette);
	const terrainInstances = SONIC_WORKSHOP_GRID_SIZE ** 2;
	const terrain = new InstancedMesh(
		terrainGeometry,
		terrainMaterial,
		terrainInstances,
	);
	terrain.name = "sonic-workshop-terrain";
	terrain.count = 0;
	terrain.frustumCulled = false;
	terrain.instanceMatrix.setUsage(DynamicDrawUsage);
	const terrainBytes = estimateGeometryBytes(terrainGeometry, terrain);
	registerGeometryMaterialMesh(
		bundleResources,
		`${options.owner}:terrain`,
		terrainGeometry,
		terrainMaterial,
		terrain,
		terrainBytes,
	);

	const meteorGeometry = new BoxGeometry(0.7, 4.2, 0.7);
	const meteorMaterial = new MeshBasicMaterial({
		color: options.palette.peak,
		transparent: true,
		opacity: 0.92,
		depthWrite: false,
		blending: AdditiveBlending,
	});
	const meteors = new InstancedMesh(
		meteorGeometry,
		meteorMaterial,
		SONIC_WORKSHOP_METEOR_CAP,
	);
	meteors.name = "sonic-workshop-meteors";
	meteors.count = SONIC_WORKSHOP_METEOR_CAP;
	meteors.frustumCulled = false;
	meteors.instanceMatrix.setUsage(DynamicDrawUsage);
	const meteorBytes = estimateGeometryBytes(meteorGeometry, meteors);
	registerGeometryMaterialMesh(
		bundleResources,
		`${options.owner}:meteors`,
		meteorGeometry,
		meteorMaterial,
		meteors,
		meteorBytes,
	);

	const particleGeometry = new BoxGeometry(0.38, 0.38, 0.38);
	const particleMaterial = new MeshBasicMaterial({
		color: options.palette.ripple,
		transparent: true,
		opacity: 0.72,
		depthWrite: false,
		blending: AdditiveBlending,
	});
	const particles = new InstancedMesh(
		particleGeometry,
		particleMaterial,
		SONIC_WORKSHOP_PARTICLE_CAP,
	);
	particles.name = "sonic-workshop-particles";
	particles.count = SONIC_WORKSHOP_PARTICLE_CAP;
	particles.frustumCulled = false;
	particles.instanceMatrix.setUsage(DynamicDrawUsage);
	const particleBytes = estimateGeometryBytes(particleGeometry, particles);
	registerGeometryMaterialMesh(
		bundleResources,
		`${options.owner}:particles`,
		particleGeometry,
		particleMaterial,
		particles,
		particleBytes,
	);

	const coverGeometry = new PlaneGeometry(2.5, 2.5);
	const coverMaterial = new MeshBasicMaterial({
		color: 0xffffff,
		map: options.coverTexture,
		transparent: true,
		opacity: 0.82,
		depthWrite: false,
		side: DoubleSide,
	});
	const cover = new Mesh(coverGeometry, coverMaterial);
	cover.name = "sonic-workshop-cover";
	cover.position.set(-3.8, 1.4, -4);
	const coverBytes = estimateGeometryBytes(coverGeometry);
	registerGeometryMaterialMesh(
		bundleResources,
		`${options.owner}:cover`,
		coverGeometry,
		coverMaterial,
		cover,
		coverBytes,
	);

	motionRoot.add(terrain, meteors, particles);
	root.add(cover);

	const ripples = Array.from(
		{ length: SONIC_WORKSHOP_RIPPLE_CAP },
		(): WorkshopRipple => ({
			active: false,
			x: 0,
			z: 0,
			radius: 0,
			strength: 0,
			age: 0,
		}),
	);
	const meteorStates = Array.from(
		{ length: SONIC_WORKSHOP_METEOR_CAP },
		(): WorkshopMeteor => ({
			active: false,
			position: new Vector3(),
			velocity: new Vector3(),
		}),
	);
	const particleStates = Array.from(
		{ length: SONIC_WORKSHOP_PARTICLE_CAP },
		(): WorkshopParticle => ({
			active: false,
			position: new Vector3(),
			velocity: new Vector3(),
			age: 0,
			lifetime: 1,
		}),
	);
	let rippleCursor = 0;
	let meteorCursor = 0;
	let particleCursor = 0;
	let lowLatched = false;
	let highLatched = false;
	let lastMeteorAt = Number.NEGATIVE_INFINITY;
	let yaw = 0;
	const matrix = new Matrix4();
	const position = new Vector3();
	const scale = new Vector3();
	const quaternion = new Quaternion();

	for (let index = 0; index < SONIC_WORKSHOP_METEOR_CAP; index += 1) {
		writeHiddenMatrix(meteors, index, matrix, position, quaternion, scale);
	}
	for (let index = 0; index < SONIC_WORKSHOP_PARTICLE_CAP; index += 1) {
		writeHiddenMatrix(particles, index, matrix, position, quaternion, scale);
	}
	meteors.instanceMatrix.needsUpdate = true;
	particles.instanceMatrix.needsUpdate = true;

	function addRipple(x: number, z: number, strength: number): void {
		const ripple = ripples[rippleCursor];
		rippleCursor = (rippleCursor + 1) % ripples.length;
		if (!ripple) return;
		ripple.active = true;
		ripple.x = x;
		ripple.z = z;
		ripple.radius = 0;
		ripple.strength = clamp(strength, 0.1, 1.4);
		ripple.age = 0;
	}

	function spawnParticle(source: Vector3, strength: number): void {
		const particle = particleStates[particleCursor];
		particleCursor = (particleCursor + 1) % particleStates.length;
		if (!particle) return;
		particle.active = true;
		particle.position.copy(source);
		particle.velocity.set(
			(normalizedRandom(options.random) - 0.5) * 18,
			5 + normalizedRandom(options.random) * 18 * strength,
			(normalizedRandom(options.random) - 0.5) * 18,
		);
		particle.age = 0;
		particle.lifetime = 0.45 + normalizedRandom(options.random) * 0.75;
	}

	function spawnMeteor(timeSeconds: number, strength: number): void {
		if (timeSeconds - lastMeteorAt < 0.5) return;
		lastMeteorAt = timeSeconds;
		const meteor = meteorStates[meteorCursor];
		meteorCursor = (meteorCursor + 1) % meteorStates.length;
		if (!meteor) return;
		meteor.active = true;
		meteor.position.set(
			(normalizedRandom(options.random) - 0.5) * 64,
			30 + normalizedRandom(options.random) * 22,
			(normalizedRandom(options.random) - 0.5) * 64,
		);
		meteor.velocity.set(
			(normalizedRandom(options.random) - 0.5) * 4,
			-(24 + strength * 28),
			(normalizedRandom(options.random) - 0.5) * 4,
		);
	}

	function updateImpulses(
		dtSeconds: number,
		timeSeconds: number,
		audio: SonicAudioSnapshot,
		settings: SonicWorkshopSettings,
	): void {
		const gain = settings.inputGain / 82;
		const low = Math.max(
			audio.kickEnvelope,
			audio.lowDrive,
			audio.bands.subBass,
			audio.bands.bass,
		) * gain;
		if (low > 0.52 && !lowLatched) {
			addRipple(
				(normalizedRandom(options.random) - 0.5) * 34,
				(normalizedRandom(options.random) - 0.5) * 34,
				low,
			);
		}
		lowLatched = low > 0.3;
		const high = Math.max(
			audio.bands.presence,
			audio.bands.brilliance,
			audio.bands.air,
			audio.snap,
		) * gain;
		if (high > 0.55 && !highLatched) spawnMeteor(timeSeconds, high);
		highLatched = high > 0.34;

		for (const ripple of ripples) {
			if (!ripple.active) continue;
			ripple.age += dtSeconds;
			ripple.radius += dtSeconds * (11 + ripple.strength * 7);
			ripple.strength *= Math.exp(-dtSeconds * 0.58);
			if (ripple.age >= 4.4 || ripple.strength < 0.025) ripple.active = false;
		}
		for (const meteor of meteorStates) {
			if (!meteor.active) continue;
			meteor.position.addScaledVector(meteor.velocity, dtSeconds);
			if (meteor.position.y > 0) continue;
			meteor.active = false;
			meteor.position.y = 0;
			addRipple(meteor.position.x, meteor.position.z, 1.1);
			for (let index = 0; index < 14; index += 1) spawnParticle(meteor.position, 1);
		}
		for (const particle of particleStates) {
			if (!particle.active) continue;
			particle.age += dtSeconds;
			if (particle.age >= particle.lifetime) {
				particle.active = false;
				continue;
			}
			particle.velocity.y -= 18 * dtSeconds;
			particle.position.addScaledVector(particle.velocity, dtSeconds);
		}
	}

	function updateMatrices(): void {
		for (let index = 0; index < meteorStates.length; index += 1) {
			const meteor = meteorStates[index];
			if (!meteor?.active) {
				writeHiddenMatrix(meteors, index, matrix, position, quaternion, scale);
				continue;
			}
			matrix.compose(meteor.position, quaternion, scale.set(1, 1, 1));
			meteors.setMatrixAt(index, matrix);
		}
		for (let index = 0; index < particleStates.length; index += 1) {
			const particle = particleStates[index];
			if (!particle?.active) {
				writeHiddenMatrix(particles, index, matrix, position, quaternion, scale);
				continue;
			}
			const remaining = 1 - particle.age / particle.lifetime;
			matrix.compose(
				particle.position,
				quaternion,
				scale.setScalar(Math.max(0.03, remaining)),
			);
			particles.setMatrixAt(index, matrix);
		}
		meteors.instanceMatrix.needsUpdate = true;
		particles.instanceMatrix.needsUpdate = true;
	}

	const bundle: SonicWorkshopLayerBundle = {
		root,
		motionRoot,
		terrain,
		meteors,
		particles,
		cover,
		geometryBytes: terrainBytes + meteorBytes + particleBytes + coverBytes,
		meshCount: SONIC_WORKSHOP_MESH_COUNT,
		drawCallCount: SONIC_WORKSHOP_DRAW_CALL_COUNT,
		terrainInstances,
		fillTerrain(startInclusive, maximumInstances) {
			const start = Math.max(0, Math.min(terrainInstances, Math.floor(startInclusive)));
			const end = Math.min(
				terrainInstances,
				start + Math.max(1, Math.floor(maximumInstances)),
			);
			const spacing = 96 / SONIC_WORKSHOP_GRID_SIZE;
			const offset = (SONIC_WORKSHOP_GRID_SIZE - 1) * spacing / 2;
			for (let index = start; index < end; index += 1) {
				const x = Math.floor(index / SONIC_WORKSHOP_GRID_SIZE) * spacing - offset;
				const z = (index % SONIC_WORKSHOP_GRID_SIZE) * spacing - offset;
				matrix.compose(
					position.set(x, 0.5, z),
					quaternion,
					scale.set(spacing * 0.78, 1, spacing * 0.78),
				);
				terrain.setMatrixAt(index, matrix);
			}
			return end;
		},
		finalizeTerrain() {
			terrain.count = terrainInstances;
			terrain.instanceMatrix.needsUpdate = true;
		},
		applySettings(settings, palette, sharedCoverTexture) {
			const uniforms = terrainMaterial.uniforms;
			uniforms.uInputGain.value = settings.inputGain / 100;
			uniforms.uAudioIntensity.value = settings.audioIntensity;
			uniforms.uResponseRange.value = settings.responseRange;
			uniforms.uPeakIntensity.value = settings.peakIntensity;
			uniforms.uPrimary.value.copy(palette.primary);
			uniforms.uBase.value.copy(palette.base);
			uniforms.uWarm.value.copy(palette.warm);
			uniforms.uCool.value.copy(palette.cool);
			uniforms.uRipple.value.copy(palette.ripple);
			uniforms.uPeak.value.copy(palette.peak);
			meteorMaterial.color.copy(palette.peak);
			particleMaterial.color.copy(palette.ripple);
			if (coverMaterial.map !== sharedCoverTexture) {
				coverMaterial.map = sharedCoverTexture;
				coverMaterial.needsUpdate = true;
			}
			cover.visible = settings.showCover && sharedCoverTexture !== null;
		},
		update(dtSeconds, timeSeconds, audio, settings) {
			const dt = clamp(dtSeconds, 0, 0.1);
			const uniforms = terrainMaterial.uniforms;
			uniforms.uTime.value = timeSeconds;
			uniforms.uBands.value.set([
				audio.bands.subBass,
				audio.bands.bass,
				audio.bands.lowMid,
				audio.bands.mid,
				audio.bands.highMid,
				audio.bands.presence,
				audio.bands.brilliance,
				audio.bands.air,
			]);
			updateImpulses(dt, timeSeconds, audio, settings);
			let rippleCount = 0;
			for (const ripple of ripples) {
				if (!ripple.active || rippleCount >= SONIC_WORKSHOP_RIPPLE_CAP) continue;
				uniforms.uRipples.value[rippleCount]?.set(
					ripple.x,
					ripple.z,
					ripple.radius,
					ripple.strength,
				);
				rippleCount += 1;
			}
			for (let index = rippleCount; index < SONIC_WORKSHOP_RIPPLE_CAP; index += 1) {
				uniforms.uRipples.value[index]?.set(0, 0, 0, 0);
			}
			uniforms.uRippleCount.value = rippleCount;
			if (settings.autoRotate) {
				yaw += dt * settings.rotationSpeed * 0.012;
			}
			motionRoot.rotation.y = yaw;
			updateMatrices();
		},
		getDiagnostics() {
			return Object.freeze({
				activeRipples: ripples.filter((entry) => entry.active).length,
				activeMeteors: meteorStates.filter((entry) => entry.active).length,
				activeParticles: particleStates.filter((entry) => entry.active).length,
			});
		},
		dispose() {
			bundleResources.dispose();
		},
	};
	bundle.applySettings(options.settings, options.palette, options.coverTexture);
	return bundle;
}

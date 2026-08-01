import { expect, test } from "bun:test";
import { Scene, type InstancedMesh } from "three";
import type { AudioSnapshot, SonicAudioSnapshot } from "../audio/audio-snapshot";
import type { FrameContext } from "../runtime/frame-context";
import { createBudgetTaskQueue, type BudgetTaskQueue } from "../runtime/budget-task-queue";
import { createCancellationScope } from "../runtime/cancellation-scope";
import {
	createVisualResourceLedger,
	type VisualResourceLedger,
	type VisualResourcePriority,
} from "../runtime/resource-ledger";
import {
	createVisualResourceScope,
	type VisualResourceRegistration,
	type VisualResourceScope,
} from "../runtime/resource-scope";
import { createVisualSubsystemDiagnosticsRegistry } from "../runtime/subsystem-diagnostics";
import { createSonicAudioProfile } from "./sonic-audio-profile";
import { smoothSonicGroundBands, writeSonicGroundEqTarget } from "./sonic-runtime-mapping";
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";
import {
	createSonicTopographyRuntime,
	type SonicBuildPhaseInfo,
} from "./sonic-topography";
import type { SonicTerrainMaterial } from "./sonic-shaders";

function createSonicSnapshot(
	overrides: Partial<SonicAudioSnapshot> = {},
): SonicAudioSnapshot {
	return Object.freeze({
		spectrum: null,
		bands: Object.freeze({
			subBass: 0,
			bass: 0,
			lowMid: 0,
			mid: 0,
			highMid: 0,
			presence: 0,
			brilliance: 0,
			air: 0,
			...overrides.bands,
		}),
		kickSub: 0,
		kickCore: 0,
		kickPunch: 0,
		body: 0,
		vocal: 0,
		snap: 0,
		lowDrive: 0,
		dominance: 0,
		energy: 0,
		warmth: 0,
		brightness: 0,
		sharpness: 0,
		smoothness: 0,
		density: 0,
		onset: 0,
		flux: 0,
		confidence: 0,
		triggerPulse: 0,
		kickEnvelope: 0,
		...overrides,
	});
}

function createLedgerBackedScope(
	raw: VisualResourceScope,
	ledger: VisualResourceLedger,
): VisualResourceScope {
	function usageFor(registration: VisualResourceRegistration) {
		if (registration.kind === "mesh") return { meshCount: 1 };
		if (registration.kind === "geometry" && registration.estimatedBytes !== undefined) {
			return { geometryBytes: registration.estimatedBytes };
		}
		if (registration.kind === "texture" && registration.estimatedBytes !== undefined) {
			return { textureBytes: registration.estimatedBytes };
		}
		if (registration.kind === "cache" && registration.estimatedBytes !== undefined) {
			return { cacheBytes: registration.estimatedBytes };
		}
		return null;
	}

	return {
		get name() {
			return raw.name;
		},
		get closed() {
			return raw.closed;
		},
		isOpen: () => raw.isOpen(),
		register(registration) {
			const usage = usageFor(registration);
			const priority: VisualResourcePriority = registration.kind === "cache"
				? "background"
				: registration.retention === "persistent"
					? "essential"
					: registration.retention === "rebuildable"
						? "normal"
						: "optional";
			const admission = usage ? ledger.admit(usage, priority) : null;
			if (usage && (!admission?.admitted || !admission.allocation)) {
				throw new Error(`resource admission denied for ${registration.owner}`);
			}
			const allocation = admission?.allocation ?? null;
			try {
				return raw.register({
					...registration,
					dispose() {
						try {
							registration.dispose();
						} finally {
							allocation?.release();
						}
					},
				});
			} catch (error) {
				allocation?.release();
				throw error;
			}
		},
		createChild(name) {
			return createLedgerBackedScope(raw.createChild(name), ledger);
		},
		releaseRetention: (retention) => raw.releaseRetention(retention),
		dispose: () => raw.dispose(),
	};
}

function createHarness(
	beforeBuildPhase?: (phase: SonicBuildPhaseInfo) => void,
	visualRotation?: () => { x: number; y: number },
	random: () => number = () => 0.375,
) {
	const scene = new Scene();
	const cancellation = createCancellationScope("sonic-root");
	const ledger = createVisualResourceLedger({
		budget: {
			textureBytes: 1,
			geometryBytes: 32 * 1024 * 1024,
			meshCount: 32,
			queuedTaskCost: 64,
			cacheBytes: 1,
		},
	});
	const resources = createLedgerBackedScope(createVisualResourceScope("sonic-root"), ledger);
	const tasks = createBudgetTaskQueue({ ledger, resourceScope: resources, cancellationScope: cancellation });
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const audio = createSonicAudioProfile();
	const runtime = createSonicTopographyRuntime(
		{
			scene,
			renderer: {} as never,
			resources,
			cancellation,
			tasks,
			diagnostics,
			audio: () => audio.getSnapshot(),
			random,
			visualRotation,
		},
		{ beforeBuildPhase },
	);
	return { scene, resources, cancellation, ledger, tasks, diagnostics, runtime };
}

async function drainBuild(tasks: BudgetTaskQueue, isIdle: () => boolean): Promise<void> {
	for (let index = 0; index < 256 && !isIdle(); index += 1) {
		tasks.runSlice(1);
		await Promise.resolve();
		await Promise.resolve();
	}
	expect(isIdle()).toBe(true);
}

test("plugin activation owns exactly four meshes and releases them exactly once across re-entry", async () => {
	const { scene, ledger, tasks, diagnostics, runtime } = createHarness();
	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);

	const firstRoot = scene.getObjectByName("sonic-topography-root");
	expect(firstRoot).toBeDefined();
	expect(firstRoot?.children.map((child) => child.name).sort()).toEqual([
		"sonic-floating-blocks",
		"sonic-meteors",
		"sonic-terrain",
		"sonic-trails",
	]);
	const activeDiagnostics = runtime.getDiagnostics();
	expect(activeDiagnostics.active).toBe(true);
	expect(activeDiagnostics.meshCount).toBe(4);
	expect(activeDiagnostics.materialCount).toBe(4);
	expect(activeDiagnostics.textureCount).toBe(0);
	expect(activeDiagnostics.floatingInstances).toBe(80);
	expect(activeDiagnostics.meteorCapacity).toBe(20);
	expect(activeDiagnostics.trailCapacity).toBe(200);
	expect(activeDiagnostics.totalInstances).toBeLessThanOrEqual(50_496);
	expect(diagnostics.snapshot().sonicTopography?.meshCount).toBe(4);
	expect(ledger.getSnapshot().current.meshCount).toBe(4);
	expect(ledger.getSnapshot().current.geometryBytes).toBeGreaterThan(0);

	let geometryDisposals = 0;
	let materialDisposals = 0;
	for (const child of firstRoot?.children ?? []) {
		const mesh = child as InstancedMesh;
		mesh.geometry.addEventListener("dispose", () => geometryDisposals += 1);
		const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
		material?.addEventListener("dispose", () => materialDisposals += 1);
	}
	runtime.deactivate();
	runtime.deactivate();
	expect(scene.getObjectByName("sonic-topography-root")).toBeUndefined();
	expect(geometryDisposals).toBe(4);
	expect(materialDisposals).toBe(4);
	expect(runtime.getDiagnostics().meshCount).toBe(0);
	expect(ledger.getSnapshot().current.meshCount).toBe(0);
	expect(ledger.getSnapshot().current.geometryBytes).toBe(0);

	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	expect(scene.getObjectByName("sonic-topography-root")).not.toBe(firstRoot);
	runtime.dispose();
	runtime.dispose();
	expect(scene.getObjectByName("sonic-topography-root")).toBeUndefined();
	expect(diagnostics.snapshot().sonicTopography).toBeUndefined();
});

test("plugin root applies the Electron 2.0.2 ground range, lower, and depth layout", async () => {
	const { scene, tasks, runtime } = createHarness();
	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);

	const root = scene.getObjectByName("sonic-topography-root");
	expect(root).toBeDefined();
	expect(root?.scale.x).toBeCloseTo(0.15504, 6);
	expect(root?.scale.y).toBeCloseTo(0.15504, 6);
	expect(root?.scale.z).toBeCloseTo(0.15504, 6);
	expect(root?.position.y).toBeCloseTo(-6.362, 6);
	expect(root?.position.z).toBeCloseTo(-7.61, 6);

	runtime.dispose();
});

test("plugin update forwards raw bands and detailed Sonic response uniforms", async () => {
	const { scene, tasks, runtime } = createHarness();
	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	const sonic = createSonicSnapshot({
		bands: Object.freeze({
			subBass: 0.41,
			bass: 0.32,
			lowMid: 0.23,
			mid: 0.14,
			highMid: 0.15,
			presence: 0.26,
			brilliance: 0.37,
			air: 0.48,
		}),
		kickCore: 0.95,
		triggerPulse: 0.4,
		kickEnvelope: 0.31,
		energy: 0.61,
		warmth: 0.52,
		brightness: 0.43,
		sharpness: 0.34,
		smoothness: 0.25,
		density: 0.76,
	});
	runtime.update({
		dt: 1,
		now: 1_000,
		snapshot: { sonic } as AudioSnapshot,
		uniforms: {} as never,
		scene,
		camera: {} as never,
		pointerParallax: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
	} as FrameContext);

	const terrain = scene.getObjectByName("sonic-terrain") as InstancedMesh<never, SonicTerrainMaterial>;
	const expectedTarget = new Float32Array(8);
	writeSonicGroundEqTarget(
		expectedTarget,
		new Float32Array([0.41, 0.32, 0.23, 0.14, 0.15, 0.26, 0.37, 0.48]),
		0.31,
		SONIC_TOPOGRAPHY_DEFAULTS.eq,
	);
	const expectedBands = smoothSonicGroundBands(
		new Float32Array(8),
		expectedTarget,
		SONIC_TOPOGRAPHY_DEFAULTS.terrain.motionSpeed,
		1,
	);
	for (let index = 0; index < expectedBands.length; index += 1) {
		expect(terrain.material.uniforms.uBands.value[index]).toBeCloseTo(expectedBands[index] ?? 0, 6);
	}
	expect(terrain.material.uniforms.uKickEnvelope.value).toBe(0.31);
	const eqAverage = Object.values(SONIC_TOPOGRAPHY_DEFAULTS.eq)
		.reduce((sum, value) => sum + value, 0) / 8;
	const low = expectedBands[0] + expectedBands[1] + expectedBands[2] + expectedBands[3];
	const high = expectedBands[5] + expectedBands[6] + expectedBands[7];
	expect(terrain.material.uniforms.uEnergy.value).toBeCloseTo(0.61 * (0.25 + eqAverage / 50 * 0.75), 6);
	expect(terrain.material.uniforms.uWarmth.value).toBeCloseTo(low / (low + high), 6);
	expect(terrain.material.uniforms.uBrightness.value).toBeCloseTo(high / (low + high), 6);
	expect(terrain.material.uniforms.uSharpness.value).toBe(0.34);
	expect(terrain.material.uniforms.uSmoothness.value).toBe(0.25);
	expect(terrain.material.uniforms.uDensity.value).toBe(0.76);
	expect(scene.getObjectByName("sonic-topography-root")?.rotation.y).toBeCloseTo(0.15, 8);

	runtime.dispose();
});

test("Sonic motion time and auto-yaw remain continuous across live speed settings", async () => {
	const { scene, tasks, runtime } = createHarness();
	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	const frame = {
		dt: 1,
		now: 1_000,
		snapshot: { sonic: createSonicSnapshot() } as AudioSnapshot,
		uniforms: {} as never,
		scene,
		camera: {} as never,
		pointerParallax: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
	} as FrameContext;
	runtime.update(frame);
	const root = scene.getObjectByName("sonic-topography-root");
	const terrain = scene.getObjectByName("sonic-terrain") as InstancedMesh<never, SonicTerrainMaterial>;
	expect(terrain.material.uniforms.uTime.value).toBeCloseTo(1.3, 8);
	expect(root?.rotation.y).toBeCloseTo(0.15, 8);

	runtime.configure({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, motionSpeed: 0, autoRotate: 0 },
	}, "eco");
	runtime.update({ ...frame, now: 2_000 } as FrameContext);
	expect(scene.getObjectByName("sonic-topography-root")).toBe(root);
	expect(terrain.material.uniforms.uTime.value).toBeCloseTo(1.75, 8);
	expect(root?.rotation.y).toBeCloseTo(0.15, 8);
	runtime.dispose();
});

test("plugin composes shared gesture rotation with the Electron auto-yaw", async () => {
	const gesture = { x: 0.2, y: -0.4 };
	const { scene, tasks, runtime } = createHarness(undefined, () => gesture);
	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	runtime.update({
		dt: 1,
		now: 1_000,
		snapshot: { sonic: createSonicSnapshot() } as AudioSnapshot,
		uniforms: {} as never,
		scene,
		camera: {} as never,
		pointerParallax: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
	} as FrameContext);

	const root = scene.getObjectByName("sonic-topography-root");
	expect(root?.rotation.x).toBeCloseTo(0.2, 8);
	expect(root?.rotation.y).toBeCloseTo(-0.25, 8);
	runtime.dispose();
});

test("each Sonic generation owns its random stream so pending rebuilds cannot perturb active impulses", async () => {
	let sourceCalls = 0;
	const { scene, tasks, runtime } = createHarness(undefined, undefined, () => {
		sourceCalls += 1;
		return 0;
	});
	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	const afterActivation = sourceCalls;
	const frame = {
		dt: 1 / 60,
		now: 1_000,
		snapshot: { sonic: createSonicSnapshot({ kickSub: 1, kickCore: 1, triggerPulse: 1, kickEnvelope: 1 }) } as AudioSnapshot,
		uniforms: {} as never,
		scene,
		camera: {} as never,
		pointerParallax: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
	} as FrameContext;
	runtime.update(frame);
	expect(sourceCalls).toBe(afterActivation);

	runtime.configure({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, density: 70 },
	}, "balanced");
	const afterPendingGenerationStarted = sourceCalls;
	runtime.update({ ...frame, now: 1_016 } as FrameContext);
	expect(sourceCalls).toBe(afterPendingGenerationStarted);
	runtime.dispose();
});

test("failed density rebuild keeps the previously committed layer", async () => {
	let failGeneration = -1;
	const { scene, tasks, runtime } = createHarness((phase) => {
		if (phase.generation === failGeneration && phase.kind === "terrain") {
			throw new Error("injected terrain failure");
		}
	});
	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	const committed = scene.getObjectByName("sonic-topography-root");
	failGeneration = runtime.getDiagnostics().generation + 1;
	runtime.configure({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, density: 70 },
	}, "balanced");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);

	expect(scene.getObjectByName("sonic-topography-root")).toBe(committed);
	expect(runtime.getDiagnostics().buildFailures).toBe(1);
	expect(runtime.getDiagnostics().lastFailure).toContain("injected terrain failure");
	runtime.configure({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, density: 70 },
	}, "balanced");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	expect(scene.getObjectByName("sonic-topography-root")).not.toBe(committed);
	expect(runtime.getDiagnostics().committedGeneration).toBe(3);
	runtime.dispose();
});

test("settings drag cancels the previous cooperative generation and only commits the latest", async () => {
	const { scene, tasks, runtime } = createHarness();
	runtime.activate({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, density: 0 },
	}, "eco");
	tasks.runSlice(1);
	await Promise.resolve();
	await Promise.resolve();
	runtime.configure({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, density: 100 },
	}, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);

	const root = scene.getObjectByName("sonic-topography-root");
	expect(root?.userData.sonicGeneration).toBe(2);
	expect(runtime.getDiagnostics().committedGeneration).toBe(2);
	expect(runtime.getDiagnostics().cancelledBuilds).toBeGreaterThanOrEqual(1);
	expect((root?.getObjectByName("sonic-terrain") as InstancedMesh).count).toBe(112 * 112);
	runtime.dispose();
});

test("deactivate cancels an in-flight build and leaves no dormant scene root", async () => {
	const { scene, tasks, runtime } = createHarness();
	runtime.activate({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, density: 100 },
	}, "ultra");
	tasks.runSlice(1);
	await Promise.resolve();
	await Promise.resolve();
	expect(runtime.getDiagnostics().pendingRebuilds).toBe(1);
	runtime.deactivate();
	for (let index = 0; index < 8; index += 1) {
		tasks.runSlice(8);
		await Promise.resolve();
	}
	expect(scene.getObjectByName("sonic-topography-root")).toBeUndefined();
	expect(runtime.getDiagnostics().pendingRebuilds).toBe(0);
	expect(runtime.getDiagnostics().residentMeshCount).toBe(0);
	expect(runtime.getDiagnostics().cancelledBuilds).toBeGreaterThanOrEqual(1);
	runtime.dispose();
});

test("ultra quality respects the frozen 50,496 total-instance ceiling", async () => {
	const { tasks, runtime } = createHarness();
	runtime.activate({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, density: 100 },
		floating: { ...SONIC_TOPOGRAPHY_DEFAULTS.floating, count: 100 },
	}, "ultra");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	const diagnostics = runtime.getDiagnostics();
	expect(diagnostics.terrainGrid).toBe(224);
	expect(diagnostics.totalInstances).toBe(50_496);
	expect(diagnostics.textureCount).toBe(0);
	runtime.dispose();
});

test("non-structural settings and equivalent derived grids update in place", async () => {
	const { scene, tasks, runtime } = createHarness();
	runtime.activate(SONIC_TOPOGRAPHY_DEFAULTS, "eco");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	const root = scene.getObjectByName("sonic-topography-root");
	const generation = runtime.getDiagnostics().generation;
	runtime.configure({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: {
			...SONIC_TOPOGRAPHY_DEFAULTS.terrain,
			density: 47,
			range: 20,
			lower: 15,
			depth: 10,
		},
		floating: {
			...SONIC_TOPOGRAPHY_DEFAULTS.floating,
			minSize: 40,
			maxSize: 70,
		},
	}, "eco");

	expect(runtime.getDiagnostics().pendingRebuilds).toBe(0);
	expect(runtime.getDiagnostics().generation).toBe(generation);
	expect(scene.getObjectByName("sonic-topography-root")).toBe(root);
	expect(root?.scale.x).toBeCloseTo(0.1104, 6);

	runtime.configure({
		...SONIC_TOPOGRAPHY_DEFAULTS,
		floating: { ...SONIC_TOPOGRAPHY_DEFAULTS.floating, count: 81 },
	}, "eco");
	expect(runtime.getDiagnostics().pendingRebuilds).toBe(1);
	expect(runtime.getDiagnostics().generation).toBe(generation + 1);
	runtime.dispose();
});

test("transaction diagnostics distinguish the rendered cap from pending resident allocations", async () => {
	const { ledger, tasks, runtime } = createHarness();
	const ultra = {
		...SONIC_TOPOGRAPHY_DEFAULTS,
		terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, density: 100 },
		floating: { ...SONIC_TOPOGRAPHY_DEFAULTS.floating, count: 100 },
	};
	runtime.activate(ultra, "ultra");
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	runtime.configure({
		...ultra,
		floating: { ...ultra.floating, count: 99 },
	}, "ultra");
	const pending = runtime.getDiagnostics();
	expect(pending.totalInstances).toBe(50_496);
	expect(pending.residentInstances).toBe(100_991);
	expect(pending.peakInstances).toBe(100_991);
	expect(pending.residentMeshCount).toBe(8);
	expect(pending.residentGeometryBytes).toBe(pending.peakGeometryBytes);
	expect(pending.geometryPressure).toBe("hard");
	expect(ledger.getSnapshot().current.meshCount).toBe(pending.residentMeshCount);
	expect(ledger.getSnapshot().current.geometryBytes).toBe(pending.residentGeometryBytes);
	runtime.dispose();
	expect(ledger.getSnapshot().current.meshCount).toBe(0);
	expect(ledger.getSnapshot().current.geometryBytes).toBe(0);
});

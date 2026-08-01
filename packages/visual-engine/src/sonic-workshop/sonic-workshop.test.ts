import { expect, test } from "bun:test";
import { Scene, Texture, type BufferGeometry, type Material } from "three";
import type { SonicAudioSnapshot } from "../audio/audio-snapshot";
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
import { SONIC_WORKSHOP_DEFAULTS } from "./sonic-workshop-settings";
import {
	SONIC_WORKSHOP_GRID_SIZE,
	SONIC_WORKSHOP_HARD_BUDGET,
	SONIC_WORKSHOP_ROOT_NAME,
	createSonicWorkshopRuntime,
	type SonicWorkshopRuntimeDependencies,
} from "./sonic-workshop";

function createAudioSnapshot(
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

function createHarness(dependencies: SonicWorkshopRuntimeDependencies = {}) {
	const scene = new Scene();
	const cancellation = createCancellationScope("workshop-test");
	const ledger = createVisualResourceLedger({
		budget: {
			textureBytes: 16 * 1024 * 1024,
			geometryBytes: 8 * 1024 * 1024,
			meshCount: 8,
			queuedTaskCost: 32,
			cacheBytes: 16 * 1024 * 1024,
		},
	});
	const resources = createLedgerBackedScope(
		createVisualResourceScope("workshop-test"),
		ledger,
	);
	const tasks = createBudgetTaskQueue({
		ledger,
		resourceScope: resources,
		cancellationScope: cancellation,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const coverTexture = new Texture();
	const runtime = createSonicWorkshopRuntime(
		{
			scene,
			renderer: {} as never,
			resources,
			cancellation,
			tasks,
			diagnostics,
			audio: () => createAudioSnapshot(),
			media: () => ({
				trackKey: "track-1",
				title: "Test Track",
				artist: "Test Artist",
				coverTexture,
				playing: true,
			}),
			random: () => 0.375,
		},
		dependencies,
	);
	return {
		scene,
		ledger,
		resources,
		cancellation,
		tasks,
		diagnostics,
		coverTexture,
		runtime,
	};
}

async function drainBuild(tasks: BudgetTaskQueue, isIdle: () => boolean): Promise<void> {
	for (let index = 0; index < 128 && !isIdle(); index += 1) {
		tasks.runSlice(4);
		await Promise.resolve();
		await Promise.resolve();
	}
	expect(isIdle()).toBe(true);
}

test("activation commits one fixed 160x160 Workshop bundle with four meshes", async () => {
	const { scene, ledger, tasks, runtime } = createHarness();
	runtime.activate({ ...SONIC_WORKSHOP_DEFAULTS, active: true });
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);

	const root = scene.getObjectByName(SONIC_WORKSHOP_ROOT_NAME);
	expect(root).toBeDefined();
	const meshNames: string[] = [];
	root?.traverse((object) => {
		if ("isMesh" in object && object.isMesh === true) meshNames.push(object.name);
	});
	expect(meshNames.sort()).toEqual([
		"sonic-workshop-cover",
		"sonic-workshop-meteors",
		"sonic-workshop-particles",
		"sonic-workshop-terrain",
	]);
	const snapshot = runtime.getDiagnostics();
	expect(snapshot.active).toBe(true);
	expect(snapshot.terrainGrid).toBe(SONIC_WORKSHOP_GRID_SIZE);
	expect(snapshot.terrainInstances).toBe(SONIC_WORKSHOP_GRID_SIZE ** 2);
	expect(snapshot.meshCount).toBe(4);
	expect(snapshot.textureBytes).toBe(0);
	expect(snapshot.cacheBytes).toBe(0);
	expect(ledger.getSnapshot().current.meshCount).toBe(4);
	runtime.dispose();
});

test("configure applies the latest non-structural settings without rebuilding the 160x160 bundle", async () => {
	const { scene, tasks, runtime } = createHarness({ phaseInstanceBudget: 256 });
	runtime.activate({ ...SONIC_WORKSHOP_DEFAULTS, active: true });
	tasks.runSlice(1);
	await Promise.resolve();
	await Promise.resolve();
	runtime.configure({
		...SONIC_WORKSHOP_DEFAULTS,
		active: true,
		theme: "ocean-deep",
	});
	runtime.configure({
		...SONIC_WORKSHOP_DEFAULTS,
		active: true,
		theme: "crimson-sunset",
	});
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);

	const diagnostics = runtime.getDiagnostics();
	const root = scene.getObjectByName(SONIC_WORKSHOP_ROOT_NAME);
	expect(diagnostics.generation).toBe(1);
	expect(diagnostics.committedGeneration).toBe(1);
	expect(diagnostics.cancelledBuilds).toBe(0);
	expect(diagnostics.theme).toBe("crimson-sunset");
	expect(root?.userData.sonicWorkshopGeneration).toBe(1);
	runtime.dispose();
});

test("pending and resident generations stay inside the frozen hard budget", async () => {
	const { ledger, tasks, runtime } = createHarness({ phaseInstanceBudget: 256 });
	runtime.activate({ ...SONIC_WORKSHOP_DEFAULTS, active: true });

	const pending = runtime.getDiagnostics();
	const ledgerSnapshot = ledger.getSnapshot();
	expect(pending.pendingRebuilds).toBe(1);
	expect(pending.meshCount).toBe(0);
	expect(pending.residentMeshCount).toBe(4);
	expect(pending.residentMeshCount).toBeLessThanOrEqual(
		SONIC_WORKSHOP_HARD_BUDGET.meshCount,
	);
	expect(pending.residentDrawCallCount).toBeLessThanOrEqual(
		SONIC_WORKSHOP_HARD_BUDGET.drawCallCount,
	);
	expect(pending.residentGeometryBytes).toBeLessThanOrEqual(
		SONIC_WORKSHOP_HARD_BUDGET.geometryBytes,
	);
	expect(ledgerSnapshot.current.meshCount).toBe(pending.residentMeshCount);
	expect(ledgerSnapshot.current.geometryBytes).toBe(
		pending.residentGeometryBytes,
	);
	expect(ledgerSnapshot.current.queuedTaskCost).toBeLessThanOrEqual(
		SONIC_WORKSHOP_HARD_BUDGET.queuedTaskCost,
	);
	expect(ledgerSnapshot.current.textureBytes).toBe(0);
	expect(ledgerSnapshot.current.cacheBytes).toBe(0);

	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	expect(runtime.getDiagnostics().residentMeshCount).toBe(4);
	expect(runtime.getDiagnostics().residentDrawCallCount).toBe(4);
	runtime.dispose();
});

test("deactivate during a partial build cancels queued work and returns every owned budget to baseline", async () => {
	const { scene, ledger, tasks, diagnostics, runtime } = createHarness({
		phaseInstanceBudget: 256,
	});
	runtime.activate({ ...SONIC_WORKSHOP_DEFAULTS, active: true });
	tasks.runSlice(1);
	await Promise.resolve();
	expect(runtime.getDiagnostics().pendingRebuilds).toBe(1);
	expect(tasks.getSnapshot().queued).toBeGreaterThan(0);
	expect(Object.keys(diagnostics.snapshot())).toHaveLength(1);

	runtime.deactivate();
	expect(runtime.getDiagnostics().pendingRebuilds).toBe(0);
	expect(scene.getObjectByName(SONIC_WORKSHOP_ROOT_NAME)).toBeUndefined();
	expect(tasks.getSnapshot().queued).toBe(0);
	expect(tasks.getSnapshot().running).toBe(0);
	expect(ledger.getSnapshot().current).toEqual({
		textureBytes: 0,
		geometryBytes: 0,
		meshCount: 0,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});

	runtime.dispose();
	expect(Object.keys(diagnostics.snapshot())).toHaveLength(0);
});

test("a failed cooperative phase releases the incomplete generation and reports no retained work", async () => {
	let shouldFail = true;
	const { scene, ledger, tasks, runtime } = createHarness({
		phaseInstanceBudget: 256,
		beforeBuildPhase() {
			if (!shouldFail) return;
			shouldFail = false;
			throw new Error("fixture build failure");
		},
	});
	runtime.activate({ ...SONIC_WORKSHOP_DEFAULTS, active: true });
	tasks.runSlice(1);
	await Promise.resolve();
	await Promise.resolve();

	const snapshot = runtime.getDiagnostics();
	expect(snapshot.pendingRebuilds).toBe(0);
	expect(snapshot.buildFailures).toBe(1);
	expect(snapshot.lastFailure).toBe("fixture build failure");
	expect(scene.getObjectByName(SONIC_WORKSHOP_ROOT_NAME)).toBeUndefined();
	expect(tasks.getSnapshot().queued).toBe(0);
	expect(ledger.getSnapshot().current).toEqual({
		textureBytes: 0,
		geometryBytes: 0,
		meshCount: 0,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});

	runtime.configure({ ...SONIC_WORKSHOP_DEFAULTS, active: true });
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	expect(runtime.getDiagnostics().committedGeneration).toBe(2);
	expect(scene.getObjectByName(SONIC_WORKSHOP_ROOT_NAME)).toBeDefined();
	runtime.dispose();
});

test("deactivate and dispose are idempotent, dispose geometry/material once, and preserve the shared cover", async () => {
	const { scene, ledger, tasks, diagnostics, coverTexture, runtime } = createHarness();
	let sharedTextureDisposals = 0;
	coverTexture.dispose = () => {
		sharedTextureDisposals += 1;
	};
	runtime.activate({ ...SONIC_WORKSHOP_DEFAULTS, active: true });
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	const root = scene.getObjectByName(SONIC_WORKSHOP_ROOT_NAME);
	const geometryDisposals = new Map<BufferGeometry, number>();
	const materialDisposals = new Map<Material, number>();
	root?.traverse((object) => {
		if (!("isMesh" in object) || object.isMesh !== true) return;
		const mesh = object as typeof object & {
			geometry: BufferGeometry;
			material: Material | Material[];
		};
		const geometry = mesh.geometry;
		const originalGeometryDispose = geometry.dispose.bind(geometry);
		geometryDisposals.set(geometry, 0);
		geometry.dispose = () => {
			geometryDisposals.set(geometry, (geometryDisposals.get(geometry) ?? 0) + 1);
			originalGeometryDispose();
		};
		for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
			const originalMaterialDispose = material.dispose.bind(material);
			materialDisposals.set(material, 0);
			material.dispose = () => {
				materialDisposals.set(material, (materialDisposals.get(material) ?? 0) + 1);
				originalMaterialDispose();
			};
		}
	});
	expect(geometryDisposals.size).toBe(4);
	expect(materialDisposals.size).toBe(4);

	runtime.deactivate();
	runtime.deactivate();
	expect(scene.getObjectByName(SONIC_WORKSHOP_ROOT_NAME)).toBeUndefined();
	expect(runtime.getDiagnostics().residentMeshCount).toBe(0);
	expect(ledger.getSnapshot().current).toEqual({
		textureBytes: 0,
		geometryBytes: 0,
		meshCount: 0,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});
	expect(sharedTextureDisposals).toBe(0);
	expect([...geometryDisposals.values()]).toEqual([1, 1, 1, 1]);
	expect([...materialDisposals.values()]).toEqual([1, 1, 1, 1]);

	runtime.activate({ ...SONIC_WORKSHOP_DEFAULTS, active: true });
	await drainBuild(tasks, () => runtime.getDiagnostics().pendingRebuilds === 0);
	runtime.dispose();
	runtime.dispose();
	expect(runtime.getDiagnostics().disposed).toBe(true);
	expect(scene.getObjectByName(SONIC_WORKSHOP_ROOT_NAME)).toBeUndefined();
	expect(ledger.getSnapshot().current).toEqual({
		textureBytes: 0,
		geometryBytes: 0,
		meshCount: 0,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});
	expect(sharedTextureDisposals).toBe(0);
	expect(Object.keys(diagnostics.snapshot())).toHaveLength(0);
});

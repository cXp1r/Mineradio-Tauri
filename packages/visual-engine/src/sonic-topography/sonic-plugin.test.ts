import { expect, test } from "bun:test";
import { Scene, type InstancedMesh } from "three";
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
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";
import {
	createSonicTopographyRuntime,
	type SonicBuildPhaseInfo,
} from "./sonic-topography";

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

function createHarness(beforeBuildPhase?: (phase: SonicBuildPhaseInfo) => void) {
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
			random: () => 0.375,
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
		terrain: { ...ultra.terrain, range: 81 },
	}, "ultra");
	const pending = runtime.getDiagnostics();
	expect(pending.totalInstances).toBe(50_496);
	expect(pending.residentInstances).toBe(100_992);
	expect(pending.peakInstances).toBe(100_992);
	expect(pending.residentMeshCount).toBe(8);
	expect(pending.residentGeometryBytes).toBe(pending.peakGeometryBytes);
	expect(pending.geometryPressure).toBe("hard");
	expect(ledger.getSnapshot().current.meshCount).toBe(pending.residentMeshCount);
	expect(ledger.getSnapshot().current.geometryBytes).toBe(pending.residentGeometryBytes);
	runtime.dispose();
	expect(ledger.getSnapshot().current.meshCount).toBe(0);
	expect(ledger.getSnapshot().current.geometryBytes).toBe(0);
});

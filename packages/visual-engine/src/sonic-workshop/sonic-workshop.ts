import type { Scene, Texture, WebGLRenderer } from "three";
import type { SonicAudioSnapshot } from "../audio/audio-snapshot";
import type { BudgetTaskQueue, BudgetTaskSettlement } from "../runtime/budget-task-queue";
import type { CancellationScope, CancellationTicket } from "../runtime/cancellation-scope";
import type { FrameContext } from "../runtime/frame-context";
import type { VisualResourceScope } from "../runtime/resource-scope";
import type {
	VisualDiagnosticObject,
	VisualSubsystemDiagnosticsPublisher,
} from "../runtime/subsystem-diagnostics";
import {
	SONIC_WORKSHOP_GRID_SIZE,
	SONIC_WORKSHOP_DRAW_CALL_COUNT,
	SONIC_WORKSHOP_MESH_COUNT,
	createSonicWorkshopLayerBundle,
	type SonicWorkshopLayerBundle,
	type SonicWorkshopRandomSource,
} from "./sonic-workshop-layers";
import {
	resolveSonicWorkshopPalette,
	type SonicWorkshopCoverPaletteSupplier,
} from "./sonic-workshop-palette";
import {
	SONIC_WORKSHOP_DEFAULTS,
	SONIC_WORKSHOP_ACTIVATION_ID,
	areSonicWorkshopSettingsEqual,
	normalizeSonicWorkshopSettings,
	type SonicWorkshopSettings,
} from "./sonic-workshop-settings";

export { SONIC_WORKSHOP_GRID_SIZE } from "./sonic-workshop-layers";

export const SONIC_WORKSHOP_ROOT_NAME = "sonic-workshop-root" as const;

export const SONIC_WORKSHOP_HARD_BUDGET = Object.freeze({
	meshCount: SONIC_WORKSHOP_MESH_COUNT * 2,
	drawCallCount: SONIC_WORKSHOP_DRAW_CALL_COUNT * 2,
	geometryBytes: 8 * 1024 * 1024,
	textureBytes: 16 * 1024 * 1024,
	cacheBytes: 16 * 1024 * 1024,
	queuedTaskCost: 32,
});

const BUILD_TASK_COST = 1;

export type SonicWorkshopAudioSupplier = () => SonicAudioSnapshot;

export interface SonicWorkshopMediaSnapshot {
	readonly trackKey: string;
	readonly title: string;
	readonly artist: string;
	readonly coverTexture: Texture | null;
	readonly playing: boolean;
}

export type SonicWorkshopMediaSupplier = () => SonicWorkshopMediaSnapshot;

export interface SonicWorkshopPluginContext {
	readonly scene: Scene;
	readonly renderer: WebGLRenderer;
	readonly resources: VisualResourceScope;
	readonly cancellation: CancellationScope;
	readonly tasks: BudgetTaskQueue;
	readonly diagnostics: VisualSubsystemDiagnosticsPublisher;
	readonly audio: SonicWorkshopAudioSupplier;
	readonly media: SonicWorkshopMediaSupplier;
	readonly coverPalette?: SonicWorkshopCoverPaletteSupplier;
	readonly random?: SonicWorkshopRandomSource;
}

export interface SonicWorkshopBuildPhaseInfo {
	readonly generation: number;
	readonly phase: number;
	readonly startInstance: number;
	readonly maximumInstances: number;
}

export interface SonicWorkshopRuntimeDependencies {
	readonly phaseInstanceBudget?: number;
	readonly beforeBuildPhase?: (phase: SonicWorkshopBuildPhaseInfo) => void;
}

export interface SonicWorkshopDiagnostics extends VisualDiagnosticObject {
	readonly active: boolean;
	readonly disposed: boolean;
	readonly generation: number;
	readonly committedGeneration: number;
	readonly pendingRebuilds: number;
	readonly meshCount: number;
	readonly residentMeshCount: number;
	readonly drawCallCount: number;
	readonly residentDrawCallCount: number;
	readonly geometryBytes: number;
	readonly residentGeometryBytes: number;
	readonly peakGeometryBytes: number;
	readonly textureBytes: number;
	readonly cacheBytes: number;
	readonly queuedTaskCost: number;
	readonly peakQueuedTaskCost: number;
	readonly terrainGrid: number;
	readonly terrainInstances: number;
	readonly activeRipples: number;
	readonly activeMeteors: number;
	readonly activeParticles: number;
	readonly theme: SonicWorkshopSettings["theme"];
	readonly coverTextureShared: boolean;
	readonly buildFailures: number;
	readonly cancelledBuilds: number;
	readonly lastFailure: string;
}

export interface SonicWorkshopRuntime {
	activate(settings?: SonicWorkshopSettings): void;
	configure(settings: SonicWorkshopSettings): void;
	update(frame: FrameContext): void;
	deactivate(): void;
	dispose(): void;
	getDiagnostics(): SonicWorkshopDiagnostics;
}

interface WorkshopGeneration {
	readonly generation: number;
	readonly scope: VisualResourceScope;
	readonly bundle: SonicWorkshopLayerBundle;
	settings: SonicWorkshopSettings;
}

interface PendingBuild {
	readonly generation: WorkshopGeneration;
	readonly ticket: CancellationTicket;
	terrainCursor: number;
	phase: number;
	failure: unknown;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : "unknown Workshop rebuild failure";
}

function activeSettings(value?: SonicWorkshopSettings): SonicWorkshopSettings {
	return normalizeSonicWorkshopSettings(value ?? {
		...SONIC_WORKSHOP_DEFAULTS,
		active: true,
	});
}

let nextRuntimeId = 1;

export function createSonicWorkshopRuntime(
	context: SonicWorkshopPluginContext,
	dependencies: SonicWorkshopRuntimeDependencies = {},
): SonicWorkshopRuntime {
	const runtimeId = nextRuntimeId;
	nextRuntimeId += 1;
	const owner = `sonic-workshop:${runtimeId}`;
	const phaseInstanceBudget = Math.max(
		256,
		Math.min(4_096, Math.round(dependencies.phaseInstanceBudget ?? 1_024)),
	);
	const random = context.random ?? Math.random;
	let active = false;
	let disposed = false;
	let generation = 0;
	let committedGeneration = 0;
	let desiredSettings = normalizeSonicWorkshopSettings(SONIC_WORKSHOP_DEFAULTS);
	let activationResources: VisualResourceScope | null = null;
	let activationCancellation: CancellationScope | null = null;
	let resident: WorkshopGeneration | null = null;
	let pending: PendingBuild | null = null;
	let elapsedSeconds = 0;
	let buildFailures = 0;
	let cancelledBuilds = 0;
	let lastFailure = "";
	let peakGeometryBytes = 0;
	let peakQueuedTaskCost = 0;
	let sharedCoverTexturePresent = false;
	let unregisterDiagnostics: (() => void) | null = null;

	// Renderer 由宿主共享；模块只消费现有 renderer，不创建第二套渲染器。
	void context.renderer;

	function palette(settings = desiredSettings) {
		return resolveSonicWorkshopPalette(settings, context.coverPalette?.());
	}

	function mediaSnapshot(): SonicWorkshopMediaSnapshot {
		const media = context.media();
		sharedCoverTexturePresent = media.coverTexture !== null;
		return media;
	}

	function currentResidentMeshCount(): number {
		return (resident?.bundle.meshCount ?? 0) + (pending?.generation.bundle.meshCount ?? 0);
	}

	function currentResidentDrawCallCount(): number {
		return (resident?.bundle.drawCallCount ?? 0)
			+ (pending?.generation.bundle.drawCallCount ?? 0);
	}

	function currentResidentGeometryBytes(): number {
		return (resident?.bundle.geometryBytes ?? 0) + (pending?.generation.bundle.geometryBytes ?? 0);
	}

	function updatePeaks(): void {
		peakGeometryBytes = Math.max(peakGeometryBytes, currentResidentGeometryBytes());
		peakQueuedTaskCost = Math.max(peakQueuedTaskCost, pending ? BUILD_TASK_COST : 0);
	}

	function releaseGeneration(target: WorkshopGeneration | null): void {
		target?.scope.dispose();
	}

	function cancelPending(countCancellation: boolean): void {
		const current = pending;
		if (!current) return;
		pending = null;
		context.tasks.cancelOwner(owner);
		releaseGeneration(current.generation);
		if (countCancellation) cancelledBuilds += 1;
	}

	function failPending(build: PendingBuild, error: unknown, cancelled: boolean): void {
		if (pending !== build) return;
		pending = null;
		context.tasks.cancelOwner(owner);
		releaseGeneration(build.generation);
		if (cancelled) cancelledBuilds += 1;
		else {
			buildFailures += 1;
			lastFailure = describeError(error);
		}
	}

	function commit(build: PendingBuild): void {
		if (
			!active
			|| disposed
			|| pending !== build
			|| build.ticket.signal.aborted
			|| !build.ticket.isCurrent()
		) {
			failPending(build, "stale Workshop rebuild", true);
			return;
		}
		const previous = resident;
		try {
			context.scene.add(build.generation.bundle.root);
			resident = build.generation;
			committedGeneration = build.generation.generation;
			pending = null;
			releaseGeneration(previous);
		} catch (error) {
			resident = previous;
			pending = null;
			releaseGeneration(build.generation);
			buildFailures += 1;
			lastFailure = describeError(error);
		}
		updatePeaks();
	}

	function schedulePhase(build: PendingBuild): void {
		if (pending !== build || disposed || !active) return;
		const info: SonicWorkshopBuildPhaseInfo = {
			generation: build.generation.generation,
			phase: build.phase,
			startInstance: build.terrainCursor,
			maximumInstances: phaseInstanceBudget,
		};
		build.phase += 1;
		const accepted = context.tasks.enqueue({
			owner,
			key: `g${info.generation}:p${info.phase}`,
			priority: "visible",
			cost: BUILD_TASK_COST,
			run(taskContext) {
				if (
					pending !== build
					|| taskContext.signal.aborted
					|| build.ticket.signal.aborted
					|| !build.ticket.isCurrent()
				) {
					throw new Error("cancelled Workshop rebuild phase");
				}
				try {
					dependencies.beforeBuildPhase?.(info);
					build.terrainCursor = build.generation.bundle.fillTerrain(
						build.terrainCursor,
						info.maximumInstances,
					);
				} catch (error) {
					build.failure = error;
					throw error;
				}
				return build.terrainCursor >= build.generation.bundle.terrainInstances;
			},
			commit(complete) {
				if (pending !== build) return;
				if (complete) {
					build.generation.bundle.finalizeTerrain();
					commit(build);
				} else {
					schedulePhase(build);
				}
			},
			onSettled(settlement: BudgetTaskSettlement) {
				if (settlement === "failed") {
					failPending(build, build.failure, false);
				} else if (
					(settlement === "cancelled" || settlement === "stale")
					&& pending === build
				) {
					failPending(build, "cancelled Workshop rebuild", true);
				}
			},
		});
		if (!accepted) failPending(build, "Workshop rebuild task admission denied", false);
		updatePeaks();
	}

	function requestBuild(): void {
		if (!active || disposed || !activationResources || !activationCancellation) return;
		cancelPending(true);
		generation += 1;
		const buildGeneration = generation;
		const ticket = activationCancellation.issue(owner, "build");
		const scope = activationResources.createChild(`generation-${buildGeneration}`);
		let bundle: SonicWorkshopLayerBundle;
		try {
			const media = mediaSnapshot();
			bundle = createSonicWorkshopLayerBundle({
				owner: `${owner}:g${buildGeneration}`,
				resources: scope,
				palette: palette(),
				settings: desiredSettings,
				coverTexture: media.coverTexture,
				random,
			});
			bundle.root.name = SONIC_WORKSHOP_ROOT_NAME;
			bundle.root.userData.sonicWorkshopGeneration = buildGeneration;
		} catch (error) {
			scope.dispose();
			buildFailures += 1;
			lastFailure = describeError(error);
			return;
		}
		const projectedMeshCount = (resident?.bundle.meshCount ?? 0) + bundle.meshCount;
		const projectedDrawCallCount = (resident?.bundle.drawCallCount ?? 0)
			+ bundle.drawCallCount;
		const projectedGeometryBytes = (resident?.bundle.geometryBytes ?? 0) + bundle.geometryBytes;
		if (
			projectedMeshCount > SONIC_WORKSHOP_HARD_BUDGET.meshCount
			|| projectedDrawCallCount > SONIC_WORKSHOP_HARD_BUDGET.drawCallCount
			|| projectedGeometryBytes > SONIC_WORKSHOP_HARD_BUDGET.geometryBytes
			|| BUILD_TASK_COST > SONIC_WORKSHOP_HARD_BUDGET.queuedTaskCost
		) {
			scope.dispose();
			buildFailures += 1;
			lastFailure = "Workshop resident+pending hard budget exceeded";
			return;
		}
		const target: WorkshopGeneration = {
			generation: buildGeneration,
			scope,
			bundle,
			settings: desiredSettings,
		};
		const build: PendingBuild = {
			generation: target,
			ticket,
			terrainCursor: 0,
			phase: 0,
			failure: null,
		};
		pending = build;
		updatePeaks();
		schedulePhase(build);
	}

	function deactivate(): void {
		if (!active && !activationResources && !resident && !pending) return;
		active = false;
		desiredSettings = normalizeSonicWorkshopSettings({
			...desiredSettings,
			active: false,
		});
		cancelPending(true);
		context.tasks.cancelOwner(owner);
		releaseGeneration(resident);
		resident = null;
		activationCancellation?.dispose();
		activationCancellation = null;
		activationResources?.dispose();
		activationResources = null;
		elapsedSeconds = 0;
	}

	function configure(settings: SonicWorkshopSettings): void {
		if (disposed) return;
		const normalized = normalizeSonicWorkshopSettings(settings);
		const unchanged = areSonicWorkshopSettingsEqual(desiredSettings, normalized);
		if (!normalized.active) {
			desiredSettings = normalized;
			deactivate();
			return;
		}
		desiredSettings = normalized;
		if (!active) {
			active = true;
			activationResources = context.resources.createChild(`${owner}:activation`);
			activationCancellation = context.cancellation.createChild(`${owner}:activation`);
			requestBuild();
			return;
		}
		if (!resident && !pending) {
			requestBuild();
			return;
		}
		if (unchanged) return;
		const media = mediaSnapshot();
		for (const target of [resident, pending?.generation ?? null]) {
			if (!target) continue;
			target.settings = normalized;
			target.bundle.applySettings(normalized, palette(normalized), media.coverTexture);
		}
	}

	function activate(settings?: SonicWorkshopSettings): void {
		configure(activeSettings(settings));
	}

	function getDiagnostics(): SonicWorkshopDiagnostics {
		const layer = resident?.bundle.getDiagnostics() ?? {
			activeRipples: 0,
			activeMeteors: 0,
			activeParticles: 0,
		};
		return Object.freeze({
			active,
			disposed,
			generation,
			committedGeneration,
			pendingRebuilds: pending ? 1 : 0,
			meshCount: resident?.bundle.meshCount ?? 0,
			residentMeshCount: currentResidentMeshCount(),
			drawCallCount: resident?.bundle.drawCallCount ?? 0,
			residentDrawCallCount: currentResidentDrawCallCount(),
			geometryBytes: resident?.bundle.geometryBytes ?? 0,
			residentGeometryBytes: currentResidentGeometryBytes(),
			peakGeometryBytes,
			textureBytes: 0,
			cacheBytes: 0,
			queuedTaskCost: pending ? BUILD_TASK_COST : 0,
			peakQueuedTaskCost,
			terrainGrid: resident ? SONIC_WORKSHOP_GRID_SIZE : 0,
			terrainInstances: resident?.bundle.terrainInstances ?? 0,
			activeRipples: layer.activeRipples,
			activeMeteors: layer.activeMeteors,
			activeParticles: layer.activeParticles,
			theme: resident?.settings.theme ?? desiredSettings.theme,
			coverTextureShared: sharedCoverTexturePresent,
			buildFailures,
			cancelledBuilds,
			lastFailure,
		});
	}

	unregisterDiagnostics = context.diagnostics.register(
		`${SONIC_WORKSHOP_ACTIVATION_ID}:${runtimeId}`,
		getDiagnostics,
	);

	return {
		activate,
		configure,
		update(frame) {
			if (!active || disposed || !resident) return;
			const media = mediaSnapshot();
			elapsedSeconds += Math.max(0, Math.min(0.1, frame.dt));
			resident.bundle.applySettings(
				resident.settings,
				palette(resident.settings),
				media.coverTexture,
			);
			resident.bundle.cover.userData.media = Object.freeze({
				trackKey: media.trackKey,
				title: media.title,
				artist: media.artist,
				playing: media.playing,
			});
			resident.bundle.update(
				frame.dt,
				elapsedSeconds,
				context.audio(),
				resident.settings,
			);
		},
		deactivate,
		dispose() {
			if (disposed) return;
			deactivate();
			disposed = true;
			unregisterDiagnostics?.();
			unregisterDiagnostics = null;
		},
		getDiagnostics,
	};
}

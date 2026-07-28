import { Group, type Scene, type WebGLRenderer } from "three";
import type { SonicAudioSnapshot, SonicBand } from "./sonic-audio-profile";
import {
	createSonicFloatingBlocksLayer,
	type SonicFloatingBlocksLayer,
	type SonicRandomSource,
} from "./sonic-floating-blocks";
import {
	createSonicImpulseLayer,
	SONIC_IMPULSE_RIPPLE_CAP,
	SONIC_METEOR_CAP,
	SONIC_TRAIL_CAP,
	type SonicImpulseLayer,
} from "./sonic-impulses";
import {
	resolveSonicPalette,
	type SonicPalette,
	type SonicPaletteSupplier,
} from "./sonic-palette";
import {
	SONIC_TOPOGRAPHY_DEFAULTS,
	normalizeSonicTopographySettings,
	type SonicPerformanceQuality,
	type SonicTopographySettings,
} from "./sonic-settings";
import {
	createSonicTerrainLayer,
	type SonicTerrainLayer,
} from "./sonic-terrain";
import type { BudgetTaskQueue, BudgetTaskSettlement } from "../runtime/budget-task-queue";
import type { CancellationScope, CancellationTicket } from "../runtime/cancellation-scope";
import type { FrameContext } from "../runtime/frame-context";
import type { VisualResourceScope } from "../runtime/resource-scope";
import type {
	VisualDiagnosticObject,
	VisualSubsystemDiagnosticsPublisher,
} from "../runtime/subsystem-diagnostics";

export const SONIC_TOPOGRAPHY_ROOT_NAME = "sonic-topography-root" as const;
export const SONIC_TOPOGRAPHY_MAX_INSTANCES = 50_496 as const;
export const SONIC_TOPOGRAPHY_MESH_COUNT = 4 as const;
export const SONIC_GEOMETRY_SOFT_BYTES = 4 * 1024 * 1024;
export const SONIC_GEOMETRY_HARD_BYTES = 6 * 1024 * 1024;

const SONIC_EQ_BANDS = [
	"subBass",
	"bass",
	"lowMid",
	"mid",
	"highMid",
	"presence",
	"brilliance",
	"air",
] as const satisfies readonly SonicBand[];

export type SonicAudioSnapshotSupplier = () => SonicAudioSnapshot;

export interface SonicTopographyPluginContext {
	readonly scene: Scene;
	readonly renderer: WebGLRenderer;
	readonly resources: VisualResourceScope;
	readonly cancellation: CancellationScope;
	readonly tasks: BudgetTaskQueue;
	readonly diagnostics: VisualSubsystemDiagnosticsPublisher;
	readonly audio: SonicAudioSnapshotSupplier;
	readonly palette?: SonicPaletteSupplier;
	readonly random?: SonicRandomSource;
}

export type SonicBuildPhaseKind = "terrain" | "floating" | "impulses";

export interface SonicBuildPhaseInfo {
	readonly generation: number;
	readonly phase: number;
	readonly kind: SonicBuildPhaseKind;
	readonly startInstance: number;
	readonly maximumInstances: number;
}

export interface SonicTopographyRuntimeDependencies {
	readonly phaseInstanceBudget?: number;
	readonly beforeBuildPhase?: (phase: SonicBuildPhaseInfo) => void;
}

export interface SonicTopographyDiagnostics extends VisualDiagnosticObject {
	readonly active: boolean;
	readonly disposed: boolean;
	readonly generation: number;
	readonly committedGeneration: number;
	readonly pendingRebuilds: number;
	readonly meshCount: number;
	readonly residentMeshCount: number;
	readonly materialCount: number;
	readonly textureCount: number;
	readonly geometryBytes: number;
	readonly residentGeometryBytes: number;
	readonly peakGeometryBytes: number;
	readonly geometryPressure: "normal" | "soft" | "hard";
	readonly totalInstances: number;
	readonly residentInstances: number;
	readonly peakInstances: number;
	readonly terrainGrid: number;
	readonly terrainInstances: number;
	readonly floatingInstances: number;
	readonly meteorCapacity: number;
	readonly trailCapacity: number;
	readonly rippleCapacity: number;
	readonly activeRipples: number;
	readonly activeMeteors: number;
	readonly activeTrails: number;
	readonly phaseInstanceBudget: number;
	readonly buildFailures: number;
	readonly cancelledBuilds: number;
	readonly lastFailure: string;
}

export interface SonicTopographyRuntime {
	activate(
		settings?: SonicTopographySettings,
		quality?: SonicPerformanceQuality,
	): void;
	configure(
		settings: SonicTopographySettings,
		quality?: SonicPerformanceQuality,
	): void;
	update(frame: FrameContext): void;
	pointerRipple(x: number, z: number, strength: number): void;
	deactivate(): void;
	dispose(): void;
	getDiagnostics(): SonicTopographyDiagnostics;
}

interface SonicLayerBundle {
	readonly generation: number;
	readonly scope: VisualResourceScope;
	readonly root: Group;
	readonly terrain: SonicTerrainLayer;
	readonly floating: SonicFloatingBlocksLayer;
	readonly impulses: SonicImpulseLayer;
	readonly meshCount: number;
	readonly materialCount: number;
	readonly geometryBytes: number;
	settings: SonicTopographySettings;
	quality: SonicPerformanceQuality;
	applySettings(settings: SonicTopographySettings, palette: SonicPalette): void;
	update(frame: FrameContext, audio: SonicAudioSnapshot): void;
	pointerRipple(x: number, z: number, strength: number): void;
	dispose(): void;
}

interface PendingBuild {
	readonly generation: number;
	readonly bundle: SonicLayerBundle;
	readonly ticket: CancellationTicket;
	terrainCursor: number;
	floatingCursor: number;
	impulsesInitialized: boolean;
	phase: number;
	failure: unknown;
}

function normalizeQuality(value: SonicPerformanceQuality | undefined): SonicPerformanceQuality {
	return value === "eco" || value === "balanced" || value === "high" || value === "ultra"
		? value
		: "high";
}

function structuralSignature(
	settings: SonicTopographySettings,
	quality: SonicPerformanceQuality,
): string {
	return [
		quality,
		settings.terrain.density,
		settings.terrain.range,
		settings.terrain.lower,
		settings.terrain.depth,
		settings.floating.count,
		settings.floating.minSize,
		settings.floating.maxSize,
	].join(":");
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : "unknown Sonic rebuild failure";
}

function createLayerBundle(options: {
	readonly generation: number;
	readonly scope: VisualResourceScope;
	readonly settings: SonicTopographySettings;
	readonly quality: SonicPerformanceQuality;
	readonly palette: SonicPalette;
	readonly random: SonicRandomSource;
}): SonicLayerBundle {
	const root = new Group();
	root.name = SONIC_TOPOGRAPHY_ROOT_NAME;
	root.userData.sonicGeneration = options.generation;
	let attachmentRegistered = false;
	try {
		options.scope.register({
			owner: `sonic:g${options.generation}:root`,
			kind: "subscription",
			retention: "rebuildable",
			dispose: () => root.removeFromParent(),
		});
		attachmentRegistered = true;
		const terrain = createSonicTerrainLayer({
			owner: `sonic:g${options.generation}:terrain`,
			resources: options.scope,
			settings: options.settings,
			quality: options.quality,
			palette: options.palette,
		});
		const floating = createSonicFloatingBlocksLayer({
			owner: `sonic:g${options.generation}:floating`,
			resources: options.scope,
			settings: options.settings,
			palette: options.palette,
			random: options.random,
		});
		const impulses = createSonicImpulseLayer({
			owner: `sonic:g${options.generation}:impulses`,
			resources: options.scope,
			palette: options.palette,
			random: options.random,
		});
		root.add(terrain.mesh, floating.mesh, impulses.meteorsMesh, impulses.trailsMesh);
		const bundle: SonicLayerBundle = {
			generation: options.generation,
			scope: options.scope,
			root,
			terrain,
			floating,
			impulses,
			meshCount: SONIC_TOPOGRAPHY_MESH_COUNT,
			materialCount: SONIC_TOPOGRAPHY_MESH_COUNT,
			geometryBytes:
				terrain.estimatedGeometryBytes +
				floating.estimatedGeometryBytes +
				impulses.estimatedGeometryBytes,
			settings: options.settings,
			quality: options.quality,
			applySettings(settings, palette) {
				bundle.settings = settings;
				terrain.applySettings(settings, palette);
				floating.applySettings(settings, palette);
				impulses.applyPalette(palette);
			},
			update(frame, audio) {
				const timeSeconds = Math.max(0, frame.now / 1000);
				const eq = bundle.settings.eq;
				for (let index = 0; index < SONIC_EQ_BANDS.length; index += 1) {
					const band = SONIC_EQ_BANDS[index];
					terrain.material.uniforms.uBands.value[index] = audio.bands[band] * eq[band] / 100;
				}
				terrain.material.uniforms.uTime.value = timeSeconds;
				floating.update(timeSeconds, audio);
				impulses.update(frame.dt, timeSeconds, audio, bundle.settings);
				terrain.material.uniforms.uRippleCount.value = impulses.writeTerrainRipples(
					terrain.material.uniforms.uRipples.value,
				);
				root.rotation.y += frame.dt * bundle.settings.terrain.autoRotate / 100 * 0.09;
			},
			pointerRipple(x, z, strength) {
				impulses.pointerRipple(x, z, strength);
			},
			dispose() {
				options.scope.dispose();
			},
		};
		bundle.applySettings(options.settings, options.palette);
		return bundle;
	} catch (error) {
		options.scope.dispose();
		if (!attachmentRegistered) root.removeFromParent();
		throw error;
	}
}

let nextRuntimeId = 1;

export function createSonicTopographyRuntime(
	context: SonicTopographyPluginContext,
	dependencies: SonicTopographyRuntimeDependencies = {},
): SonicTopographyRuntime {
	const runtimeId = nextRuntimeId;
	nextRuntimeId += 1;
	const owner = `sonic-topography:${runtimeId}`;
	const phaseInstanceBudget = Math.max(
		64,
		Math.min(4_096, Math.round(dependencies.phaseInstanceBudget ?? 1_024)),
	);
	const random = context.random ?? Math.random;
	let active = false;
	let disposed = false;
	let generation = 0;
	let committedGeneration = 0;
	let desiredSettings = normalizeSonicTopographySettings(SONIC_TOPOGRAPHY_DEFAULTS);
	let desiredQuality: SonicPerformanceQuality = "high";
	let activationResources: VisualResourceScope | null = null;
	let activationCancellation: CancellationScope | null = null;
	let activeBundle: SonicLayerBundle | null = null;
	let pendingBuild: PendingBuild | null = null;
	let buildFailures = 0;
	let cancelledBuilds = 0;
	let lastFailure = "";
	let peakGeometryBytes = 0;
	let peakInstances = 0;
	let unregisterDiagnostics: (() => void) | null = null;

	function currentPalette(settings = desiredSettings): SonicPalette {
		return resolveSonicPalette(settings.colors, context.palette?.());
	}

	function bundleInstances(bundle: SonicLayerBundle | null): number {
		if (!bundle) return 0;
		return bundle.terrain.instanceCount + bundle.floating.instanceCount + SONIC_METEOR_CAP + SONIC_TRAIL_CAP;
	}

	function updatePeaks(): void {
		const geometry = (activeBundle?.geometryBytes ?? 0) + (pendingBuild?.bundle.geometryBytes ?? 0);
		const instances = bundleInstances(activeBundle) + bundleInstances(pendingBuild?.bundle ?? null);
		peakGeometryBytes = Math.max(peakGeometryBytes, geometry);
		peakInstances = Math.max(peakInstances, instances);
	}

	function cancelPending(countCancellation: boolean): void {
		const pending = pendingBuild;
		if (!pending) return;
		pendingBuild = null;
		context.tasks.cancelOwner(owner);
		pending.bundle.dispose();
		if (countCancellation) cancelledBuilds += 1;
	}

	function failPending(build: PendingBuild, error: unknown, cancelled: boolean): void {
		if (pendingBuild !== build) return;
		pendingBuild = null;
		context.tasks.cancelOwner(owner);
		build.bundle.dispose();
		if (cancelled) cancelledBuilds += 1;
		else {
			buildFailures += 1;
			lastFailure = describeError(error);
		}
	}

	function commitBundle(build: PendingBuild): void {
		if (
			!active ||
			disposed ||
			pendingBuild !== build ||
			!build.ticket.isCurrent() ||
			build.ticket.signal.aborted
		) {
			failPending(build, "stale Sonic rebuild", true);
			return;
		}
		const previous = activeBundle;
		try {
			context.scene.add(build.bundle.root);
			activeBundle = build.bundle;
			committedGeneration = build.generation;
			pendingBuild = null;
			previous?.dispose();
		} catch (error) {
			activeBundle = previous;
			build.bundle.dispose();
			pendingBuild = null;
			buildFailures += 1;
			lastFailure = describeError(error);
		}
		updatePeaks();
	}

	function nextPhase(build: PendingBuild): SonicBuildPhaseInfo {
		if (build.terrainCursor < build.bundle.terrain.instanceCount) {
			return {
				generation: build.generation,
				phase: build.phase,
				kind: "terrain",
				startInstance: build.terrainCursor,
				maximumInstances: phaseInstanceBudget,
			};
		}
		if (build.floatingCursor < build.bundle.floating.instanceCount) {
			return {
				generation: build.generation,
				phase: build.phase,
				kind: "floating",
				startInstance: build.floatingCursor,
				maximumInstances: Math.min(64, phaseInstanceBudget),
			};
		}
		return {
			generation: build.generation,
			phase: build.phase,
			kind: "impulses",
			startInstance: 0,
			maximumInstances: SONIC_METEOR_CAP + SONIC_TRAIL_CAP,
		};
	}

	function schedulePhase(build: PendingBuild): void {
		if (pendingBuild !== build || disposed || !active) return;
		const info = nextPhase(build);
		build.phase += 1;
		const accepted = context.tasks.enqueue({
			owner,
			key: `g${build.generation}:p${info.phase}`,
			priority: "visible",
			cost: 1,
			run(taskContext) {
				if (
					pendingBuild !== build ||
					taskContext.signal.aborted ||
					build.ticket.signal.aborted ||
					!build.ticket.isCurrent()
				) {
					throw new Error("cancelled Sonic rebuild phase");
				}
				try {
					dependencies.beforeBuildPhase?.(info);
					if (info.kind === "terrain") {
						build.terrainCursor = build.bundle.terrain.fillRange(
							build.terrainCursor,
							info.maximumInstances,
						);
					} else if (info.kind === "floating") {
						build.floatingCursor = build.bundle.floating.fillRange(
							build.floatingCursor,
							info.maximumInstances,
						);
					} else {
						build.bundle.impulses.initialize();
						build.impulsesInitialized = true;
					}
				} catch (error) {
					build.failure = error;
					throw error;
				}
				return build.impulsesInitialized;
			},
			commit(complete) {
				if (pendingBuild !== build) return;
				if (complete) {
					build.bundle.terrain.finalize();
					build.bundle.floating.finalize();
					commitBundle(build);
				} else {
					schedulePhase(build);
				}
			},
			onSettled(settlement: BudgetTaskSettlement) {
				if (settlement === "failed") {
					failPending(build, build.failure, false);
				} else if (
					(settlement === "cancelled" || settlement === "stale") &&
					pendingBuild === build
				) {
					failPending(build, "cancelled Sonic rebuild", true);
				}
			},
		});
		if (!accepted) failPending(build, "Sonic rebuild task admission denied", false);
	}

	function requestRebuild(): void {
		if (!active || disposed || !activationResources || !activationCancellation) return;
		cancelPending(true);
		generation += 1;
		const buildGeneration = generation;
		const ticket = activationCancellation.issue(owner, "rebuild");
		const buildScope = activationResources.createChild(`generation-${buildGeneration}`);
		let bundle: SonicLayerBundle;
		try {
			bundle = createLayerBundle({
				generation: buildGeneration,
				scope: buildScope,
				settings: desiredSettings,
				quality: desiredQuality,
				palette: currentPalette(),
				random,
			});
		} catch (error) {
			buildScope.dispose();
			buildFailures += 1;
			lastFailure = describeError(error);
			return;
		}
		const build: PendingBuild = {
			generation: buildGeneration,
			bundle,
			ticket,
			terrainCursor: 0,
			floatingCursor: 0,
			impulsesInitialized: false,
			phase: 0,
			failure: null,
		};
		pendingBuild = build;
		updatePeaks();
		schedulePhase(build);
	}

	function getDiagnostics(): SonicTopographyDiagnostics {
		const impulseDiagnostics = activeBundle?.impulses.getDiagnostics() ?? {
			ripples: 0,
			meteors: 0,
			trails: 0,
		};
		const totalInstances = bundleInstances(activeBundle);
		const residentInstances = totalInstances + bundleInstances(pendingBuild?.bundle ?? null);
		const geometryBytes = activeBundle?.geometryBytes ?? 0;
		const residentGeometryBytes = geometryBytes + (pendingBuild?.bundle.geometryBytes ?? 0);
		const geometryPressure = residentGeometryBytes > SONIC_GEOMETRY_HARD_BYTES
			? "hard"
			: residentGeometryBytes >= SONIC_GEOMETRY_SOFT_BYTES
				? "soft"
				: "normal";
		return Object.freeze({
			active,
			disposed,
			generation,
			committedGeneration,
			pendingRebuilds: pendingBuild ? 1 : 0,
			meshCount: activeBundle?.meshCount ?? 0,
			residentMeshCount:
				(activeBundle?.meshCount ?? 0) + (pendingBuild?.bundle.meshCount ?? 0),
			materialCount: activeBundle?.materialCount ?? 0,
			textureCount: 0,
			geometryBytes,
			residentGeometryBytes,
			peakGeometryBytes,
			geometryPressure,
			totalInstances,
			residentInstances,
			peakInstances,
			terrainGrid: activeBundle?.terrain.grid ?? 0,
			terrainInstances: activeBundle?.terrain.instanceCount ?? 0,
			floatingInstances: activeBundle?.floating.instanceCount ?? 0,
			meteorCapacity: activeBundle ? SONIC_METEOR_CAP : 0,
			trailCapacity: activeBundle ? SONIC_TRAIL_CAP : 0,
			rippleCapacity: activeBundle ? SONIC_IMPULSE_RIPPLE_CAP : 0,
			activeRipples: impulseDiagnostics.ripples,
			activeMeteors: impulseDiagnostics.meteors,
			activeTrails: impulseDiagnostics.trails,
			phaseInstanceBudget,
			buildFailures,
			cancelledBuilds,
			lastFailure,
		});
	}

	unregisterDiagnostics = context.diagnostics.register("sonicTopography", getDiagnostics);

	return {
		activate(settings = SONIC_TOPOGRAPHY_DEFAULTS, quality = "high") {
			if (disposed) throw new Error("Sonic topography runtime is disposed.");
			if (active) {
				this.configure(settings, quality);
				return;
			}
			desiredSettings = normalizeSonicTopographySettings(settings);
			desiredQuality = normalizeQuality(quality);
			activationResources = context.resources.createChild(`${owner}:activation-${generation + 1}`);
			activationCancellation = context.cancellation.createChild(`${owner}:activation-${generation + 1}`);
			active = true;
			requestRebuild();
		},
		configure(settings, quality = desiredQuality) {
			if (disposed) return;
			const normalized = normalizeSonicTopographySettings(settings);
			const normalizedQuality = normalizeQuality(quality);
			const structuralReference = pendingBuild?.bundle ?? activeBundle;
			const changedStructure = !structuralReference ||
				structuralSignature(normalized, normalizedQuality) !==
					structuralSignature(
						structuralReference.settings,
						structuralReference.quality,
					);
			desiredSettings = normalized;
			desiredQuality = normalizedQuality;
			if (!active) return;
			if (changedStructure) {
				requestRebuild();
				return;
			}
			const palette = currentPalette(normalized);
			activeBundle?.applySettings(normalized, palette);
			pendingBuild?.bundle.applySettings(normalized, palette);
		},
		update(frame) {
			if (!active || disposed || !activeBundle) return;
			const audio = frame.snapshot.sonic ?? context.audio();
			activeBundle.update(frame, audio);
		},
		pointerRipple(x, z, strength) {
			if (!active || disposed) return;
			activeBundle?.pointerRipple(x, z, strength);
		},
		deactivate() {
			if (!active) return;
			active = false;
			cancelPending(true);
			const bundle = activeBundle;
			activeBundle = null;
			bundle?.dispose();
			activationCancellation?.dispose();
			activationCancellation = null;
			activationResources?.dispose();
			activationResources = null;
		},
		dispose() {
			if (disposed) return;
			this.deactivate();
			disposed = true;
			unregisterDiagnostics?.();
			unregisterDiagnostics = null;
		},
		getDiagnostics,
	};
}

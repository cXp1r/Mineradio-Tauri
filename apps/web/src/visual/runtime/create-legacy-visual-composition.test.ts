import { expect, test } from "bun:test";
import "../../../../../packages/visual-engine/src/runtime/happy-dom-preload";
import {
	createVisualEngine,
	createVisualResourceScope,
	type VisualEngineCompositionContext,
	type VisualResourceScope,
} from "@mineradio/visual-engine";
import {
	createLegacyVisualComposition,
	createLegacyHomeVisualRuntimeGovernor,
	LEGACY_VISUAL_LANE_CADENCE,
	mountOwnedStageLyricsLifecycle,
	normalizeSonicPerformanceQuality,
	resolveLegacyVisualCameraPolicyInput,
	sonicPaletteSnapshotFromLyricPalette,
	resolveSonicPointerRipple,
	resolveSonicShelfMode,
	shouldActivateSonicTopography,
} from "./create-legacy-visual-composition";
import { createLegacyVisualEventBridge } from "./legacy-visual-events";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => { resolve = next; });
	return { promise, resolve };
}

test("legacy visual composition factory is side-effect free", () => {
	let touched = 0;
	const composition = createLegacyVisualComposition({
		audioElementRef: { get current() { touched += 1; return null; } },
		events: createLegacyVisualEventBridge(),
	});
	expect(touched).toBe(0);
	expect(typeof composition.mount).toBe("function");
	expect(typeof composition.applyFrameSnapshot).toBe("function");
	expect(typeof composition.dispose).toBe("function");
});

test("Sonic production route activates only for preset 7 and normalizes quality", () => {
	expect(shouldActivateSonicTopography(7)).toBe(true);
	expect(shouldActivateSonicTopography(6)).toBe(false);
	expect(shouldActivateSonicTopography(8)).toBe(false);
	expect(normalizeSonicPerformanceQuality("eco")).toBe("eco");
	expect(normalizeSonicPerformanceQuality("ultra")).toBe("ultra");
	expect(normalizeSonicPerformanceQuality("unknown")).toBe("high");
});

test("Sonic cover palette receives Stage primary, secondary, and highlight colors", () => {
	expect(sonicPaletteSnapshotFromLyricPalette({
		primary: "#112233",
		secondary: "#445566",
		highlight: "#778899",
		glowColor: "#aabbcc",
	})).toEqual({
		primary: "#112233",
		secondary: "#445566",
		highlight: "#778899",
	});
	expect(sonicPaletteSnapshotFromLyricPalette(null)).toBeNull();
});

test("legacy composition camera policy exposes only the eligible Stage target", () => {
	const stageTarget = { x: 0.4, y: 0.2, z: -0.3 };
	expect(resolveLegacyVisualCameraPolicyInput({ preset: 7, lyricCameraLock: false, particleLyrics: true }, stageTarget)).toEqual({
		activePreset: 7,
		lyricCameraLock: false,
		wallpaperLyricLock: false,
		stageWorldTarget: stageTarget,
	});
	expect(resolveLegacyVisualCameraPolicyInput({ preset: 7, lyricCameraLock: false, particleLyrics: false }, stageTarget).stageWorldTarget).toBeNull();
	expect(resolveLegacyVisualCameraPolicyInput({ preset: 7, lyricCameraLock: true, particleLyrics: true }, stageTarget).lyricCameraLock).toBe(true);
	expect(resolveLegacyVisualCameraPolicyInput({ preset: 5, lyricCameraLock: true, particleLyrics: true }, stageTarget).wallpaperLyricLock).toBe(true);
});

test("Sonic lane is ordered between skull and Stage Lyrics", () => {
	expect(LEGACY_VISUAL_LANE_CADENCE.SonicTopography).toBe("presentation");
});

test("Sonic pointer release preserves the Electron 2.0.2 screen mapping and press strength", () => {
	const base = { preset: 7, dragged: false, overUi: false, freeCameraActive: false, heldMs: 0, ndcX: 0.5, ndcY: -0.25 };
	expect(resolveSonicPointerRipple({ ...base, preset: 6 })).toBeNull();
	expect(resolveSonicPointerRipple({ ...base, dragged: true })).toBeNull();
	expect(resolveSonicPointerRipple({ ...base, overUi: true })).toBeNull();
	expect(resolveSonicPointerRipple({ ...base, freeCameraActive: true })).toBeNull();
	expect(resolveSonicPointerRipple(base)).toEqual({ x: 8.5, z: -4.25, strength: 0.25 });
	expect(resolveSonicPointerRipple({ ...base, heldMs: 10_000 })).toEqual({ x: 8.5, z: -4.25, strength: 3 });
});

test("Sonic suppresses the Shelf unless an already-open detail must remain usable", () => {
	expect(resolveSonicShelfMode(7, "side", false)).toBe("off");
	expect(resolveSonicShelfMode(7, "stage", false)).toBe("off");
	expect(resolveSonicShelfMode(7, "side", true)).toBe("side");
	expect(resolveSonicShelfMode(6, "stage", false)).toBe("stage");
});

test("late Stage Lyrics mount cannot revive a disposed composition and its owned lifecycle disposes exactly once", async () => {
	const gate = deferred();
	const scope = createVisualResourceScope("test").createChild("legacy");
	let disposeCalls = 0;
	let mountedCalls = 0;
	const lifecycle = {
		mount: () => gate.promise,
		dispose: () => { disposeCalls += 1; },
	};
	const pending = mountOwnedStageLyricsLifecycle({
		scope,
		lifecycle: lifecycle as never,
		scene: {} as never,
		isCurrent: () => scope.isOpen(),
		onMounted: () => { mountedCalls += 1; },
	});
	scope.dispose();
	gate.resolve();
	expect(await pending).toBe(false);
	expect(mountedCalls).toBe(0);
	expect(disposeCalls).toBe(1);
	scope.dispose();
	expect(disposeCalls).toBe(1);
});

test("Stage Lyrics ownership releases the lifecycle immediately when registration is already stale", async () => {
	const scope = createVisualResourceScope("test").createChild("legacy");
	scope.dispose();
	let disposeCalls = 0;
	const lifecycle = {
		mount: async () => {},
		dispose: () => { disposeCalls += 1; },
	};

	let caught: unknown = null;
	try {
		await mountOwnedStageLyricsLifecycle({
			scope,
			lifecycle: lifecycle as never,
			scene: {} as never,
			isCurrent: () => false,
			onMounted: () => { throw new Error("stale lifecycle must not mount"); },
		});
	} catch (error) {
		caught = error;
	}
	expect((caught as Error).message).toContain("cancelled");
	expect(disposeCalls).toBe(1);
});

test("legacy composition surfaces child disposal failures through facade cleanup without skipping releases", async () => {
	const childCreated = deferred();
	const disposalFailure = new Error("legacy child disposal failed");
	const disposalOrder: string[] = [];
	const reported: unknown[][] = [];
	const legacy = createLegacyVisualComposition({
		audioElementRef: { current: null },
		events: createLegacyVisualEventBridge(),
	});
	const engine = createVisualEngine({
		mediaClock: {
			currentTimeSeconds: () => 0,
			durationSeconds: () => null,
			isPlaying: () => false,
		},
		createComposition: () => ({
			mount(context: VisualEngineCompositionContext) {
				const rootResources = context.resources;
				const resources: VisualResourceScope = {
					get name() { return rootResources.name; },
					get closed() { return rootResources.closed; },
					isOpen: () => rootResources.isOpen(),
					register: (registration) => rootResources.register(registration),
					createChild(name) {
						const child = rootResources.createChild(name);
						child.register({
							owner: "failing-cleanup",
							kind: "listener",
							retention: "persistent",
							dispose() {
								disposalOrder.push("failing");
								throw disposalFailure;
							},
						});
						child.register({
							owner: "healthy-cleanup",
							kind: "listener",
							retention: "persistent",
							dispose() { disposalOrder.push("healthy"); },
						});
						childCreated.resolve();
						return child;
					},
					releaseRetention: (retention) => rootResources.releaseRetention(retention),
					dispose: () => rootResources.dispose(),
				};
				return legacy.mount({ ...context, resources });
			},
			applyFrameSnapshot: (snapshot) => legacy.applyFrameSnapshot(snapshot),
			applyPreset: (preset) => legacy.applyPreset(preset),
			setVisibility: (visibility) => legacy.setVisibility(visibility),
			dispose: () => legacy.dispose(),
		}),
	});
	const mountResultPromise = engine.mount(document.createElement("div")).then(
		() => ({ status: "fulfilled" as const, error: null }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	);
	await childCreated.promise;
	const originalConsoleError = console.error;
	console.error = (...args: unknown[]) => { reported.push(args); };
	try {
		engine.dispose();
		engine.dispose();
	} finally {
		console.error = originalConsoleError;
	}
	const mountResult = await mountResultPromise;

	expect(mountResult.status).toBe("rejected");
	expect(mountResult.error instanceof Error).toBe(true);
	expect(disposalOrder).toEqual(["healthy", "failing"]);
	expect(reported.length).toBe(1);
	expect(reported[0]?.[0]).toContain("composition dispose");
	expect(reported[0]?.[1] instanceof AggregateError).toBe(true);
	expect((reported[0]?.[1] as AggregateError).errors).toEqual([disposalFailure]);
});

test("legacy event bridge forwards Shelf payloads by identity and updates callbacks without replacing the sink", () => {
	const payload = { playlistId: "7", provider: "netease" };
	const first: unknown[] = [];
	const second: unknown[] = [];
	const events = createLegacyVisualEventBridge({
		onShelfPlayPlaylist: (value) => first.push(value),
	});
	const sameEvents = events;
	events.onShelfPlayPlaylist(payload as never);
	events.update({ onShelfPlayPlaylist: (value) => second.push(value) });
	events.onShelfPlayPlaylist(payload as never);
	expect(events).toBe(sameEvents);
	expect(first).toEqual([payload]);
	expect(second).toEqual([payload]);
	expect(first[0]).toBe(payload);
	expect(second[0]).toBe(payload);
});

test("legacy composition uses facade-owned scheduler services and dedicated visual lanes", async () => {
	const source = await fetch(new URL("./create-legacy-visual-composition.ts", import.meta.url)).then((response) => response.text());
	expect(LEGACY_VISUAL_LANE_CADENCE).toEqual({
		Beatmap: 60,
		Ripples: 60,
		Shelf: 30,
		LyricParticles: 45,
		SonicTopography: "presentation",
		StageLyrics: 45,
		DesktopOverlaySync: 12,
		HomeVisual: "presentation",
		CameraCinematic: "presentation",
	});
	expect(source).toContain("scheduler: context.scheduler");
	expect(source).toContain("performance: context.performance");
	expect(source).toContain("nextContext.cancellation");
	expect(source).toContain("nextContext.getFrameSnapshot()");
	expect(source).toContain("options.getPrefersReducedMotion?.()");
	expect(source).toContain("RenderStepSlot.Beatmap");
	expect(source).toContain("RenderStepSlot.Maintenance");
	expect(source).toContain("RenderStepSlot.Ripples");
	expect(source).toContain("RenderStepSlot.Shelf");
	expect(source).toContain("RenderStepSlot.LyricParticles");
	expect(source).toContain("RenderStepSlot.SonicTopography");
	expect(source).toContain("RenderStepSlot.StageLyrics");
	expect(source).toContain("RenderStepSlot.DesktopOverlaySync");
	expect(source).not.toContain("scheduler.start(");
	expect(source).not.toContain("scheduler.stop(");
	expect(source).not.toContain("scheduler.dispose(");
	expect(source).not.toContain("audioEngine.update(ctx.dt)");
	expect(source).toContain("runtimeGovernor?.sync(context?.scheduler.getMode()");
	expect(source.match(/runtimeGovernor\?\.sync\(context\?\.scheduler\.getMode\(\)/g)?.length).toBe(2);
	expect(source).toContain("maintenanceLane.pump(nextContext.scheduler.getMode())");
	expect(source).not.toContain("runtimeGovernor?.pump(");
});

test("home visual runtime governor releases in exact order and wakes only in an active mode", () => {
	const calls: string[] = [];
	const governor = createLegacyHomeVisualRuntimeGovernor({
		homeVisual: { setRuntimeActive: (active) => calls.push(`active:${active}`) },
		tasks: {
			cancelPriority: (priority) => calls.push(`cancel:${priority}`),
		},
		resources: {
			releaseRetention: (retention) => {
				calls.push(`release:${Array.isArray(retention) ? retention.join("+") : retention}`);
				return { disposed: 0, errors: [] };
			},
		},
		trimCache: (maxEntries) => calls.push(`trim:${maxEntries}`),
		refreshPerformanceSnapshots: () => calls.push("refresh"),
	});

	governor.sync("foreground");
	governor.sync("released");
	governor.sync("released");
	governor.sync("deep-sleep");
	expect(calls).toEqual([
		"active:false",
		"cancel:background",
		"trim:0",
		"release:rebuildable+ephemeral",
		"refresh",
	]);
	governor.sync("foreground");
	expect(calls.at(-1)).toBe("active:true");
});

test("legacy composition registers resources with semantic ownership kinds", async () => {
	const source = await fetch(new URL("./create-legacy-visual-composition.ts", import.meta.url)).then((response) => response.text());
	const normalizedSource = source.replace(/\s+/g, " ");
	expect(normalizedSource).toContain('"renderer", "mesh"');
	expect(normalizedSource).toContain('"home-visual", "mesh"');
	expect(normalizedSource).toContain('"stage-lyrics", "mesh"');
	expect(normalizedSource).toContain('"render-loop", "subscription"');
	expect(normalizedSource).toContain('"renderer-resize", "listener"');
	expect(normalizedSource).toContain('"audio-beat-subscription", "subscription"');
	expect(normalizedSource).toContain('"audio-frame-source", "async-task"');
	expect(source).not.toContain('registerOwnedDisposable(scope, isCurrent, "renderer", await');
});

test("legacy composition keeps both production Shelf data sync paths on the budgeted builder", async () => {
	const source = await fetch(new URL("./create-legacy-visual-composition.ts", import.meta.url)).then((response) => response.text());
	const calls = source.match(/shelfManager\.setData\([^\n]+/g) ?? [];
	expect(calls.length).toBe(2);
	for (const call of calls) expect(call).toContain("{ asyncBuild: true }");
});

test("legacy composition routes every Shelf portrait decision through the shared 1.08 policy", async () => {
	const source = await fetch(new URL("./create-legacy-visual-composition.ts", import.meta.url)).then((response) => response.text());
	expect(source.match(/isShelfPortraitViewport\(/g)?.length).toBeGreaterThanOrEqual(5);
	expect(source).not.toContain("window.innerHeight > window.innerWidth");
});

test("legacy composition clears camera focus from the Shelf detail phase callback", async () => {
	const source = await fetch(new URL("./create-legacy-visual-composition.ts", import.meta.url)).then((response) => response.text());
	expect(source).toContain("onDetailPhaseChange: (phase)");
	expect(source).toContain('if (phase !== "closing") return;');
	expect(source).toContain("cinema.setFocusZone(null");
});

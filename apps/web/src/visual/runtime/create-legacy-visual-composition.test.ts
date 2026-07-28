import { expect, test } from "bun:test";
import { createVisualResourceScope } from "@mineradio/visual-engine";
import {
	createLegacyVisualComposition,
	LEGACY_VISUAL_LANE_CADENCE,
	mountOwnedStageLyricsLifecycle,
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
	expect(source).toContain("RenderStepSlot.Ripples");
	expect(source).toContain("RenderStepSlot.Shelf");
	expect(source).toContain("RenderStepSlot.LyricParticles");
	expect(source).toContain("RenderStepSlot.StageLyrics");
	expect(source).toContain("RenderStepSlot.DesktopOverlaySync");
	expect(source).not.toContain("scheduler.start(");
	expect(source).not.toContain("scheduler.stop(");
	expect(source).not.toContain("scheduler.dispose(");
	expect(source).not.toContain("audioEngine.update(ctx.dt)");
	expect(source).not.toContain("context.tasks");
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

import { expect, test } from "bun:test";
import { RENDER_STEP_ORDER, RenderStepSlot } from "./render-step-slot";

test("maintenance has one deterministic lane before visual subsystem updates", () => {
	expect(RENDER_STEP_ORDER.filter((slot) => slot === RenderStepSlot.Maintenance)).toHaveLength(1);
	expect(RENDER_STEP_ORDER.indexOf(RenderStepSlot.Maintenance)).toBeGreaterThan(
		RENDER_STEP_ORDER.indexOf(RenderStepSlot.Beatmap),
	);
	expect(RENDER_STEP_ORDER.indexOf(RenderStepSlot.Maintenance)).toBeLessThan(
		RENDER_STEP_ORDER.indexOf(RenderStepSlot.HomeVisual),
	);
});

test("sonic renders after skull and before stage lyrics", () => {
	expect(RENDER_STEP_ORDER.filter((slot) => slot === RenderStepSlot.SonicTopography)).toHaveLength(1);
	expect(RENDER_STEP_ORDER.indexOf(RenderStepSlot.SonicTopography)).toBeGreaterThan(
		RENDER_STEP_ORDER.indexOf(RenderStepSlot.SkullLayer),
	);
	expect(RENDER_STEP_ORDER.indexOf(RenderStepSlot.SonicTopography)).toBeLessThan(
		RENDER_STEP_ORDER.indexOf(RenderStepSlot.StageLyrics),
	);
});

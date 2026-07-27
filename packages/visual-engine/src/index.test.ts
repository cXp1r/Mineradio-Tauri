import { expect, test } from "bun:test";
import {
	createVisualEngine,
	type VisualEngineFacade,
	type VisualEngineOptions,
} from "./index";

test("createVisualEngine exposes the option-based facade", () => {
	const options: VisualEngineOptions = {
		mediaClock: {
			currentTimeSeconds: () => 0,
			durationSeconds: () => null,
			isPlaying: () => false,
		},
		createComposition: () => ({
			async mount(context) {
				context.scheduler.registerRuntimeCallbacks({ onAnimation() {} });
			},
			applyFrameSnapshot() {},
			applyPreset() {},
			setVisibility() {},
			dispose() {},
		}),
	};
	const engine: VisualEngineFacade = createVisualEngine(options);

	expect(typeof engine.mount).toBe("function");
	expect(typeof engine.setPlaybackSnapshot).toBe("function");
	expect(typeof engine.getPerformanceSnapshot).toBe("function");
	expect(typeof engine.dispose).toBe("function");
});

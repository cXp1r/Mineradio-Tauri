import { expect, test } from "bun:test";
import { createVisualEngine, type VisualEngine } from "./index";

test("createVisualEngine returns lifecycle methods", () => {
	const engine: VisualEngine = createVisualEngine();

	expect(typeof engine.update).toBe("function");
	expect(typeof engine.resize).toBe("function");
	expect(typeof engine.dispose).toBe("function");
});

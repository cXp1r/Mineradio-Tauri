import { expect, test } from "bun:test";
import { createVisualSubsystemDiagnosticsRegistry } from "./subsystem-diagnostics";

test("subsystem diagnostics snapshots are immutable copies and unregister with their supplier", () => {
	const registry = createVisualSubsystemDiagnosticsRegistry();
	const source = { pending: 2, nested: { peak: 4 } };
	const unregister = registry.register("stageLyrics", () => source);

	const first = registry.snapshot();
	expect(first).toEqual({ stageLyrics: { pending: 2, nested: { peak: 4 } } });
	expect(Object.isFrozen(first)).toBe(true);
	expect(Object.isFrozen(first.stageLyrics)).toBe(true);
	expect(Object.isFrozen(first.stageLyrics?.nested)).toBe(true);

	source.pending = 7;
	source.nested.peak = 9;
	expect(first.stageLyrics).toEqual({ pending: 2, nested: { peak: 4 } });

	unregister();
	expect(registry.snapshot()).toEqual({});
});

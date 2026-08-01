import { expect, test } from "bun:test";
import { createVisualMaintenanceLane } from "./visual-maintenance-lane";

test("maintenance lane pumps the shared task queue independently of Home state", () => {
	const calls: string[] = [];
	const lane = createVisualMaintenanceLane({
		tasks: { runSlice: (budget) => { calls.push(`slice:${budget}`); return 1; } },
		refreshPerformanceSnapshots: () => calls.push("refresh"),
	});

	lane.pump("foreground");
	lane.pump("background");
	lane.pump("deep-sleep");
	lane.pump("released");

	expect(calls).toEqual(["slice:1", "refresh", "slice:1", "refresh"]);
});

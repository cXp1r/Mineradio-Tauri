import type { BudgetTaskQueue } from "./budget-task-queue";
import type { VisualRuntimeMode } from "./visual-engine-contract";

export interface VisualMaintenanceLane {
	pump(mode: VisualRuntimeMode): void;
}

export interface VisualMaintenanceLaneOptions {
	readonly tasks: Pick<BudgetTaskQueue, "runSlice">;
	readonly refreshPerformanceSnapshots: () => void;
	readonly taskCostBudget?: number;
}

export function createVisualMaintenanceLane(
	options: VisualMaintenanceLaneOptions,
): VisualMaintenanceLane {
	const taskCostBudget = options.taskCostBudget ?? 1;
	if (!Number.isFinite(taskCostBudget) || taskCostBudget < 0) {
		throw new RangeError("Maintenance task cost budget must be finite and non-negative.");
	}

	return {
		pump(mode) {
			if (mode !== "foreground" && mode !== "background") return;
			options.tasks.runSlice(taskCostBudget);
			options.refreshPerformanceSnapshots();
		},
	};
}

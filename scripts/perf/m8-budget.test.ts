import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const budgetCli = path.join(import.meta.dir, "m8-budget.mjs");

describe("M8 deterministic performance gate", () => {
	test("print-plan exposes every required core budget and resource lifecycle suite", () => {
		const result = spawnSync(process.execPath, [budgetCli, "--print-plan"], {
			cwd: repoRoot,
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		const plan = JSON.parse(result.stdout) as {
			testTargets: string[];
			budgets: string[];
			nativeTestFilters: string[];
		};

		for (const requiredTarget of [
			"apps/web/src/features/home/home-dashboard-policy.test.ts",
			"apps/web/src/features/home/home-hero-video.test.ts",
			"apps/web/src/features/home/HomeDashboardHero.test.tsx",
			"apps/web/src/features/search/search-session-controller.test.ts",
			"apps/web/src/features/settings/settings-transaction-controller.test.ts",
			"apps/web/src/features/settings/SettingsWorkbench.test.tsx",
			"apps/web/src/adapters/storage/preferences-repository.conformance.test.ts",
			"apps/web/src/adapters/tauri/tauri-preferences-repository.test.ts",
			"apps/web/src/preferences/legacy-preferences.test.ts",
			"apps/web/src/perf/m8-dom-budget.test.tsx",
		]) {
			expect(plan.testTargets.includes(requiredTarget)).toBe(true);
		}

		for (const requiredBudget of [
			"home-visible-dom",
			"search-visible-dom",
			"settings-history-dom",
			"preferences-migration-limits",
			"timer-listener-object-url-cleanup",
		]) {
			expect(plan.budgets.includes(requiredBudget)).toBe(true);
		}
		expect(plan.nativeTestFilters).toEqual(["preference_"]);
	});

	test("Linux CI can skip duplicate native compilation while retaining the declared Rust gate", () => {
		const result = spawnSync(process.execPath, [budgetCli, "--print-plan"], {
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				MINERADIO_PERF_SKIP_NATIVE: "1",
			},
		});

		expect(result.status).toBe(0);
		const plan = JSON.parse(result.stdout) as {
			nativeTestFilters: string[];
			nativeGateSkipped: boolean;
		};
		expect(plan.nativeTestFilters).toEqual(["preference_"]);
		expect(plan.nativeGateSkipped).toBe(true);
	});
});

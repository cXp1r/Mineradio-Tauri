import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const baselinePath = path.join(repoRoot, "scripts", "perf", "m8-budget-baseline.json");
const distRoot = path.join(repoRoot, "apps", "web", "dist");
const reportPath = path.join(repoRoot, "tmp", "perf-results", "m8-budget-current.json");
const updateBaseline = process.argv.includes("--update-baseline");
const printPlan = process.argv.includes("--print-plan");
const skipNative = process.env.MINERADIO_PERF_SKIP_NATIVE === "1";

const deterministicTestTargets = [
	"packages/visual-engine/src/home-visual/cover-depth.test.ts",
	"apps/web/src/components/shell/virtual-list.test.ts",
	"apps/web/src/components/shell/PlaylistPanelHost.test.tsx",
	"apps/web/src/components/lyrics/LyricView.test.tsx",
	"apps/web/src/features/home/home-dashboard-policy.test.ts",
	"apps/web/src/features/home/home-listen-ledger.test.ts",
	"apps/web/src/features/home/home-hero-video.test.ts",
	"apps/web/src/features/home/HomeDashboardHero.test.tsx",
	"apps/web/src/home/EmptyHomeHost.test.tsx",
	"apps/web/src/features/search/search-session-controller.test.ts",
	"apps/web/src/components/shell/SearchShell.test.ts",
	"apps/web/src/components/shell/SearchDetailPage.test.tsx",
	"apps/web/src/features/settings/settings-transaction-controller.test.ts",
	"apps/web/src/features/settings/settings-catalog.test.ts",
	"apps/web/src/features/settings/SettingsWorkbench.test.tsx",
	"apps/web/src/adapters/storage/preferences-repository.conformance.test.ts",
	"apps/web/src/adapters/tauri/tauri-preferences-repository.test.ts",
	"apps/web/src/preferences/keys.test.ts",
	"apps/web/src/preferences/legacy-preferences.test.ts",
	"apps/web/src/preferences/preference-digest.test.ts",
	"apps/web/src/perf/m8-dom-budget.test.tsx",
	"scripts/perf/m8-budget.test.ts",
	"scripts/perf/m8-windows-release-evidence.test.ts",
];

const deterministicBudgetNames = [
	"home-visible-dom",
	"search-visible-dom",
	"settings-history-dom",
	"large-list-virtual-window",
	"depth-hot-path-allocation",
	"bundle-size",
	"preferences-migration-limits",
	"timer-listener-object-url-cleanup",
	"direct-local-storage-boundary",
];

const nativeTestFilters = ["preference_"];

if (printPlan) {
	process.stdout.write(`${JSON.stringify({
		schemaVersion: 1,
		testTargets: deterministicTestTargets,
		budgets: deterministicBudgetNames,
		nativeTestFilters,
		nativeGateSkipped: skipNative,
	})}\n`);
	process.exit(0);
}

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
	}
}

function collectDistStats(root) {
	const result = {
		totalBytes: 0,
		jsBytes: 0,
		cssBytes: 0,
		largestJsBytes: 0,
		fileCount: 0,
	};
	const visit = (directory) => {
		for (const name of readdirSync(directory)) {
			const fullPath = path.join(directory, name);
			const item = statSync(fullPath);
			if (item.isDirectory()) {
				visit(fullPath);
				continue;
			}
			result.fileCount += 1;
			result.totalBytes += item.size;
			if (name.endsWith(".js")) {
				result.jsBytes += item.size;
				result.largestJsBytes = Math.max(result.largestJsBytes, item.size);
			}
			if (name.endsWith(".css")) result.cssBytes += item.size;
		}
	};
	visit(root);
	return result;
}

function normalizedRelative(filePath) {
	return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function collectDirectLocalStorageFiles() {
	const sourceRoot = path.join(repoRoot, "apps", "web", "src");
	const matches = [];
	const visit = (directory) => {
		for (const name of readdirSync(directory)) {
			const fullPath = path.join(directory, name);
			const item = statSync(fullPath);
			if (item.isDirectory()) {
				visit(fullPath);
				continue;
			}
			if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue;
			if (!readFileSync(fullPath, "utf8").includes("localStorage")) continue;
			matches.push(normalizedRelative(fullPath));
		}
	};
	visit(sourceRoot);
	return matches.sort();
}

function readBaseline() {
	if (!existsSync(baselinePath)) {
		throw new Error(`missing M8 performance baseline: ${baselinePath}`);
	}
	return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function assertBundleBudget(current, baseline) {
	const tolerance = baseline.bundleTolerance ?? 0.1;
	for (const metric of ["totalBytes", "jsBytes", "cssBytes", "largestJsBytes"]) {
		const expected = Number(baseline.bundle?.[metric] ?? 0);
		const actual = Number(current[metric] ?? 0);
		const maximum = Math.ceil(expected * (1 + tolerance));
		if (expected <= 0 || actual > maximum) {
			throw new Error(
				`M8 bundle budget exceeded for ${metric}: ${actual} > ${maximum} (baseline ${expected})`,
			);
		}
	}
}

function assertLocalStorageBudget(current, baseline) {
	const allowed = new Set(baseline.directLocalStorageFiles ?? []);
	const unexpected = current.filter(
		(file) =>
			!allowed.has(file) &&
			!file.startsWith("apps/web/src/adapters/storage/"),
	);
	if (unexpected.length) {
		throw new Error(
			`new direct localStorage production access is forbidden:\n${unexpected.join("\n")}`,
		);
	}
}

if (process.env.MINERADIO_PERF_SKIP_BUILD !== "1") {
	run("bun", ["run", "web:build"]);
}
if (!existsSync(distRoot)) throw new Error("apps/web/dist is missing after build");

const current = {
	capturedAt: new Date().toISOString(),
	bundle: collectDistStats(distRoot),
	directLocalStorageFiles: collectDirectLocalStorageFiles(),
	deterministicGatePlan: {
		budgets: deterministicBudgetNames,
		testTargets: deterministicTestTargets,
		nativeTestFilters,
		nativeGateSkipped: skipNative,
	},
};

if (updateBaseline) {
	const previous = existsSync(baselinePath) ? readBaseline() : {};
	writeFileSync(
		baselinePath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				bundleTolerance: previous.bundleTolerance ?? 0.1,
				bundle: current.bundle,
				directLocalStorageFiles: current.directLocalStorageFiles,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
} else {
	const baseline = readBaseline();
	assertBundleBudget(current.bundle, baseline);
	assertLocalStorageBudget(current.directLocalStorageFiles, baseline);
	run("bun", ["test", ...deterministicTestTargets]);
	if (!skipNative) {
		for (const filter of nativeTestFilters) {
			run("cargo", [
				"test",
				"--manifest-path",
				"apps/desktop/src-tauri/Cargo.toml",
				"--locked",
				filter,
			]);
		}
	}
}

mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
console.log(`M8 deterministic performance budget passed: ${reportPath}`);

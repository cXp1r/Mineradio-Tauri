import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const appSource = readFileSync(
	resolve(import.meta.dir, "../../apps/web/src/app/App.tsx"),
	"utf8",
);

test("production bootstrap owns the only long-lived Web update port and controller", () => {
	const bootstrap = read("apps/web/src/main.tsx");
	expect(bootstrap).toContain("createTauriUpdateRuntimePort");
	expect(bootstrap).toContain("createDisabledUpdateRuntimePort");
	expect(bootstrap).toContain("updater bootstrap failed; continuing with updates disabled");
	expect(bootstrap).toContain("createUpdateExperienceController");
	expect(bootstrap).toContain("updateController={updateController}");
	expect(bootstrap).toContain("updateController.dispose()");
	expect(bootstrap).toContain("updateRuntime.dispose()");
});

test("App and UpdateHost only consume the injected update experience", () => {
	const hostSource = read("apps/web/src/components/shell/UpdateHost.tsx");
	expect(appSource).toContain("useUpdateExperience");
	expect(appSource).toContain("updateController: UpdateExperienceController");
	expect(appSource).not.toContain("useUpdaterController");
	expect(appSource).not.toContain("useUpdateStore");
	expect(appSource).not.toContain("checkForUpdate");
	expect(appSource).not.toContain("getUpdaterStatus");
	expect(appSource).not.toContain("installUpdate");
	expect(appSource).not.toContain("shouldOpenDevUpdatePreview");
	expect(appSource).not.toContain("applyUpdateCheckResult");
	expect(appSource).not.toContain("setUpdateStatus");
	expect(hostSource).not.toContain("LegacyUpdateHost");
	expect(hostSource).not.toContain("UpdateState");
});

test("legacy Web updater authorities are deleted after cutover", () => {
	for (const path of [
		"apps/web/src/tauri/updater.ts",
		"apps/web/src/stores/update-store.ts",
		"apps/web/src/features/updater/useUpdaterController.ts",
	]) {
		expect(existsSync(resolve(root, path))).toBe(false);
	}
});

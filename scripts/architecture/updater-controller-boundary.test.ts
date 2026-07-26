import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(
	resolve(import.meta.dir, "../../apps/web/src/app/App.tsx"),
	"utf8",
);

test("App delegates updater behavior to the updater controller", () => {
	expect(appSource).toContain("useUpdaterController");
	expect(appSource).not.toContain("checkForUpdate");
	expect(appSource).not.toContain("getUpdaterStatus");
	expect(appSource).not.toContain("installUpdate");
	expect(appSource).not.toContain("shouldOpenDevUpdatePreview");
	expect(appSource).not.toContain("applyUpdateCheckResult");
	expect(appSource).not.toContain("setUpdateStatus");
});

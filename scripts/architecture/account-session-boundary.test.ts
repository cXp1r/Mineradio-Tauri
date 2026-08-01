import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("App delegates provider session state and actions to the account controller", () => {
	const appSource = readFileSync(
		fileURLToPath(new URL("../../apps/web/src/app/App.tsx", import.meta.url)),
		"utf8",
	);
	const controllerSource = readFileSync(
		fileURLToPath(new URL(
			"../../apps/web/src/features/accounts/useAccountSessionController.ts",
			import.meta.url,
		)),
		"utf8",
	);

	expect(appSource).toContain("useAccountSessionController({");
	for (const forbidden of [
		"setNeteaseStatus",
		"setQqStatus",
		"setSodaStatus",
		"setProviderSessionCookie(",
		".loginStatus(provider)",
		".logout(provider)",
	]) {
		expect(appSource).not.toContain(forbidden);
	}

	expect(controllerSource).toContain("AccountPort");
	expect(controllerSource).not.toContain("SidecarClient");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("App delegates login QR generation and polling to the account runtime", () => {
	const appSource = readFileSync(
		fileURLToPath(new URL("../../apps/web/src/app/App.tsx", import.meta.url)),
		"utf8",
	);
	const runtimeSource = readFileSync(
		fileURLToPath(new URL(
			"../../apps/web/src/features/accounts/useLoginQrRuntime.ts",
			import.meta.url,
		)),
		"utf8",
	);

	expect(appSource).toContain("useLoginQrRuntime({");
	expect(appSource).toContain("accounts: applicationPorts?.music.accounts ?? null");
	for (const forbidden of [
		"loginQrRequestSeqRef",
		"createProviderLoginQrKey(",
		"createProviderLoginQrImage(",
		"checkProviderLoginQr(",
		"window.setInterval(() =>",
	]) {
		expect(appSource).not.toContain(forbidden);
	}

	expect(runtimeSource).toContain("AccountPort");
	expect(runtimeSource).not.toContain("SidecarClient");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("SearchShell depends on the search port instead of SidecarClient", () => {
	const source = readFileSync(
		fileURLToPath(new URL(
			"../../apps/web/src/components/shell/SearchShell.tsx",
			import.meta.url,
		)),
		"utf8",
	);
	expect(source).toContain("../../ports/music/search-port");
	expect(source).not.toContain("../../api/sidecar-client");
	expect(source).not.toContain("SidecarClient");
});

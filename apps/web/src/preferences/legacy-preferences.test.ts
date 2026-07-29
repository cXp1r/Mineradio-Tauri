import { expect, test } from "bun:test";
import { DEFAULT_LEGACY_PREFERENCE_MAPPINGS } from "./legacy-preferences";

test("Electron v3 search history migrates from its real legacy key and mirrors an items envelope", () => {
	const mapping = DEFAULT_LEGACY_PREFERENCE_MAPPINGS.find(
		(candidate) => candidate.legacyKey === "mineradio-search-history",
	);

	expect(mapping?.decode(JSON.stringify({
		version: 3,
		modes: { song: ["周杰伦"], qq: ["林俊杰"] },
	}))).toEqual(["周杰伦", "林俊杰"]);
	expect(mapping?.encode(["周杰伦", "林俊杰"])).toBe(
		JSON.stringify({ version: 3, items: ["周杰伦", "林俊杰"] }),
	);
});

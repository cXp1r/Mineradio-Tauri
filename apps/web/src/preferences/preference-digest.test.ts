import { expect, test } from "bun:test";
import {
	canonicalPreferenceDigest,
	canonicalPreferenceJson,
} from "./preference-digest";

test("preference digest is stable across object key order and changes with content", async () => {
	const first = { nested: { z: 1, a: true }, name: "MineRadio" };
	const reordered = { name: "MineRadio", nested: { a: true, z: 1 } };

	expect(canonicalPreferenceJson(first)).toBe(
		canonicalPreferenceJson(reordered),
	);
	expect(await canonicalPreferenceDigest(first)).toBe(
		await canonicalPreferenceDigest(reordered),
	);
	expect(await canonicalPreferenceDigest({ ...first, name: "Changed" })).not.toBe(
		await canonicalPreferenceDigest(first),
	);
});

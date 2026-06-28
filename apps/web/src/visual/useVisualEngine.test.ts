import { expect, test } from "bun:test";
import { isRuntimeShelfPreviewActive } from "./useVisualEngine";

test("isRuntimeShelfPreviewActive follows side-auto shelf visibility readiness", () => {
	expect(isRuntimeShelfPreviewActive("auto", 0.17)).toBe(true);
	expect(isRuntimeShelfPreviewActive("auto", 0.16)).toBe(false);
	expect(isRuntimeShelfPreviewActive("auto", 0)).toBe(false);
	expect(isRuntimeShelfPreviewActive("always", 0.9)).toBe(false);
	expect(isRuntimeShelfPreviewActive(undefined, 0.9)).toBe(false);
});

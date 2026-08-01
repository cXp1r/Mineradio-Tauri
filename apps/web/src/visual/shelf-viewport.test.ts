import { expect, test } from "bun:test";
import { isShelfPortraitViewport } from "./shelf-viewport";

test("Shelf portrait policy uses the single 1.08 boundary", () => {
	expect(isShelfPortraitViewport(1000, 1080)).toBe(false);
	expect(isShelfPortraitViewport(1000, 1081)).toBe(true);
	expect(isShelfPortraitViewport(0, 1081)).toBe(false);
});

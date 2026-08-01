import { expect, test } from "bun:test";
import { Color } from "three";
import { resolveSonicPalette } from "./sonic-palette";
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";

function expectColor(actual: Color, expected: Color): void {
	expect(actual.r).toBeCloseTo(expected.r, 8);
	expect(actual.g).toBeCloseTo(expected.g, 8);
	expect(actual.b).toBeCloseTo(expected.b, 8);
}

test("cover palette derives the Electron 2.0.2 base, cool, warm, and ripple colors", () => {
	const primary = new Color("#336699");
	const secondary = new Color("#aa3300");
	const highlight = new Color("#00ffaa");
	const palette = resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors, {
		primary: "#336699",
		secondary: "#aa3300",
		highlight: "#00ffaa",
	});
	const expectedBase = primary.clone().lerp(new Color("#05070c"), 0.84);
	expectColor(palette.base, expectedBase);
	expectColor(palette.base2, expectedBase.clone().lerp(highlight, 0.14));
	expectColor(palette.cool, primary.clone().lerp(new Color("#ffffff"), 0.08));
	expectColor(palette.warm, secondary.clone().lerp(new Color("#ffb15a"), 0.18));
	expectColor(palette.accent, highlight.clone().lerp(new Color("#ffffff"), 0.1));
});

test("custom palette keeps explicit colors and derives the secondary base", () => {
	const settings = {
		...SONIC_TOPOGRAPHY_DEFAULTS.colors,
		mode: "custom" as const,
	};
	const palette = resolveSonicPalette(settings, {
		primary: "#ffffff",
		secondary: "#ffffff",
		highlight: "#ffffff",
	});
	expectColor(palette.base, new Color(settings.base));
	expectColor(palette.base2, new Color(settings.base).lerp(new Color("#ffffff"), 0.12));
	expectColor(palette.cool, new Color(settings.cool));
	expectColor(palette.warm, new Color(settings.warm));
	expectColor(palette.accent, new Color(settings.accent));
});

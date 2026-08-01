import { expect, test } from "bun:test";
import {
	SONIC_WORKSHOP_DEFAULTS,
	normalizeSonicWorkshopSettings,
} from "./sonic-workshop-settings";

test("normalizes untrusted Workshop settings into the public bounded shape", () => {
	const normalized = normalizeSonicWorkshopSettings({
		active: true,
		inputGain: 150,
		audioIntensity: -1,
		responseRange: 1.75,
		peakIntensity: Number.NaN,
		theme: "unknown",
		colors: {
			mode: "custom",
			primary: "#ABC",
			base: "not-a-color",
			warm: "#123456",
			cool: "#fedcba",
			ripple: "#987654",
			peak: "#010203",
		},
		showCover: false,
		autoRotate: false,
		rotationSpeed: 99,
	});

	expect(normalized).toEqual({
		active: true,
		inputGain: 100,
		audioIntensity: 0.3,
		responseRange: 1.75,
		peakIntensity: SONIC_WORKSHOP_DEFAULTS.peakIntensity,
		theme: SONIC_WORKSHOP_DEFAULTS.theme,
		colors: {
			mode: "custom",
			primary: "#aabbcc",
			base: SONIC_WORKSHOP_DEFAULTS.colors.base,
			warm: "#123456",
			cool: "#fedcba",
			ripple: "#987654",
			peak: "#010203",
		},
		showCover: false,
		autoRotate: false,
		rotationSpeed: 20,
	});
	expect(Object.isFrozen(normalized)).toBe(true);
	expect(Object.isFrozen(normalized.colors)).toBe(true);
});

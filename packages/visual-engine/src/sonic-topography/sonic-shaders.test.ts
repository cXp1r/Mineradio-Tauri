import { expect, test } from "bun:test";
import { NormalBlending } from "three";
import {
	createSonicFloatingMaterial,
	createSonicTerrainMaterial,
} from "./sonic-shaders";
import { resolveSonicPalette } from "./sonic-palette";
import { SONIC_TOPOGRAPHY_DEFAULTS } from "./sonic-settings";

test("terrain material exposes the Electron 2.0.2 deformation and lighting contract", () => {
	const material = createSonicTerrainMaterial(
		resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors),
	);
	const uniforms = material.uniforms;

	expect(uniforms.uBands.value).toBeInstanceOf(Float32Array);
	expect(uniforms.uEq.value).toBeInstanceOf(Float32Array);
	expect(uniforms.uEq.value.length).toBe(8);
	expect(uniforms.uKickEnvelope.value).toBe(0);
	expect(uniforms.uEnergy.value).toBe(0);
	expect(uniforms.uSharpness.value).toBe(0);
	expect(uniforms.uSmoothness.value).toBe(0);
	expect(uniforms.uDensity.value).toBe(0);
	expect(uniforms.uWarmth.value).toBe(0.5);
	expect(uniforms.uBrightness.value).toBe(0.5);
	expect(uniforms.uBaseColor).toBe(uniforms.uBaseColor1);
	expect(uniforms.uCoolColor).toBe(uniforms.uCoolCore);
	expect(uniforms.uWarmColor).toBe(uniforms.uWarmCore);
	expect(uniforms.uAccentColor).toBe(uniforms.uRippleColor);
	expect(uniforms.uGlow).toBe(uniforms.uGlowIntensity);

	expect(material.vertexShader).toContain("float snoise(vec2 value)");
	expect(material.vertexShader).toContain("uniform float uKickEnvelope;");
	expect(material.vertexShader).toContain("float subRegion");
	expect(material.vertexShader).toContain("float bassRegion");
	expect(material.vertexShader).toContain("float lowMidLift");
	expect(material.vertexShader).toContain("float midLift");
	expect(material.vertexShader).toContain("float highMidLift");
	expect(material.vertexShader).toContain("bool whiteRipple = ripple.w < 0.0;");
	expect(material.vertexShader).toContain("whiteRipple ? 1.35 : 5.5");
	expect(material.fragmentShader).toContain("bool isTop");
	expect(material.fragmentShader).toContain("float twinkleMultiplier");
	expect(material.fragmentShader).toContain("float flashChance");
	expect(material.fragmentShader).toContain("float verticalFalloff");
	expect(material.fragmentShader).toContain("vec3 atmosphericColor");

	material.dispose();
});

test("floating material reuses terrain color semantics for high-frequency twinkle and flash", () => {
	const palette = resolveSonicPalette(SONIC_TOPOGRAPHY_DEFAULTS.colors);
	const terrainMaterial = createSonicTerrainMaterial(palette);
	const floatingMaterial = createSonicFloatingMaterial(palette);
	const shader = floatingMaterial.fragmentShader;

	expect(floatingMaterial.blending).toBe(NormalBlending);
	expect(floatingMaterial.depthWrite).toBe(false);
	expect(shader).toBe(terrainMaterial.fragmentShader);
	expect(shader).toContain("topIntensity += uBands[7] * 2.0 * twinkleMultiplier;");
	expect(shader).toContain("float flashChance = smoothstep(0.3, 1.0, uBands[5]);");
	expect(shader).toContain("uBands[5] * (1.0 + uSharpness * 2.0)");
	expect(shader).toContain("uBands[6] * 3.0 * twinkleMultiplier");
	expect("uColor" in floatingMaterial.uniforms).toBe(false);
	expect("uOpacity" in floatingMaterial.uniforms).toBe(false);

	floatingMaterial.dispose();
	terrainMaterial.dispose();
});

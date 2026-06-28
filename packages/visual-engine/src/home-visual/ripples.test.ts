import { expect, test } from "bun:test";
import { createHomeRipples, RIPPLE_MAX } from "./ripples";

function makeTexture(data: Float32Array) {
	return {
		image: { data, width: 1, height: RIPPLE_MAX },
		magFilter: 0,
		minFilter: 0,
		needsUpdate: false,
	};
}

function makeUniforms() {
	const data = new Float32Array(RIPPLE_MAX * 4);
	const tex = makeTexture(data);
	return {
		data,
		uRippleTex: { value: tex },
		uRippleCount: { value: 0 },
		uTime: { value: 0 },
		uBass: { value: 0 },
	};
}

test("createHomeRipples seeds baseline 12-slot 1xN RGBA data texture", () => {
	const uniforms = makeUniforms();
	const ripples = createHomeRipples(uniforms);
	expect(RIPPLE_MAX).toBe(12);
	expect(ripples.getData()).toBe(uniforms.data);
	expect(uniforms.uRippleTex.value.image.width).toBe(1);
	expect(uniforms.uRippleTex.value.image.height).toBe(12);
	expect(uniforms.uRippleCount.value).toBe(0);
});

test("update triggers 2 or 3 bass-hit ripples across baseline 3x3 regions and writes RGBA x/y/age/strength", () => {
	const uniforms = makeUniforms();
	const random = makeRandom([0.1, 0.2, 0.6, 0.3, 0.4, 0.8, 0.7, 0.6, 0.2, 0.5]);
	const ripples = createHomeRipples(uniforms, { random });
	uniforms.uTime.value = 0.4;
	uniforms.uBass.value = 0.4;
	ripples.update(0.016);

	expect(uniforms.uRippleCount.value).toBe(2);
	expect(uniforms.uRippleTex.value.needsUpdate).toBe(true);
	expect(uniforms.data[0]).toBeCloseTo(0.07, 5);
	expect(uniforms.data[1]).toBeCloseTo(-1.868, 5);
	expect(uniforms.data[2]).toBeCloseTo(0.016, 5);
	expect(uniforms.data[3]).toBeCloseTo(1.31, 5);
	expect(uniforms.data[4]).toBeCloseTo(0.14, 5);
	expect(uniforms.data[5]).toBeCloseTo(1.798, 5);
	expect(uniforms.data[6]).toBeCloseTo(0.016, 5);
	expect(uniforms.data[7]).toBeCloseTo(1.26, 5);
});

test("update follows baseline bass rising edge, cooldown, aging, and expiry", () => {
	const uniforms = makeUniforms();
	const ripples = createHomeRipples(uniforms, { random: () => 0 });
	uniforms.uTime.value = 0.4;
	uniforms.uBass.value = 0.4;
	ripples.update(0.016);
	expect(uniforms.uRippleCount.value).toBe(2);

	uniforms.uTime.value = 0.5;
	uniforms.uBass.value = 0.5;
	ripples.update(0.016);
	expect(uniforms.uRippleCount.value).toBe(2);

	uniforms.uTime.value = 0.8;
	uniforms.uBass.value = 0.1;
	ripples.update(0.016);
	expect(uniforms.uRippleCount.value).toBe(2);

	uniforms.uTime.value = 0.9;
	uniforms.uBass.value = 0.4;
	ripples.update(0.016);
	expect(uniforms.uRippleCount.value).toBe(4);

	ripples.update(2.01);
	expect(uniforms.uRippleCount.value).toBe(0);
	expect(uniforms.data[2]).toBe(-10);
	expect(uniforms.data[3]).toBe(0);
});

function makeRandom(values: number[]): () => number {
	let i = 0;
	return () => values[i++] ?? values[values.length - 1] ?? 0;
}

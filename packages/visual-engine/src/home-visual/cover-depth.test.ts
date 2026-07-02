import { expect, test } from "bun:test";
import { buildEdgeAndDepthCanvas, createCoverDepthTween, mergeAiDepthIntoEdgeCanvas, visualEase } from "./cover-depth";

function makeSourceCanvas(width: number, height: number, data: Uint8ClampedArray) {
	return {
		width,
		height,
		getContext(type: string) {
			expect(type).toBe("2d");
			return {
				drawImage() {},
				getImageData() {
					return { data };
				},
			};
		},
	};
}

function makeOutputCanvas() {
	const out = {
		width: 0,
		height: 0,
		imageData: null as { data: Uint8ClampedArray; width: number; height: number } | null,
		sourceData: null as Uint8ClampedArray | null,
		getContext(type: string) {
			expect(type).toBe("2d");
			return {
				drawImage() {},
				getImageData() {
					return { data: out.sourceData ?? new Uint8ClampedArray(256 * 256 * 4) };
				},
				createImageData(width: number, height: number) {
					return { data: new Uint8ClampedArray(width * height * 4), width, height };
				},
				putImageData(imageData: { data: Uint8ClampedArray; width: number; height: number }) {
					out.imageData = imageData;
				},
			};
		},
	};
	return out;
}

function makeImageDataCanvas(width: number, height: number, data: Uint8ClampedArray) {
	return {
		width,
		height,
		getContext(type: string) {
			expect(type).toBe("2d");
			return {
				drawImage() {},
				getImageData() {
					return { data };
				},
				putImageData(imageData: { data: Uint8ClampedArray }) {
					data.set(imageData.data);
				},
			};
		},
	};
}

test("visualEase preserves baseline smoothstep easing", () => {
	expect(visualEase(-1)).toBe(0);
	expect(visualEase(0)).toBe(0);
	expect(visualEase(0.5)).toBe(0.5);
	expect(visualEase(1)).toBe(1);
	expect(visualEase(2)).toBe(1);
});

test("buildEdgeAndDepthCanvas outputs baseline 256x256 RGBA depth/edge/fg/luminance texture", () => {
	const srcData = new Uint8ClampedArray(256 * 256 * 4);
	for (let y = 0; y < 256; y++) {
		for (let x = 0; x < 256; x++) {
			const i = (y * 256 + x) * 4;
			const v = x < 128 ? 0 : 255;
			srcData[i] = v;
			srcData[i + 1] = v;
			srcData[i + 2] = v;
			srcData[i + 3] = 255;
		}
	}
	const source = makeSourceCanvas(256, 256, srcData);
	const normalized = makeOutputCanvas();
	normalized.sourceData = srcData;
	const output = makeOutputCanvas();
	const result = buildEdgeAndDepthCanvas(source as never, {
		createCanvas: (width, height) => {
			const canvas = normalized.width === 0 ? normalized : output;
			canvas.width = width;
			canvas.height = height;
			return canvas as never;
		},
	});

	expect(result).toBe(output);
	expect(output.width).toBe(256);
	expect(output.height).toBe(256);
	expect(output.imageData?.width).toBe(256);
	expect(output.imageData?.height).toBe(256);
	const centerLeft = (128 * 256 + 127) * 4;
	const centerRight = (128 * 256 + 128) * 4;
	expect(output.imageData!.data[centerRight + 3]).toBeGreaterThan(output.imageData!.data[centerLeft + 3]);
	expect(output.imageData!.data[centerLeft + 1]).toBeGreaterThan(0);
	expect(output.imageData!.data[centerRight + 1]).toBeGreaterThan(0);
});

test("buildEdgeAndDepthCanvas reuses large Float32 scratch buffers across sequential builds", () => {
	const srcData = new Uint8ClampedArray(256 * 256 * 4);
	const source = makeSourceCanvas(256, 256, srcData);
	const realFloat32Array = globalThis.Float32Array;
	let largeAllocations = 0;
	(globalThis as unknown as { Float32Array: Float32ArrayConstructor }).Float32Array = new Proxy(realFloat32Array, {
		construct(target, args) {
			if (args[0] === 256 * 256) largeAllocations += 1;
			return Reflect.construct(target, args);
		},
	}) as Float32ArrayConstructor;
	try {
		for (let i = 0; i < 2; i++) {
			const normalized = makeOutputCanvas();
			normalized.sourceData = srcData;
			const output = makeOutputCanvas();
			buildEdgeAndDepthCanvas(source as never, {
				createCanvas: (width, height) => {
					const canvas = normalized.width === 0 ? normalized : output;
					canvas.width = width;
					canvas.height = height;
					return canvas as never;
				},
			});
		}
	} finally {
		(globalThis as unknown as { Float32Array: Float32ArrayConstructor }).Float32Array = realFloat32Array;
	}
	expect(largeAllocations).toBeLessThanOrEqual(3);
});

test("buildEdgeAndDepthCanvas avoids redundant large Float32 scratch buffers", () => {
	const srcData = new Uint8ClampedArray(256 * 256 * 4);
	const source = makeSourceCanvas(256, 256, srcData);
	const normalized = makeOutputCanvas();
	normalized.sourceData = srcData;
	const output = makeOutputCanvas();
	const realFloat32Array = globalThis.Float32Array;
	let largeAllocations = 0;
	(globalThis as unknown as { Float32Array: Float32ArrayConstructor }).Float32Array = new Proxy(realFloat32Array, {
		construct(target, args) {
			if (args[0] === 256 * 256) largeAllocations += 1;
			return Reflect.construct(target, args);
		},
	}) as Float32ArrayConstructor;
	try {
		buildEdgeAndDepthCanvas(source as never, {
			createCanvas: (width, height) => {
				const canvas = normalized.width === 0 ? normalized : output;
				canvas.width = width;
				canvas.height = height;
				return canvas as never;
			},
		});
	} finally {
		(globalThis as unknown as { Float32Array: Float32ArrayConstructor }).Float32Array = realFloat32Array;
	}
	expect(largeAllocations).toBeLessThanOrEqual(3);
});

test("createCoverDepthTween advances uHasDepth and uAiBoost with baseline smoothstep", () => {
	const uniforms = {
		uHasDepth: { value: 0 },
		uAiBoost: { value: 0 },
	};
	const tween = createCoverDepthTween(uniforms);
	tween.setTarget(1, 0.55, 180);
	tween.advance(0.09);
	expect(uniforms.uHasDepth.value).toBeCloseTo(0.5, 5);
	expect(uniforms.uAiBoost.value).toBeCloseTo(0.275, 5);
	tween.advance(0.09);
	expect(uniforms.uHasDepth.value).toBe(1);
	expect(uniforms.uAiBoost.value).toBe(0.55);
	tween.setTarget(0, 0, 1);
	expect(uniforms.uHasDepth.value).toBe(0);
	expect(uniforms.uAiBoost.value).toBe(0);
});

test("mergeAiDepthIntoEdgeCanvas normalizes AI luminance into R and preserves heuristic GBA channels", () => {
	const heuristic = new Uint8ClampedArray([
		10, 20, 30, 40,
		50, 60, 70, 80,
		90, 100, 110, 120,
		130, 140, 150, 160,
	]);
	const ai = new Uint8ClampedArray([
		255, 255, 255, 255,
		200, 200, 200, 255,
		40, 40, 40, 255,
		0, 0, 0, 255,
	]);
	const heuristicCanvas = makeImageDataCanvas(2, 2, heuristic);
	const aiCanvas = makeImageDataCanvas(2, 2, ai);
	const result = mergeAiDepthIntoEdgeCanvas(heuristicCanvas as never, aiCanvas as never);
	expect(result).toBe(heuristicCanvas);
	expect(Array.from(heuristic)).toEqual([
		0, 20, 30, 40,
		55, 60, 70, 80,
		215, 100, 110, 120,
		255, 140, 150, 160,
	]);
});

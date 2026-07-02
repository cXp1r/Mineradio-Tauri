import { expect, test } from "bun:test";
import { createHomeCoverTextureController, coverTextureSizeForResolution, prepareSquareCoverCanvas } from "./cover-texture";

function makeTexture(label: string) {
	return {
		label,
		image: { width: 4, height: 4, label },
		needsUpdate: false,
		disposed: false,
		dispose() {
			this.disposed = true;
		},
	};
}

function makeUniforms() {
	return {
		uCoverTex: { value: makeTexture("cover") },
		uPrevCoverTex: { value: makeTexture("prev") },
		uEdgeTex: { value: makeTexture("edge") },
		uColorMixT: { value: 1 },
		uHasCover: { value: 0 },
		uLoading: { value: 0 },
		uHasDepth: { value: 0 },
		uAiBoost: { value: 0 },
	};
}

test("setCoverUrl('') clears baseline cover-state uniforms without changing texture objects", () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async () => ({ width: 32, height: 32, src: "unused" }),
	});
	const coverTex = uniforms.uCoverTex.value;
	ctl.setCoverUrl("");
	expect(uniforms.uHasCover.value).toBe(0);
	expect(uniforms.uLoading.value).toBe(0);
	expect(uniforms.uHasDepth.value).toBe(0);
	expect(uniforms.uAiBoost.value).toBe(0);
	expect(uniforms.uCoverTex.value).toBe(coverTex);
});

test("setCoverUrl(url) loads the current cover image, marks texture dirty, and sets uHasCover", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const prepared: unknown[] = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 128, height: 96, src: url };
		},
		onCoverPrepared: (image) => prepared.push(image),
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	expect(uniforms.uLoading.value).toBe(1);
	await ctl.whenIdle();
	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 128, height: 96, src: "https://img.example/a.jpg" });
	expect(prepared).toEqual([{ width: 128, height: 96, src: "https://img.example/a.jpg" }]);
	expect(uniforms.uCoverTex.value.needsUpdate).toBe(true);
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uColorMixT.value).toBe(0);
	expect(uniforms.uLoading.value).toBe(0);
});

test("setCoverUrl(relative image-proxy) loads same-origin proxy covers for WebView2", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 96, height: 96, src: url };
		},
	});

	ctl.setCoverUrl("/image-proxy?url=https%3A%2F%2Fimg.example%2Fcover.jpg");
	await ctl.whenIdle();

	expect(loaded).toEqual(["/image-proxy?url=https%3A%2F%2Fimg.example%2Fcover.jpg"]);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 96, height: 96, src: "/image-proxy?url=https%3A%2F%2Fimg.example%2Fcover.jpg" });
	expect(uniforms.uHasCover.value).toBe(1);
});

test("setCoverUrl(url) keeps the cover visible when cover-dependent color work throws", async () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 128, height: 128, src: url }),
		onCoverPrepared: () => {
			throw new Error("palette failed");
		},
	});

	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();

	expect(uniforms.uCoverTex.value.image).toEqual({ width: 128, height: 128, src: "https://img.example/a.jpg" });
	expect(uniforms.uCoverTex.value.needsUpdate).toBe(true);
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uColorMixT.value).toBe(0);
	expect(uniforms.uLoading.value).toBe(0);
});

test("setCoverUrl(data:image) accepts inline custom cover sources instead of clearing", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 32, height: 32, src: url };
		},
	});

	ctl.setCoverUrl(dataUrl);
	await ctl.whenIdle();

	expect(loaded).toEqual([dataUrl]);
	expect(ctl.getCurrentUrl()).toBe(dataUrl);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 32, height: 32, src: dataUrl });
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uColorMixT.value).toBe(0);
});

test("setCoverUrl(blob) accepts local object URLs used by imported cover images", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const blobUrl = "blob:http://localhost/local-cover";
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 48, height: 48, src: url };
		},
	});

	ctl.setCoverUrl(blobUrl);
	await ctl.whenIdle();

	expect(loaded).toEqual([blobUrl]);
	expect(ctl.getCurrentUrl()).toBe(blobUrl);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 48, height: 48, src: blobUrl });
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uColorMixT.value).toBe(0);
});

test("setCoverUrl(proxy) falls back to the direct cover URL like the baseline loader", async () => {
	const uniforms = makeUniforms();
	const originalImage = globalThis.Image;
	const originalFetch = globalThis.fetch;
	const originalCreateObjectUrl = URL.createObjectURL;
	const originalRevokeObjectUrl = URL.revokeObjectURL;
	const loaded: string[] = [];
	const direct = "http://p3.music.126.net/cover.jpg";
	const proxy = `http://127.0.0.1:56764/image-proxy?url=${encodeURIComponent(direct)}`;

	class FakeImage {
		crossOrigin = "";
		decoding = "";
		width = 64;
		height = 64;
		naturalWidth = 64;
		naturalHeight = 64;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(value: string) {
			loaded.push(value);
			queueMicrotask(() => {
				if (value === direct) this.onload?.();
				else this.onerror?.();
			});
		}
	}

	globalThis.Image = FakeImage as unknown as typeof Image;
	globalThis.fetch = (async () => ({
		ok: true,
		headers: { get: () => "image/jpeg" },
		blob: async () => new Blob(["bad-proxy-image"], { type: "image/jpeg" }),
	})) as unknown as typeof fetch;
	URL.createObjectURL = () => "blob:http://127.0.0.1/bad-proxy-image";
	URL.revokeObjectURL = () => {};
	try {
		const ctl = createHomeCoverTextureController({
			uniforms: uniforms as never,
			createCanvas: (width, height) => ({ width, height, getContext: () => null }) as never,
		});
		ctl.setCoverUrl(proxy);
		await ctl.whenIdle();

		expect(loaded).toEqual([proxy, "blob:http://127.0.0.1/bad-proxy-image", direct]);
		expect((uniforms.uCoverTex.value.image as { width: number }).width).toBe(64);
		expect((uniforms.uCoverTex.value.image as { height: number }).height).toBe(64);
		expect(uniforms.uHasCover.value).toBe(1);
	} finally {
		globalThis.Image = originalImage;
		globalThis.fetch = originalFetch;
		URL.createObjectURL = originalCreateObjectUrl;
		URL.revokeObjectURL = originalRevokeObjectUrl;
	}
});

test("setCoverUrl(unsupported scheme) preserves safety behavior by clearing without loading", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 32, height: 32, src: url };
		},
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uHasCover.value).toBe(1);

	ctl.setCoverUrl("file:///Users/me/cover.png");
	await ctl.whenIdle();

	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(ctl.getCurrentUrl()).toBe("");
	expect(uniforms.uHasCover.value).toBe(0);
	expect(uniforms.uLoading.value).toBe(0);
	expect(uniforms.uHasDepth.value).toBe(0);
	expect(uniforms.uAiBoost.value).toBe(0);
});

test("setCoverUrl(next) snapshots the previous loaded cover into uPrevCoverTex before applying next", async () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	ctl.setCoverUrl("https://img.example/b.jpg");
	await ctl.whenIdle();
	expect(uniforms.uPrevCoverTex.value.image).toEqual({ width: 64, height: 64, src: "https://img.example/a.jpg" });
	expect(uniforms.uPrevCoverTex.value.needsUpdate).toBe(true);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 64, height: 64, src: "https://img.example/b.jpg" });
	expect(uniforms.uColorMixT.value).toBe(0);
});

test("stale cover loads are ignored when a newer URL is requested", async () => {
	const uniforms = makeUniforms();
	const resolvers: Array<(image: unknown) => void> = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: (url) => new Promise((resolve) => {
			resolvers.push(() => resolve({ width: 32, height: 32, src: url }));
		}),
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	ctl.setCoverUrl("https://img.example/b.jpg");
	resolvers[0]?.({});
	await Promise.resolve();
	expect(uniforms.uHasCover.value).toBe(0);
	resolvers[1]?.({});
	await ctl.whenIdle();
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 32, height: 32, src: "https://img.example/b.jpg" });
	expect(uniforms.uHasCover.value).toBe(1);
});

test("advanceColorMix moves uColorMixT toward 1 over the baseline color mix duration", async () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		colorMixDurationMs: 1000,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	ctl.advanceColorMix(0.25);
	expect(uniforms.uColorMixT.value).toBeCloseTo(0.25, 5);
	ctl.advanceColorMix(0.75);
	expect(uniforms.uColorMixT.value).toBe(1);
});

test("setCoverUrl(url) builds the baseline edge/depth texture and advances depth uniforms", async () => {
	const uniforms = makeUniforms();
	const edgeCanvas = { width: 256, height: 256, label: "edge-depth" };
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: (image) => {
			expect((image as { src: string }).src).toBe("https://img.example/a.jpg");
			return edgeCanvas as never;
		},
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(edgeCanvas);
	expect(uniforms.uEdgeTex.value.needsUpdate).toBe(true);
	expect(uniforms.uHasDepth.value).toBe(0);
	ctl.advanceDepth(0.09);
	expect(uniforms.uHasDepth.value).toBeCloseTo(0.5, 5);
	expect(uniforms.uAiBoost.value).toBeCloseTo(0.275, 5);
	ctl.advanceDepth(0.09);
	expect(uniforms.uHasDepth.value).toBe(1);
	expect(uniforms.uAiBoost.value).toBe(0.55);
});

test("setCoverUrl(url) boosts depth to the baseline AI target when aiDepth is enabled and an AI depth canvas is available", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const mergedCanvas = { width: 256, height: 256, label: "merged-ai-depth" };
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: () => heuristicCanvas as never,
		aiDepthEnabled: true,
		estimateAiDepth: async (image) => {
			expect((image as { src: string }).src).toBe("https://img.example/a.jpg");
			return aiCanvas as never;
		},
		mergeAiDepth: (heuristic, ai) => {
			expect(heuristic).toBe(heuristicCanvas);
			expect(ai).toBe(aiCanvas);
			return mergedCanvas as never;
		},
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(mergedCanvas);
	ctl.advanceDepth(0.36);
	expect(uniforms.uHasDepth.value).toBe(1);
	expect(uniforms.uAiBoost.value).toBe(1);
});

test("setCoverUrl(url) applies the cover before waiting for slow AI depth work", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	let resolveAi: ((image: typeof aiCanvas) => void) | null = null;
	const aiPending = new Promise<typeof aiCanvas>((resolve) => {
		resolveAi = resolve;
	});
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: () => heuristicCanvas as never,
		aiDepthEnabled: true,
		estimateAiDepth: async () => aiPending,
		mergeAiDepth: (_heuristic, ai) => ai,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await Promise.resolve();
	await Promise.resolve();

	expect(uniforms.uCoverTex.value.image).toEqual({ width: 64, height: 64, src: "https://img.example/a.jpg" });
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uLoading.value).toBe(0);
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);

	const finishAi = resolveAi as ((image: typeof aiCanvas) => void) | null;
	if (!finishAi) throw new Error("expected pending AI depth resolver");
	finishAi(aiCanvas);
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(aiCanvas);
});

test("setCoverUrl(url) keeps the heuristic depth target when aiDepth is enabled but AI estimation returns null", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: () => heuristicCanvas as never,
		aiDepthEnabled: true,
		estimateAiDepth: async () => null,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);
	ctl.advanceDepth(0.18);
	expect(uniforms.uHasDepth.value).toBe(1);
	expect(uniforms.uAiBoost.value).toBe(0.55);
});

test("setAiDepthEnabled(true) reuses the prepared cover and heuristic depth while running AI depth", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const loaded: string[] = [];
	let depthBuilds = 0;
	let aiRuns = 0;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 64, height: 64, src: url };
		},
		buildEdgeDepth: () => {
			depthBuilds += 1;
			return heuristicCanvas as never;
		},
		aiDepthEnabled: false,
		estimateAiDepth: async () => {
			aiRuns += 1;
			return aiCanvas as never;
		},
		mergeAiDepth: (_heuristic, ai) => ai,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(aiRuns).toBe(0);

	ctl.setAiDepthEnabled(true);
	await ctl.whenIdle();

	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(depthBuilds).toBe(1);
	expect(aiRuns).toBe(1);
	expect(uniforms.uEdgeTex.value.image).toBe(aiCanvas);
});

test("setAiDepthEnabled(false) reuses heuristic depth and ignores stale in-flight AI depth", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const aiResolver: { current?: (value: typeof aiCanvas) => void } = {};
	const loaded: string[] = [];
	let depthBuilds = 0;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 64, height: 64, src: url };
		},
		buildEdgeDepth: () => {
			depthBuilds += 1;
			return heuristicCanvas as never;
		},
		aiDepthEnabled: true,
		estimateAiDepth: async () => new Promise<typeof aiCanvas>((resolve) => {
			aiResolver.current = resolve;
		}),
		mergeAiDepth: (_heuristic, ai) => ai,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await Promise.resolve();

	ctl.setAiDepthEnabled(false);
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);

	aiResolver.current?.(aiCanvas);
	await Promise.resolve();
	await ctl.whenIdle();

	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(depthBuilds).toBe(1);
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);
	expect(uniforms.uAiBoost.value).toBe(0);
	ctl.advanceDepth(0.18);
	expect(uniforms.uAiBoost.value).toBe(0.55);
});

test("coverTextureSizeForResolution preserves baseline 256/384/512 thresholds", () => {
	expect(coverTextureSizeForResolution(0.75)).toBe(256);
	expect(coverTextureSizeForResolution(1.09)).toBe(256);
	expect(coverTextureSizeForResolution(1.10)).toBe(384);
	expect(coverTextureSizeForResolution(1.31)).toBe(384);
	expect(coverTextureSizeForResolution(1.32)).toBe(512);
	expect(coverTextureSizeForResolution(1.55)).toBe(512);
});

test("prepareSquareCoverCanvas crops the image center into a baseline square texture canvas", () => {
	const drawCalls: unknown[][] = [];
	const canvas = {
		width: 0,
		height: 0,
		getContext(type: string) {
			expect(type).toBe("2d");
			return {
				drawImage(...args: unknown[]) {
					drawCalls.push(args);
				},
			};
		},
	};
	const image = { naturalWidth: 800, naturalHeight: 600 };
	const result = prepareSquareCoverCanvas(image as never, {
		coverResolution: 1.55,
		createCanvas: () => canvas as never,
	});
	expect(result).toBe(canvas);
	expect(canvas.width).toBe(512);
	expect(canvas.height).toBe(512);
	expect(drawCalls).toEqual([[image, 100, 0, 600, 600, 0, 0, 512, 512]]);
});

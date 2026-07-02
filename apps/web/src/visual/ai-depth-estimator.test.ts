import { beforeEach, expect, test } from "bun:test";
import {
	AI_DEPTH_MODEL_ID,
	TRANSFORMERS_JSDELIVR_URL,
	createJsDelivrAiDepthEstimator,
	resetJsDelivrAiDepthPipelineForTests,
	type AiDepthStatusDetail,
} from "./ai-depth-estimator";

beforeEach(() => {
	resetJsDelivrAiDepthPipelineForTests();
});

function makeCanvasHarness() {
	const drawCalls: unknown[][] = [];
	const dataUrlCalls: unknown[][] = [];
	const inputCanvas = {
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
		toDataURL(...args: unknown[]) {
			dataUrlCalls.push(args);
			return "data:image/jpeg;base64,cover";
		},
	};
	return {
		drawCalls,
		dataUrlCalls,
		createCanvas: (size: number) => {
			inputCanvas.width = size;
			inputCanvas.height = size;
			return inputCanvas as never;
		},
	};
}

test("createJsDelivrAiDepthEstimator loads the baseline jsDelivr transformers model and sends a 160px JPEG input", async () => {
	const harness = makeCanvasHarness();
	const depthCanvas = { width: 160, height: 160, label: "depth" };
	const pipelineInputs: unknown[] = [];
	let importedUrl = "";
	const env = { allowLocalModels: true, backends: { onnx: { wasm: { numThreads: 4 } } } };
	const estimator = createJsDelivrAiDepthEstimator({
		createCanvas: harness.createCanvas,
		now: () => 1000,
		importModule: async (url) => {
			importedUrl = url;
			return {
				env,
				pipeline: async (task, model) => {
					expect(task).toBe("depth-estimation");
					expect(model).toBe(AI_DEPTH_MODEL_ID);
					return async (input) => {
						pipelineInputs.push(input);
						return { depth: { toCanvas: async () => depthCanvas } };
					};
				},
			};
		},
	});

	const result = await estimator({ width: 320, height: 240, label: "cover" } as never);

	expect(importedUrl).toBe(TRANSFORMERS_JSDELIVR_URL);
	expect(env.allowLocalModels).toBe(false);
	expect(env.backends.onnx.wasm.numThreads).toBe(1);
	expect(harness.drawCalls).toEqual([[{ width: 320, height: 240, label: "cover" }, 0, 0, 160, 160]]);
	expect(harness.dataUrlCalls).toEqual([["image/jpeg", 0.82]]);
	expect(pipelineInputs).toEqual(["data:image/jpeg;base64,cover"]);
	expect(result).toBe(depthCanvas);
});

test("createJsDelivrAiDepthEstimator mirrors baseline status chip messages and success toast event", async () => {
	const statuses: AiDepthStatusDetail[] = [];
	const estimator = createJsDelivrAiDepthEstimator({
		createCanvas: makeCanvasHarness().createCanvas,
		now: () => 1000,
		onStatus: (detail) => statuses.push(detail),
		importModule: async () => ({
			env: { backends: { onnx: { wasm: {} } } },
			pipeline: async () => async () => ({ predicted_depth: { toCanvas: async () => ({ label: "depth" }) } }),
		}),
	});

	await estimator({ width: 64, height: 64 } as never);

	expect(statuses).toEqual([
		{ visible: true, text: "后台增强封面深度…" },
		{ visible: true, text: "加载 AI 深度模型 (首次需下载 50MB)…" },
		{ visible: false, text: "", toast: "AI 深度已后台增强" },
	]);
});

test("createJsDelivrAiDepthEstimator applies baseline min-gap and failure cooldown guards", async () => {
	const imports: string[] = [];
	let now = 1000;
	const estimator = createJsDelivrAiDepthEstimator({
		createCanvas: makeCanvasHarness().createCanvas,
		now: () => now,
		minGapMs: 18000,
		cooldownMs: 120000,
		importModule: async (url) => {
			imports.push(url);
			return {
				env: {},
				pipeline: async () => async () => {
					throw new Error("model failed");
				},
			};
		},
	});

	expect(await estimator({ width: 64, height: 64 } as never)).toBeNull();
	now += 18000;
	expect(await estimator({ width: 64, height: 64 } as never)).toBeNull();
	expect(imports).toEqual([TRANSFORMERS_JSDELIVR_URL]);

	resetJsDelivrAiDepthPipelineForTests();
	now += 120001;
	expect(await estimator({ width: 64, height: 64 } as never)).toBeNull();
	expect(imports).toEqual([TRANSFORMERS_JSDELIVR_URL, TRANSFORMERS_JSDELIVR_URL]);
});

test("createJsDelivrAiDepthEstimator reuses its 160px input canvas across runs", async () => {
	const created: Array<{ width: number; height: number; draws: unknown[][]; urls: unknown[][] }> = [];
	let now = 1000;
	const estimator = createJsDelivrAiDepthEstimator({
		minGapMs: 0,
		now: () => now,
		createCanvas: (size) => {
			const canvas = {
				width: size,
				height: size,
				draws: [] as unknown[][],
				urls: [] as unknown[][],
				getContext(type: string) {
					expect(type).toBe("2d");
					return {
						drawImage: (...args: unknown[]) => canvas.draws.push(args),
					};
				},
				toDataURL: (...args: unknown[]) => {
					canvas.urls.push(args);
					return `data:image/jpeg;base64,cover-${created.length}`;
				},
			};
			created.push(canvas);
			return canvas as never;
		},
		importModule: async () => ({
			env: { backends: { onnx: { wasm: {} } } },
			pipeline: async () => async () => ({ depth: { toCanvas: async () => ({ label: "depth" }) } }),
		}),
	});

	expect(await estimator({ width: 320, height: 240, label: "a" } as never)).toEqual({ label: "depth" });
	now += 1;
	expect(await estimator({ width: 640, height: 480, label: "b" } as never)).toEqual({ label: "depth" });

	expect(created.length).toBe(1);
	expect(created[0].draws.length).toBe(2);
	expect(created[0].urls).toEqual([
		["image/jpeg", 0.82],
		["image/jpeg", 0.82],
	]);
});

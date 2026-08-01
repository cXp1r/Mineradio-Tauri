import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	buildM8WindowsReleaseEvidence,
	evaluateM8WindowsReleaseEvidence,
} from "./m8-windows-release-evidence-model.mjs";
import {
	collectM8WindowsReleaseEvidence,
	createWindowsPowerShellCollector,
} from "./m8-windows-release-evidence.mjs";

function steadyRun(
	cpu: number[],
	workingSet: number[],
	privateBytes: number[],
) {
	const samples = Array.from({ length: 60 }, (_, index) => {
		const sourceIndex = index % cpu.length;
		return {
			offsetMs: (index + 1) * 1_000,
			cpuPercent: cpu[sourceIndex],
			workingSetBytes: workingSet[sourceIndex],
			privateBytes: privateBytes[sourceIndex],
		};
	});
	return {
		warmupSeconds: 10,
		sampleSeconds: 60,
		sampleIntervalMs: 1_000,
		samples,
	};
}

describe("M8 Windows release evidence model", () => {
	test("aggregates the fixed five-start and three-round release protocol", () => {
		const evidence = buildM8WindowsReleaseEvidence({
			capturedAt: "2026-07-30T00:00:00.000Z",
			git: { commit: "a".repeat(40), dirty: false },
			host: { platform: "win32", release: "Windows 11", arch: "x64" },
			target: { executablePath: "C:/MineRadio/MineRadio-Tauri.exe" },
			coldStarts: [120, 80, 100, 110, 90].map((readyMs, index) => ({
				run: index + 1,
				readyMs,
				readiness: "main-window",
			})),
			steadyStateRuns: [
				steadyRun([3, 1, 2], [100, 120, 110], [200, 250, 225]),
				steadyRun([4, 2, 3], [130, 150, 140], [260, 300, 280]),
				steadyRun([5, 3, 4], [160, 180, 170], [310, 350, 330]),
			],
			optionalMetrics: {
				gpuMemory: { status: "required-manual", note: "需 GPU 工具采集" },
				frameTime: { status: "pending", note: "等待 release harness" },
				packageSize: { status: "captured", bytes: 123_456 },
			},
		});

		expect(evidence.protocol.coldStartRuns).toBe(5);
		expect(evidence.protocol.warmupSeconds).toBe(10);
		expect(evidence.protocol.sampleSeconds).toBe(60);
		expect(evidence.protocol.sampleRuns).toBe(3);
		expect(evidence.summary.coldStartMedianMs).toBe(100);
		expect(evidence.summary.cpuMedianPercent).toBe(3);
		expect(evidence.summary.workingSetMedianBytes).toBe(140);
		expect(evidence.summary.privateBytesPeak).toBe(350);

		const evaluation = evaluateM8WindowsReleaseEvidence(evidence);
		expect(evaluation.codeCompletePassed).toBe(true);
		expect(evaluation.fieldValidated).toBe(false);
		expect(evaluation.status).toBe("field-validation-pending");
		expect(evaluation.nonBlocking).toBe(true);
		expect(evaluation.pendingFields).toEqual([
			"gpuMemory",
			"frameTime",
			"lowEndDevice",
			"webView2Upgrade",
			"windowsSoak",
		]);
		expect(evidence.fieldValidation.lowEndDevice.status).toBe("required-manual");
		expect(evidence.fieldValidation.webView2Upgrade.status).toBe("required-manual");
		expect(evidence.fieldValidation.windowsSoak.status).toBe("required-manual");
	});

	test("does not treat captured labels without GPU, frame and package values as evidence", () => {
		const evidence = buildM8WindowsReleaseEvidence({
			capturedAt: "2026-07-30T00:00:00.000Z",
			git: { commit: "b".repeat(40), dirty: false },
			host: { platform: "win32", release: "Windows 11", arch: "x64" },
			target: { executablePath: "C:/MineRadio/MineRadio-Tauri.exe" },
			coldStarts: [1, 2, 3, 4, 5].map((readyMs, index) => ({
				run: index + 1,
				readyMs,
				readiness: "main-window",
			})),
			steadyStateRuns: [1, 2, 3].map(() =>
				steadyRun([1], [100], [200]),
			),
			optionalMetrics: {
				gpuMemory: { status: "captured" },
				frameTime: { status: "captured" },
				packageSize: { status: "captured" },
			},
		});

		const evaluation = evaluateM8WindowsReleaseEvidence(evidence);
		expect(evaluation.fieldValidated).toBe(false);
		expect(evaluation.pendingFields).toEqual([
			"gpuMemory",
			"frameTime",
			"packageSize",
			"lowEndDevice",
			"webView2Upgrade",
			"windowsSoak",
		]);
	});

	test("rejects a truncated steady-state round instead of accepting partial evidence", () => {
		expect(() =>
			buildM8WindowsReleaseEvidence({
				capturedAt: "2026-07-30T00:00:00.000Z",
				git: { commit: "d".repeat(40), dirty: false },
				host: { platform: "win32", release: "Windows 11", arch: "x64" },
				target: { executablePath: "C:/MineRadio/MineRadio-Tauri.exe" },
				coldStarts: [1, 2, 3, 4, 5].map((readyMs, index) => ({
					run: index + 1,
					readyMs,
					readiness: "main-window",
				})),
				steadyStateRuns: [
					steadyRun([1], [100], [200]),
					steadyRun([1], [100], [200]),
					{
						...steadyRun([1], [100], [200]),
						samples: [{
							offsetMs: 1_000,
							cpuPercent: 1,
							workingSetBytes: 100,
							privateBytes: 200,
						}],
					},
				],
				optionalMetrics: {},
			}),
		).toThrow("必须包含 60 个采样点");
	});

	test("only promotes complete numeric metrics and reviewed field artifacts", () => {
		const evidence = buildM8WindowsReleaseEvidence({
			capturedAt: "2026-07-30T00:00:00.000Z",
			git: { commit: "e".repeat(40), dirty: false },
			host: { platform: "win32", release: "Windows 11", arch: "x64" },
			target: { executablePath: "C:/MineRadio/MineRadio-Tauri.exe" },
			coldStarts: [1, 2, 3, 4, 5].map((readyMs, index) => ({
				run: index + 1,
				readyMs,
				readiness: "main-window",
			})),
			steadyStateRuns: [1, 2, 3].map(() =>
				steadyRun([1], [100], [200]),
			),
			optionalMetrics: {
				gpuMemory: { status: "captured", medianBytes: 100, peakBytes: 150 },
				frameTime: { status: "captured", p50Ms: 8, p95Ms: 16 },
				packageSize: { status: "captured", bytes: 1_000 },
			},
			fieldValidation: {
				lowEndDevice: {
					status: "captured",
					verified: true,
					artifactPaths: ["low-end.json"],
				},
				webView2Upgrade: {
					status: "captured",
					verified: true,
					artifactPaths: ["upgrade.webm"],
				},
				windowsSoak: {
					status: "captured",
					verified: true,
					durationSeconds: 1_800,
					artifactPaths: ["soak.json"],
				},
			},
		});

		expect(evidence.evaluation.fieldValidated).toBe(true);
		expect(evidence.evaluation.status).toBe("field-validated");
		expect(evidence.evaluation.nonBlocking).toBe(false);
		expect(evidence.evaluation.pendingFields).toEqual([]);
	});

	test("collector executes five cold starts and three exact steady-state rounds", async () => {
		const calls: string[] = [];
		const collector = {
			async collectHost() {
				return { platform: "win32", release: "Windows 11", arch: "x64" };
			},
			async collectColdStart(input: { run: number }) {
				calls.push(`cold:${input.run}`);
				return {
					run: input.run,
					readyMs: input.run * 10,
					readiness: "main-window",
				};
			},
			async collectSteadyState(input: {
				run: number;
				warmupSeconds: number;
				sampleSeconds: number;
				sampleIntervalMs: number;
			}) {
				calls.push(
					`steady:${input.run}:${input.warmupSeconds}:${input.sampleSeconds}:${input.sampleIntervalMs}`,
				);
				return steadyRun([input.run], [100 + input.run], [200 + input.run]);
			},
		};

		const evidence = await collectM8WindowsReleaseEvidence(
			{
				capturedAt: "2026-07-30T00:00:00.000Z",
				git: { commit: "c".repeat(40), dirty: false },
				executablePath: "C:/MineRadio/MineRadio-Tauri.exe",
				optionalMetrics: {
					gpuMemory: { status: "pending" },
					frameTime: { status: "required-manual" },
					packageSize: { status: "captured", bytes: 999 },
				},
			},
			collector,
		);

		expect(calls).toEqual([
			"cold:1",
			"cold:2",
			"cold:3",
			"cold:4",
			"cold:5",
			"steady:1:10:60:1000",
			"steady:2:10:60:1000",
			"steady:3:10:60:1000",
		]);
		expect(evidence.summary.coldStartMedianMs).toBe(30);
		expect(evidence.evaluation.status).toBe("field-validation-pending");
	});

	test("PowerShell adapter passes paths and arguments without command interpolation", async () => {
		const invocations: string[][] = [];
		const execute = (args: string[]) => {
			invocations.push(args);
			if (args.includes("host")) {
				return JSON.stringify({
					platform: "win32",
					release: "Windows 11",
					arch: "x64",
					logicalProcessors: 8,
				});
			}
			if (args.includes("cold")) {
				return JSON.stringify({ run: 1, readyMs: 321, readiness: "main-window" });
			}
			return JSON.stringify(steadyRun([2], [100], [200]));
		};
		const collector = createWindowsPowerShellCollector({ execute });
		const executablePath = "C:/Program Files/MineRadio/MineRadio-Tauri.exe";
		const input = {
			run: 1,
			executablePath,
			args: ["--profile", "性能 门禁"],
			readyTimeoutSeconds: 30,
		};

		await collector.collectHost();
		await collector.collectColdStart(input);
		await collector.collectSteadyState({
			...input,
			warmupSeconds: 10,
			sampleSeconds: 60,
			sampleIntervalMs: 1_000,
		});

		expect(invocations.length).toBe(3);
		for (const args of invocations.slice(1)) {
			expect(args.includes(executablePath)).toBe(true);
			expect(args.some((value) => value.includes("性能 门禁"))).toBe(false);
			const encodedIndex = args.indexOf("-ArgumentsBase64") + 1;
			const decoded = JSON.parse(
				Buffer.from(args[encodedIndex], "base64").toString("utf8"),
			);
			expect(decoded).toEqual(["--profile", "性能 门禁"]);
		}
	});

	test("checked-in JSON schema fixes protocol cardinality and pending metric states", () => {
		const schema = JSON.parse(
			readFileSync(
				path.join(import.meta.dir, "m8-windows-release-evidence.schema.json"),
				"utf8",
			),
		) as {
			properties: Record<string, any>;
			$defs: Record<string, any>;
		};

		expect(schema.properties.protocol.properties.coldStartRuns.const).toBe(5);
		expect(schema.properties.protocol.properties.warmupSeconds.const).toBe(10);
		expect(schema.properties.protocol.properties.sampleSeconds.const).toBe(60);
		expect(schema.properties.protocol.properties.sampleRuns.const).toBe(3);
		expect(schema.properties.coldStarts.minItems).toBe(5);
		expect(schema.properties.coldStarts.maxItems).toBe(5);
		expect(schema.properties.steadyStateRuns.minItems).toBe(3);
		expect(schema.properties.steadyStateRuns.maxItems).toBe(3);
		expect(schema.$defs.metricStatus.enum).toEqual([
			"captured",
			"required-manual",
			"pending",
		]);
	});
});

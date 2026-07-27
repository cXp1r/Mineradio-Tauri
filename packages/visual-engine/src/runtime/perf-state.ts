import type { VisualPerformanceSnapshot } from "./visual-engine-contract";

export type RenderPerfMode = "vsync" | `${number}fps`;

export interface PerfState {
	mode: RenderPerfMode;
	frames: number;
	fps: number;
	longFrames: number;
	skipped: number;
	lastRenderAt: number;
	lastSampleAt: number;
}

export type PerfStateSnapshot = Readonly<PerfState>;

export function createPerfState(now: number): PerfState {
	return {
		mode: "vsync",
		frames: 0,
		fps: 0,
		longFrames: 0,
		skipped: 0,
		lastRenderAt: now,
		lastSampleAt: now,
	};
}

export function projectPerfState(
	snapshot: VisualPerformanceSnapshot,
	modeHint?: RenderPerfMode,
): PerfStateSnapshot {
	const presentation = snapshot.gates.presentation;
	const fps = Math.round(presentation?.effectiveFps ?? 0);
	return {
		mode: modeHint ?? (presentation && presentation.skips > 0 && fps > 0
			? (`${fps}fps` as RenderPerfMode)
			: "vsync"),
		frames: snapshot.frames.rafTicks,
		fps,
		longFrames: snapshot.frames.longFrames,
		skipped: snapshot.frames.skippedRenders,
		lastRenderAt: 0,
		lastSampleAt: 0,
	};
}

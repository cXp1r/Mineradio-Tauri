import type { FxState } from "../home-visual/fx-defaults";
import type { ShelfItem } from "../shelf/shelf-animate";
import type { ShelfPane } from "../shelf/shelf-state";
import type { LyricLine } from "../stage-lyrics/lyric-line-progress";

export type VisualPresetId = number;

export type VisualBackgroundPolicy = "auto" | "keep" | "release";

export type VisualRuntimeMode =
	| "foreground"
	| "background"
	| "deep-sleep"
	| "released";

export type ForegroundFramePolicy =
	| { readonly mode: "vsync" }
	| { readonly mode: "fixed"; readonly fps: 24 | 30 | 45 | 60 };

export interface VisualVisibilityState {
	readonly documentVisible: boolean;
	readonly windowVisible: boolean;
	readonly windowFocused: boolean;
	readonly windowMinimized: boolean;
}

export interface VisualMediaClock {
	currentTimeSeconds(): number;
	durationSeconds(): number | null;
	isPlaying(): boolean;
}

export interface PlaybackVisualSnapshot {
	readonly trackKey: string;
	readonly playing: boolean;
	readonly durationMs: number | null;
	readonly coverUrl: string;
	readonly beatMapKey: string;
	readonly beatMap: unknown;
	readonly splashActive: boolean;
	readonly homeActive: boolean;
}

export interface LyricsVisualSnapshot {
	readonly lines: readonly LyricLine[];
	readonly fallbackText: string;
	readonly hasNativeKaraoke: boolean;
}

export interface ShelfVisualSnapshot {
	readonly items: readonly ShelfItem[];
	readonly pane: ShelfPane;
	readonly mode: string;
	readonly cameraMode: string;
	readonly presence: string;
	readonly mergeCollections: boolean;
	readonly mineCount: number;
	readonly favCount: number;
	readonly secondaryLeftDisplaySeamGuard: boolean;
}

export interface VisualSettingsSnapshot {
	readonly fx: Readonly<Partial<FxState>>;
	readonly coverResolution: number;
	readonly wallpaperSafe: boolean;
	readonly backgroundPolicy: VisualBackgroundPolicy;
	readonly foregroundFramePolicy: ForegroundFramePolicy;
	readonly prefersReducedMotion: boolean;
}

export interface VisualFrameSnapshot {
	readonly revision: number;
	readonly playback: PlaybackVisualSnapshot;
	readonly lyrics: LyricsVisualSnapshot;
	readonly shelf: ShelfVisualSnapshot;
	readonly settings: VisualSettingsSnapshot;
}

export interface VisualResourceUsage {
	readonly textureBytes: number;
	readonly geometryBytes: number;
	readonly meshCount: number;
	readonly queuedTaskCost: number;
	readonly cacheBytes: number;
}

export type VisualResourceBudget = VisualResourceUsage;

export type VisualResourcePressure = "normal" | "soft" | "hard";

export interface VisualPerformanceSnapshot {
	readonly runtime: {
		readonly mode: VisualRuntimeMode;
		readonly running: boolean;
		readonly mounted: boolean;
		readonly generation: number;
	};
	readonly frames: {
		readonly rafTicks: number;
		readonly timerTicks: number;
		readonly renders: number;
		readonly skippedRenders: number;
		readonly frameCostP50Ms: number;
		readonly frameCostP95Ms: number;
		readonly longFrames: number;
	};
	readonly gates: Readonly<
		Record<
			string,
			{
				readonly runs: number;
				readonly skips: number;
				readonly effectiveFps: number;
				readonly pendingDtSec: number;
				readonly costP50Ms: number;
				readonly costP95Ms: number;
				readonly errors: number;
			}
		>
	>;
	readonly resources: {
		readonly current: VisualResourceUsage;
		readonly peak: VisualResourceUsage;
		readonly budget: VisualResourceBudget;
		readonly pressure: VisualResourcePressure;
		readonly allocations: number;
		readonly releases: number;
	};
	readonly tasks: {
		readonly queued: number;
		readonly running: number;
		readonly completed: number;
		readonly cancelled: number;
		readonly staleResultsDropped: number;
		readonly failed: number;
		readonly peakQueueDepth: number;
	};
}

export interface VisualEngineFacade {
	mount(container: HTMLElement): Promise<void>;
	setPlaybackSnapshot(snapshot: PlaybackVisualSnapshot): void;
	setLyricsSnapshot(snapshot: LyricsVisualSnapshot): void;
	setShelfSnapshot(snapshot: ShelfVisualSnapshot): void;
	setVisualSettings(snapshot: VisualSettingsSnapshot): void;
	applyPreset(preset: VisualPresetId): void;
	setVisibility(state: VisualVisibilityState): void;
	getPerformanceSnapshot(): VisualPerformanceSnapshot;
	dispose(): void;
}

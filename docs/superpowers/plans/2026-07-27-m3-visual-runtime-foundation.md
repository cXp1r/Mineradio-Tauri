# M3 Visual Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the production Visual Engine facade, independent frame scheduling, deterministic resource and task ownership, and bounded performance instrumentation without changing current visual or Sidecar API behavior.

**Architecture:** The visual-engine package owns a transport-free Runtime Kernel: contracts, lifecycle, scheduler, frame gates, cancellation, resource scopes, budgets, task queue, and performance collection. The Web application keeps a Legacy Visual Composition adapter for existing Home, Shelf, Lyrics, Particles, DOM input, and callbacks; React only mounts the facade and commits immutable snapshots.

**Tech Stack:** TypeScript, Bun test, React 19, Three.js, GSAP, Vite.

---

## File map

### New Runtime Kernel files

- `packages/visual-engine/src/runtime/visual-engine-contract.ts`: facade, snapshot, media clock, composition, lifecycle, and event contracts.
- `packages/visual-engine/src/runtime/frame-gate.ts`: phase-credit cadence primitive.
- `packages/visual-engine/src/runtime/visual-visibility.ts`: explicit foreground/background/deep-sleep/released derivation.
- `packages/visual-engine/src/runtime/visual-scheduler.ts`: sole RAF/timer owner.
- `packages/visual-engine/src/runtime/cancellation-scope.ts`: owner/key generation and AbortSignal cancellation.
- `packages/visual-engine/src/runtime/resource-ledger.ts`: current/peak usage, budget decisions, and pressure state.
- `packages/visual-engine/src/runtime/resource-scope.ts`: hierarchical exactly-once reverse-order disposal.
- `packages/visual-engine/src/runtime/three-resource-scanner.ts`: read-only Three.js resource accounting.
- `packages/visual-engine/src/runtime/budget-task-queue.ts`: priority queue with cancellation and stale-result rejection.
- `packages/visual-engine/src/runtime/performance-collector.ts`: bounded p50/p95 frame, gate, task, and resource metrics.
- `packages/visual-engine/src/runtime/visual-engine.ts`: real facade lifecycle and composition host.

### New Web adapter files

- `apps/web/src/visual/runtime/visual-snapshot-builders.ts`: existing props/refs to readonly visual snapshots.
- `apps/web/src/visual/runtime/visual-environment-adapter.ts`: document and native window visibility input.
- `apps/web/src/visual/runtime/create-legacy-visual-composition.ts`: current imperative visual assembly.
- `apps/web/src/visual/runtime/legacy-visual-events.ts`: existing Shelf and desktop-motion callback bridge.

### Existing files that remain authoritative

- `packages/visual-engine/src/runtime/render-loop.ts`: renderer-facing adapter over VisualScheduler.
- `packages/visual-engine/src/home-visual/cover-texture.ts`: cover and AI depth behavior, augmented with cancellation.
- `apps/web/src/visual/VisualEngineHost.tsx`: stable DOM host and public prop compatibility.
- `apps/web/src/visual/useVisualEngine.ts`: thin React lifecycle adapter after extraction.

---

### Task 1: Freeze the public facade and snapshot contracts

**Files:**
- Create: `packages/visual-engine/src/runtime/visual-engine-contract.ts`
- Create: `packages/visual-engine/src/runtime/visual-engine-contract.test.ts`
- Modify: `packages/visual-engine/src/index.ts`
- Modify: `packages/visual-engine/src/index.test.ts`

- [ ] **Step 1: Add contract characterization tests**

Create tests that instantiate typed fixture snapshots and assert the exported factory surface contains:

~~~ts
import { expect, test } from "bun:test";
import {
  type PlaybackVisualSnapshot,
  type LyricsVisualSnapshot,
  type ShelfVisualSnapshot,
  type VisualEngineFacade,
  type VisualSettingsSnapshot,
  type VisualVisibilityState,
} from "./index";

test("visual engine exports the M3 facade lifecycle", () => {
  const engine: VisualEngineFacade = {
    async mount() {},
    setPlaybackSnapshot() {},
    setLyricsSnapshot() {},
    setShelfSnapshot() {},
    setVisualSettings() {},
    applyPreset() {},
    setVisibility() {},
    getPerformanceSnapshot: () => ({
      runtime: { mode: "foreground", running: false, mounted: false, generation: 0 },
      frames: {
        rafTicks: 0,
        timerTicks: 0,
        renders: 0,
        skippedRenders: 0,
        frameCostP50Ms: 0,
        frameCostP95Ms: 0,
        longFrames: 0,
      },
      gates: {},
      resources: {
        current: { textureBytes: 0, geometryBytes: 0, meshCount: 0, queuedTaskCost: 0, cacheBytes: 0 },
        peak: { textureBytes: 0, geometryBytes: 0, meshCount: 0, queuedTaskCost: 0, cacheBytes: 0 },
        budget: { textureBytes: 0, geometryBytes: 0, meshCount: 0, queuedTaskCost: 0, cacheBytes: 0 },
        pressure: "normal",
        allocations: 0,
        releases: 0,
      },
      tasks: {
        queued: 0,
        running: 0,
        completed: 0,
        cancelled: 0,
        staleResultsDropped: 0,
        failed: 0,
        peakQueueDepth: 0,
      },
    }),
    dispose() {},
  };

  expect(typeof engine.mount).toBe("function");
  expect(typeof engine.setPlaybackSnapshot).toBe("function");
  expect(typeof engine.setLyricsSnapshot).toBe("function");
  expect(typeof engine.setShelfSnapshot).toBe("function");
  expect(typeof engine.setVisualSettings).toBe("function");
  expect(typeof engine.applyPreset).toBe("function");
  expect(typeof engine.setVisibility).toBe("function");
  expect(typeof engine.getPerformanceSnapshot).toBe("function");
  expect(typeof engine.dispose).toBe("function");
});
~~~

- [ ] **Step 2: Run the focused test and verify red**

Run:

~~~powershell
bun test packages/visual-engine/src/runtime/visual-engine-contract.test.ts packages/visual-engine/src/index.test.ts
~~~

Expected: FAIL because the M3 contract and option-based factory do not exist.

- [ ] **Step 3: Define the exact public contracts**

Add these primary types:

~~~ts
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
  readonly gates: Readonly<Record<string, {
    readonly runs: number;
    readonly skips: number;
    readonly effectiveFps: number;
    readonly pendingDtSec: number;
    readonly costP50Ms: number;
    readonly costP95Ms: number;
    readonly errors: number;
  }>>;
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
~~~

Task 1 defines snapshot and facade contracts only. The composition/runtime-service contracts are added in Task 6 after Scheduler, ResourceScope, CancellationScope, BudgetTaskQueue, and PerformanceCollector exist, so every intermediate commit typechecks.

- [ ] **Step 4: Export contracts without removing existing leaf exports**

Keep every existing barrel export. Export the new contract types while temporarily retaining the old no-op createVisualEngine implementation until Task 6 replaces it. Do not route production through the no-op.

- [ ] **Step 5: Run package tests and typecheck**

Run:

~~~powershell
bun test packages/visual-engine/src/runtime/visual-engine-contract.test.ts packages/visual-engine/src/index.test.ts
bun run --filter ./packages/visual-engine typecheck
~~~

Expected: PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add packages/visual-engine/src/runtime/visual-engine-contract.ts packages/visual-engine/src/runtime/visual-engine-contract.test.ts packages/visual-engine/src/index.ts packages/visual-engine/src/index.test.ts
git commit -m "feat(visual-engine): define M3 facade contracts"
~~~

---

### Task 2: Implement phase-credit Frame Gate

**Files:**
- Create: `packages/visual-engine/src/runtime/frame-gate.ts`
- Create: `packages/visual-engine/src/runtime/frame-gate.test.ts`
- Modify: `packages/visual-engine/src/index.ts`

- [ ] **Step 1: Write failing timeline tests**

Cover:

- 24/30/45/60 FPS on simulated 60/120/144Hz timelines with run-count error at most one;
- 45 FPS on 60Hz does not collapse to 30;
- first active tick may run immediately;
- at most one run per tick;
- skipped time is accumulated into the next run;
- returned dt is capped at 0.05;
- clock rollback and a stall over 1000ms reset phase;
- inactive then active does not catch up;
- setRate and reset clear previous phase.

Use a deterministic helper:

~~~ts
function simulate(rate: number, displayHz: number, seconds: number): number {
  const gate = createFrameGate({ rate });
  let runs = 0;
  for (let frame = 0; frame <= displayHz * seconds; frame += 1) {
    const decision = gate.advance((frame * 1000) / displayHz);
    if (decision.run) runs += 1;
  }
  return runs;
}
~~~

- [ ] **Step 2: Verify red**

~~~powershell
bun test packages/visual-engine/src/runtime/frame-gate.test.ts
~~~

Expected: FAIL because createFrameGate does not exist.

- [ ] **Step 3: Implement FrameGate**

Expose:

~~~ts
export type FrameGateRate = "presentation" | number;

export interface FrameGateDecision {
  readonly run: boolean;
  readonly dtSec: number;
  readonly pendingDtSec: number;
}

export interface FrameGate {
  advance(nowMs: number, active?: boolean): FrameGateDecision;
  reset(nowMs?: number): void;
  setRate(rate: FrameGateRate): void;
  getPendingDtSec(): number;
}
~~~

Maintain separate phase credit and accumulated task dt. On a run, subtract exactly one target period while preserving fractional phase; discard whole-period debt above one cycle so a single scheduler tick never performs catch-up loops.

- [ ] **Step 4: Verify green and export**

~~~powershell
bun test packages/visual-engine/src/runtime/frame-gate.test.ts
bun run --filter ./packages/visual-engine typecheck
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add packages/visual-engine/src/runtime/frame-gate.ts packages/visual-engine/src/runtime/frame-gate.test.ts packages/visual-engine/src/index.ts
git commit -m "feat(visual-engine): add phase-credit frame gates"
~~~

---

### Task 3: Add visibility-aware VisualScheduler

**Files:**
- Create: `packages/visual-engine/src/runtime/visual-visibility.ts`
- Create: `packages/visual-engine/src/runtime/visual-visibility.test.ts`
- Create: `packages/visual-engine/src/runtime/visual-scheduler.ts`
- Create: `packages/visual-engine/src/runtime/visual-scheduler.test.ts`
- Modify: `packages/visual-engine/src/index.ts`

- [ ] **Step 1: Write visibility truth-table tests**

Assert:

~~~text
visible + focused + not minimized        -> foreground
visible + blurred + auto                 -> background
hidden/minimized/invisible + auto        -> deep-sleep
hidden/minimized/invisible + keep        -> background
any non-foreground + release             -> released
~~~

- [ ] **Step 2: Write scheduler race tests**

Use an injected fake driver and test:

- start is idempotent and owns one RAF;
- stop/dispose are idempotent;
- stale RAF callback after stop cannot reschedule;
- deep-sleep cancels RAF and owns one maintenance timer;
- maintenance timer does not call animation work;
- wake cancels timer, increments generation, resets presentation cadence, and owns one RAF;
- hidden plus keep retains RAF;
- released retains neither RAF nor timer;
- stepOnce does not schedule;
- callback errors are reported and later ticks still run;
- default foreground policy is VSync;
- fixed FPS is used only when explicitly set.

- [ ] **Step 3: Verify red**

~~~powershell
bun test packages/visual-engine/src/runtime/visual-visibility.test.ts packages/visual-engine/src/runtime/visual-scheduler.test.ts
~~~

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement visibility derivation and scheduler**

Use:

~~~ts
export interface VisualSchedulerDriver {
  now(): number;
  requestFrame(callback: (nowMs: number) => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

export interface VisualScheduler {
  start(): void;
  stop(): void;
  stepOnce(nowMs?: number): void;
  setVisibility(state: VisualVisibilityState): void;
  setBackgroundPolicy(policy: VisualBackgroundPolicy): void;
  setForegroundFramePolicy(policy: ForegroundFramePolicy): void;
  getMode(): VisualRuntimeMode;
  getGeneration(): number;
  dispose(): void;
}
~~~

Every scheduled callback captures the current generation. A callback whose generation is stale returns without scheduling replacement work.

- [ ] **Step 5: Verify green**

~~~powershell
bun test packages/visual-engine/src/runtime/visual-visibility.test.ts packages/visual-engine/src/runtime/visual-scheduler.test.ts
bun run --filter ./packages/visual-engine typecheck
~~~

Expected: PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add packages/visual-engine/src/runtime/visual-visibility.ts packages/visual-engine/src/runtime/visual-visibility.test.ts packages/visual-engine/src/runtime/visual-scheduler.ts packages/visual-engine/src/runtime/visual-scheduler.test.ts packages/visual-engine/src/index.ts
git commit -m "feat(visual-engine): add visibility-aware scheduler"
~~~

---

### Task 4: Implement resource ownership, ledger, and Three.js accounting

**Files:**
- Create: `packages/visual-engine/src/runtime/resource-ledger.ts`
- Create: `packages/visual-engine/src/runtime/resource-ledger.test.ts`
- Create: `packages/visual-engine/src/runtime/resource-scope.ts`
- Create: `packages/visual-engine/src/runtime/resource-scope.test.ts`
- Create: `packages/visual-engine/src/runtime/three-resource-scanner.ts`
- Create: `packages/visual-engine/src/runtime/three-resource-scanner.test.ts`
- Modify: `packages/visual-engine/src/index.ts`

- [ ] **Step 1: Write failing ResourceScope tests**

Test:

- child and resource disposers execute in exact reverse creation order;
- handle dispose and scope dispose call each disposer once;
- parent disposal cascades to children;
- closed scopes reject registration with VisualResourceScopeClosedError;
- one failing disposer is reported while later disposers still run;
- releaseRetention only releases matching rebuildable/ephemeral entries.

- [ ] **Step 2: Write failing ledger tests**

Test current/peak usage, soft pressure, hard pressure, optional/background denial, essential admission, queued task cost, and release back to normal pressure.

- [ ] **Step 3: Write failing scanner tests**

Build a fake scene containing shared geometry, material, and texture references. Assert byte/count de-duplication and assert every fake dispose counter remains zero.

- [ ] **Step 4: Verify red**

~~~powershell
bun test packages/visual-engine/src/runtime/resource-scope.test.ts packages/visual-engine/src/runtime/resource-ledger.test.ts packages/visual-engine/src/runtime/three-resource-scanner.test.ts
~~~

Expected: FAIL.

- [ ] **Step 5: Implement ledger**

Import VisualResourceUsage, VisualResourceBudget, and VisualResourcePressure from visual-engine-contract.ts, then expose:

~~~ts
export type VisualResourcePriority = "essential" | "normal" | "optional" | "background";
~~~

The ledger must keep current and peak separately. Hard pressure denies only optional/background allocations; it never automatically releases essential resources.

- [ ] **Step 6: Implement hierarchical ResourceScope**

Register children as ordered owned entries. Wrap each registration in an exactly-once handle. Return a disposal report containing every caught error.

- [ ] **Step 7: Implement read-only Three.js scanner**

Use Set identity de-duplication. Estimate texture bytes as width × height × 4 and geometry bytes from attribute/index typed-array byteLength. Never call dispose.

- [ ] **Step 8: Verify green**

~~~powershell
bun test packages/visual-engine/src/runtime/resource-scope.test.ts packages/visual-engine/src/runtime/resource-ledger.test.ts packages/visual-engine/src/runtime/three-resource-scanner.test.ts
bun run --filter ./packages/visual-engine typecheck
~~~

Expected: PASS.

- [ ] **Step 9: Commit**

~~~powershell
git add packages/visual-engine/src/runtime/resource-ledger.ts packages/visual-engine/src/runtime/resource-ledger.test.ts packages/visual-engine/src/runtime/resource-scope.ts packages/visual-engine/src/runtime/resource-scope.test.ts packages/visual-engine/src/runtime/three-resource-scanner.ts packages/visual-engine/src/runtime/three-resource-scanner.test.ts packages/visual-engine/src/index.ts
git commit -m "feat(visual-engine): add visual resource ownership"
~~~

---

### Task 5: Add cancellation, budget task queue, and performance collection

**Files:**
- Create: `packages/visual-engine/src/runtime/cancellation-scope.ts`
- Create: `packages/visual-engine/src/runtime/cancellation-scope.test.ts`
- Create: `packages/visual-engine/src/runtime/budget-task-queue.ts`
- Create: `packages/visual-engine/src/runtime/budget-task-queue.test.ts`
- Create: `packages/visual-engine/src/runtime/performance-collector.ts`
- Create: `packages/visual-engine/src/runtime/performance-collector.test.ts`
- Modify: `packages/visual-engine/src/index.ts`

- [ ] **Step 1: Write failing cancellation tests**

Test same-owner/key replacement aborts the old ticket, parent disposal cascades, disposed scope rejects issue, and an unabortable promise cannot commit after its ticket becomes stale.

- [ ] **Step 2: Write failing task queue tests**

Test:

- critical → visible → normal → background order;
- runSlice starts only within cost budget;
- same owner/key replaces prior queued work;
- cancelOwner and cancelPriority;
- soft pressure pauses background;
- hard pressure rejects or cancels background/optional work;
- commit requires a live signal, open scope, and current generation;
- staleResultsDropped and failure counters;
- dispose cancels queued and running tickets.

- [ ] **Step 3: Write failing performance tests**

Test fixed-capacity samples, p50/p95, per-gate separation, actual execution cost rather than frame dt, task counters, deep-copy snapshot, and current/peak resource projection.

- [ ] **Step 4: Verify red**

~~~powershell
bun test packages/visual-engine/src/runtime/cancellation-scope.test.ts packages/visual-engine/src/runtime/budget-task-queue.test.ts packages/visual-engine/src/runtime/performance-collector.test.ts
~~~

Expected: FAIL.

- [ ] **Step 5: Implement cancellation tickets**

Expose:

~~~ts
export interface CancellationTicket {
  readonly owner: string;
  readonly key: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
~~~

Each owner/key issue invalidates its predecessor. Parent scope disposal aborts every child and ticket.

- [ ] **Step 6: Implement budget queue**

Expose `enqueue`, `runSlice`, `cancelOwner`, `cancelPriority`, `dispose`, and `getSnapshot`. Release queuedTaskCost when work starts or is cancelled. Awaited work may call commit only after all stale guards pass.

- [ ] **Step 7: Implement bounded performance collector**

Use the VisualPerformanceSnapshot contract from visual-engine-contract.ts. Use fixed-capacity ring buffers, calculate percentile values from sorted copies, and record task errors and gate errors instead of silently swallowing them.

- [ ] **Step 8: Verify green**

~~~powershell
bun test packages/visual-engine/src/runtime/cancellation-scope.test.ts packages/visual-engine/src/runtime/budget-task-queue.test.ts packages/visual-engine/src/runtime/performance-collector.test.ts
bun run --filter ./packages/visual-engine typecheck
~~~

Expected: PASS.

- [ ] **Step 9: Commit**

~~~powershell
git add packages/visual-engine/src/runtime/cancellation-scope.ts packages/visual-engine/src/runtime/cancellation-scope.test.ts packages/visual-engine/src/runtime/budget-task-queue.ts packages/visual-engine/src/runtime/budget-task-queue.test.ts packages/visual-engine/src/runtime/performance-collector.ts packages/visual-engine/src/runtime/performance-collector.test.ts packages/visual-engine/src/index.ts
git commit -m "feat(visual-engine): add bounded visual task runtime"
~~~

---

### Task 6: Implement the real facade lifecycle

**Files:**
- Create: `packages/visual-engine/src/runtime/visual-engine.ts`
- Create: `packages/visual-engine/src/runtime/visual-engine.test.ts`
- Modify: `packages/visual-engine/src/runtime/visual-engine-contract.ts`
- Modify: `packages/visual-engine/src/index.ts`
- Modify: `packages/visual-engine/src/index.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use a fake composition and verify:

- setters before mount retain only the latest snapshot;
- mount receives the latest immutable frame bundle;
- setters after mount update composition without remount;
- same-instance second mount rejects;
- dispose during an unresolved mount aborts and releases partial resources;
- mount rejection rolls back;
- dispose is exactly-once and idempotent;
- stale mount completion after dispose cannot start scheduler or commit composition;
- getPerformanceSnapshot returns collector data;
- applyPreset and setVisibility delegate only while live.

- [ ] **Step 2: Verify red**

~~~powershell
bun test packages/visual-engine/src/runtime/visual-engine.test.ts packages/visual-engine/src/index.test.ts
~~~

Expected: FAIL because the production facade implementation is absent.

- [ ] **Step 3: Implement facade state machine**

Implement:

~~~text
idle -> mounting -> mounted -> disposing -> disposed
~~~

Create the root CancellationScope, ResourceScope, ledger, task queue, collector, and scheduler once per facade. Capture lifecycle generation before awaiting composition mount. On failure or disposal, cancel first, then reverse-dispose resources.

Add the exact composition contracts:

~~~ts
export interface VisualEngineCompositionContext {
  readonly container: HTMLElement;
  readonly mediaClock: VisualMediaClock;
  readonly resources: VisualResourceScope;
  readonly cancellation: CancellationScope;
  readonly tasks: BudgetTaskQueue;
  readonly scheduler: VisualScheduler;
  readonly performance: PerformanceCollector;
  getFrameSnapshot(): VisualFrameSnapshot;
}

export interface VisualEngineComposition {
  mount(context: VisualEngineCompositionContext): Promise<void>;
  applyFrameSnapshot(snapshot: VisualFrameSnapshot): void;
  applyPreset(preset: VisualPresetId): void;
  setVisibility(state: VisualVisibilityState): void;
  dispose(): void;
}

export interface VisualEngineOptions {
  readonly mediaClock: VisualMediaClock;
  readonly createComposition: () => VisualEngineComposition;
  readonly resourceBudget?: Partial<VisualResourceBudget>;
  readonly initialVisibility?: VisualVisibilityState;
}
~~~

- [ ] **Step 4: Make createVisualEngine production-only**

Remove the no-op implementation completely. The factory must require a mediaClock and createComposition option and return the real facade.

- [ ] **Step 5: Verify green**

~~~powershell
bun test packages/visual-engine/src/runtime/visual-engine.test.ts packages/visual-engine/src/index.test.ts
bun run --filter ./packages/visual-engine typecheck
~~~

Expected: PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add packages/visual-engine/src/runtime/visual-engine.ts packages/visual-engine/src/runtime/visual-engine.test.ts packages/visual-engine/src/runtime/visual-engine-contract.ts packages/visual-engine/src/index.ts packages/visual-engine/src/index.test.ts
git commit -m "feat(visual-engine): implement visual engine facade"
~~~

---

### Task 7: Move RenderLoop onto the scheduler and independent gates

**Files:**
- Modify: `packages/visual-engine/src/runtime/render-step-slot.ts`
- Modify: `packages/visual-engine/src/runtime/render-loop.ts`
- Modify: `packages/visual-engine/src/runtime/render-loop.test.ts`
- Modify: `packages/visual-engine/src/runtime/perf-state.ts`
- Modify: `packages/visual-engine/src/index.ts`

- [ ] **Step 1: Extend RenderLoop characterization tests**

Add tests for:

- audio.update before audio.getSnapshot and before every visual step;
- one immutable audio snapshot reference shared by all tasks in a scheduler tick;
- Beatmap slot precedes every existing visual slot;
- existing slot relative order remains unchanged;
- Shelf 30, LyricParticles 45, StageLyrics 45, DesktopOverlay 12, and presentation tasks use independent gates;
- fixed presentation FPS does not cap AudioAnalysis 60;
- hidden/minimized skips the complete visual pipeline;
- deep-sleep calls maintenance only;
- wake has bounded dt;
- task error does not block later tasks/render and increments diagnostics;
- stepOnce does not create RAF;
- splash 520ms warm rendering stays compatible.

- [ ] **Step 2: Verify red**

~~~powershell
bun test packages/visual-engine/src/runtime/render-loop.test.ts
~~~

Expected: FAIL for the new ordering and scheduler behaviors.

- [ ] **Step 3: Add Beatmap slot and cadence metadata**

Keep existing old-slot order unchanged after inserting Beatmap first. Add optional RenderStepOptions:

~~~ts
export interface RenderStepOptions {
  readonly cadence?: FrameGateRate;
  readonly isActive?: (mode: VisualRuntimeMode) => boolean;
}
~~~

- [ ] **Step 4: Delegate RAF/timer ownership to VisualScheduler**

RenderLoop must not schedule callbacks itself. Create per-step FrameGate instances. The animation tick order is:

~~~text
AudioAnalysis gate
-> audio.update()
-> audio.getSnapshot()
-> Beatmap gate
-> remaining task gates
-> presentationDue renderer.render()
~~~

`uTime` and pointer parallax advance only on presentation cadence.

- [ ] **Step 5: Project compatibility perf APIs from the new collector**

Keep `getFps()` and `getPerfState()` until consumers migrate, but source their values from the M3 collector rather than an independent counter.

- [ ] **Step 6: Verify green**

~~~powershell
bun test packages/visual-engine/src/runtime/render-loop.test.ts
bun run --filter ./packages/visual-engine typecheck
~~~

Expected: PASS.

- [ ] **Step 7: Commit**

~~~powershell
git add packages/visual-engine/src/runtime/render-step-slot.ts packages/visual-engine/src/runtime/render-loop.ts packages/visual-engine/src/runtime/render-loop.test.ts packages/visual-engine/src/runtime/perf-state.ts packages/visual-engine/src/index.ts
git commit -m "refactor(visual-engine): schedule independent visual lanes"
~~~

---

### Task 8: Extract the Legacy Visual Composition and thin the React adapter

**Files:**
- Create: `apps/web/src/visual/runtime/visual-snapshot-builders.ts`
- Create: `apps/web/src/visual/runtime/visual-snapshot-builders.test.ts`
- Create: `apps/web/src/visual/runtime/visual-environment-adapter.ts`
- Create: `apps/web/src/visual/runtime/visual-environment-adapter.test.ts`
- Create: `apps/web/src/visual/runtime/legacy-visual-events.ts`
- Create: `apps/web/src/visual/runtime/create-legacy-visual-composition.ts`
- Create: `apps/web/src/visual/runtime/create-legacy-visual-composition.test.ts`
- Modify: `apps/web/src/visual/useVisualEngine.ts`
- Modify: `apps/web/src/visual/useVisualEngine.test.ts`
- Modify: `apps/web/src/visual/VisualEngineHost.tsx`
- Modify: `apps/web/src/visual/VisualEngineHost.test.tsx`

- [ ] **Step 1: Add characterization tests before moving code**

Lock:

- VisualEngineHost DOM IDs/classes;
- CSS album background uses the direct cover URL;
- WebGL cover uses the Sidecar image-proxy URL;
- real media clock reads audio.currentTime before React position fallback;
- Shelf callback payloads remain byte-for-byte compatible;
- Home preview/preset restore behavior;
- Stage Lyrics lifecycle and desktop motion callback;
- snapshot changes do not recreate renderer/facade;
- StrictMode cleanup disposes each facade instance once.

- [ ] **Step 2: Add snapshot builder tests**

Assert complete immutable playback, lyrics, shelf, and settings snapshots. Preserve preset numeric IDs, all current FX values, and opaque beatmap/cover values. Do not include ProviderId, HTTP routes, or Sidecar base URL.

- [ ] **Step 3: Add environment adapter tests**

Use fake document/window/native state sources. Assert visibilitychange, focus, blur, native visible/focused/minimized updates, unsubscribe, and default Web fallback.

- [ ] **Step 4: Verify characterization baseline**

~~~powershell
bun test apps/web/src/visual/VisualEngineHost.test.tsx apps/web/src/visual/useVisualEngine.test.ts apps/web/src/visual/runtime/visual-snapshot-builders.test.ts apps/web/src/visual/runtime/visual-environment-adapter.test.ts
~~~

Expected: existing characterization passes; new modules fail until implemented.

- [ ] **Step 5: Mechanically extract imperative assembly**

Move the effect body, initAudioSource helpers that are runtime-owned, MountedHandles creation, pointer wiring, Shelf wiring, and subsystem registration to `create-legacy-visual-composition.ts`.

Replace every manual partial unwind block with immediate ResourceScope registration:

~~~ts
const rendererScope = context.resources.createChild("renderer");
const renderer = await createRenderer(container, rendererOptions);
rendererScope.register({
  owner: "renderer",
  kind: "mesh",
  retention: "persistent",
  dispose: () => renderer.dispose(),
});
~~~

Register returned off-functions as listener/subscription resources immediately after creation.

- [ ] **Step 6: Connect independent render lanes**

Register:

~~~text
Beatmap             60
Ripples             60
Shelf               30
LyricParticles      45
StageLyrics         45
DesktopOverlaySync  12
HomeVisual/Camera   presentation
~~~

Remove audioEngine.update from the old Ripples callback because RenderLoop now owns AudioAnalysis before snapshot capture.

- [ ] **Step 7: Make useVisualEngine a lifecycle bridge**

The hook may:

- create one facade for one mount;
- call mount;
- submit snapshot/settings/visibility updates;
- call dispose in cleanup.

It may not import Three.js, createRenderer, createRenderLoop, registerStep, create Home/Shelf/Lyrics modules, or manually dispose their handles.

- [ ] **Step 8: Keep VisualEngineHost public props and DOM stable**

Build snapshots internally without changing App-facing engineProps. Remove the unused PlayerController/controllerRef dependency if its existing tests prove it is unused.

- [ ] **Step 9: Verify focused Web behavior**

~~~powershell
bun test apps/web/src/visual
bun run --filter ./apps/web typecheck
bun run --filter ./packages/visual-engine typecheck
~~~

Expected: PASS.

- [ ] **Step 10: Commit**

~~~powershell
git add apps/web/src/visual/runtime apps/web/src/visual/useVisualEngine.ts apps/web/src/visual/useVisualEngine.test.ts apps/web/src/visual/VisualEngineHost.tsx apps/web/src/visual/VisualEngineHost.test.tsx
git commit -m "refactor(web): mount visuals through runtime facade"
~~~

---

### Task 9: Integrate cancellation and budget governance into cover/AI work

**Files:**
- Modify: `packages/visual-engine/src/home-visual/cover-texture.ts`
- Modify: `packages/visual-engine/src/home-visual/cover-texture.test.ts`
- Modify: `packages/visual-engine/src/home-visual/home-visual.ts`
- Modify: `packages/visual-engine/src/home-visual/home-visual.test.ts`
- Modify: `apps/web/src/visual/ai-depth-estimator.ts`
- Modify: `apps/web/src/visual/ai-depth-estimator.test.ts`
- Modify: `apps/web/src/visual/runtime/create-legacy-visual-composition.ts`

- [ ] **Step 1: Add red tests for late async work**

Test:

- changing cover aborts the previous cover-load ticket;
- disposing controller prevents late load and AI results from touching uniforms/cache;
- an unabortable AI promise becomes stale and cannot commit;
- HomeVisual disposed before async back-cover completion immediately disposes the late layer;
- current cache behavior and 18-entry compatibility remain under normal pressure;
- release pressure trims measured cover cache without changing visible essential textures.

- [ ] **Step 2: Verify red**

~~~powershell
bun test packages/visual-engine/src/home-visual/cover-texture.test.ts packages/visual-engine/src/home-visual/home-visual.test.ts apps/web/src/visual/ai-depth-estimator.test.ts
~~~

Expected: FAIL for AbortSignal/dispose behavior.

- [ ] **Step 3: Make cover and AI functions signal-aware**

Change:

~~~ts
export type HomeCoverLoader =
  (url: string, signal?: AbortSignal) => Promise<HomeCoverImage>;

export type HomeAiDepthEstimator =
  (image: HomeCoverImage, signal?: AbortSignal) =>
    Promise<HomeCoverImage | null>;
~~~

Add controller dispose, optional cancellation scope, task queue, and ledger options. Keep immediate execution when no runtime options are injected so leaf callers retain behavior.

- [ ] **Step 4: Guard every async commit**

After every awaited load/import/pipeline/depth operation check signal and ticket generation. Third-party work need not be physically preemptible; stale results must be unable to commit.

- [ ] **Step 5: Add cache measurement and trim functions**

Export runtime-only helpers to estimate and trim cover cache bytes. Keep the existing 18-entry LRU cap as the normal-pressure compatibility rule.

- [ ] **Step 6: Register cover/AI tasks and released-mode trimming**

In the legacy composition:

- owner/key cover-load and ai-depth tasks;
- cancel background tasks on released;
- release rebuildable/ephemeral scopes;
- lazily rebuild after wake;
- feed queue and resource snapshots into the collector.

- [ ] **Step 7: Verify green**

~~~powershell
bun test packages/visual-engine/src/home-visual/cover-texture.test.ts packages/visual-engine/src/home-visual/home-visual.test.ts apps/web/src/visual/ai-depth-estimator.test.ts apps/web/src/visual/runtime/create-legacy-visual-composition.test.ts
bun run typecheck
~~~

Expected: PASS.

- [ ] **Step 8: Commit**

~~~powershell
git add packages/visual-engine/src/home-visual/cover-texture.ts packages/visual-engine/src/home-visual/cover-texture.test.ts packages/visual-engine/src/home-visual/home-visual.ts packages/visual-engine/src/home-visual/home-visual.test.ts apps/web/src/visual/ai-depth-estimator.ts apps/web/src/visual/ai-depth-estimator.test.ts apps/web/src/visual/runtime/create-legacy-visual-composition.ts
git commit -m "feat(visual-engine): govern visual async resources"
~~~

---

### Task 10: Add architecture guards, parity updates, and full verification

**Files:**
- Create: `scripts/architecture/visual-runtime-boundary.test.ts`
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md`
- Modify: `docs/superpowers/specs/2026-07-27-m3-visual-runtime-foundation-design.md`

- [ ] **Step 1: Add architecture boundary tests**

Assert:

- visual-engine source contains no imports from React, Zustand, Tauri, Sidecar, Provider, or apps/web;
- VisualEngineHost/useVisualEngine do not import Three.js, renderer setup, render loop, or leaf visual factories;
- production Web path imports and calls createVisualEngine;
- useVisualEngine does not call registerStep;
- runtime contracts contain no ProviderId, HTTP route, or Sidecar base URL;
- existing API freeze markers remain unchanged.

- [ ] **Step 2: Correct parity ownership**

Update:

- visual.frame-scheduler from partial to implemented after tests pass;
- visual.sonic-topography blocked_by to M4 behavior parity, while noting M3 scheduler/resource foundation;
- shelf.3d blocked_by to M4 behavior parity;
- Stage Lyrics remains partial and explicitly pending M4;
- M3 milestone status to complete only after all commands below pass.

- [ ] **Step 3: Run focused runtime suites**

~~~powershell
bun test packages/visual-engine/src/runtime
bun test packages/visual-engine/src/home-visual
bun test apps/web/src/visual
bun test scripts/architecture/visual-runtime-boundary.test.ts
~~~

Expected: PASS with zero failures.

- [ ] **Step 4: Run full verification**

~~~powershell
bun run typecheck
bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture
bun run web:build
git diff --check
~~~

Expected:

- typecheck exit 0;
- all tests pass;
- Web build exit 0;
- diff check exit 0.

- [ ] **Step 5: Inspect scope and API freeze**

Run:

~~~powershell
git diff --name-only 217dbb3..HEAD
git diff 217dbb3..HEAD -- sidecars/api packages/shared apps/web/src/adapters/sidecar
git status --short
~~~

Expected:

- no Sidecar route, DTO, ProviderId, or media URL behavior changes;
- only intentional shared files, if any, are documentation-free exports;
- worktree contains no uncommitted implementation changes.

- [ ] **Step 6: Commit final guards and documentation**

~~~powershell
git add scripts/architecture/visual-runtime-boundary.test.ts docs/parity/capability-matrix.md docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md docs/superpowers/specs/2026-07-27-m3-visual-runtime-foundation-design.md
git commit -m "docs: mark M3 visual runtime complete"
~~~

- [ ] **Step 7: Run post-commit smoke verification**

~~~powershell
bun test packages/visual-engine/src/runtime apps/web/src/visual scripts/architecture/visual-runtime-boundary.test.ts
bun run typecheck
git status --short --branch
~~~

Expected: zero failures and a clean M3 branch.

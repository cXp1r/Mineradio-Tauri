# Mineradio M2 Playback Session State Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce an explicit, stale-safe playback session state machine and ensure every user playback intent—including replaying the same track—creates a unique frontend playback session without changing the frozen Sidecar HTTP API or current visible playback behavior.

**Architecture:** Add a pure playback state reducer for phase/session/load ownership, keep `PlaybackSessionCoordinator` as the compatibility boundary for URL age and one-shot recovery, and add a monotonic `playbackIntentId` to the existing Zustand store so React can distinguish replay from a no-op track identity update. The current single `Audio` element, `SidecarClient`, media URL adapter, DTOs, error text, and UI timing remain unchanged; dual-deck owner handoff, stalled probes, Audio Graph recovery, fades, output routing, and gapless/crossfade are separate M2 plans built on this foundation.

**Tech Stack:** TypeScript, React 19, Zustand, Bun test, existing `PlaybackPort`/`MediaUrlPort` adapters.

---

## Frozen boundaries

- Do not modify `sidecars/api/**`, `packages/shared/**`, `apps/web/src/api/sidecar-client.ts`, Rust sidecar supervision, endpoint paths, request bodies, error fields, or media proxy URL construction.
- Do not add `MineRadio-api`, Tauri IPC transport, a second HTTP implementation, gapless, crossfade, output routing, or persistence in this slice.
- Preserve the current UI behavior where selecting a track updates `currentTrack`/`isPlaying` before media ownership is committed. M2 will introduce pending/committed owner separation in a later plan after characterization coverage exists.
- Use strict red-green TDD only for the state reducer, replay intent identity, stale session rejection, and recovery-state transitions. Mechanical wiring and documentation use existing characterization tests, typecheck, and architecture guards.

## File structure

- Create `apps/web/src/features/playback/playback-state-machine.ts`: pure phase/session/load reducer with stale-event rejection.
- Create `apps/web/src/features/playback/playback-state-machine.test.ts`: state transition matrix for current-session and stale-session events.
- Modify `apps/web/src/stores/playback-store.ts`: add monotonic `playbackIntentId` and increment it for playback/stop intents.
- Modify `apps/web/src/stores/playback-store.test.ts`: prove same-track replay and stop/queue actions create new intents.
- Modify `apps/web/src/features/playback/playback-session-coordinator.ts`: compose the new state machine with existing URL-age and recovery policy.
- Modify `apps/web/src/features/playback/playback-session-coordinator.test.ts`: prove unique session IDs and current/stale load ownership.
- Modify `apps/web/src/features/playback/usePlaybackSessionRuntime.ts`: accept `playbackIntentId`, pass session/load handles to the coordinator, and publish media lifecycle events to the machine.
- Modify `apps/web/src/features/playback/usePlaybackSessionRuntime.test.tsx`: characterize same-track replay and stale completion rejection.
- Modify `apps/web/src/app/App.tsx`: pass the store intent ID into the existing runtime only.
- Modify `scripts/architecture/playback-session-boundary.test.ts`: require the explicit state machine to remain owned by the playback feature.
- Modify `docs/parity/capability-matrix.md` and `docs/parity/app-extraction-map.md`: record the M2 foundation evidence without claiming gapless/crossfade completion.

### Task 1: Pure playback state machine

**Files:**
- Create: `apps/web/src/features/playback/playback-state-machine.ts`
- Create: `apps/web/src/features/playback/playback-state-machine.test.ts`

- [x] **Step 1: Write the failing transition tests**

Create tests covering the exact public contract:

```ts
import { expect, test } from "bun:test";
import {
  createPlaybackState,
  reducePlaybackState,
} from "./playback-state-machine";

test("PLAY_TRACK creates a resolving session and stale load events are ignored", () => {
  const resolving = reducePlaybackState(createPlaybackState(), {
    type: "PLAY_TRACK",
    playbackSessionId: 1,
    loadRequestId: 1,
    trackKey: "netease:first",
  });

  expect(resolving).toMatchObject({
    phase: "resolving",
    playbackSessionId: 1,
    loadRequestId: 1,
    trackKey: "netease:first",
  });

  expect(reducePlaybackState(resolving, {
    type: "SOURCE_READY",
    playbackSessionId: 1,
    loadRequestId: 0,
  })).toEqual(resolving);
});

test("the current source reaches playing through loading", () => {
  const resolving = reducePlaybackState(createPlaybackState(), {
    type: "PLAY_TRACK",
    playbackSessionId: 4,
    loadRequestId: 9,
    trackKey: "qq:track",
  });
  const loading = reducePlaybackState(resolving, {
    type: "SOURCE_READY",
    playbackSessionId: 4,
    loadRequestId: 9,
  });
  const playing = reducePlaybackState(loading, {
    type: "MEDIA_PLAYING",
    playbackSessionId: 4,
  });

  expect(loading.phase).toBe("loading");
  expect(playing.phase).toBe("playing");
});

test("one recoverable media failure enters recovering and exhaustion enters failed", () => {
  const playing = {
    ...createPlaybackState(),
    phase: "playing" as const,
    playbackSessionId: 2,
    loadRequestId: 3,
    trackKey: "soda:track",
  };
  const recovering = reducePlaybackState(playing, {
    type: "MEDIA_FAILED",
    playbackSessionId: 2,
    recoverable: true,
    reason: "media-error",
  });
  const failed = reducePlaybackState(recovering, {
    type: "RECOVERY_EXHAUSTED",
    playbackSessionId: 2,
    reason: "media-error",
  });

  expect(recovering).toMatchObject({ phase: "recovering", recoveryAttempts: 1 });
  expect(failed).toMatchObject({ phase: "failed", failureReason: "media-error" });
});

test("switching sessions and STOP invalidate older events", () => {
  const first = reducePlaybackState(createPlaybackState(), {
    type: "PLAY_TRACK",
    playbackSessionId: 1,
    loadRequestId: 1,
    trackKey: "netease:first",
  });
  const second = reducePlaybackState(first, {
    type: "SWITCH_TRACK",
    playbackSessionId: 2,
    loadRequestId: 2,
    trackKey: "netease:second",
  });
  const stopped = reducePlaybackState(second, {
    type: "STOP",
    playbackSessionId: 3,
  });

  expect(reducePlaybackState(second, {
    type: "SOURCE_READY",
    playbackSessionId: 1,
    loadRequestId: 1,
  })).toEqual(second);
  expect(stopped).toMatchObject({ phase: "idle", playbackSessionId: 3, trackKey: "" });
});
```

- [x] **Step 2: Run the state-machine test and verify RED**

Run:

```powershell
bun test --parallel=1 apps/web/src/features/playback/playback-state-machine.test.ts
```

Expected: FAIL because `playback-state-machine.ts` does not exist.

- [x] **Step 3: Implement the minimal pure reducer**

Implement these exported types and functions:

```ts
export type PlaybackPhase =
  | "idle"
  | "resolving"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "recovering"
  | "failed";

export interface PlaybackMachineState {
  phase: PlaybackPhase;
  playbackSessionId: number;
  loadRequestId: number;
  trackKey: string;
  recoveryAttempts: number;
  failureReason: string | null;
}

export function createPlaybackState(): PlaybackMachineState {
  return {
    phase: "idle",
    playbackSessionId: 0,
    loadRequestId: 0,
    trackKey: "",
    recoveryAttempts: 0,
    failureReason: null,
  };
}
```

The reducer must accept `PLAY_TRACK`, `SWITCH_TRACK`, `BEGIN_RELOAD`, `SOURCE_READY`, `MEDIA_PLAYING`, `PAUSE`, `RESUME`, `MEDIA_ENDED`, `MEDIA_FAILED`, `RESOLVE_FAILED`, `RECOVERY_EXHAUSTED`, and `STOP`. Session-scoped events with a non-current `playbackSessionId`, and load-scoped events with a non-current `loadRequestId`, return the exact previous state object. A new session resets recovery count and failure reason. `BEGIN_RELOAD` preserves the current playback session, replaces only the load request, and uses `recovering` for `media-error` or `resolving` for URL/quality refresh.

- [x] **Step 4: Run the state-machine test and verify GREEN**

Run the command from Step 2. Expected: all state-machine tests pass.

- [x] **Step 5: Commit the state machine**

```powershell
git add apps/web/src/features/playback/playback-state-machine.ts apps/web/src/features/playback/playback-state-machine.test.ts
git commit -m "refactor(web): add playback session state machine"
```

### Task 2: Playback intent identity in the store

**Files:**
- Modify: `apps/web/src/stores/playback-store.ts`
- Modify: `apps/web/src/stores/playback-store.test.ts`

- [x] **Step 1: Write failing tests for replay and invalidation intents**

Add tests that reset the store, call `setCurrentTrack(track)` twice with the same object, and assert `playbackIntentId` increases twice. Also assert `playAt`, `next`, `previous`, `ended`, current-track removal, and `clearQueue` each advance the ID only when they produce a new playback or stop intent; queue-only mutations and volume changes must not advance it.

```ts
test("replaying the same track creates a new playback intent", () => {
  const track = makeTrack("same");
  const state = usePlaybackStore.getState();
  state.setCurrentTrack(track);
  const firstIntent = usePlaybackStore.getState().playbackIntentId;
  usePlaybackStore.getState().setCurrentTrack(track);
  expect(usePlaybackStore.getState().playbackIntentId).toBe(firstIntent + 1);
});
```

- [x] **Step 2: Run the store test and verify RED**

```powershell
bun test --parallel=1 apps/web/src/stores/playback-store.test.ts
```

Expected: FAIL because `playbackIntentId` is absent.

- [x] **Step 3: Add the monotonic intent counter**

Add `playbackIntentId: number` to `PlaybackState`, initialize it to `0`, and centralize incrementing through:

```ts
function nextPlaybackIntent(state: PlaybackState): number {
  return state.playbackIntentId + 1;
}
```

Every state update that applies `playbackPatchForTrack` or `stopPlaybackPatch` because of a user/queue playback decision must also write `playbackIntentId: nextPlaybackIntent(state)`. Do not increment it for `setPlaying`, `setPosition`, `setDuration`, volume/mute/mode, `setQueue`, `enqueue`, or moving a non-current queue item.

- [x] **Step 4: Run store tests and verify GREEN**

Run the command from Step 2. Expected: all playback-store tests pass.

- [x] **Step 5: Commit the intent boundary**

```powershell
git add apps/web/src/stores/playback-store.ts apps/web/src/stores/playback-store.test.ts
git commit -m "refactor(web): identify playback intents"
```

### Task 3: Compose state machine into the session coordinator

**Files:**
- Modify: `apps/web/src/features/playback/playback-session-coordinator.ts`
- Modify: `apps/web/src/features/playback/playback-session-coordinator.test.ts`

- [x] **Step 1: Write failing coordinator tests**

Add tests proving:

```ts
test("the same track starts a new session when the playback intent changes", () => {
  const coordinator = new PlaybackSessionCoordinator();
  const first = coordinator.beginTrack("netease:first", 1);
  const replay = coordinator.beginTrack("netease:first", 2);

  expect(first?.playbackSessionId).not.toBe(replay?.playbackSessionId);
  expect(coordinator.isPlaybackCurrent(first!.playbackToken)).toBe(false);
  expect(coordinator.snapshot().phase).toBe("resolving");
});

test("a stale load cannot mark the current source ready", () => {
  const coordinator = new PlaybackSessionCoordinator();
  const first = coordinator.beginTrack("netease:first", 1)!;
  const second = coordinator.beginTrack("netease:second", 2)!;

  coordinator.markLoaded(makeLoadedSource("netease:first"), first.playbackToken);
  expect(coordinator.snapshot()).toMatchObject({
    phase: "resolving",
    playbackSessionId: second.playbackSessionId,
    trackKey: "netease:second",
  });
});
```

Preserve every existing URL-age, long-pause, local/trial, and one-shot media recovery test.

- [x] **Step 2: Run coordinator tests and verify RED**

```powershell
bun test --parallel=1 apps/web/src/features/playback/playback-session-coordinator.test.ts
```

Expected: FAIL because `beginTrack` has no intent parameter/session ID, `markLoaded` has no load token, and `snapshot` is absent.

- [x] **Step 3: Integrate the reducer without changing policy values**

Keep current constants and public recovery methods. Add:

```ts
private state = createPlaybackState();
private playbackIntentId = 0;
private nextPlaybackSessionId = 0;

snapshot(): PlaybackMachineState {
  return this.state;
}
```

`beginTrack(trackKey, playbackIntentId)` returns `null` only when both track key and intent ID match the active request. A changed intent creates a new `playbackSessionId`, increments the existing playback/lyric tokens, clears loaded-source/pause/recovery fields, and dispatches `PLAY_TRACK` or `SWITCH_TRACK`. `beginReload(reason)` dispatches `BEGIN_RELOAD`; `markLoaded(source, playbackToken)` dispatches `SOURCE_READY` only for the current token; `markPlaying`, `markPaused`, `claimMediaErrorRecovery`, terminal failure, and `clear` dispatch their corresponding machine events.

- [x] **Step 4: Run machine and coordinator tests**

```powershell
bun test --parallel=1 apps/web/src/features/playback/playback-state-machine.test.ts apps/web/src/features/playback/playback-session-coordinator.test.ts
```

Expected: all tests pass.

- [x] **Step 5: Commit coordinator integration**

```powershell
git add apps/web/src/features/playback/playback-session-coordinator.ts apps/web/src/features/playback/playback-session-coordinator.test.ts
git commit -m "refactor(web): track explicit playback sessions"
```

### Task 4: Wire playback intent and lifecycle into the runtime

**Files:**
- Modify: `apps/web/src/features/playback/usePlaybackSessionRuntime.ts`
- Modify: `apps/web/src/features/playback/usePlaybackSessionRuntime.test.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `scripts/architecture/playback-session-boundary.test.ts`

- [x] **Step 1: Add the focused replay/stale integration test**

Render the runtime with a stable track object and `playbackIntentId=1`, resolve the first URL, rerender with the same track and `playbackIntentId=2`, then resolve the stale first request after the second request. Assert only the second URL reaches `controller.load`, and the second intent calls `play()` even though track identity did not change.

- [x] **Step 2: Run the runtime test and verify RED**

```powershell
bun test --parallel=1 apps/web/src/features/playback/usePlaybackSessionRuntime.test.tsx
```

Expected: the new test fails because the hook does not accept or depend on a playback intent ID.

- [x] **Step 3: Wire the new identifier and lifecycle transitions**

- Add `playbackIntentId: number` to `PlaybackSessionRuntimeOptions`.
- Pass it to `coordinator.beginTrack(key, playbackIntentId)` and include it in the current-track effect dependencies.
- Pass the active playback token to `markLoaded` so stale source results cannot move the machine to `loading`.
- Keep the existing `isPlaybackCurrent` and `isLyricCurrent` guards before every UI/audio commit.
- Keep `handleRuntimePlay` and `handleRuntimePause` stable while forwarding them to the coordinator.
- On terminal resolve/play failure, mark the current session failed before preserving the existing `setPlaying(false)`, error text, toast, and trial-banner behavior.
- Select `playbackIntentId` from `usePlaybackStore` in `App.tsx` and pass it to the hook. Make no other App composition changes.
- Extend the architecture test so `usePlaybackSessionRuntime.ts` must import `PlaybackSessionCoordinator`, and `playback-session-coordinator.ts` must import `playback-state-machine`; App must not import the machine directly.

- [x] **Step 4: Run focused Playback characterization**

```powershell
bun test --parallel=1 apps/web/src/features/playback apps/web/src/audio/player-controller.test.ts apps/web/src/stores/playback-store.test.ts apps/web/src/app/App.test.tsx scripts/architecture/playback-session-boundary.test.ts scripts/architecture/playback-runtime-boundary.test.ts scripts/architecture/playback-port-boundary.test.ts scripts/architecture/playback-ui-boundary.test.ts
```

Expected: all tests pass; existing proxy URL, trial, local file, lyrics fallback, quality, queue, and App behavior remain unchanged.

- [x] **Step 5: Commit runtime wiring**

```powershell
git add apps/web/src/features/playback/usePlaybackSessionRuntime.ts apps/web/src/features/playback/usePlaybackSessionRuntime.test.tsx apps/web/src/app/App.tsx scripts/architecture/playback-session-boundary.test.ts
git commit -m "refactor(web): route playback through session state"
```

### Task 5: Record evidence and run the frozen-line audit

**Files:**
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/parity/app-extraction-map.md`

- [x] **Step 1: Update parity evidence**

Record `playback.session-state` as M2 foundation: explicit phase/session/load ownership, same-track replay identity, stale source rejection, current one-shot recovery preserved. Leave `playback.gapless`, output routing, Audio Graph recovery, stalled probes, and crossfade as partial/missing.

- [x] **Step 2: Verify the API freeze diff is empty**

```powershell
git diff 2ba0be3 -- sidecars/api apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json packages/shared apps/web/src/api/sidecar-client.ts
```

Expected: no output.

- [x] **Step 3: Run full verification**

```powershell
bun run typecheck
bun test --parallel=1
bun run web:build
git diff --check
```

Then run the existing Rust gate because the branch is a cross-runtime convergence branch even though this slice does not modify Rust:

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

Expected: all commands exit `0`.

- [x] **Step 4: Commit documentation**

```powershell
git add docs/parity/capability-matrix.md docs/parity/app-extraction-map.md docs/superpowers/plans/2026-07-27-m2-playback-session-state-foundation.md
git commit -m "docs: plan M2 playback session foundation"
```

## Completion checkpoint

- Every actual playback/stop intent has a monotonic identity.
- Replaying the same track creates a fresh `playbackSessionId`.
- Current and stale load results are distinguished by the coordinator.
- The internal phase reaches `resolving → loading → playing`, supports paused/recovering/failed/ended/idle, and ignores stale events.
- Existing long-pause, URL-age, one-shot media-error recovery, proxy URL, lyrics, beatmap, local audio, trial, and visible error behavior remain unchanged.
- Bun sidecar, HTTP API, shared DTOs, media URLs, Tauri sidecar supervisor, and packaging remain untouched.
- This plan does not claim Audio owner commit parity, gapless, crossfade, stalled recovery, Audio Graph recovery, fades, or output routing.

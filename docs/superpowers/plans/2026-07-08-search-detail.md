# Full-Screen Search Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full-screen glass search result page with explicit song row actions for play, append queue, play next, like, and collect.

**Architecture:** Extend `useSearchStore` so compact search and full-screen search share committed keyword, mode, detail visibility, and recent queries. Add a focused `SearchDetailPage` component for the full-screen result experience, then wire it through `App` playback and queue callbacks. Keep existing `SearchShell` as the compact entry point.

**Tech Stack:** React, Zustand, Bun tests, existing SidecarClient search APIs, existing playback store.

---

## File Structure

- Modify `apps/web/src/stores/search-store.ts`: add search mode, detail visibility, recent queries, and actions.
- Modify `apps/web/src/components/shell/SearchShell.tsx`: use store-backed mode and open full-screen detail on committed search.
- Create `apps/web/src/components/shell/SearchDetailPage.tsx`: full-screen search results, podcast drill-in, row actions.
- Modify `apps/web/src/app/App.tsx`: render `SearchDetailPage` and provide queue/play callbacks.
- Modify `apps/web/src/styles.css`: add glass full-screen search detail styles.
- Modify/add tests under `apps/web/src/components/shell/` and `apps/web/src/app/App.test.tsx`.

## Task 1: Store And Compact Entry

**Files:**
- Modify: `apps/web/src/stores/search-store.ts`
- Modify: `apps/web/src/components/shell/SearchShell.tsx`
- Test: `apps/web/src/components/shell/SearchShell.test.ts`
- Test: `apps/web/src/components/shell/SearchShell.actions.test.tsx`

- [ ] **Step 1: Write failing store/entry tests**

Add tests that assert:

```ts
useSearchStore.getState().openDetail("晴天", "song");
expect(useSearchStore.getState().detailOpen).toBe(true);
expect(useSearchStore.getState().keyword).toBe("晴天");
expect(useSearchStore.getState().mode).toBe("song");
```

and:

```tsx
input.value = "晴天";
input.dispatchEvent(new window.Event("input", { bubbles: true }));
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
expect(useSearchStore.getState().detailOpen).toBe(true);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test apps/web/src/components/shell/SearchShell.test.ts apps/web/src/components/shell/SearchShell.actions.test.tsx`

Expected: failures because `detailOpen`, `mode`, and `openDetail` do not exist.

- [ ] **Step 3: Implement store and compact entry**

Add `SearchMode`, `detailOpen`, `mode`, `recentQueries`, `setMode`, `openDetail`, `closeDetail`, and `addRecentQuery` to `useSearchStore`. Update `SearchShell` to use store-backed mode instead of a local-only ref for committed mode, and make Enter call `openDetail(keyword, mode)`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `bun test apps/web/src/components/shell/SearchShell.test.ts apps/web/src/components/shell/SearchShell.actions.test.tsx`

Expected: all targeted tests pass.

## Task 2: Full-Screen Search Detail Component

**Files:**
- Create: `apps/web/src/components/shell/SearchDetailPage.tsx`
- Test: `apps/web/src/components/shell/SearchDetailPage.test.tsx`

- [ ] **Step 1: Write failing detail page tests**

Add tests that render the page with a fake client and assert:

```tsx
expect(container.querySelector("[data-search-detail]")).not.toBeNull();
expect(container.textContent).toContain("晴天");
expect(container.querySelector("[data-search-detail-play]")).not.toBeNull();
expect(container.querySelector("[data-search-detail-append]")).not.toBeNull();
expect(container.querySelector("[data-search-detail-next]")).not.toBeNull();
```

and action behavior:

```tsx
playButton.click();
appendButton.click();
nextButton.click();
expect(calls).toEqual(["play:0", "append:song-1", "next:song-1"]);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test apps/web/src/components/shell/SearchDetailPage.test.tsx`

Expected: fails because `SearchDetailPage` does not exist.

- [ ] **Step 3: Implement detail component**

Create a component that reads search store state, renders a full-screen page, performs searches with `SidecarClient.searchAll`, `SidecarClient.search`, `SidecarClient.podcastSearch`, and `SidecarClient.podcastHot`, and renders song rows with play, append, next, like, collect, provider, album, artist, and duration.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `bun test apps/web/src/components/shell/SearchDetailPage.test.tsx`

Expected: detail tests pass.

## Task 3: App Playback And Queue Wiring

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Test: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Write failing App tests**

Add tests that render `App`, open the search detail page from compact search, and assert:

```tsx
expect(host.querySelector("[data-search-detail]")).not.toBeNull();
```

For row actions, assert append queue does not start playback:

```tsx
appendButton.click();
expect(usePlaybackStore.getState().queue.map((track) => track.id)).toContain("song-1");
expect(usePlaybackStore.getState().currentTrack).toBeNull();
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test apps/web/src/app/App.test.tsx --test-name-pattern "search detail|Search detail"`

Expected: fails because `App` does not render the detail page or append queue callback.

- [ ] **Step 3: Wire App**

Render `SearchDetailPage` in `App`. Add callbacks:

- `playSearchDetailTracks(tracks, index)`: set queue to visible search results, play selected index, close detail, enter playback surface.
- `appendSearchResult(track)`: call `enqueue(track)` and show a toast without changing current track.
- existing `insertSearchResultNext`, `toggleLikeTrack`, and `openCollectPicker`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `bun test apps/web/src/app/App.test.tsx --test-name-pattern "search detail|Search detail"`

Expected: targeted App tests pass.

## Task 4: Styling And Full Verification

**Files:**
- Modify: `apps/web/src/styles.css`
- Test: existing search and Home/App tests

- [ ] **Step 1: Write failing CSS expectation**

Add test expectations for:

```ts
expect(css).toContain("[data-search-detail]");
expect(css).toContain(".search-detail-track");
expect(css).toContain(".search-detail-action");
```

- [ ] **Step 2: Run CSS-related tests to verify RED**

Run: `bun test apps/web/src/app/App.test.tsx --test-name-pattern "CSS|search detail"`

Expected: CSS expectation fails before styles exist.

- [ ] **Step 3: Implement styles**

Add a full-screen glass search detail page styled like playlist detail, with transparent table rows and compact icon/text action buttons. Keep text inside row action buttons from overflowing at 1440 x 1080.

- [ ] **Step 4: Run full verification**

Run:

```powershell
bun test apps/web/src/components/shell/SearchShell.test.ts apps/web/src/components/shell/SearchShell.actions.test.tsx apps/web/src/components/shell/SearchDetailPage.test.tsx
bun test apps/web/src/app/App.test.tsx --test-name-pattern "Home|search detail|Search detail|CSS|shouldUseCachedHomeDiscoverPlaylist"
bun run typecheck
```

Expected: all commands exit 0.

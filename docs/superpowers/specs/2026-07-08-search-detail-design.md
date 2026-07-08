# Search Detail Page And Search Optimization Design

## Context

Mineradio already has a compact search surface in `SearchShell`. It supports song search across providers, provider-specific modes for Netease and QQ, podcast search, debounced requests, stale request protection, virtualized long result lists, and inline actions such as like, collect, and next play.

The current search result UI is still a floating dropdown. That makes quick searches convenient, but it becomes cramped when users need to compare many songs, switch providers, inspect podcast programs, or perform repeated queue operations. The new Home playlist detail page established a full-screen glass page pattern that can also serve search.

## Goals

- Add a full-screen search result page.
- Keep the top search box as a lightweight entry point.
- Improve search result clarity with room for modes, provider context, result metadata, and error states.
- Add explicit row actions beside each song: play single, add to queue, play next, like, and collect.
- Preserve the existing quick search behavior where useful.
- Reuse current search APIs and playback callbacks before changing provider internals.
- Keep the visual language aligned with the Home playlist detail glass style.

## Non-Goals

- Do not redesign the entire player shell.
- Do not replace provider adapters.
- Do not add a new account or login flow.
- Do not build a single-track detail page in this phase.
- Do not remove compact search entirely; it remains the entry point.

## Proposed UX

The top search input remains visible as the main entry. Typing can still show lightweight feedback, but pressing Enter or choosing a committed search opens a full-screen search detail page.

The search detail page uses the same page-level glass rhythm as playlist detail:

- Back button at the top.
- Large search input in the page header.
- Mode chips for All, Netease, QQ, and Podcast.
- Optional provider/status chips showing partial failures or fallback status.
- Main result area with dense, transparent rows.
- Empty state with recent searches and starter suggestions.
- Loading state that does not erase stable previous context until the new request resolves.

Entry points that should open the full-screen page:

- Pressing Enter in the top search input.
- Clicking a search shortcut from Home.
- Clicking an artist in playlist detail.
- Clicking an artist from queue or search results.
- Opening podcast search from Home.

## Song Result Rows

Each song row should include:

- Cover.
- Title.
- Primary artist line.
- Album when available.
- Provider label.
- Playable state when restricted, unavailable, trial-only, or fallback.
- Duration when available.

Each song row should expose these actions:

- `播放单曲`: play this result immediately as the current single-item queue or current search queue selection.
- `加入播放队列`: append this track to the queue.
- `下一首播放`: insert this track after the current track.
- `红心`: toggle provider like when supported.
- `收藏到歌单`: open the existing collect picker.

Clicking the row body should be equivalent to `播放单曲`. Action buttons must stop propagation so they do not accidentally start playback.

Disabled/unplayable rows should keep metadata visible, disable playback actions, and keep collect/artist navigation available when sensible.

## Search Modes

### All

All mode should continue to call cross-source search. The first implementation renders one ranked `最佳匹配` list with provider labels on every row. It does not need separate provider sections yet because provider-specific modes already exist for Netease and QQ. If later user testing shows that mixed results are hard to compare, the page can add grouped provider sections without changing the core search contract.

### Netease And QQ

Provider-specific modes keep the current provider search behavior. They should use the same row layout so users can compare results without relearning the interface.

### Podcast

Podcast mode stays inside the full-screen search page:

- First level: podcast/radio results.
- Second level: program list for the selected podcast.
- Back within the page returns to the podcast list.
- Program rows support play single and next play. Queue append can be added if the queue model accepts podcast program tracks consistently.

## State Model

The existing `useSearchStore` should grow from a compact dropdown state into a shared search session state:

- `keyword`
- `mode`
- `results`
- `podcastResults`
- `podcastPrograms`
- `selectedPodcast`
- `loading`
- `error`
- `providerErrors`
- `selectedIndex`
- `recentQueries`
- `detailOpen`

The `SearchShell` can remain the compact controller, but the full-screen page should own the committed result display. Shared helpers should avoid duplicating request logic.

## Data Flow

1. User types in compact search.
2. Pressing Enter commits the query and opens search detail.
3. Search detail calls the existing `SidecarClient` search methods:
   - `searchAll(keyword, limit)` for All.
   - `search(provider, keyword, limit)` for Netease/QQ.
   - `podcastSearch` or `podcastHot` for Podcast.
4. Search detail stores results in `useSearchStore`.
5. Row actions route through existing App callbacks:
   - immediate play through the current playback path,
   - append queue through a new queue append callback if needed,
   - next play through existing insert-next behavior,
   - like through existing provider like logic,
   - collect through existing collect picker.
6. Playback exits or suppresses the search detail page according to the same pattern used by playlist detail.

## Queue Behavior

`下一首播放` can reuse the existing `insertQueueNext` path.

`加入播放队列` should append the track at the end of the current queue without changing playback. If no queue exists, it should create a queue containing that track and leave playback stopped. The UI should show a toast such as `已加入播放队列: <title>`.

`播放单曲` should start playback immediately by setting the queue to the current visible search result list and playing the selected index. This makes next/previous follow the search context.

## Error Handling

- Empty keyword should not call song search.
- Sidecar not ready should show an inline state and keep the page usable.
- Provider failures in All mode should not discard other provider results.
- Explicit provider mode failure should show the provider error and offer switching to All.
- Playback failures should keep the search page reachable and display the existing toast/error path.
- Stale requests must not overwrite newer committed searches.

## Styling Plan

- Use a full-screen `#empty-home`-style page container or a sibling detail container that shares the playlist detail glass treatment.
- Keep rows transparent, dense, and table-like rather than card-heavy.
- Use icon buttons for row actions, with tooltips/aria labels for clarity.
- Avoid nested cards and oversized copy.
- Keep the page responsive at 1440 x 1080 first, then collapse columns for narrower windows.

## Testing Plan

Frontend tests:

- Enter in compact search opens full-screen search detail.
- Search detail renders committed keyword, mode chips, and results.
- Row body plays the selected song.
- `播放单曲` starts playback without also firing other row actions.
- `加入播放队列` appends to queue without starting playback.
- `下一首播放` inserts after the current track.
- Artist click searches inside the full-screen search page.
- Provider mode switch reruns search and clears stale results.
- Empty state shows recent searches.
- Podcast mode drills into programs and back.

Backend/resolver tests:

- Keep existing cross-source resolver behavior.
- Add focused tests only if provider partial-error metadata is introduced.
- Add scoring tests when ranking rules are changed.

Manual verification:

- Open the app at 1440 x 1080.
- Search a common song such as `晴天`.
- Compare All, Netease, and QQ modes.
- Use play single, append queue, and next play on several rows.
- Search from playlist detail artist link and confirm the full-screen page opens.

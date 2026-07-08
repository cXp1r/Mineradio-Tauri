# Home Right Rail Scroll And Recommendations Design

## Context

The main Tauri window now opens at 1440 x 1080. On the Home screen, the right-side "你的歌单与推荐" rail still renders a fixed set of five tiles in a horizontal row. At taller window sizes those cards visually stretch into the extra space instead of offering more music to explore.

The current data path is already centered on `GET /discover/home`:

- `sidecars/api/src/services/discover-home.ts` builds the Home payload.
- `packages/shared/src/discover.ts` defines the response shape.
- `apps/web/src/home/EmptyHomeHost.tsx` renders the Home cards and rail.
- `apps/web/src/styles.css` fixes the current rail to five grid columns.

Today, logged-out Home responses intentionally return an empty starter envelope. Logged-in responses prefer Netease recommendation data when available, then fall back to provider playlists and playlist tracks.

## Goals

- Keep the left construction hero fixed while the right Home content can scroll vertically.
- Replace the fixed five-tile rail with a richer exploratory feed of playlists and recommendations.
- Show public recommendation playlists when the user is logged out.
- When logged in, combine personalized Netease recommendations with user playlists from Netease, QQ, and Soda.
- Preserve existing tile click behavior for songs, playlists, podcasts, weather songs, and starter actions.
- Avoid broad visual refactors outside the Home rail.

## Non-Goals

- Do not redesign the left construction hero.
- Do not change the main left playlist panel or 3D shelf behavior beyond sharing the richer playlist data.
- Do not add new provider account flows.
- Do not require login before showing public recommendation playlists.

## Proposed Architecture

### Backend Discover Aggregation

`buildDiscoverHome` remains the single source for Home recommendation data.

Logged-out behavior changes from "empty starter only" to "starter mode plus public recommendations." It should call the existing Netease public recommendation source, `personalized`, without a cookie. If public recommendations fail or return no valid playlists, the response stays usable with empty playlist data and starter actions on the client.

Logged-in behavior keeps Netease personalization as the first priority, but no longer discards adapter playlists when Netease recommendations are present. It should merge:

- Netease private recommendation playlists from `recommendResource`
- Netease public recommendation playlists from `personalized`
- User playlists from each logged-in provider via `playlistList`
- Daily songs from Netease `recommendSongs` when available
- Existing fallbacks from first playlist tracks and provider search
- Existing podcast fallback via `podcast.hot`

Playlist merging should dedupe by `provider:id`, keep personalized Netease items before public items, then append user provider playlists in provider order.

### Shared Contract

The existing `DiscoverHomeResponse` shape is sufficient. Logged-out public recommendations can be represented as:

- `loggedIn: false`
- `mode: "starter"`
- `playlists: PlaylistSummary[]`
- `dailySongs: []`
- `podcasts: []` or fallback podcasts if already available later

No schema change is required.

### Frontend Home Rail

`EmptyHomeHost` should build a larger tile list instead of slicing the rail to five. The first rows should favor songs and personalized content, then include playlists and podcasts.

The rail layout becomes:

- Left construction hero remains fixed in the left grid column.
- Right column becomes a contained scroll region.
- The rail header stays at the top of the right column.
- Tiles render in a vertical grid with fixed minimum card dimensions and responsive column counts.
- At 1440 x 1080, the user should see the first rows and scroll down for more playlists.

For logged-out users:

- If public recommendation playlists exist, the rail title can remain "推荐歌单与开始探索".
- Public playlist tiles should open through existing `onOpenPlaylist(index)`.
- Starter tiles remain available below recommendation tiles so login, search, import, podcast search, and visual guide actions are not lost.

For logged-in users:

- The rail title remains "你的歌单与推荐".
- Personalized Netease items appear first.
- User playlists from Netease, QQ, and Soda appear after personalized recommendations.

## Data Flow

1. `App` loads `/discover/home` as it does today.
2. The sidecar checks login status for Netease, QQ, and Soda.
3. If no providers are logged in, it fetches public Netease playlist recommendations and returns them in `playlists`.
4. If any provider is logged in, it fetches Netease personalized data when possible and provider playlist lists for logged-in providers.
5. `EmptyHomeHost` converts the richer `discover.playlists`, `discover.dailySongs`, `discover.podcasts`, weather songs, listen history, and starter actions into one rail feed.
6. Tile clicks continue to call existing callbacks by tile type.

## Error Handling

- Public recommendation failures should not fail `/discover/home`; return starter mode with empty recommendation arrays.
- Provider playlist failures should be isolated per provider.
- Invalid or duplicate playlists should be filtered before returning.
- If logged-in daily songs are unavailable, existing playlist-detail and search fallbacks should still produce songs when possible.
- Frontend loading skeletons remain only for tiles without cover art while Home data is loading.

## Styling Plan

- Change `.home-rail` into a scroll-contained panel with `overflow-y: auto` and `min-height: 0`.
- Change `.home-tile-row` from `repeat(5, 1fr)` to an auto-fit or fixed responsive grid suitable for vertical scrolling.
- Give `.home-tile` stable height constraints so tiles do not stretch with the rail.
- Add subtle scrollbar styling that matches the existing dark glass UI.
- Keep mobile behavior as full-page scroll when the layout collapses to one column.

## Testing Plan

- Update `sidecars/api/src/server.test.ts`:
  - logged-out `/discover/home` returns public recommendation playlists when `personalized` succeeds.
  - logged-out failures still return starter mode safely.
  - logged-in responses merge Netease recommendations and provider playlists instead of choosing only one source.
- Update `apps/web/src/home/EmptyHomeHost.test.tsx`:
  - more than five playlist tiles render into the rail.
  - logged-out public recommendations appear before starter actions.
  - playlist tiles keep routing through `onOpenPlaylist(index)`.
- Update CSS assertions where useful:
  - rail has vertical overflow.
  - tile grid no longer uses a fixed five-column-only row.
- Run focused tests first, then `bun run typecheck` and the existing full `bun test packages/shared packages/visual-engine sidecars/api apps/web`.

## Open Decisions

- Keep the existing `DiscoverHomeResponse` schema for this iteration.
- Use Netease public recommendations as the first logged-out public source.
- Do not add a visible "load more" button yet; the rail should scroll through the fetched Home payload.

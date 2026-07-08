# Home Right Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Home right rail a vertically scrollable recommendation feed, with logged-out public playlist recommendations and logged-in personalized plus multi-provider user playlists.

**Architecture:** Keep `/discover/home` as the Home data source and enrich its playlist aggregation. Keep `EmptyHomeHost` as the renderer, but change its tile builder from a fixed five-card row to a larger feed that can scroll inside the right column while the left construction hero stays fixed.

**Tech Stack:** Bun test runner, React, TypeScript, Tauri sidecar route handler, shared Zod schemas, CSS grid.

---

## File Structure

- Modify `sidecars/api/src/server.test.ts`: route-level regression tests for logged-out public recommendations and logged-in playlist merging.
- Modify `sidecars/api/src/services/discover-home.ts`: public recommendation loading, logged-in playlist merging, dedupe helpers, and larger playlist caps.
- Modify `apps/web/src/home/EmptyHomeHost.test.tsx`: rendering and click-routing tests for more than five rail tiles and logged-out public recommendations before starter actions.
- Modify `apps/web/src/home/EmptyHomeHost.tsx`: tile model and `buildHomeTiles` logic so the rail feed can include songs, playlists, podcasts, weather songs, and starter actions without slicing to five.
- Modify `apps/web/src/styles.css`: right rail internal vertical scroll and stable tile grid sizing.

---

### Task 1: Backend Discover Tests

**Files:**
- Modify: `sidecars/api/src/server.test.ts`

- [ ] **Step 1: Replace the logged-out starter test with public recommendation coverage**

In `sidecars/api/src/server.test.ts`, replace the existing test named `GET /discover/home returns the logged-out starter envelope` with:

```ts
test("GET /discover/home returns logged-out public playlist recommendations when available", async () => {
  const calls: string[] = [];
  const handler = createRouteHandler({
    providerAdapters: {
      ...providers,
      netease: {
        ...providers.netease,
        async loginStatus() {
          return { provider: "netease", loggedIn: false };
        }
      },
      qq: {
        ...providers.qq,
        async loginStatus() {
          return { provider: "qq", loggedIn: false };
        }
      },
      soda: {
        ...providers.soda,
        async loginStatus() {
          return { provider: "soda", loggedIn: false };
        }
      }
    },
    discoverRequester: {
      async personalized(params) {
        calls.push(`personalized:${"cookie" in params ? "cookie" : "public"}`);
        return {
          body: {
            result: [{
              id: 7001,
              name: "公开推荐歌单",
              picUrl: "https://img.example/public.jpg",
              trackCount: 24
            }]
          }
        };
      },
      async djHot() {
        calls.push("dj_hot");
        return { body: { djRadios: [] } };
      },
      async recommendResource() {
        calls.push("recommend_resource");
        return { body: { recommend: [] } };
      },
      async recommendSongs() {
        calls.push("recommend_songs");
        return { body: { data: { dailySongs: [] } } };
      }
    },
    now: () => 1782656256000
  });

  const r = await handler(new Request("http://127.0.0.1/discover/home"));
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b).toEqual({
    ok: true,
    data: {
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [{
        provider: "netease",
        id: "7001",
        name: "公开推荐歌单",
        coverUrl: "https://img.example/public.jpg",
        trackCount: 24,
        trackIds: [],
        subscribed: false
      }],
      podcasts: [],
      mode: "starter",
      updatedAt: 1782656256000
    }
  });
  expect(calls).toEqual(["personalized:public"]);
});
```

- [ ] **Step 2: Add a logged-out failure fallback test**

Immediately after the public recommendation test, add:

```ts
test("GET /discover/home keeps starter mode when logged-out public recommendations fail", async () => {
  const handler = createRouteHandler({
    providerAdapters: {
      ...providers,
      netease: {
        ...providers.netease,
        async loginStatus() {
          return { provider: "netease", loggedIn: false };
        }
      },
      qq: {
        ...providers.qq,
        async loginStatus() {
          return { provider: "qq", loggedIn: false };
        }
      },
      soda: {
        ...providers.soda,
        async loginStatus() {
          return { provider: "soda", loggedIn: false };
        }
      }
    },
    discoverRequester: {
      async personalized() {
        throw new Error("public recommendation unavailable");
      },
      async djHot() {
        return { body: { djRadios: [] } };
      },
      async recommendResource() {
        return { body: { recommend: [] } };
      },
      async recommendSongs() {
        return { body: { data: { dailySongs: [] } } };
      }
    },
    now: () => 1782656256000
  });

  const r = await handler(new Request("http://127.0.0.1/discover/home"));
  expect(r.status).toBe(200);
  const b = await body(r);
  expect(b).toEqual({
    ok: true,
    data: {
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [],
      podcasts: [],
      mode: "starter",
      updatedAt: 1782656256000
    }
  });
});
```

- [ ] **Step 3: Add logged-in merge assertions to the Netease recommendation test**

In the test named `GET /discover/home uses the baseline Netease recommendation sources`, change the fake Netease adapter and add a logged-in QQ adapter:

```ts
netease: {
  ...providers.netease,
  async loginStatus() {
    return { provider: "netease", loggedIn: true, nickname: "tester", userId: "42" };
  },
  async playlistList() {
    calls.push("netease:list");
    return [{
      provider: "netease",
      id: "mine-1",
      name: "网易用户歌单",
      coverUrl: "https://img.example/mine.jpg",
      trackCount: 18,
      trackIds: [],
      subscribed: false
    }];
  },
  async search() {
    calls.push("adapter:search");
    return [];
  }
},
qq: {
  ...providers.qq,
  async loginStatus() {
    return { provider: "qq", loggedIn: true, nickname: "qq user", userId: "qq-42" };
  },
  async playlistList() {
    calls.push("qq:list");
    return [{
      provider: "qq",
      id: "qq-mine-1",
      name: "QQ 用户歌单",
      coverUrl: "https://img.example/qq.jpg",
      trackCount: 11,
      trackIds: [],
      subscribed: false
    }];
  }
}
```

Then change the playlist assertion in that test to:

```ts
expect(b.data.playlists.map((playlist: { provider: string; name: string }) => `${playlist.provider}:${playlist.name}`)).toEqual([
  "netease:私人推荐歌单",
  "netease:公开推荐歌单",
  "netease:网易用户歌单",
  "qq:QQ 用户歌单"
]);
expect(calls).toEqual([
  "personalized",
  "dj_hot",
  "recommend_resource",
  "recommend_songs",
  "netease:list",
  "qq:list"
]);
```

- [ ] **Step 4: Run backend tests and verify expected failures**

Run:

```powershell
bun test sidecars/api/src/server.test.ts
```

Expected before implementation: failures in the new logged-out public recommendation test and the logged-in merge assertion, because the current implementation returns empty logged-out playlists and skips adapter playlists when Netease recommendations exist.

---

### Task 2: Backend Discover Implementation

**Files:**
- Modify: `sidecars/api/src/services/discover-home.ts`
- Test: `sidecars/api/src/server.test.ts`

- [ ] **Step 1: Add playlist cap constants near `PROVIDER_ORDER`**

Add these constants under `const PROVIDER_ORDER: ProviderId[] = ["netease", "qq", "soda"];`:

```ts
const HOME_PLAYLIST_LIMIT = 24;
const NETEASE_PRIVATE_PLAYLIST_LIMIT = 8;
const NETEASE_PUBLIC_PLAYLIST_LIMIT = 12;
```

- [ ] **Step 2: Change logged-out branch to load public recommendations**

Replace the current `if (!logged) { ... }` branch in `buildDiscoverHome` with:

```ts
  if (!logged) {
    const publicPlaylists = await loadLoggedOutPublicPlaylists(options.discoverRequester, now);
    return DiscoverHomeResponseSchema.parse({
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: publicPlaylists,
      podcasts: [],
      mode: "starter",
      updatedAt: now()
    });
  }
```

- [ ] **Step 3: Merge Netease discover playlists with adapter playlists**

Replace the existing logged-in playlist aggregation block:

```ts
  const adapterPlaylists = neteaseDiscover.playlists.length
    ? []
    : await loadAdapterPlaylists(options.providerAdapters, loggedProviders);
  const playlists = (neteaseDiscover.playlists.length ? neteaseDiscover.playlists : adapterPlaylists)
    .filter((playlist) => playlist.id && playlist.name)
    .slice(0, 10);
```

with:

```ts
  const adapterPlaylists = await loadAdapterPlaylists(options.providerAdapters, loggedProviders);
  const playlists = mergePlaylists(neteaseDiscover.playlists, adapterPlaylists)
    .slice(0, HOME_PLAYLIST_LIMIT);
```

- [ ] **Step 4: Add logged-out public playlist loader**

Place this function above `loadNeteaseDiscover`:

```ts
async function loadLoggedOutPublicPlaylists(
  requester: DiscoverRequester | undefined,
  now: () => number
): Promise<PlaylistSummary[]> {
  try {
    const api = requester ?? defaultDiscoverRequester();
    const result = await api.personalized({ timestamp: now(), limit: NETEASE_PUBLIC_PLAYLIST_LIMIT });
    return resultBody({ status: "fulfilled", value: result })
      .map((body) => arrayOf(body.result ?? body.data)
        .map((playlist) => mapDiscoverPlaylist(playlist))
        .filter(isValidPlaylist)
        .slice(0, NETEASE_PUBLIC_PLAYLIST_LIMIT))
      .unwrapOr([]);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Adjust Netease recommendation limits**

In `loadNeteaseDiscover`, change the `Promise.allSettled` calls to:

```ts
  const results = await Promise.allSettled([
    api.personalized({ ...baseParams, limit: NETEASE_PUBLIC_PLAYLIST_LIMIT }),
    api.djHot({ ...baseParams, limit: 6, offset: 0 }),
    api.recommendResource(baseParams),
    api.recommendSongs(baseParams)
  ]);
```

Then change the public and private playlist slicing to:

```ts
      .slice(0, NETEASE_PUBLIC_PLAYLIST_LIMIT))
```

and:

```ts
      .slice(0, NETEASE_PRIVATE_PLAYLIST_LIMIT))
```

Finally change the returned playlist cap to:

```ts
    playlists: mergePlaylists(privatePlaylists, publicPlaylists).slice(0, HOME_PLAYLIST_LIMIT),
```

- [ ] **Step 6: Update adapter playlist cap**

In `loadAdapterPlaylists`, change:

```ts
    .filter((playlist) => playlist.id && playlist.name)
    .slice(0, 10);
```

to:

```ts
    .filter(isValidPlaylist)
    .slice(0, HOME_PLAYLIST_LIMIT);
```

- [ ] **Step 7: Add playlist validation and dedupe helpers**

Place these helpers near the other helper functions:

```ts
function isValidPlaylist(playlist: PlaylistSummary): boolean {
  return !!(playlist.id && playlist.name);
}

function mergePlaylists(...groups: PlaylistSummary[][]): PlaylistSummary[] {
  const seen = new Set<string>();
  const merged: PlaylistSummary[] = [];
  for (const playlist of groups.flat()) {
    if (!isValidPlaylist(playlist)) continue;
    const key = `${playlist.provider}:${playlist.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(playlist);
  }
  return merged;
}
```

- [ ] **Step 8: Run backend tests and verify pass**

Run:

```powershell
bun test sidecars/api/src/server.test.ts
```

Expected after implementation: all `server.test.ts` tests pass.

- [ ] **Step 9: Commit backend changes**

Run:

```powershell
git add sidecars/api/src/server.test.ts sidecars/api/src/services/discover-home.ts
git commit -m "feat: enrich home discover playlists"
```

Expected: one commit containing only backend discover tests and implementation.

---

### Task 3: Frontend Rail Tile Tests

**Files:**
- Modify: `apps/web/src/home/EmptyHomeHost.test.tsx`

- [ ] **Step 1: Add a test for rendering more than five playlist tiles**

Add this test after `EmptyHomeHost renders discover songs, playlists, and podcasts into baseline cards and rail`:

```tsx
test("EmptyHomeHost renders more than five playlist rail tiles without dropping later playlists", () => {
  const playlists = Array.from({ length: 8 }, (_, index) => ({
    provider: index % 2 ? "qq" as const : "netease" as const,
    id: `p${index + 1}`,
    name: `探索歌单 ${index + 1}`,
    coverUrl: `https://img.example/p${index + 1}.jpg`,
    trackCount: 10 + index,
    trackIds: [],
    subscribed: false,
  }));
  const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
    discover: {
      loggedIn: true,
      user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
      mode: "member",
      dailySongs: [],
      playlists,
      podcasts: [],
      updatedAt: 1782656256000,
    },
  }));

  expect(html).toContain("探索歌单 1");
  expect(html).toContain("探索歌单 6");
  expect(html).toContain("探索歌单 8");
  expect((html.match(/class="home-tile/g) ?? []).length).toBeGreaterThan(5);
});
```

- [ ] **Step 2: Add a test for logged-out public recommendations before starter actions**

Add this test after `EmptyHomeHost renders baseline logged-out starter tiles`:

```tsx
test("EmptyHomeHost puts logged-out public recommendation playlists before starter actions", () => {
  const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
    discover: {
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [
        { provider: "netease", id: "pub-1", name: "公开推荐一", coverUrl: "https://img.example/pub1.jpg", trackCount: 30, trackIds: [], subscribed: false },
        { provider: "netease", id: "pub-2", name: "公开推荐二", coverUrl: "https://img.example/pub2.jpg", trackCount: 18, trackIds: [], subscribed: false },
      ],
      podcasts: [],
      mode: "starter",
      updatedAt: 1782656256000,
    },
  }));

  expect(html).toContain('id="home-rail-title">推荐歌单与开始探索');
  expect(html.indexOf("公开推荐一")).toBeGreaterThan(-1);
  expect(html.indexOf("登录同步歌单")).toBeGreaterThan(-1);
  expect(html.indexOf("公开推荐一")).toBeLessThan(html.indexOf("登录同步歌单"));
});
```

- [ ] **Step 3: Add a routing test for public playlist tiles**

Add this test near the other click-routing tests:

```tsx
test("EmptyHomeHost routes logged-out public playlist tiles through playlist callback indexes", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const calls: number[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  flushSync(() => root.render(<EmptyHomeHost
    discover={{
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [
        { provider: "netease", id: "pub-1", name: "公开推荐一", coverUrl: "", trackCount: 30, trackIds: [], subscribed: false },
        { provider: "netease", id: "pub-2", name: "公开推荐二", coverUrl: "", trackCount: 18, trackIds: [], subscribed: false },
      ],
      podcasts: [],
      mode: "starter",
      updatedAt: 1,
    }}
    onOpenPlaylist={(index) => calls.push(index)}
  />));
  const playlistTiles = Array.from(host.querySelectorAll(".home-tile"))
    .filter((tile) => tile.textContent?.includes("公开推荐"));
  (playlistTiles[1] as HTMLButtonElement).click();

  expect(calls).toEqual([1]);
  root.unmount();
  host.remove();
});
```

- [ ] **Step 4: Add CSS contract assertions**

In `Home CSS keeps cover pseudo-elements without the extra bottom mask`, add these assertions:

```ts
expect(css).toContain("overflow-y: auto");
expect(css).toContain("grid-template-columns: repeat(auto-fill, minmax(132px, 1fr))");
expect(css).not.toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");
```

- [ ] **Step 5: Run frontend Home tests and verify expected failures**

Run:

```powershell
bun test apps/web/src/home/EmptyHomeHost.test.tsx
```

Expected before implementation: failures because `buildHomeTiles` slices to five tiles, the logged-out rail title remains "先从这里开始", public playlists are not placed before starter actions, and CSS still uses the fixed five-column row.

---

### Task 4: Frontend Rail Tile Implementation

**Files:**
- Modify: `apps/web/src/home/EmptyHomeHost.tsx`
- Test: `apps/web/src/home/EmptyHomeHost.test.tsx`

- [ ] **Step 1: Add rail feed constants**

Near `const HOME_WAVE_BAR_COUNT = 24;`, add:

```ts
const HOME_RAIL_MAX_TILES = 32;
const HOME_RAIL_PRIMARY_SONG_COUNT = 4;
```

- [ ] **Step 2: Add starter tile type alias**

Below `const STARTER_TILES = [...] as const;`, add:

```ts
type StarterTile = (typeof STARTER_TILES)[number];
```

Then change the start of `type HomeTile =` from:

```ts
type HomeTile =
  | (typeof STARTER_TILES)[number]
```

to:

```ts
type HomeTile =
  | StarterTile
```

- [ ] **Step 3: Add tile push helper**

Place this helper above `buildHomeTiles`:

```ts
function pushTile(tiles: HomeTile[], tile: HomeTile, max = HOME_RAIL_MAX_TILES): void {
  if (tiles.length < max) tiles.push(tile);
}
```

- [ ] **Step 4: Replace `buildHomeTiles` with an uncapped feed builder**

Replace the whole `buildHomeTiles` function with:

```ts
function buildHomeTiles(
  discover: DiscoverHomeResponse | null | undefined,
  weatherRadio: WeatherRadioResponse | null | undefined,
  listenSummary: HomeListenSummary | null | undefined,
): HomeTile[] {
  const weatherSongs = weatherRadio?.radio.songs ?? [];
  const playlists = discover?.playlists ?? [];
  const podcasts = discover?.podcasts ?? [];
  const tiles: HomeTile[] = [];

  if (listenSummary?.recent?.track) {
    const recent = listenSummary.recent;
    pushTile(tiles, {
      kind: "recent",
      tone: "search",
      title: recent.track.title || "继续听",
      sub: artistLine(recent.track, "最近播放"),
      action: "Play",
      record: recent,
      coverUrl: recent.track.coverUrl,
    });
  }

  if (listenSummary?.topArtist?.name) {
    pushTile(tiles, {
      kind: "profile",
      tone: "local",
      title: listenSummary.topArtist.name,
      sub: `常听歌手 · ${listenSummary.topArtist.plays} 次`,
      action: "Search",
      query: listenSummary.topArtist.name,
      coverUrl: listenSummary.topArtist.coverUrl,
    });
  }

  if (!discover?.loggedIn) {
    playlists.forEach((playlist, index) => pushTile(tiles, {
      kind: "playlist",
      tone: "playlist",
      title: playlist.name || "推荐歌单",
      sub: playlist.trackCount ? `${playlist.trackCount} 首 · 公开推荐` : "公开推荐",
      action: "Open",
      index,
      coverUrl: playlist.coverUrl,
    }));
    weatherSongs.forEach((song, index) => pushTile(tiles, {
      kind: "weatherSong",
      tone: "daily",
      title: song.title || "天气电台歌曲",
      sub: artistLine(song, "天气电台"),
      action: "Play",
      index,
      coverUrl: song.coverUrl,
    }));
    STARTER_TILES.forEach((tile) => pushTile(tiles, tile));
    return tiles.length ? tiles.slice(0, HOME_RAIL_MAX_TILES) : [...STARTER_TILES];
  }

  discover.dailySongs.slice(0, HOME_RAIL_PRIMARY_SONG_COUNT).forEach((song, index) => {
    pushTile(tiles, {
      kind: "song",
      tone: index % 2 ? "search" : "daily",
      title: song.title || "今日歌曲",
      sub: artistLine(song, "今日歌曲"),
      action: "Play",
      index,
      coverUrl: song.coverUrl,
    });
  });

  playlists.forEach((playlist, index) => {
    pushTile(tiles, {
      kind: "playlist",
      tone: "playlist",
      title: playlist.name || "推荐歌单",
      sub: playlist.trackCount ? `${playlist.trackCount} 首` : "Playlist",
      action: "Open",
      index,
      coverUrl: playlist.coverUrl,
    });
  });

  podcasts.forEach((podcast, index) => {
    pushTile(tiles, {
      kind: "podcast",
      tone: "podcast",
      title: podcast.name || "热门播客",
      sub: podcastSub(podcast),
      action: "Podcast",
      index,
      coverUrl: podcast.coverUrl,
    });
  });

  weatherSongs.forEach((song, index) => {
    pushTile(tiles, {
      kind: "weatherSong",
      tone: "daily",
      title: song.title || "天气电台歌曲",
      sub: artistLine(song, "天气电台"),
      action: "Play",
      index,
      coverUrl: song.coverUrl,
    });
  });

  return tiles.length ? tiles.slice(0, HOME_RAIL_MAX_TILES) : [...STARTER_TILES];
}
```

- [ ] **Step 5: Update rail title and note**

Inside `EmptyHomeHost`, after `const loading = props.loading === true;`, add:

```ts
  const hasPublicRecommendations = loggedOut && (discover?.playlists.length ?? 0) > 0;
```

Then replace the rail title and note JSX:

```tsx
<div className="home-section-title" id="home-rail-title">{loggedOut ? "先从这里开始" : "你的歌单与推荐"}</div>
<div className="home-section-note" id="home-rail-note">{loggedOut && !hasWeatherSongs ? "不会自动拉取外部推荐" : "刚刚更新 · 点击即可播放"}</div>
```

with:

```tsx
<div className="home-section-title" id="home-rail-title">{loggedOut ? (hasPublicRecommendations ? "推荐歌单与开始探索" : "先从这里开始") : "你的歌单与推荐"}</div>
<div className="home-section-note" id="home-rail-note">{loggedOut && !hasWeatherSongs && !hasPublicRecommendations ? "正在等待推荐源" : "刚刚更新 · 点击即可播放"}</div>
```

- [ ] **Step 6: Run frontend Home tests and verify pass**

Run:

```powershell
bun test apps/web/src/home/EmptyHomeHost.test.tsx
```

Expected after implementation: all `EmptyHomeHost.test.tsx` tests pass except CSS assertions, which pass after Task 5.

---

### Task 5: Right Rail Scroll Styling

**Files:**
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/home/EmptyHomeHost.test.tsx`
- Test: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Update rail container CSS**

Replace the `.home-rail` block with:

```css
.home-rail {
  align-self: stretch;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  overflow: hidden;
}
```

- [ ] **Step 2: Update tile row CSS for vertical scrolling**

Replace the `.home-tile-row` block with:

```css
.home-tile-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  grid-auto-rows: minmax(166px, auto);
  align-content: start;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 6px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, .22) transparent;
}

.home-tile-row::-webkit-scrollbar {
  width: 8px;
}

.home-tile-row::-webkit-scrollbar-track {
  background: transparent;
}

.home-tile-row::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(255, 255, 255, .18);
}
```

- [ ] **Step 3: Stabilize tile height**

In `.home-tile`, replace:

```css
  min-height: 166px;
```

with:

```css
  min-height: 166px;
  height: 166px;
```

- [ ] **Step 4: Update desktop compact overrides**

In `body.desktop-shell .home-tile`, add `height: 154px;` under `min-height: 154px;`.

In `@media (max-height: 760px) body.desktop-shell .home-tile`, add `height: 130px;` under `min-height: 130px;`.

In `@media (max-width: 1120px) body.desktop-shell .home-tile`, add `height: 120px;` under `min-height: 120px;`.

In `@media (max-height: 700px) body.desktop-shell .home-tile`, add `height: 104px;` under `min-height: 104px;`.

- [ ] **Step 5: Keep collapsed mobile layout page-scroll based**

Inside both `@media (max-width: 760px)` blocks that define `.home-tile-row`, add:

```css
    overflow-y: visible;
    padding-right: 0;
```

- [ ] **Step 6: Run CSS-related tests**

Run:

```powershell
bun test apps/web/src/home/EmptyHomeHost.test.tsx apps/web/src/app/App.test.tsx
```

Expected after implementation: both files pass. If `App.test.tsx` has a timing timeout but the failing file passes when run alone, rerun the focused failing file once before changing code.

- [ ] **Step 7: Commit frontend changes**

Run:

```powershell
git add apps/web/src/home/EmptyHomeHost.test.tsx apps/web/src/home/EmptyHomeHost.tsx apps/web/src/styles.css
git commit -m "feat: make home rail scrollable"
```

Expected: one commit containing only Home rail rendering tests, implementation, and CSS.

---

### Task 6: Full Verification

**Files:**
- No code edits unless verification exposes a real regression.

- [ ] **Step 1: Run typecheck**

Run:

```powershell
bun run typecheck
```

Expected: all package typechecks exit with code 0.

- [ ] **Step 2: Run full test suite**

Run:

```powershell
bun test packages/shared packages/visual-engine sidecars/api apps/web
```

Expected: `0 fail`. If the App suite times out during full parallel execution, rerun the specific failing file once:

```powershell
bun test apps/web/src/app/App.test.tsx
```

Treat a repeated failure as a real regression and fix it before completing.

- [ ] **Step 3: Inspect final diff and status**

Run:

```powershell
git status --short --branch
git log --oneline -5
```

Expected: branch is `codex/frontend-style-refresh`; either clean after task commits or only contains deliberate uncommitted verification notes.

- [ ] **Step 4: Final commit if verification required code changes**

If verification required any code edits, commit them:

```powershell
git add sidecars/api/src/server.test.ts sidecars/api/src/services/discover-home.ts apps/web/src/home/EmptyHomeHost.test.tsx apps/web/src/home/EmptyHomeHost.tsx apps/web/src/styles.css
git commit -m "fix: stabilize home rail recommendations"
```

Expected: no uncommitted implementation changes remain.

---

## Self-Review

- Spec coverage: backend public logged-out recommendations are covered by Task 1 and Task 2; logged-in personalized plus multi-provider playlists are covered by Task 1 and Task 2; right-side-only scrolling is covered by Task 3, Task 4, and Task 5; verification is covered by Task 6.
- Placeholder scan: the plan contains concrete paths, code snippets, commands, and expected outcomes.
- Type consistency: `DiscoverHomeResponse`, `PlaylistSummary`, `ProviderId`, `HomeTile`, and existing `onOpenPlaylist(index)` callback names match the current codebase.

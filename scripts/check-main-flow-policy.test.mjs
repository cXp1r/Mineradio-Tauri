import { describe, expect, test } from "bun:test";

import {
  evaluateMainFlowPolicy,
  extractMainFlowPolicy,
  checkMainFlowPolicy,
} from "./check-main-flow-policy.mjs";

const goodPolicy = extractMainFlowPolicy({
  rootPackage: {
    scripts: {
      start: "bun run tauri:dev",
      dev: "bun run tauri:dev",
      build: "bun run tauri:build",
      "main-flow-policy:check": "node scripts/check-main-flow-policy.mjs",
    },
  },
  tauriConfig: {
    build: {
      beforeBuildCommand: "bun run --filter @mineradio/web build && bun run --filter @mineradio/desktop build:sidecar",
      frontendDist: "../../web/dist",
    },
    bundle: {
      externalBin: ["binaries/mineradio-sidecar-api"],
    },
  },
  rustLib: [
    "build_and_start_sidecar(",
    "commands::get_runtime_config",
    "commands::get_sidecar_status",
    "commands::configure_global_hotkeys",
    "commands::get_updater_status",
    "commands::check_for_update",
    "commands::window_minimize",
    "commands::window_toggle_maximize",
    "commands::window_toggle_fullscreen",
    "commands::open_external",
    "commands::export_json_file",
    "commands::import_json_file",
    "commands::desktop_lyrics_show_window",
    "commands::desktop_lyrics_update_payload",
    "commands::login_netease_show_window",
    "commands::login_qq_show_window",
  ].join("\n"),
  sidecarServer: [
    'path === "/health"',
    'path === "/providers/capabilities"',
    'path === "/audio-proxy"',
    'path === "/image-proxy"',
    'path === "/weather/radio"',
    'path === "/discover/home"',
    'path === "/podcast/search"',
    'path === "/podcast/hot"',
    'path === "/podcast/detail"',
    'path === "/podcast/programs"',
    'path === "/podcast/my"',
    'path === "/podcast/my/items"',
    'path === "/podcast/dj-beatmap"',
    'path === "/search"',
    'path === "/song-url"',
    'sub === "session-cookie"',
    'sub === "login-status"',
    'sub === "logout"',
    'sub === "search"',
    'sub === "song-url"',
    'sub === "lyric"',
    'sub === "playlists"',
    'sub === "like"',
    'sub === "like-check"',
    'sub === "playlists/add-song"',
    "detailMatch",
  ].join("\n"),
  sidecarClient: [
    "async searchAll(",
    "async weatherRadio(",
    "async discoverHome(",
    "async podcastSearch(",
    "async podcastHot(",
    "async podcastDetail(",
    "async podcastPrograms(",
    "async podcastMy(",
    "async podcastMyItems(",
    "async podcastDjBeatmap(",
    "async resolveSongUrl(",
    "audioProxyUrl(",
    "imageProxyUrl(",
    "async lyric(",
    "async playlistDetail(",
    "async playlistList(",
    "async likeSong(",
    "async checkSongLikes(",
    "async addSongToPlaylist(",
    "async setProviderSessionCookie(",
    "async clearProviderSessionCookie(",
    "async loginStatus(",
    "async logout(",
  ].join("\n"),
  appTsx: [
    "usePlaybackStore",
    "useProviderStore",
    "useSearchStore",
    "useLyricsStore",
    "useShelfStore",
    "useVisualStore",
    "useUpdateStore",
    "useUiStore",
    "client.searchAll",
    "client.resolveSongUrl",
    "client.audioProxyUrl",
    "client.lyric(currentTrack)",
    "client.playlistList(\"netease\")",
    "client.playlistList(\"qq\")",
    "client.discoverHome()",
    "weatherRadio.call(client",
    "podcastMy.call(client)",
    "sidecarClient.podcastMyItems",
    "sidecarClient.podcastPrograms",
    "client.podcastDjBeatmap",
    "client.likeSong",
    "client.addSongToPlaylist",
    "client.setProviderSessionCookie",
    "client.loginStatus",
    "client.logout",
    "<SearchShell",
    "<VisualComponent",
    "<BottomControlsHost",
    "<UpdateHost",
  ].join("\n"),
  searchShell: [
    "client.searchAll",
    "client.search(",
    "onResultPlay",
    "onResultNext",
    "onResultLike",
    "onResultCollect",
    "onArtistSearch",
  ].join("\n"),
});

describe("main flow policy check", () => {
  test("accepts a fully wired Tauri/Bun/React product main flow", () => {
    expect(evaluateMainFlowPolicy(goodPolicy)).toEqual({ ok: true, errors: [] });
  });

  test("rejects regressions to a half-migrated stack or broken playback flow", () => {
    const result = evaluateMainFlowPolicy({
      ...goodPolicy,
      rootPackage: {
        scripts: {
          start: "electron .",
          dev: "bun run tauri:dev",
          build: "bun run tauri:build",
        },
      },
      appTsx: goodPolicy.appTsx
        .replace("client.resolveSongUrl", "")
        .concat("\n<iframe src=\"/public/index.html\" />"),
      searchShell: goodPolicy.searchShell.replace("client.searchAll", ""),
      sidecarServer: goodPolicy.sidecarServer.replace('path === "/song-url"', ""),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("root package.json scripts.start must stay on the Tauri/Bun mainline");
    expect(result.errors).toContain("root package.json must expose main-flow-policy:check");
    expect(result.errors).toContain('Bun sidecar server must keep route marker: path === "/song-url"');
    expect(result.errors).toContain("React App shell must keep product-flow wiring marker: client.resolveSongUrl");
    expect(result.errors).toContain("SearchShell must keep search/action wiring marker: client.searchAll");
    expect(result.errors).toContain("React shell must not reintroduce iframe/webview wrapping of the old monolithic UI");
  });

  test("current repository keeps the code-side product main flow closed", () => {
    expect(checkMainFlowPolicy(process.cwd())).toEqual({ ok: true, errors: [] });
  });
});

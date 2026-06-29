import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_ROOT_SCRIPTS = {
  start: "bun run tauri:dev",
  dev: "bun run tauri:dev",
  build: "bun run tauri:build",
};

const REQUIRED_TAURI_COMMANDS = [
  "get_runtime_config",
  "get_sidecar_status",
  "configure_global_hotkeys",
  "get_updater_status",
  "check_for_update",
  "window_minimize",
  "window_toggle_maximize",
  "window_toggle_fullscreen",
  "open_external",
  "export_json_file",
  "import_json_file",
  "desktop_lyrics_show_window",
  "desktop_lyrics_update_payload",
  "login_netease_show_window",
  "login_qq_show_window",
];

const REQUIRED_SIDECAR_ROUTES = [
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
];

const REQUIRED_CLIENT_METHODS = [
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
];

const REQUIRED_APP_WIRING = [
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
];

const REQUIRED_SEARCH_SHELL_WIRING = [
  "client.searchAll",
  "client.search(",
  "onResultPlay",
  "onResultNext",
  "onResultLike",
  "onResultCollect",
  "onArtistSearch",
];

const REQUIRED_WEB_STORES = [
  "usePlaybackStore",
  "useProviderStore",
  "useSearchStore",
  "useLyricsStore",
  "useShelfStore",
  "useVisualStore",
  "useUpdateStore",
  "useUiStore",
];

export function extractMainFlowPolicy(input) {
  return {
    rootPackage: input.rootPackage ?? {},
    tauriConfig: input.tauriConfig ?? {},
    rustLib: input.rustLib ?? "",
    sidecarServer: input.sidecarServer ?? "",
    sidecarClient: input.sidecarClient ?? "",
    appTsx: input.appTsx ?? "",
    searchShell: input.searchShell ?? "",
    storesIndex: input.storesIndex ?? "",
  };
}

export function evaluateMainFlowPolicy(policy) {
  const errors = [];
  const scripts = policy.rootPackage.scripts ?? {};
  for (const [script, expected] of Object.entries(REQUIRED_ROOT_SCRIPTS)) {
    if (scripts[script] !== expected) {
      errors.push(`root package.json scripts.${script} must stay on the Tauri/Bun mainline`);
    }
  }
  if (scripts["main-flow-policy:check"] !== "node scripts/check-main-flow-policy.mjs") {
    errors.push("root package.json must expose main-flow-policy:check");
  }

  const build = policy.tauriConfig.build ?? {};
  if (!String(build.beforeBuildCommand ?? "").includes("@mineradio/web build")) {
    errors.push("Tauri beforeBuildCommand must build the Vite/React web app");
  }
  if (!String(build.beforeBuildCommand ?? "").includes("@mineradio/desktop build:sidecar")) {
    errors.push("Tauri beforeBuildCommand must build the Bun sidecar binary");
  }
  if (build.frontendDist !== "../../web/dist") {
    errors.push("Tauri frontendDist must point at apps/web/dist");
  }
  const externalBin = policy.tauriConfig.bundle?.externalBin ?? [];
  if (!Array.isArray(externalBin) || !externalBin.includes("binaries/mineradio-sidecar-api")) {
    errors.push("Tauri bundle must include the compiled Bun sidecar externalBin");
  }

  if (!policy.rustLib.includes("build_and_start_sidecar(")) {
    errors.push("Rust lib.rs must start and supervise the Bun sidecar");
  }
  for (const command of REQUIRED_TAURI_COMMANDS) {
    if (!policy.rustLib.includes(`commands::${command}`)) {
      errors.push(`Rust invoke handler must expose ${command}`);
    }
  }

  for (const route of REQUIRED_SIDECAR_ROUTES) {
    if (!policy.sidecarServer.includes(route)) {
      errors.push(`Bun sidecar server must keep route marker: ${route}`);
    }
  }

  for (const method of REQUIRED_CLIENT_METHODS) {
    if (!policy.sidecarClient.includes(method)) {
      errors.push(`web SidecarClient must keep method marker: ${method}`);
    }
  }

  for (const marker of REQUIRED_APP_WIRING) {
    if (!policy.appTsx.includes(marker)) {
      errors.push(`React App shell must keep product-flow wiring marker: ${marker}`);
    }
  }

  for (const marker of REQUIRED_SEARCH_SHELL_WIRING) {
    if (!policy.searchShell.includes(marker)) {
      errors.push(`SearchShell must keep search/action wiring marker: ${marker}`);
    }
  }

  for (const marker of REQUIRED_WEB_STORES) {
    if (!policy.appTsx.includes(marker) && !policy.storesIndex.includes(marker)) {
      errors.push(`React/Zustand shell must keep store wiring marker: ${marker}`);
    }
  }

  if (/<iframe\b|<webview\b/i.test(policy.appTsx)) {
    errors.push("React shell must not reintroduce iframe/webview wrapping of the old monolithic UI");
  }

  return { ok: errors.length === 0, errors };
}

export function checkMainFlowPolicy(rootDir = process.cwd()) {
  const requiredFiles = {
    rootPackage: "package.json",
    tauriConfig: "apps/desktop/src-tauri/tauri.conf.json",
    rustLib: "apps/desktop/src-tauri/src/lib.rs",
    sidecarServer: "sidecars/api/src/server.ts",
    sidecarClient: "apps/web/src/api/sidecar-client.ts",
    appTsx: "apps/web/src/app/App.tsx",
    searchShell: "apps/web/src/components/shell/SearchShell.tsx",
  };
  for (const path of Object.values(requiredFiles)) {
    if (!existsSync(resolve(rootDir, path))) throw new Error(`${path} is missing`);
  }
  const storesText = [
    "playback-store.ts",
    "provider-store.ts",
    "search-store.ts",
    "lyrics-store.ts",
    "shelf-store.ts",
    "visual-store.ts",
    "update-store.ts",
    "ui-store.ts",
  ]
    .map((name) => readFileSync(resolve(rootDir, "apps/web/src/stores", name), "utf8"))
    .join("\n");

  return evaluateMainFlowPolicy(extractMainFlowPolicy({
    rootPackage: JSON.parse(readFileSync(resolve(rootDir, requiredFiles.rootPackage), "utf8")),
    tauriConfig: JSON.parse(readFileSync(resolve(rootDir, requiredFiles.tauriConfig), "utf8")),
    rustLib: readFileSync(resolve(rootDir, requiredFiles.rustLib), "utf8"),
    sidecarServer: readFileSync(resolve(rootDir, requiredFiles.sidecarServer), "utf8"),
    sidecarClient: readFileSync(resolve(rootDir, requiredFiles.sidecarClient), "utf8"),
    appTsx: readFileSync(resolve(rootDir, requiredFiles.appTsx), "utf8"),
    searchShell: readFileSync(resolve(rootDir, requiredFiles.searchShell), "utf8"),
    storesIndex: storesText,
  }));
}

if (import.meta.main) {
  const result = checkMainFlowPolicy(process.cwd());
  if (!result.ok) {
    console.error("Main flow policy check failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Main flow policy check passed.");
}

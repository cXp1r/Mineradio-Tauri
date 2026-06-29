import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATH = "apps/desktop/src-tauri/tauri.conf.json";

export function extractWindowsInstallerPolicy(tauriConfig) {
  const windows = tauriConfig?.bundle?.windows ?? {};
  const nsis = windows.nsis ?? {};
  return {
    targets: tauriConfig?.bundle?.targets,
    allowDowngrades: windows.allowDowngrades,
    webviewInstallMode: windows.webviewInstallMode,
    installMode: nsis.installMode,
    installerIcon: nsis.installerIcon,
    uninstallerIcon: nsis.uninstallerIcon,
    startMenuFolder: nsis.startMenuFolder,
    languages: nsis.languages,
    displayLanguageSelector: nsis.displayLanguageSelector
  };
}

export function evaluateInstallerPolicy(policy) {
  const errors = [];
  if (!targetsIncludeNsis(policy.targets)) {
    errors.push("bundle.targets must explicitly include nsis");
  }
  if (policy.installMode !== "currentUser") {
    errors.push("bundle.windows.nsis.installMode must stay currentUser");
  }
  if (policy.allowDowngrades !== false) {
    errors.push("bundle.windows.allowDowngrades must be false");
  }
  if (
    policy.webviewInstallMode?.type !== "downloadBootstrapper" ||
    policy.webviewInstallMode?.silent !== true
  ) {
    errors.push("bundle.windows.webviewInstallMode must use silent downloadBootstrapper");
  }
  if (policy.installerIcon !== "icons/icon.ico") {
    errors.push("bundle.windows.nsis.installerIcon must use icons/icon.ico");
  }
  if (policy.uninstallerIcon !== "icons/icon.ico") {
    errors.push("bundle.windows.nsis.uninstallerIcon must use icons/icon.ico");
  }
  if (policy.startMenuFolder !== "Mineradio Tauri Rewrite") {
    errors.push("bundle.windows.nsis.startMenuFolder must stay Mineradio Tauri Rewrite");
  }
  if (!Array.isArray(policy.languages) || policy.languages[0] !== "SimpChinese" || !policy.languages.includes("English")) {
    errors.push("bundle.windows.nsis.languages must prefer SimpChinese and include English fallback");
  }
  if (policy.displayLanguageSelector !== false) {
    errors.push("bundle.windows.nsis.displayLanguageSelector must stay false");
  }
  return { ok: errors.length === 0, errors };
}

export function checkInstallerPolicy(rootDir = process.cwd()) {
  const path = resolve(rootDir, CONFIG_PATH);
  if (!existsSync(path)) throw new Error(`${CONFIG_PATH} is missing`);
  const tauriConfig = JSON.parse(readFileSync(path, "utf8"));
  return evaluateInstallerPolicy(extractWindowsInstallerPolicy(tauriConfig));
}

function targetsIncludeNsis(targets) {
  if (Array.isArray(targets)) return targets.includes("nsis");
  return targets === "nsis";
}

if (import.meta.main) {
  const result = checkInstallerPolicy(process.cwd());
  if (!result.ok) {
    console.error("Installer policy check failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Installer policy check passed.");
}

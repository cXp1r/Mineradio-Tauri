import { describe, expect, test } from "bun:test";

import {
  evaluateInstallerPolicy,
  extractWindowsInstallerPolicy
} from "./check-installer-policy.mjs";

describe("installer policy check", () => {
  test("extracts Windows NSIS policy from tauri config", () => {
    const policy = extractWindowsInstallerPolicy({
      bundle: {
        targets: ["nsis"],
        windows: {
          allowDowngrades: false,
          webviewInstallMode: { type: "downloadBootstrapper", silent: true },
          nsis: {
            installMode: "currentUser",
            installerIcon: "icons/icon.ico",
            uninstallerIcon: "icons/icon.ico",
            languages: ["SimpChinese", "English"],
            displayLanguageSelector: false
          }
        }
      }
    });

    expect(policy).toEqual({
      targets: ["nsis"],
      allowDowngrades: false,
      webviewInstallMode: { type: "downloadBootstrapper", silent: true },
      installMode: "currentUser",
      installerIcon: "icons/icon.ico",
      uninstallerIcon: "icons/icon.ico",
      languages: ["SimpChinese", "English"],
      displayLanguageSelector: false
    });
  });

  test("fails when installer policy drifts from DECISIONS A5", () => {
    const result = evaluateInstallerPolicy({
      targets: "all",
      allowDowngrades: true,
      webviewInstallMode: { type: "skip" },
      installMode: "both",
      installerIcon: "",
      uninstallerIcon: "",
      languages: ["English"],
      displayLanguageSelector: true
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("bundle.targets must explicitly include nsis");
    expect(result.errors).toContain("bundle.windows.nsis.installMode must stay currentUser");
    expect(result.errors).toContain("bundle.windows.allowDowngrades must be false");
    expect(result.errors).toContain("bundle.windows.webviewInstallMode must use silent downloadBootstrapper");
  });
});

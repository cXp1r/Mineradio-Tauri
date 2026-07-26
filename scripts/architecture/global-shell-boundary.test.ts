import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(
  resolve(import.meta.dir, "../../apps/web/src/app/App.tsx"),
  "utf8",
);

test("App delegates global shell effects and browser preference persistence", () => {
  expect(appSource).toContain("useGlobalShellRuntime");
  expect(appSource).toContain("useShellPreferences");
  expect(appSource).not.toContain("useEffect(");
  expect(appSource).not.toContain("readBooleanPreference");
  expect(appSource).not.toContain("saveBooleanPreference");
  expect(appSource).not.toContain("localStorage");
  expect(appSource).not.toContain("AI_DEPTH_STATUS_EVENT");
  expect(appSource).not.toContain('document.addEventListener("pointerdown"');
  expect(appSource).not.toContain('document.addEventListener("click"');
  expect(appSource).not.toContain('window.addEventListener("mousemove"');
  expect(appSource).not.toContain("loadShelfSettingsFromStorage");
  expect(appSource).not.toContain("saveShelfSettingsToStorage");
  expect(appSource).not.toContain("saveVisualFxToStorage");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(
  resolve(import.meta.dir, "../../apps/web/src/app/App.tsx"),
  "utf8",
);
const shellSource = readFileSync(
  resolve(import.meta.dir, "../../apps/web/src/app/AppShell.tsx"),
  "utf8",
);

test("App is a controller composition layer without concrete runtime imports", () => {
  expect(appSource).toContain("<AppShell");
  expect(appSource).toContain("useDesktopRuntime");
  expect(appSource).toContain("useHomeController");
  expect(appSource).toContain("useLibraryController");
  expect(appSource).toContain("usePlaybackSessionRuntime");
  expect(appSource).not.toContain("useEffect(");
  expect(appSource).not.toContain('from "../api/sidecar-client"');
  expect(appSource).not.toContain('from "../audio/player-controller"');
  expect(appSource).not.toContain('from "../tauri/runtime"');
  expect(appSource).not.toContain("resolvedDesktopRuntime.minimizeWindow(");
  expect(appSource).not.toContain("resolvedDesktopRuntime.toggleWindowMaximize(");
  expect(appSource).not.toContain("resolvedDesktopRuntime.toggleWindowFullscreen(");
  expect(appSource).not.toContain("resolvedDesktopRuntime.closeWindow(");
});

test("AppShell owns the stable feature surface order", () => {
  const compositionSource = shellSource.slice(
    shellSource.indexOf("export function AppShell"),
  );
  const surfaceOrder = [
    "<VisualSurface",
    "<HomeSurface",
    "<AccountSurface",
    "<VisualGuideHost",
    "<LibrarySurface",
    "<PlaybackSurface",
    "<PlaybackCustomizationOverlay",
    "<LibraryOverlaySurface",
    "<AccountOverlaySurface",
    "<PlaybackNoticeOverlay",
  ].map((token) => compositionSource.indexOf(token));

  expect(surfaceOrder.every((index) => index >= 0)).toBe(true);
  expect(surfaceOrder).toEqual([...surfaceOrder].sort((a, b) => a - b));
  expect(shellSource).toContain("<PlaybackRuntimeSurface");
});

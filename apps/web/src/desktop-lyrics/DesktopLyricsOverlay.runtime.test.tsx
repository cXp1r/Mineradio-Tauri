import { expect, test } from "bun:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DesktopLyricsOverlay } from "./DesktopLyricsOverlay";

test("DesktopLyricsOverlay advances progress on its own requestAnimationFrame clock", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const runtimeWindow = window;
  const originalRequestAnimationFrame = runtimeWindow.requestAnimationFrame;
  const originalCancelAnimationFrame = runtimeWindow.cancelAnimationFrame;
  const performanceNowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.performance,
    "now",
  );
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextRequestId = 1;

  runtimeWindow.requestAnimationFrame = (callback) => {
    const requestId = nextRequestId;
    nextRequestId += 1;
    callbacks.set(requestId, callback);
    return requestId;
  };
  runtimeWindow.cancelAnimationFrame = (requestId) => {
    callbacks.delete(requestId);
  };
  Object.defineProperty(globalThis.performance, "now", {
    configurable: true,
    value: () => 1_000,
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => {
      root.render(
        <DesktopLyricsOverlay
          payload={{
            enabled: true,
            text: "自主刷新",
            playing: true,
            progress: 0.25,
            progressSpan: 4,
            frameRate: 60,
            playback: { time: 8, duration: 100, rate: 1 },
          }}
        />,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (host.querySelector(".desktop-lyrics-overlay") as HTMLElement).style
        .getPropertyValue("--desktop-lyrics-progress"),
    ).toBe("25%");

    const firstFrame = Array.from(callbacks.values())[0];
    expect(typeof firstFrame).toBe("function");
    flushSync(() => {
      firstFrame?.(2_000);
    });

    expect(
      (host.querySelector(".desktop-lyrics-overlay") as HTMLElement).style
        .getPropertyValue("--desktop-lyrics-progress"),
    ).toBe("50%");
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    runtimeWindow.requestAnimationFrame = originalRequestAnimationFrame;
    runtimeWindow.cancelAnimationFrame = originalCancelAnimationFrame;
    if (performanceNowDescriptor) {
      Object.defineProperty(
        globalThis.performance,
        "now",
        performanceNowDescriptor,
      );
    } else {
      delete (globalThis.performance as unknown as Record<string, unknown>).now;
    }
  }
});

test("DesktopLyricsOverlay re-reports native hot bounds after viewport resize", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 210,
    bottom: 80,
    width: 200,
    height: 60,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  });
  const reported: unknown[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => {
      root.render(
        <DesktopLyricsOverlay
          payload={{ enabled: true, text: "热区刷新" }}
          onHotBoundsChange={(bounds) => reported.push(bounds)}
        />,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const initialReports = reported.length;
    expect(initialReports).toBeGreaterThan(0);

    window.dispatchEvent(new Event("resize"));

    expect(reported.length).toBeGreaterThan(initialReports);
    expect(reported.at(-1)).toEqual({
      left: -16,
      top: -4,
      right: 236,
      bottom: 104,
    });
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  }
});

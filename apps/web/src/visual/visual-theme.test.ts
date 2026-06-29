import { expect, test } from "bun:test";
import "../../../../packages/visual-engine/src/runtime/happy-dom-preload";
import { FX_DEFAULTS } from "@mineradio/visual-engine";
import { applyVisualThemeToRoot } from "./visual-theme";

test("applyVisualThemeToRoot mirrors baseline UI accent and visual tint CSS variables", () => {
  const root = document.createElement("div");
  applyVisualThemeToRoot(root, {
    ...FX_DEFAULTS,
    uiAccentColor: "#12abef",
    visualTintColor: "#223344",
  });

  expect(root.style.getPropertyValue("--fc-accent")).toBe("#12abef");
  expect(root.style.getPropertyValue("--fc-accent-hov")).toBe("#12abef");
  expect(root.style.getPropertyValue("--fc-accent-rgb")).toBe("18,171,239");
  expect(root.style.getPropertyValue("--glass-border")).toBe("rgba(18,171,239,.30)");
  expect(root.style.getPropertyValue("--visual-tint")).toBe("#223344");
});

import type { FxState } from "@mineradio/visual-engine";

export function applyVisualThemeToRoot(root: HTMLElement, fx: Pick<FxState, "uiAccentColor" | "visualTintColor">): void {
  const accent = normalizeHexColor(fx.uiAccentColor, "#ffffff");
  const tint = normalizeHexColor(fx.visualTintColor, "#9db8cf");
  const rgb = hexToRgb(accent);
  root.style.setProperty("--fc-accent", accent);
  root.style.setProperty("--fc-accent-hov", accent);
  root.style.setProperty("--fc-accent-rgb", `${rgb.r},${rgb.g},${rgb.b}`);
  root.style.setProperty("--glass-border", `rgba(${rgb.r},${rgb.g},${rgb.b},.30)`);
  root.style.setProperty(
    "--glass-shadow-focus",
    `0 24px 72px rgba(0,0,0,.34),0 0 0 1px rgba(${rgb.r},${rgb.g},${rgb.b},.13),0 0 42px rgba(${rgb.r},${rgb.g},${rgb.b},.075),inset 0 1px 0 rgba(255,255,255,.20)`,
  );
  root.style.setProperty("--visual-tint", tint);
}

function normalizeHexColor(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : fallback;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = Number.parseInt(hex.slice(1), 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
}

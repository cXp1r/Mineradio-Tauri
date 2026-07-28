import { expect, test } from "bun:test";
import type { FxStatePatch } from "@mineradio/visual-engine";
import {
  loadFromStorage,
  loadVisualFxFromStorage,
  normalizeVisualFxState,
  saveVisualFxToStorage,
  useVisualStore,
  VISUAL_SETTINGS_STORE_KEY,
} from "./visual-store";

test("loadFromStorage rejects a malformed payload", () => {
  expect(loadFromStorage("{not json")).toBeNull();
  expect(loadFromStorage(JSON.stringify({ version: "x" }))).toBeNull();
});

test("loadFromStorage accepts a valid PersistedVisualState", () => {
  const valid = {
    version: 1,
    preset: "stardust",
    intensity: 0.7,
    custom: { hue: 120 },
    updatedAt: 1,
  };
  const loaded = loadFromStorage(JSON.stringify(valid));
  expect(loaded?.preset).toBe("stardust");
  expect(loaded?.intensity).toBe(0.7);
});

test("visual store actions update state and serialize", () => {
  useVisualStore.setState({
    fx: { ...useVisualStore.getState().fx, preset: 0, intensity: 0.5 },
    preset: 0,
    intensity: 0.5,
    custom: {},
  });
  useVisualStore.getState().setPreset(4);
  useVisualStore.getState().setIntensity(0.3);
  useVisualStore.getState().setNumberSetting("depth", 1.4);
  useVisualStore.getState().setBooleanSetting("cinema", false);
  useVisualStore.getState().setStringSetting("lyricFont", "stone-song");
  useVisualStore.getState().setCustom("hue", 200);
  const serialized = useVisualStore.getState().serialize();
  expect(serialized.preset).toBe("4");
  expect(serialized.intensity).toBe(0.3);
  expect(serialized.custom.hue).toBe(200);
  expect(useVisualStore.getState().fx.depth).toBe(1.4);
  expect(useVisualStore.getState().fx.cinema).toBe(false);
  expect(useVisualStore.getState().fx.lyricFont).toBe("stone-song");
});

test("loadVisualFxFromStorage accepts baseline numeric fx state and keeps wallpaper mode disabled", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({
      preset: 6,
      intensity: 1.2,
      wallpaperMode: true,
      cinema: false,
      lyricFont: "kai-song",
    }),
  );
  const fx = loadVisualFxFromStorage(fakeStorage);
  expect(fx?.preset).toBe(6);
  expect(fx?.intensity).toBe(1.2);
  expect(fx?.cinema).toBe(false);
  expect(fx?.wallpaperMode).toBe(false);
  expect(fx?.lyricFont).toBe("kai-song");
});

test("loadVisualFxFromStorage keeps the baseline-disabled float layer off even if an old archive enables it", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({
      floatLayer: true,
    }),
  );
  const fx = loadVisualFxFromStorage(fakeStorage);
  expect(fx?.floatLayer).toBe(false);
});

test("loadVisualFxFromStorage normalizes unsupported lyric font keys", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({
      lyricFont: "Papyrus",
    }),
  );
  const fx = loadVisualFxFromStorage(fakeStorage);
  expect(fx?.lyricFont).toBe("hei");
});

test("loadVisualFxFromStorage clamps baseline lyric layout controls", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({
      lyricScale: 9,
      lyricOffsetX: -9,
      lyricOffsetY: 9,
      lyricOffsetZ: -9,
      lyricTiltX: 99,
      lyricTiltY: -99,
    }),
  );
  const fx = loadVisualFxFromStorage(fakeStorage);
  expect(fx?.lyricScale).toBe(1.65);
  expect(fx?.lyricOffsetX).toBe(-2);
  expect(fx?.lyricOffsetY).toBe(1.35);
  expect(fx?.lyricOffsetZ).toBe(-1.6);
  expect(fx?.lyricTiltX).toBe(42);
  expect(fx?.lyricTiltY).toBe(-42);
});

test("loadVisualFxFromStorage clamps baseline desktop lyrics controls", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({
      desktopLyricsSize: 9,
      desktopLyricsOpacity: 0.1,
      desktopLyricsY: 2,
      desktopLyricsFps: 999,
    }),
  );
  const fx = loadVisualFxFromStorage(fakeStorage);
  expect(fx?.desktopLyricsSize).toBe(1.55);
  expect(fx?.desktopLyricsOpacity).toBe(0.28);
  expect(fx?.desktopLyricsY).toBe(0.92);
  expect(fx?.desktopLyricsFps).toBe(120);
});

test("loadVisualFxFromStorage normalizes baseline visual color controls", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({
      visualTintMode: "CUSTOM",
      visualTintColor: "12ABEF",
      uiAccentColor: "not-a-color",
      homeAccentColor: "fedcba",
    }),
  );
  const fx = loadVisualFxFromStorage(fakeStorage);
  expect(fx?.visualTintMode).toBe("custom");
  expect(fx?.visualTintColor).toBe("#12abef");
  expect(fx?.uiAccentColor).toBe("#ffffff");
  expect(fx?.homeAccentColor).toBe("#fedcba");
});

test("loadVisualFxFromStorage normalizes baseline stage lyric color controls", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({
      lyricColorMode: "CUSTOM",
      lyricColor: "123456",
      lyricHighlightMode: "CUSTOM",
      lyricHighlightColor: "#abcdef",
      lyricGlowLinked: false,
      lyricGlowColor: "fedcba",
    }),
  );
  const fx = loadVisualFxFromStorage(fakeStorage);
  expect(fx?.lyricColorMode).toBe("custom");
  expect(fx?.lyricColor).toBe("#123456");
  expect(fx?.lyricHighlightMode).toBe("custom");
  expect(fx?.lyricHighlightColor).toBe("#abcdef");
  expect(fx?.lyricGlowLinked).toBe(false);
  expect(fx?.lyricGlowColor).toBe("#fedcba");
});

test("loadVisualFxFromStorage migrates legacy preset 8 to Sonic preset 7", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  fakeStorage.setItem(VISUAL_SETTINGS_STORE_KEY, JSON.stringify({ preset: 8 }));
  expect(loadVisualFxFromStorage(fakeStorage)?.preset).toBe(7);
});

test("visual settings owns nested Stage and Sonic normalization before persistence", () => {
  const normalized = normalizeVisualFxState({
    stageLyrics: {
      displayMode: "invalid",
      customLineCount: 99,
      contextOpacity: -4,
    },
    sonic: {
      terrain: { amplitude: 101.4, density: -8 },
      colors: { mode: "custom", base: "#abc" },
      trigger: { bandStart: 511, bandEnd: 0 },
    },
  } as unknown as FxStatePatch);

  expect(normalized.stageLyrics.displayMode).toBe("single");
  expect(normalized.stageLyrics.customLineCount).toBe(10);
  expect(normalized.stageLyrics.contextOpacity).toBe(0.25);
  expect(normalized.sonic.terrain.amplitude).toBe(100);
  expect(normalized.sonic.terrain.density).toBe(0);
  expect(normalized.sonic.colors.mode).toBe("custom");
  expect(normalized.sonic.colors.base).toBe("#aabbcc");
  expect(normalized.sonic.trigger.bandStart).toBe(510);
  expect(normalized.sonic.trigger.bandEnd).toBe(512);
});

test("visual settings round-trip preserves normalized nested Stage and Sonic snapshots", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const original = useVisualStore.getState();
  useVisualStore.getState().setFxPatch({
    stageLyrics: { ...original.fx.stageLyrics, displayMode: "dual", translationMode: "current" },
    sonic: { ...original.fx.sonic, terrain: { ...original.fx.sonic.terrain, density: 83 } },
  });

  saveVisualFxToStorage(fakeStorage);
  const loaded = loadVisualFxFromStorage(fakeStorage);

  expect(loaded?.stageLyrics.displayMode).toBe("dual");
  expect(loaded?.stageLyrics.translationMode).toBe("current");
  expect(loaded?.sonic.terrain.density).toBe(83);
  useVisualStore.setState(original, true);
});

test("setFxPatch deep-merges nested Stage and Sonic changes against the current snapshot", () => {
  const original = useVisualStore.getState();
  const before = normalizeVisualFxState({
    stageLyrics: { displayMode: "cinema", translationMode: "current", contextOpacity: 0.73 },
    sonic: {
      terrain: { amplitude: 22, density: 46 },
      colors: { mode: "custom", base: "#123456" },
    },
  });
  useVisualStore.setState({ fx: before, preset: before.preset, intensity: before.intensity });

  useVisualStore.getState().setFxPatch({
    stageLyrics: { displayMode: "dual" },
    sonic: { terrain: { density: 83 } },
  });

  const after = useVisualStore.getState().fx;
  expect(after.stageLyrics.displayMode).toBe("dual");
  expect(after.stageLyrics.translationMode).toBe("current");
  expect(after.stageLyrics.contextOpacity).toBe(0.73);
  expect(after.sonic.terrain.density).toBe(83);
  expect(after.sonic.terrain.amplitude).toBe(22);
  expect(after.sonic.colors.mode).toBe("custom");
  expect(after.sonic.colors.base).toBe("#123456");
  useVisualStore.setState(original, true);
});

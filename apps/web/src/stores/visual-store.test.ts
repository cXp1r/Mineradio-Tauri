import { expect, test } from "bun:test";
import type { FxStatePatch } from "@mineradio/visual-engine";
import {
  loadFromStorage,
  loadVisualFxFromStorage,
  normalizeVisualFxState,
  saveVisualFxToStorage,
  useVisualStore,
  VISUAL_SETTINGS_STORE_KEY,
  VISUAL_WORKSHOP_SETTINGS_STORE_KEY,
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

test("selecting any numeric preset through setPreset clears Workshop activation", () => {
  const original = useVisualStore.getState();
  const workshop = normalizeVisualFxState({
    preset: 8,
    workshop: { active: true, inputGain: 93 },
  });
  useVisualStore.setState({
    fx: workshop,
    preset: workshop.preset,
    intensity: workshop.intensity,
  });

  useVisualStore.getState().setPreset(7);

  expect(useVisualStore.getState().preset).toBe(7);
  expect(useVisualStore.getState().fx.workshop.active).toBe(false);
  expect(useVisualStore.getState().fx.workshop.inputGain).toBe(93);
  useVisualStore.setState(original, true);
});

test("loadVisualFxFromStorage preserves bounded custom lyric font identifiers", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({ lyricFont: "custom:abc1234" }),
  );
  expect(loadVisualFxFromStorage(fakeStorage)?.lyricFont).toBe("custom:abc1234");
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

test("loadVisualFxFromStorage migrates legacy preset 8 to Sonic 7 and ignores embedded Workshop state", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  fakeStorage.setItem(
    VISUAL_SETTINGS_STORE_KEY,
    JSON.stringify({ preset: 8, workshop: { active: true, inputGain: 100 } }),
  );
  const loaded = loadVisualFxFromStorage(fakeStorage);
  expect(loaded?.preset).toBe(7);
  expect(loaded?.workshop.active).toBe(false);
  expect(loaded?.workshop.inputGain).toBe(82);
});

test("a valid independent Workshop preference restores current preset 8", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  fakeStorage.setItem(VISUAL_SETTINGS_STORE_KEY, JSON.stringify({ preset: 3 }));
  fakeStorage.setItem(
    VISUAL_WORKSHOP_SETTINGS_STORE_KEY,
    JSON.stringify({
      version: 1,
      activationId: "sonic-workshop-v1",
      active: true,
      settings: { inputGain: 93, theme: "ocean-deep" },
    }),
  );

  const fx = loadVisualFxFromStorage(fakeStorage);
  expect(fx?.preset).toBe(8);
  expect(fx?.workshop.active).toBe(true);
  expect(fx?.workshop.inputGain).toBe(93);
  expect(fx?.workshop.theme).toBe("ocean-deep");
});

test("a damaged Workshop fallback key preserves a valid legacy visual preset", () => {
  const storage = new Map<string, string>([
    [VISUAL_SETTINGS_STORE_KEY, JSON.stringify({ preset: 3, intensity: 0.72 })],
    [VISUAL_WORKSHOP_SETTINGS_STORE_KEY, "{truncated"],
  ]);
  const fx = loadVisualFxFromStorage({
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });

  expect(fx?.preset).toBe(3);
  expect(fx?.intensity).toBe(0.72);
  expect(fx?.workshop.active).toBe(false);
});

test("fallback write failure cannot leave an old active Workshop overriding the visual preset", () => {
  const storage = new Map<string, string>([
    [VISUAL_SETTINGS_STORE_KEY, JSON.stringify({ preset: 7 })],
    [VISUAL_WORKSHOP_SETTINGS_STORE_KEY, JSON.stringify({
      version: 1,
      activationId: "sonic-workshop-v1",
      active: true,
      settings: { active: true },
    })],
  ]);
  const original = useVisualStore.getState();
  useVisualStore.getState().setPreset(2);
  saveVisualFxToStorage({
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === VISUAL_SETTINGS_STORE_KEY) throw new Error("quota fixture");
      storage.set(key, value);
    },
  });

  const loaded = loadVisualFxFromStorage({
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  expect(loaded?.preset).toBe(7);
  expect(loaded?.workshop.active).toBe(false);
  useVisualStore.setState(original, true);
});

test("visual settings owns nested Stage, Sonic, and Workshop normalization before persistence", () => {
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
	workshop: {
		active: true,
		inputGain: 999,
		colors: { mode: "custom", primary: "#abc" },
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
  expect(normalized.sonic.trigger.bandEnd).toBe(511);
	expect(normalized.workshop.active).toBe(true);
	expect(normalized.workshop.inputGain).toBe(100);
	expect(normalized.workshop.colors.primary).toBe("#aabbcc");
	expect(normalized.workshop.colors.base).toBe("#16060f");
});

test("visual settings round-trip stores Workshop separately and restores current preset 8", () => {
  const storage = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const original = useVisualStore.getState();
  useVisualStore.getState().setFxPatch({
	preset: 8,
    stageLyrics: { ...original.fx.stageLyrics, displayMode: "dual", translationMode: "current" },
    sonic: { ...original.fx.sonic, terrain: { ...original.fx.sonic.terrain, density: 83 } },
	workshop: { active: true, inputGain: 93, theme: "ocean-deep" },
  });

  saveVisualFxToStorage(fakeStorage);
  const loaded = loadVisualFxFromStorage(fakeStorage);
	const legacyVisual = JSON.parse(storage.get(VISUAL_SETTINGS_STORE_KEY) ?? "null") as Record<string, unknown>;
	const workshop = JSON.parse(storage.get(VISUAL_WORKSHOP_SETTINGS_STORE_KEY) ?? "null") as Record<string, unknown>;

	expect(legacyVisual.preset).toBe(7);
	expect("workshop" in legacyVisual).toBe(false);
	expect(workshop.version).toBe(1);
	expect(workshop.activationId).toBe("sonic-workshop-v1");
	expect(workshop.active).toBe(true);
	expect(loaded?.preset).toBe(8);
  expect(loaded?.stageLyrics.displayMode).toBe("dual");
  expect(loaded?.stageLyrics.translationMode).toBe("current");
  expect(loaded?.sonic.terrain.density).toBe(83);
	expect(loaded?.workshop.active).toBe(true);
	expect(loaded?.workshop.inputGain).toBe(93);
	expect(loaded?.workshop.theme).toBe("ocean-deep");
  useVisualStore.setState(original, true);
});

test("setFxPatch deep-merges nested Stage, Sonic, and Workshop changes against the current snapshot", () => {
  const original = useVisualStore.getState();
  const before = normalizeVisualFxState({
    stageLyrics: { displayMode: "cinema", translationMode: "current", contextOpacity: 0.73 },
    sonic: {
      terrain: { amplitude: 22, density: 46 },
      colors: { mode: "custom", base: "#123456" },
    },
	workshop: {
		active: true,
		inputGain: 70,
		colors: { mode: "custom", primary: "#654321" },
	},
  });
  useVisualStore.setState({ fx: before, preset: before.preset, intensity: before.intensity });

  useVisualStore.getState().setFxPatch({
    stageLyrics: { displayMode: "dual" },
    sonic: { terrain: { density: 83 } },
	workshop: { inputGain: 91, colors: { peak: "#abcdef" } },
  });

  const after = useVisualStore.getState().fx;
  expect(after.stageLyrics.displayMode).toBe("dual");
  expect(after.stageLyrics.translationMode).toBe("current");
  expect(after.stageLyrics.contextOpacity).toBe(0.73);
  expect(after.sonic.terrain.density).toBe(83);
  expect(after.sonic.terrain.amplitude).toBe(22);
  expect(after.sonic.colors.mode).toBe("custom");
  expect(after.sonic.colors.base).toBe("#123456");
	expect(after.workshop.active).toBe(true);
	expect(after.workshop.inputGain).toBe(91);
	expect(after.workshop.colors.primary).toBe("#654321");
	expect(after.workshop.colors.peak).toBe("#abcdef");
  useVisualStore.setState(original, true);
});

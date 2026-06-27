import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import { FX_DEFAULTS, cloneFxState } from "./fx-defaults";

const EXPECTED_KEYS = [
	"preset", "intensity", "cinemaShake", "depth", "coverResolution",
	"point", "speed", "twist", "color", "scatter", "bgFade",
	"bloomStrength", "lyricGlowStrength", "lyricScale",
	"lyricOffsetX", "lyricOffsetY", "lyricOffsetZ", "lyricTiltX", "lyricTiltY",
	"lyricColorMode", "lyricColor", "lyricHighlightMode", "lyricHighlightColor",
	"lyricGlowLinked", "lyricGlowColor", "lyricFont",
	"lyricLetterSpacing", "lyricLineHeight", "lyricWeight",
	"visualTintMode", "visualTintColor",
	"uiAccentColor", "homeAccentColor", "homeIconColor", "visualIconColor",
	"backgroundColorMode", "backgroundColor", "backgroundOpacity",
	"controlGlassChromaticOffset", "backgroundColorCustom",
	"backgroundImage", "backgroundMedia",
	"desktopLyrics", "desktopLyricsSize", "desktopLyricsOpacity",
	"desktopLyricsY", "desktopLyricsClickThrough", "desktopLyricsCinema",
	"desktopLyricsHighlight", "desktopLyricsFps",
	"wallpaperMode", "wallpaperOpacity",
	"floatLayer", "cinema", "edge", "aiDepth", "bloom", "lyricGlow",
	"lyricGlowBeat", "lyricGlowParticles", "lyricCameraLock",
	"particleLyrics", "backCover",
	"shelf", "shelfCameraMode", "shelfPresence",
	"shelfShowPodcasts", "shelfMergeCollections",
	"shelfSize", "shelfOffsetX", "shelfOffsetY", "shelfOffsetZ",
	"shelfAngleY", "shelfAngleYManual", "shelfOpacity",
	"shelfBgOpacity", "shelfAccentColor",
	"performanceBackground", "performanceQuality", "liveBackgroundKeep",
	"cam",
	"mouseActive", "mouseXy", "burstAmt", "vinylSpin", "particleDim",
] as const;

test("FX_DEFAULTS exposes the verbatim baseline fxDefaults literal (81 baseline keys + 5 runtime keys = 86)", () => {
	expect(Object.keys(FX_DEFAULTS).length).toBe(EXPECTED_KEYS.length);
	for (const key of EXPECTED_KEYS) {
		expect(Object.prototype.hasOwnProperty.call(FX_DEFAULTS, key)).toBe(true);
	}
});

test("FX_DEFAULTS baseline scalar values match baseline index.html 3196-3268", () => {
	expect(FX_DEFAULTS.preset).toBe(0);
	expect(FX_DEFAULTS.intensity).toBe(0.85);
	expect(FX_DEFAULTS.cinemaShake).toBe(0.5);
	expect(FX_DEFAULTS.depth).toBe(1.0);
	expect(FX_DEFAULTS.coverResolution).toBe(1.55);
	expect(FX_DEFAULTS.point).toBe(1.0);
	expect(FX_DEFAULTS.speed).toBe(1.0);
	expect(FX_DEFAULTS.twist).toBe(0.0);
	expect(FX_DEFAULTS.color).toBe(1.10);
	expect(FX_DEFAULTS.scatter).toBe(0.0);
	expect(FX_DEFAULTS.bgFade).toBe(0.20);
	expect(FX_DEFAULTS.bloomStrength).toBe(0.62);
	expect(FX_DEFAULTS.lyricGlowStrength).toBe(0.28);
	expect(FX_DEFAULTS.lyricScale).toBe(1.0);
	expect(FX_DEFAULTS.lyricOffsetX).toBe(0);
	expect(FX_DEFAULTS.lyricOffsetY).toBe(0);
	expect(FX_DEFAULTS.lyricOffsetZ).toBe(0);
	expect(FX_DEFAULTS.lyricTiltX).toBe(0);
	expect(FX_DEFAULTS.lyricTiltY).toBe(0);
	expect(FX_DEFAULTS.lyricColorMode).toBe("auto");
	expect(FX_DEFAULTS.lyricColor).toBe("#a9b8c8");
	expect(FX_DEFAULTS.lyricHighlightMode).toBe("auto");
	expect(FX_DEFAULTS.lyricHighlightColor).toBe("#fac900");
	expect(FX_DEFAULTS.lyricGlowLinked).toBe(true);
	expect(FX_DEFAULTS.lyricGlowColor).toBe("#008aff");
	expect(FX_DEFAULTS.lyricFont).toBe("hei");
	expect(FX_DEFAULTS.lyricLetterSpacing).toBe(0);
	expect(FX_DEFAULTS.lyricLineHeight).toBe(1.0);
	expect(FX_DEFAULTS.lyricWeight).toBe(900);
	expect(FX_DEFAULTS.visualTintMode).toBe("auto");
	expect(FX_DEFAULTS.visualTintColor).toBe("#9db8cf");
	expect(FX_DEFAULTS.uiAccentColor).toBe("#ffffff");
	expect(FX_DEFAULTS.homeAccentColor).toBe("#ffffff");
	expect(FX_DEFAULTS.homeIconColor).toBe("#ffffff");
	expect(FX_DEFAULTS.visualIconColor).toBe("#ffffff");
	expect(FX_DEFAULTS.backgroundColorMode).toBe("cover");
	expect(FX_DEFAULTS.backgroundColor).toBe("#000000");
	expect(FX_DEFAULTS.backgroundOpacity).toBe(1);
	expect(FX_DEFAULTS.controlGlassChromaticOffset).toBe(90);
	expect(FX_DEFAULTS.backgroundColorCustom).toBe(false);
	expect(FX_DEFAULTS.backgroundImage).toBe("");
	expect(FX_DEFAULTS.backgroundMedia).toBe(null);
	expect(FX_DEFAULTS.desktopLyrics).toBe(false);
	expect(FX_DEFAULTS.desktopLyricsSize).toBe(1.0);
	expect(FX_DEFAULTS.desktopLyricsOpacity).toBe(0.92);
	expect(FX_DEFAULTS.desktopLyricsY).toBe(0.76);
	expect(FX_DEFAULTS.desktopLyricsClickThrough).toBe(false);
	expect(FX_DEFAULTS.desktopLyricsCinema).toBe(true);
	expect(FX_DEFAULTS.desktopLyricsHighlight).toBe(false);
	expect(FX_DEFAULTS.desktopLyricsFps).toBe(60);
	expect(FX_DEFAULTS.wallpaperMode).toBe(false);
	expect(FX_DEFAULTS.wallpaperOpacity).toBe(1);
	expect(FX_DEFAULTS.floatLayer).toBe(false);
	expect(FX_DEFAULTS.cinema).toBe(true);
	expect(FX_DEFAULTS.edge).toBe(false);
	expect(FX_DEFAULTS.aiDepth).toBe(false);
	expect(FX_DEFAULTS.bloom).toBe(false);
	expect(FX_DEFAULTS.lyricGlow).toBe(true);
	expect(FX_DEFAULTS.lyricGlowBeat).toBe(true);
	expect(FX_DEFAULTS.lyricGlowParticles).toBe(false);
	expect(FX_DEFAULTS.lyricCameraLock).toBe(false);
	expect(FX_DEFAULTS.particleLyrics).toBe(true);
	expect(FX_DEFAULTS.backCover).toBe(false);
	expect(FX_DEFAULTS.shelf).toBe("side");
	expect(FX_DEFAULTS.shelfCameraMode).toBe("static");
	expect(FX_DEFAULTS.shelfPresence).toBe("always");
	expect(FX_DEFAULTS.shelfShowPodcasts).toBe(false);
	expect(FX_DEFAULTS.shelfMergeCollections).toBe(false);
	expect(FX_DEFAULTS.shelfSize).toBe(1);
	expect(FX_DEFAULTS.shelfOffsetX).toBe(0);
	expect(FX_DEFAULTS.shelfOffsetY).toBe(0);
	expect(FX_DEFAULTS.shelfOffsetZ).toBe(0);
	expect(FX_DEFAULTS.shelfAngleY).toBe(-15);
	expect(FX_DEFAULTS.shelfAngleYManual).toBe(false);
	expect(FX_DEFAULTS.shelfOpacity).toBe(1);
	expect(FX_DEFAULTS.shelfBgOpacity).toBe(0.90);
	expect(FX_DEFAULTS.shelfAccentColor).toBe("#ffffff");
	expect(FX_DEFAULTS.performanceBackground).toBe("auto");
	expect(FX_DEFAULTS.performanceQuality).toBe("high");
	expect(FX_DEFAULTS.liveBackgroundKeep).toBe(false);
	expect(FX_DEFAULTS.cam).toBe("off");
});

test("FX_DEFAULTS runtime additions match baseline uniform/variable init: mouseActive false, mouseXY(-999,-999), burstAmt 0, vinylSpin 0, particleDim 1", () => {
	expect(FX_DEFAULTS.mouseActive).toBe(false);
	expect(FX_DEFAULTS.mouseXy).toEqual({ x: -999, y: -999 });
	expect(FX_DEFAULTS.burstAmt).toBe(0);
	expect(FX_DEFAULTS.vinylSpin).toBe(0);
	expect(FX_DEFAULTS.particleDim).toBe(1);
});

test("cloneFxState returns a deep-ish copy with a fresh mouseXy nested object", () => {
	const a = cloneFxState();
	const b = cloneFxState();
	expect(a).not.toBe(b);
	expect(a.mouseXy).not.toBe(b.mouseXy);
	expect(a.mouseXy).toEqual(b.mouseXy);
	expect(a.preset).toBe(FX_DEFAULTS.preset);
	expect(a.intensity).toBe(FX_DEFAULTS.intensity);
});
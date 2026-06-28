import { expect, test } from "bun:test";
import { DesktopLyricsPayloadSchema, DESKTOP_LYRICS_FPS_VALUES } from "./desktop";

test("desktop lyrics payload applies safe defaults for a minimal payload", () => {
	const parsed = DesktopLyricsPayloadSchema.parse({
		enabled: true,
		text: "晚风吹过"
	});

	expect(parsed.enabled).toBe(true);
	expect(parsed.text).toBe("晚风吹过");
	expect(parsed.progress).toBe(0);
	expect(parsed.opacity).toBe(0.92);
	expect(parsed.clickThrough).toBe(true);
	expect(parsed.font.fit.minPx).toBe(24);
	expect(parsed.font.fit.maxPx).toBe(72);
	expect(parsed.motion.fps).toBe(60);
	expect(parsed.position.x).toBe(80);
	expect(parsed.position.y).toBe(80);
});

test("desktop lyrics payload clamps progress opacity and position to transport bounds", () => {
	const parsed = DesktopLyricsPayloadSchema.parse({
		enabled: true,
		text: "boundaries",
		progress: 2,
		opacity: -1,
		position: { x: -20, y: 30000 }
	});

	expect(parsed.progress).toBe(1);
	expect(parsed.opacity).toBe(0);
	expect(parsed.position.x).toBe(0);
	expect(parsed.position.y).toBe(10000);
});

test("desktop lyrics payload validates supported fps values", () => {
	expect(DESKTOP_LYRICS_FPS_VALUES).toEqual([24, 30, 60, 120]);
	expect(DesktopLyricsPayloadSchema.parse({ enabled: true, text: "24", motion: { fps: 24 } }).motion.fps).toBe(24);
	expect(() => DesktopLyricsPayloadSchema.parse({ enabled: true, text: "bad", motion: { fps: 25 } })).toThrow();
});

test("desktop lyrics payload keeps colors and click-through knobs shared across layers", () => {
	const parsed = DesktopLyricsPayloadSchema.parse({
		enabled: true,
		text: "colors",
		colors: {
			primary: "#ffffff",
			secondary: "#ffd166",
			background: "rgba(0, 0, 0, 0.28)",
			glow: "rgba(255, 209, 102, 0.7)"
		},
		clickThrough: false,
		font: {
			family: "Microsoft YaHei UI",
			weight: 700,
			fit: { minPx: 18, maxPx: 96, stepPx: 2, maxLines: 2 }
		}
	});

	expect(parsed.colors.secondary).toBe("#ffd166");
	expect(parsed.clickThrough).toBe(false);
	expect(parsed.font.fit.maxLines).toBe(2);
});

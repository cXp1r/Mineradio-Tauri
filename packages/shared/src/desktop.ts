import { z } from "zod";

export const DESKTOP_LYRICS_FPS_VALUES = [24, 30, 60, 120] as const;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const ClampedNumberSchema = (min: number, max: number, fallback: number) =>
	z
		.number()
		.finite()
		.catch(fallback)
		.transform((value) => clamp(value, min, max))
		.default(fallback);

export const DesktopLyricsColorsSchema = z.object({
	primary: z.string().min(1).default("#ffffff"),
	secondary: z.string().min(1).default("#9fe7ff"),
	background: z.string().min(1).default("rgba(0, 0, 0, 0.22)"),
	glow: z.string().min(1).default("rgba(159, 231, 255, 0.68)")
});

export const DesktopLyricsPositionSchema = z.object({
	x: ClampedNumberSchema(0, 10000, 80),
	y: ClampedNumberSchema(0, 10000, 80)
});

export const DesktopLyricsFontFitSchema = z.object({
	minPx: ClampedNumberSchema(8, 160, 24),
	maxPx: ClampedNumberSchema(8, 240, 72),
	stepPx: ClampedNumberSchema(1, 16, 1),
	maxLines: z.number().int().min(1).max(4).default(1)
});

export const DesktopLyricsFontSchema = z
	.object({
		family: z.string().min(1).default("Microsoft YaHei UI, Segoe UI, sans-serif"),
		weight: z.union([z.number().int().min(100).max(900), z.string().min(1)]).default(700),
		fit: DesktopLyricsFontFitSchema.prefault({})
	})
	.transform((font) => ({
		...font,
		fit: {
			...font.fit,
			maxPx: Math.max(font.fit.minPx, font.fit.maxPx)
		}
	}));

export const DesktopLyricsMotionSchema = z.object({
	fps: z.union([
		z.literal(24),
		z.literal(30),
		z.literal(60),
		z.literal(120)
	]).default(60),
	reduceMotion: z.boolean().default(false),
	smoothingMs: ClampedNumberSchema(0, 2000, 120)
});

export const DesktopLyricsPayloadSchema = z.object({
	enabled: z.boolean().default(false),
	text: z.string().default(""),
	progress: ClampedNumberSchema(0, 1, 0),
	colors: DesktopLyricsColorsSchema.prefault({}),
	opacity: ClampedNumberSchema(0, 1, 0.92),
	position: DesktopLyricsPositionSchema.prefault({}),
	clickThrough: z.boolean().default(true),
	font: DesktopLyricsFontSchema.prefault({}),
	motion: DesktopLyricsMotionSchema.prefault({})
});

export type DesktopLyricsPayload = z.infer<typeof DesktopLyricsPayloadSchema>;

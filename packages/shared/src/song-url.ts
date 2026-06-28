import { z } from "zod";
import { TrackSchema } from "./track";

const PLAYBACK_QUALITY_VALUES = ["jymaster", "hires", "lossless", "exhigh", "standard"] as const;
export type PlaybackQuality = (typeof PLAYBACK_QUALITY_VALUES)[number];

const PLAYBACK_QUALITY_ALIASES: Record<string, PlaybackQuality> = {
	jymaster: "jymaster",
	master: "jymaster",
	svip: "jymaster",
	hires: "hires",
	"hi-res": "hires",
	highres: "hires",
	highest: "hires",
	lossless: "lossless",
	flac: "lossless",
	sq: "lossless",
	exhigh: "exhigh",
	high: "exhigh",
	"320k": "exhigh",
	hq: "exhigh",
	standard: "standard",
	normal: "standard",
	std: "standard",
};

export const PlaybackQualitySchema = z.preprocess((value) => {
	const normalized = typeof value === "string" ? PLAYBACK_QUALITY_ALIASES[value.toLowerCase()] : undefined;
	return normalized ?? value;
}, z.enum(PLAYBACK_QUALITY_VALUES));

export const SongUrlRequestSchema = z.object({
	track: TrackSchema,
	quality: PlaybackQualitySchema.optional(),
});

export type SongUrlRequest = z.infer<typeof SongUrlRequestSchema>;

export const SongUrlResultSchema = z.object({
	url: z.string(),
	proxied: z.boolean(),
	level: PlaybackQualitySchema.optional(),
	quality: z.string().optional(),
	br: z.number().int().nonnegative().optional(),
	requestedQuality: PlaybackQualitySchema.nullable().optional(),
});

export type SongUrlResult = z.infer<typeof SongUrlResultSchema>;

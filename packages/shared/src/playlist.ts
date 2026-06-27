import { z } from "zod";
import { ProviderIdSchema } from "./provider";
import { TrackSchema } from "./track";

export const PlaylistSummarySchema = z.object({
  provider: ProviderIdSchema,
  id: z.string().min(1),
  name: z.string(),
  coverUrl: z.string().optional().default(""),
  trackCount: z.number().int().nonnegative().optional(),
  trackIds: z.array(z.string()).default([])
});

export const PlaylistDetailSchema = PlaylistSummarySchema.extend({
  tracks: z.array(TrackSchema).default([])
});

export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>;
export type PlaylistDetail = z.infer<typeof PlaylistDetailSchema>;
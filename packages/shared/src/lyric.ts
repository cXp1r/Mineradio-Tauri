import { z } from "zod";
import { ProviderIdSchema } from "./provider";

export const LyricLineSchema = z.object({
  timeMs: z.number().nonnegative(),
  text: z.string(),
  translation: z.string().optional()
});

export const LyricPayloadSchema = z.object({
  provider: ProviderIdSchema,
  trackId: z.string().min(1),
  lines: z.array(LyricLineSchema),
  hasTranslation: z.boolean().default(false),
  isWordByWord: z.boolean().default(false)
});

export type LyricLine = z.infer<typeof LyricLineSchema>;
export type LyricPayload = z.infer<typeof LyricPayloadSchema>;
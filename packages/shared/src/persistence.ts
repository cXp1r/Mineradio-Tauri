import { z } from "zod";

export const PersistedVisualStateSchema = z.object({
  version: z.number().int().nonnegative(),
  preset: z.string().default("default"),
  intensity: z.number().min(0).max(1).default(0.5),
  custom: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.number().int().nonnegative().default(0)
});

export type PersistedVisualState = z.infer<typeof PersistedVisualStateSchema>;
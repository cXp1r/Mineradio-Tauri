import { z } from "zod";
import { ProviderIdSchema, ProviderCapabilitySchema } from "./provider";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  appVersion: z.string(),
  apiVersion: z.string(),
  schemaVersion: z.string(),
  providers: z.array(z.string())
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ProviderStatusEntrySchema = z.object({
  providerId: ProviderIdSchema,
  available: z.boolean(),
  capabilities: z.array(ProviderCapabilitySchema).default([]),
  message: z.string().optional()
});

export type ProviderStatusEntry = z.infer<typeof ProviderStatusEntrySchema>;
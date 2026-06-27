import { z } from "zod";
import { ProviderStatusEntrySchema } from "./health";

export const ProviderStatusSchema = ProviderStatusEntrySchema;

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const CapabilityMatrixSchema = z.object({
  version: z.string(),
  providers: z.array(ProviderStatusSchema).default([])
});

export type CapabilityMatrix = z.infer<typeof CapabilityMatrixSchema>;
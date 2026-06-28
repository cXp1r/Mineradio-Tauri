import { z } from "zod";
import { ProviderIdSchema } from "./provider";

export const ProviderSessionCookieAckSchema = z
  .object({
    provider: ProviderIdSchema,
    stored: z.boolean(),
  })
  .strict();

export type ProviderSessionCookieAck = z.infer<typeof ProviderSessionCookieAckSchema>;

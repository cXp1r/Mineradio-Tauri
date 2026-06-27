import { z } from "zod";

export const SongUrlResultSchema = z.object({
	url: z.string(),
	proxied: z.boolean(),
});

export type SongUrlResult = z.infer<typeof SongUrlResultSchema>;
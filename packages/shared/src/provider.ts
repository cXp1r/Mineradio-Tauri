import { z } from "zod";

export const ProviderIdSchema = z.enum(["netease", "qq"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderCapabilitySchema = z.enum([
  "search",
  "songUrl",
  "lyric",
  "playlistList",
  "playlistDetail",
  "loginStatus",
  "logout",
  "like",
  "comment",
  "podcast",
  "quality"
]);

export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
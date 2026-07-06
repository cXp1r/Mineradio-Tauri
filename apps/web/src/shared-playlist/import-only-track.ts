import type { Track } from "@mineradio/shared";

export function isImportOnlyTrack(track: Track | null | undefined): boolean {
  const id = String(track?.id ?? "");
  const sourceId = String(track?.sourceId ?? "");
  return /^import:/i.test(id) || /^import:/i.test(sourceId);
}

import type { LyricPayload } from "@mineradio/shared";
import { getLyricIndex, selectLyricIndexAtPosition } from "./lyric-index";

export function selectCurrentIndex(
	positionMs: number,
	payload: LyricPayload | null,
): number {
	return selectLyricIndexAtPosition(getLyricIndex(payload), positionMs);
}

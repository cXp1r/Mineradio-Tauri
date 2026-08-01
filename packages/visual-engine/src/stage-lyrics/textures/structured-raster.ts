import type { StageLyricLayoutResult } from "../layout/stage-lyric-layout";
import type { StageLyricsSettings } from "../model/stage-lyrics-settings";

export interface StageLyricRasterRow {
	readonly key: string;
	readonly text: string;
	readonly alpha: number;
	readonly scale: number;
	readonly weight?: number;
	readonly translationLine: boolean;
	readonly active: boolean;
	readonly offset: number;
}

export interface StageLyricRasterPayload {
	readonly rows: readonly StageLyricRasterRow[];
	readonly activeRowIndex: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * 将 layout module 的语义条目收敛为 Canvas/Shader 唯一需要理解的 raster interface。
 * 位置以 active row 为零点，避免纹理实现重新推断 display/translation 规则。
 */
export function createStageLyricRasterPayload(
	layout: StageLyricLayoutResult,
	settings: Pick<StageLyricsSettings, "contextSpread" | "edgeFade">,
): StageLyricRasterPayload {
	if (layout.entries.length === 0 || layout.activeEntryIndex < 0) {
		return Object.freeze({ rows: Object.freeze([]), activeRowIndex: -1 });
	}
	const activeEntry = layout.entries[layout.activeEntryIndex];
	if (!activeEntry) {
		return Object.freeze({ rows: Object.freeze([]), activeRowIndex: -1 });
	}
	const rawOffsets = layout.entries.map((entry) => (
		(entry.virtualIndex - activeEntry.virtualIndex) * settings.contextSpread
		+ (entry.lineOffset ?? 0)
	));
	const maxDistance = Math.max(1, ...rawOffsets.map((offset) => Math.abs(offset)));
	const rows = layout.entries.map((entry, index): StageLyricRasterRow => {
		const active = index === layout.activeEntryIndex;
		const distance = Math.abs(rawOffsets[index] ?? 0) / maxDistance;
		const edgeMultiplier = active
			? 1
			: 1 - clamp(settings.edgeFade, 0, 1) * distance * 0.58;
		return Object.freeze({
			key: entry.key,
			text: entry.text,
			alpha: active ? 1 : clamp(entry.alpha * edgeMultiplier, 0.08, 0.96),
			scale: clamp(entry.scale, 0.4, 1.2),
			...(entry.weight === undefined ? {} : { weight: entry.weight }),
			translationLine: entry.translationLine,
			active,
			offset: rawOffsets[index] ?? 0,
		});
	});
	return Object.freeze({
		rows: Object.freeze(rows),
		activeRowIndex: layout.activeEntryIndex,
	});
}

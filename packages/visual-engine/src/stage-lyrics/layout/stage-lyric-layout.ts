import type { LyricLine } from "../lyric-line-progress";
import type { StageLyricEntry } from "../model/stage-lyric-entry";
import type {
	StageLyricDisplayMode,
	StageLyricsSettings,
} from "../model/stage-lyrics-settings";

export interface StageLyricLayoutResult {
	readonly entries: readonly StageLyricEntry[];
	readonly activeEntryIndex: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function cleanText(value: unknown): string {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function stageLyricDisplayOffsets(
	mode: StageLyricDisplayMode,
	customLineCount: number,
): readonly number[] {
	if (mode === "single") return [0];
	if (mode === "dual") return [0, 1];
	const count = mode === "triple"
		? 3
		: mode === "cinema"
			? 5
			: clamp(Math.round(customLineCount), 1, 10);
	const activeSlot = Math.floor(count / 2);
	return Array.from({ length: count }, (_, index) => index - activeSlot);
}

export function stageLyricTranslationVisualGap(
	settings: Pick<StageLyricsSettings, "translationGap" | "translationScale">,
): number {
	return clamp(
		0.98 + (settings.translationGap - 0.28) * 0.36 + Math.max(0, settings.translationScale - 0.66) * 0.12,
		0.92,
		2.2,
	);
}

export function buildStageLyricPrimaryVirtualIndices(
	lines: readonly Pick<LyricLine, "translation">[],
	settings: Pick<StageLyricsSettings, "translationMode" | "translationGap" | "translationScale" | "contextSpread">,
): readonly number[] {
	if (lines.length === 0) return [];
	if (settings.translationMode === "off") {
		return lines.map((_, index) => index);
	}
	const visualGap = stageLyricTranslationVisualGap(settings);
	const primaryStep = clamp(visualGap + 0.82 + settings.translationScale * 0.14, 1.78, 2.88);
	const compactStep = clamp(1.04 + (settings.contextSpread - 1) * 0.1, 0.96, 1.24);
	const hasTranslation = (index: number) => cleanText(lines[index]?.translation).length > 0;
	const indices = [0];
	for (let index = 1; index < lines.length; index += 1) {
		const previous = index - 1;
		const step = hasTranslation(previous) || hasTranslation(index)
			? primaryStep
			: compactStep;
		indices[index] = indices[previous] + step;
	}
	return indices;
}

function baseEntry(
	line: LyricLine,
	lineIndex: number,
	currentIndex: number,
	virtualIndex: number,
	settings: StageLyricsSettings,
): StageLyricEntry {
	const delta = lineIndex - currentIndex;
	if (delta === 0) {
		return {
			key: `line:${lineIndex}`,
			text: cleanText(line.text),
			role: "current",
			lineIndex,
			virtualIndex,
			alpha: 1,
			scale: 1,
			translationLine: false,
		};
	}
	const distance = Math.abs(delta);
	const cinema = settings.displayMode === "cinema";
	const nearAlpha = cinema ? settings.contextOpacity : settings.contextOpacity * 0.92;
	const farAlpha = cinema ? settings.contextOpacity * 0.64 : settings.contextOpacity * 0.52;
	return {
		key: `line:${lineIndex}`,
		text: cleanText(line.text),
		role: delta < 0 ? "prev" : "next",
		lineIndex,
		virtualIndex,
		alpha: clamp(distance > 1 ? farAlpha : nearAlpha, 0.18, 0.92),
		scale: distance > 1 ? (cinema ? 0.82 : 0.78) : (cinema ? 0.9 : 0.88),
		translationLine: false,
	};
}

function translationEntry(
	parent: StageLyricEntry,
	translation: string,
	isCurrent: boolean,
	settings: StageLyricsSettings,
): StageLyricEntry {
	return {
		key: `translation:${parent.lineIndex}`,
		text: translation,
		role: "translation",
		parentRole: parent.role === "translation" ? "context" : parent.role,
		lineIndex: parent.lineIndex,
		parentIndex: parent.lineIndex,
		virtualIndex: parent.virtualIndex + stageLyricTranslationVisualGap(settings),
		alpha: isCurrent
			? clamp(settings.translationOpacity + 0.08, 0.48, 1)
			: clamp(parent.alpha * 0.62, 0.24, 0.6),
		scale: isCurrent
			? clamp(settings.translationScale * 1.08, 0.7, 1.12)
			: clamp(settings.translationScale * 0.92, 0.5, 0.96),
		weight: 650,
		lineOffset: 0,
		translationLine: true,
	};
}

function shouldInsertTranslation(
	entryIndex: number,
	activeEntryIndex: number,
	mode: StageLyricsSettings["translationMode"],
): boolean {
	if (mode === "off") return false;
	if (mode === "current") return entryIndex === activeEntryIndex;
	if (mode === "dual") {
		return entryIndex === activeEntryIndex || entryIndex === activeEntryIndex + 1;
	}
	return true;
}

export function buildStageLyricLayout(
	lines: readonly LyricLine[],
	currentIndex: number,
	settings: StageLyricsSettings,
	maxRows = Number.POSITIVE_INFINITY,
): StageLyricLayoutResult {
	if (lines.length === 0) return { entries: [], activeEntryIndex: -1 };
	const activeLine = clamp(Math.round(currentIndex), 0, lines.length - 1);
	const primaryVirtualIndices = buildStageLyricPrimaryVirtualIndices(lines, settings);
	const primaryEntries = stageLyricDisplayOffsets(settings.displayMode, settings.customLineCount)
		.map((offset) => activeLine + offset)
		.filter((lineIndex) => lineIndex >= 0 && lineIndex < lines.length)
		.map((lineIndex) => baseEntry(
			lines[lineIndex],
			lineIndex,
			activeLine,
			primaryVirtualIndices[lineIndex] ?? lineIndex,
			settings,
		))
		.filter((entry) => entry.text.length > 0);
	if (settings.displayMode === "dual" && primaryEntries.length === 1 && activeLine > 0) {
		const previousIndex = activeLine - 1;
		const previous = baseEntry(
			lines[previousIndex],
			previousIndex,
			activeLine,
			primaryVirtualIndices[previousIndex] ?? previousIndex,
			settings,
		);
		if (previous.text) primaryEntries.unshift(previous);
	}
	const primaryActiveIndex = primaryEntries.findIndex((entry) => entry.lineIndex === activeLine);
	const entries: StageLyricEntry[] = [];
	let activeEntryIndex = -1;
	const rowLimit = Number.isFinite(maxRows) ? Math.max(1, Math.round(maxRows)) : Number.POSITIVE_INFINITY;
	const visibleTranslationMode = settings.translationMode !== "off" && cleanText(lines[activeLine]?.translation)
		? settings.translationMode
		: "off";
	for (let index = 0; index < primaryEntries.length && entries.length < rowLimit; index += 1) {
		const entry = primaryEntries[index];
		if (index === primaryActiveIndex) activeEntryIndex = entries.length;
		entries.push(entry);
		if (entries.length >= rowLimit || !shouldInsertTranslation(index, primaryActiveIndex, visibleTranslationMode)) {
			continue;
		}
		const translation = cleanText(lines[entry.lineIndex]?.translation);
		if (translation) {
			entries.push(translationEntry(entry, translation, index === primaryActiveIndex, settings));
		}
	}
	return { entries, activeEntryIndex };
}

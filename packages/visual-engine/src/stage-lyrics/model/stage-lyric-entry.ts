export type StageLyricEntryRole =
	| "current"
	| "prev"
	| "next"
	| "context"
	| "translation";

export interface StageLyricEntry {
	readonly key: string;
	readonly text: string;
	readonly role: StageLyricEntryRole;
	readonly parentRole?: Exclude<StageLyricEntryRole, "translation">;
	readonly lineIndex: number;
	readonly parentIndex?: number;
	readonly virtualIndex: number;
	readonly alpha: number;
	readonly scale: number;
	readonly weight?: number;
	readonly lineOffset?: number;
	readonly translationLine: boolean;
}

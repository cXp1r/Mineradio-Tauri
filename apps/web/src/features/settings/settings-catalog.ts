import type { FxState } from "@mineradio/visual-engine";
import type { SettingsValueChange } from "./settings-transaction-controller";

export type SettingsTabId =
	| "common"
	| "interface"
	| "lyrics"
	| "motion"
	| "shelf"
	| "system";

export interface SettingsTabDefinition {
	id: SettingsTabId;
	label: string;
	description: string;
}

export const SETTINGS_TABS: readonly SettingsTabDefinition[] = [
	{ id: "common", label: "常用", description: "预设与常用调节" },
	{ id: "interface", label: "界面", description: "颜色、背景与玻璃" },
	{ id: "lyrics", label: "歌词", description: "歌词外观与桌面歌词" },
	{ id: "motion", label: "动效", description: "粒子、舞台与声景" },
	{ id: "shelf", label: "歌单架", description: "3D 歌单架模式与内容" },
	{ id: "system", label: "系统", description: "性能、缓存与桌面能力" },
] as const;

export type LowSpecSettings = Pick<
	FxState,
	| "performanceQuality"
	| "performanceBackground"
	| "coverResolution"
	| "aiDepth"
	| "bloom"
	| "backCover"
	| "lyricGlowParticles"
	| "particleLyrics"
>;

const LOW_SPEC_VALUES: LowSpecSettings = {
	performanceQuality: "eco",
	performanceBackground: "release",
	coverResolution: 0.9,
	aiDepth: false,
	bloom: false,
	backCover: false,
	lyricGlowParticles: false,
	particleLyrics: false,
};

export function buildLowSpecChanges(
	current: LowSpecSettings,
): Record<string, SettingsValueChange> {
	const changes: Record<string, SettingsValueChange> = {};
	for (const key of Object.keys(LOW_SPEC_VALUES) as Array<keyof LowSpecSettings>) {
		changes[key] = {
			before: current[key],
			after: LOW_SPEC_VALUES[key],
		};
	}
	return changes;
}

export function settingGroupMatches(
	query: string,
	terms: readonly string[],
): boolean {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return true;
	return terms.some((term) => term.toLocaleLowerCase().includes(normalized));
}

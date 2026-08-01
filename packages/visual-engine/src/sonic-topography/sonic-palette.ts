/**
 * Sonic Topography 视觉层的 Tauri 修改版本。
 * 直接上游：XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224，public/sonic-topography-preset.js。
 * 原始项目：yin-yizhen/sonic-topography@3ff303e，作者 Ajin；适用 Non-Commercial Learning License。
 * 完整来源、许可范围与修改告知见 THIRD_PARTY_NOTICES.md。
 */
import { Color } from "three";
import type { SonicColorSettings } from "./sonic-settings";

export interface SonicPaletteSnapshot {
	readonly primary?: string;
	readonly secondary?: string;
	readonly highlight?: string;
	readonly base?: string;
	readonly cool?: string;
	readonly warm?: string;
	readonly accent?: string;
}

export type SonicPaletteSupplier = () => SonicPaletteSnapshot | null;

export interface SonicPalette {
	readonly base: Color;
	readonly base2: Color;
	readonly cool: Color;
	readonly warm: Color;
	readonly accent: Color;
	readonly glow: number;
}

function safeColor(value: string | undefined, fallback: string): Color {
	try {
		return new Color(value ?? fallback);
	} catch {
		return new Color(fallback);
	}
}

export function resolveSonicPalette(
	settings: SonicColorSettings,
	coverPalette?: SonicPaletteSnapshot | null,
): SonicPalette {
	if (settings.mode === "cover" && coverPalette) {
		const primary = safeColor(coverPalette.primary ?? coverPalette.base, "#62d6ff");
		const secondary = safeColor(coverPalette.secondary ?? coverPalette.cool, settings.cool);
		const highlight = safeColor(coverPalette.highlight ?? coverPalette.accent, settings.accent);
		const base = primary.clone().lerp(safeColor(settings.base, "#05070c"), 0.84);
		return Object.freeze({
			base,
			base2: base.clone().lerp(highlight, 0.14),
			cool: primary.clone().lerp(new Color("#ffffff"), 0.08),
			warm: secondary.clone().lerp(new Color("#ffb15a"), 0.18),
			accent: highlight.clone().lerp(new Color("#ffffff"), 0.1),
			glow: Math.max(0, Math.min(1, settings.glow / 100)),
		});
	}
	const base = safeColor(settings.base, "#05070c");
	return Object.freeze({
		base,
		base2: base.clone().lerp(new Color("#ffffff"), 0.12),
		cool: safeColor(settings.cool, "#0066ff"),
		warm: safeColor(settings.warm, "#ff3c19"),
		accent: safeColor(settings.accent, "#33e6ff"),
		glow: Math.max(0, Math.min(1, settings.glow / 100)),
	});
}

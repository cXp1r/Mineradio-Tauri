import { Color } from "three";
import type { SonicColorSettings } from "./sonic-settings";

export interface SonicPaletteSnapshot {
	readonly base?: string;
	readonly cool?: string;
	readonly warm?: string;
	readonly accent?: string;
}

export type SonicPaletteSupplier = () => SonicPaletteSnapshot | null;

export interface SonicPalette {
	readonly base: Color;
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
	const source = settings.mode === "cover" ? coverPalette : null;
	return Object.freeze({
		base: safeColor(source?.base, settings.base),
		cool: safeColor(source?.cool, settings.cool),
		warm: safeColor(source?.warm, settings.warm),
		accent: safeColor(source?.accent, settings.accent),
		glow: Math.max(0, Math.min(1, settings.glow / 100)),
	});
}

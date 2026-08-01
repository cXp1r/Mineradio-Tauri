import { Color } from "three";
import {
	SONIC_WORKSHOP_THEME_COLORS,
	type SonicWorkshopSettings,
} from "./sonic-workshop-settings";

export interface SonicWorkshopCoverPalette {
	readonly primary?: string;
	readonly base?: string;
	readonly warm?: string;
	readonly cool?: string;
	readonly ripple?: string;
	readonly peak?: string;
}

export type SonicWorkshopCoverPaletteSupplier = () => SonicWorkshopCoverPalette | null;

export interface SonicWorkshopPalette {
	readonly primary: Color;
	readonly base: Color;
	readonly warm: Color;
	readonly cool: Color;
	readonly ripple: Color;
	readonly peak: Color;
}

function safeColor(value: string | undefined, fallback: string): Color {
	try {
		return new Color(value ?? fallback);
	} catch {
		return new Color(fallback);
	}
}

export function resolveSonicWorkshopPalette(
	settings: SonicWorkshopSettings,
	coverPalette?: SonicWorkshopCoverPalette | null,
): SonicWorkshopPalette {
	const theme = SONIC_WORKSHOP_THEME_COLORS[settings.theme];
	const source = settings.colors.mode === "theme"
		? theme
		: settings.colors.mode === "cover" && coverPalette
			? {
				primary: coverPalette.primary ?? settings.colors.primary,
				base: coverPalette.base ?? settings.colors.base,
				warm: coverPalette.warm ?? coverPalette.primary ?? settings.colors.warm,
				cool: coverPalette.cool ?? settings.colors.cool,
				ripple: coverPalette.ripple ?? coverPalette.peak ?? settings.colors.ripple,
				peak: coverPalette.peak ?? coverPalette.cool ?? settings.colors.peak,
			}
			: settings.colors;
	return Object.freeze({
		primary: safeColor(source.primary, theme.primary),
		base: safeColor(source.base, theme.base),
		warm: safeColor(source.warm, theme.warm),
		cool: safeColor(source.cool, theme.cool),
		ripple: safeColor(source.ripple, theme.ripple),
		peak: safeColor(source.peak, theme.peak),
	});
}

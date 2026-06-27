export interface LyricPalette {
	primary: string;
	secondary: string;
	highlight: string;
	glowColor: string;
}

export const DEFAULT_LYRIC_PALETTE: LyricPalette = {
	primary: "#d6f8ff",
	secondary: "#9cffdf",
	highlight: "#fff0b8",
	glowColor: "#9cffdf",
};

export function resolveLyricPalette(partial: Partial<LyricPalette> | undefined): LyricPalette {
	return {
		primary: partial?.primary?.trim() || DEFAULT_LYRIC_PALETTE.primary,
		secondary: partial?.secondary?.trim() || DEFAULT_LYRIC_PALETTE.secondary,
		highlight: partial?.highlight?.trim() || DEFAULT_LYRIC_PALETTE.highlight,
		glowColor: partial?.glowColor?.trim() || DEFAULT_LYRIC_PALETTE.glowColor,
	};
}
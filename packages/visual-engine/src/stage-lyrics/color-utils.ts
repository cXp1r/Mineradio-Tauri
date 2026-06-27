export interface RGB {
	r: number;
	g: number;
	b: number;
}

function clamp01(v: number): number {
	if (Number.isNaN(v)) return 0;
	return Math.max(0, Math.min(1, v));
}

function clamp255(v: number): number {
	if (Number.isNaN(v)) return 0;
	return Math.max(0, Math.min(255, v));
}

function hexToRgb(input: string, fallback: string): RGB {
	const str = String(input == null ? "" : input).replace(/^#/, "");
	if (str.length === 3) {
		const expanded = str
			.split("")
			.map((c) => c + c)
			.join("");
		return hexToRgb("#" + expanded, fallback);
	}
	if (!/^[0-9a-f]{6}$/i.test(str)) {
		if (fallback && fallback !== input) return hexToRgb(fallback, "#d6f8ff");
		return hexToRgb("#d6f8ff", "#d6f8ff");
	}
	const num = parseInt(str, 16);
	return {
		r: ((num >> 16) & 255) / 255,
		g: ((num >> 8) & 255) / 255,
		b: (num & 255) / 255,
	};
}

const NAMED_COLORS: Record<string, string> = {
	white: "#ffffff",
	black: "#000000",
	red: "#ff0000",
	green: "#00ff00",
	blue: "#0000ff",
	yellow: "#ffff00",
	cyan: "#00ffff",
	magenta: "#ff00ff",
	orange: "#ffa500",
	gold: "#ffd700",
	silver: "#c0c0c0",
	gray: "#808080",
	grey: "#808080",
	teal: "#008080",
	purple: "#800080",
	pink: "#ffc0cb",
	brown: "#a52a2a",
};

export function cssColorToThreeColor(css: string | undefined, fallback: string = "#d6f8ff"): RGB {
	const value = String(css ?? fallback ?? "#d6f8ff").trim();
	try {
		if (/^#[0-9a-f]{3}$/i.test(value) || /^#[0-9a-f]{6}$/i.test(value)) {
			return hexToRgb(value, fallback);
		}
		const m = value.match(/^rgba?\(\s*([.\d]+)\s*,\s*([.\d]+)\s*,\s*([.\d]+)/i);
		if (m) {
			return {
				r: clamp255(parseFloat(m[1])) / 255,
				g: clamp255(parseFloat(m[2])) / 255,
				b: clamp255(parseFloat(m[3])) / 255,
			};
		}
		const named = NAMED_COLORS[value.toLowerCase()];
		if (named) return hexToRgb(named, fallback);
		return hexToRgb(fallback ?? "#d6f8ff", "#d6f8ff");
	} catch {
		return hexToRgb(fallback ?? "#d6f8ff", "#d6f8ff");
	}
}

export function lyricThreeColor(css: string | undefined, fallback: string = "#d6f8ff", minLum: number = 0.34): RGB {
	const c = cssColorToThreeColor(css, fallback);
	const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
	const floor = minLum == null ? 0.34 : minLum;
	if (lum < floor) {
		const lift = floor - lum;
		c.r = clamp01(c.r + lift);
		c.g = clamp01(c.g + lift);
		c.b = clamp01(c.b + lift);
	}
	return c;
}
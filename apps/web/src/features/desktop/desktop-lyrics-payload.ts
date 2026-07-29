import type { JsonValue } from "../../tauri/runtime";
import type { CurrentBeatMapState } from "../playback/usePlaybackSessionRuntime";
import {
	customLyricFontFamily,
	type FxState,
	type LyricPalette,
} from "@mineradio/visual-engine";

export interface DesktopLyricsPayloadContext {
	title?: string;
	artist?: string;
	playing?: boolean;
	progressSpan?: number;
	positionMs?: number;
	durationMs?: number | null;
	playbackRate?: number;
	highBloom?: number;
	beatGlow?: number;
	beatPulse?: number;
	bass?: number;
	stageLyricPalette?: LyricPalette;
	hasNativeKaraoke?: boolean;
	beatMapKey?: string;
	beatMap?: JsonValue | null;
}

const DESKTOP_LYRIC_FONT_STACKS: Record<string, string> = {
	sans: 'Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",Arial,sans-serif',
	hei: '"Noto Sans SC","Microsoft YaHei",SimHei,"PingFang SC",sans-serif',
	song: '"Noto Serif SC","Source Han Serif SC",SimSun,"Songti SC",serif',
	"bold-song": '"Source Han Serif SC Heavy","Source Han Serif SC","Noto Serif SC Black","Noto Serif SC","STZhongsong","SimSun",serif',
	"stone-song": '"FZYaSongS-B-GB","FZCuSong-B09S","Source Han Serif SC Heavy","Noto Serif SC Black","STZhongsong","SimSun",serif',
	"kai-song": '"Kaiti SC","STKaiti","KaiTi","Source Han Serif SC","Noto Serif SC",serif',
	"serif-en": 'Georgia,"Times New Roman","Noto Serif SC","Source Han Serif SC",serif',
	gothic: '"UnifrakturCook","UnifrakturMaguntia","Old English Text MT","Blackletter","Cinzel Decorative","Noto Serif SC",serif',
	editorial: '"Didot","Bodoni 72","Libre Baskerville",Georgia,"Noto Serif SC",serif',
	humanist: '"Avenir Next","Segoe UI","Inter","Noto Sans SC","PingFang SC",sans-serif',
	round: '"HarmonyOS Sans SC","Microsoft YaHei UI","PingFang SC","Noto Sans SC",sans-serif',
	mono: '"JetBrains Mono",Consolas,"Noto Sans SC","Microsoft YaHei",monospace',
	display: '"Alibaba PuHuiTi","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
};

function clampNumber(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function normalizeDesktopLyricFontKey(key: unknown): string {
	const value = String(key || "sans").trim().toLowerCase();
	if (customLyricFontFamily(value)) return value;
	return Object.prototype.hasOwnProperty.call(DESKTOP_LYRIC_FONT_STACKS, value)
		? value
		: "sans";
}

function desktopLyricFontStackForKey(key: unknown): string {
	const normalized = normalizeDesktopLyricFontKey(key);
	const customFamily = customLyricFontFamily(normalized);
	return customFamily
		? `"${customFamily}",Inter,"Noto Sans SC","Microsoft YaHei",sans-serif`
		: DESKTOP_LYRIC_FONT_STACKS[normalized];
}

function desktopLyricFontWeightValue(fx: FxState): number {
	if (normalizeDesktopLyricFontKey(fx.lyricFont) === "stone-song") return 900;
	return Math.round(clampNumber(Number(fx.lyricWeight) || 900, 500, 900) / 50) * 50;
}

function desktopOverlayColorValue(value: unknown, fallback: string): string {
	const raw = String(value || "").trim();
	if (/^#[0-9a-f]{3}$/i.test(raw) || /^#[0-9a-f]{6}$/i.test(raw)) return raw;
	if (/^rgba?\(/i.test(raw) || /^hsla?\(/i.test(raw)) return raw;
	return fallback;
}

function beatMapArrayLength(map: Record<string, JsonValue>, key: string): number {
	const value = map[key];
	return Array.isArray(value) ? value.length : 0;
}

function beatMapNumber(map: Record<string, JsonValue>, key: string): number {
	const value = map[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function beatMapString(map: Record<string, JsonValue>, key: string, fallback: string): string {
	const value = map[key];
	return typeof value === "string" && value ? value : fallback;
}

export function desktopLyricsBeatMapKey(map: JsonValue | null, source = "mr"): string {
	if (!map || typeof map !== "object" || Array.isArray(map)) return "none";
	const record = map as Record<string, JsonValue>;
	const cameraCount = beatMapArrayLength(record, "cameraBeats") || beatMapArrayLength(record, "beats") || beatMapArrayLength(record, "kicks");
	const pulseCount = beatMapArrayLength(record, "pulseBeats") || beatMapArrayLength(record, "kicks");
	return [
		source,
		beatMapNumber(record, "analyzedAt"),
		cameraCount,
		pulseCount,
		Math.round(beatMapNumber(record, "duration") * 10),
		Math.round(beatMapNumber(record, "partialUntilSec") * 10),
		beatMapString(record, "tempoSource", "local"),
	].join("|");
}

export function desktopLyricsBeatMapContext(
	state: CurrentBeatMapState | null,
	force: boolean,
	lastKeyRef: { current: string },
): Pick<DesktopLyricsPayloadContext, "beatMapKey" | "beatMap"> {
	const key = state?.key ?? "none";
	const shouldSendMap = force || key !== lastKeyRef.current;
	return {
		beatMapKey: key,
		...(shouldSendMap ? { beatMap: state?.map ?? null } : {}),
	};
}

export function buildDesktopLyricsPayloadPatch(
	fx: FxState,
	text: string,
	progress: number,
	context: DesktopLyricsPayloadContext = {},
) {
	const size = clampNumber(fx.desktopLyricsSize, 0.72, 1.55);
	const yRatio = clampNumber(fx.desktopLyricsY, 0.08, 0.92);
	const durationSeconds = Math.max(0, Number(context.durationMs ?? 0) / 1000);
	const timeSeconds = Math.max(0, Number(context.positionMs ?? 0) / 1000);
	const fps = fx.desktopLyricsFps === 24 || fx.desktopLyricsFps === 30 || fx.desktopLyricsFps === 60 || fx.desktopLyricsFps === 120
		? fx.desktopLyricsFps
		: 60;
	return {
		enabled: true,
		text,
		progress: clampNumber(progress, 0, 1),
		progressSpan: clampNumber(Number(context.progressSpan ?? 4.8), 0, 60),
		title: context.title || "MineRadio-Tauri",
		artist: context.artist || "",
		playing: context.playing === true,
		size,
		y: yRatio,
		frameRate: fps,
		opacity: clampNumber(fx.desktopLyricsOpacity, 0.28, 1),
		position: { x: 80, y: Math.round(yRatio * 1000) },
		clickThrough: fx.desktopLyricsClickThrough,
		lyricGlowParticles: fx.lyricGlowParticles,
		cinema: fx.desktopLyricsCinema !== false,
		highlightFollow: fx.desktopLyricsHighlight === true,
		fontFamily: desktopLyricFontStackForKey(fx.lyricFont),
		fontWeight: desktopLyricFontWeightValue(fx),
		letterSpacing: clampNumber(Number(fx.lyricLetterSpacing) || 0, -0.04, 0.18),
		lineHeight: clampNumber(Number(fx.lyricLineHeight) || 1, 0.86, 1.35),
		lyricScale: clampNumber(Number(fx.lyricScale) || 1, 0.35, 1.65),
		feather: context.hasNativeKaraoke ? 0.03 : 0.055,
		beatMapKey: context.beatMapKey || "",
		...(Object.prototype.hasOwnProperty.call(context, "beatMap") ? { beatMap: context.beatMap ?? null } : {}),
		colors: {
			primary: desktopOverlayColorValue(context.stageLyricPalette?.primary ?? fx.lyricColor, "#d6f8ff"),
			secondary: desktopOverlayColorValue(context.stageLyricPalette?.secondary ?? fx.visualTintColor, "#9cffdf"),
			background: "rgba(0, 0, 0, 0.22)",
			highlight: desktopOverlayColorValue(context.stageLyricPalette?.highlight ?? fx.lyricHighlightColor, "#fff0b8"),
			glow: desktopOverlayColorValue(context.stageLyricPalette?.glowColor ?? fx.lyricGlowColor, "#9cffdf"),
		},
		font: {
			family: desktopLyricFontStackForKey(fx.lyricFont),
			weight: desktopLyricFontWeightValue(fx),
			fit: { minPx: Math.round(18 * size), maxPx: Math.round(64 * size), stepPx: 1, maxLines: 1 },
		},
		motion: {
			fps,
			reduceMotion: false,
			smoothingMs: 120,
			lyricGlow: fx.lyricGlow,
			lyricGlowBeat: fx.lyricGlowBeat,
			lyricGlowStrength: fx.lyricGlow ? clampNumber(Number(fx.lyricGlowStrength) || 0, 0, 0.85) : 0,
			highBloom: clampNumber(Number(context.highBloom ?? 0), 0, 1.45),
			beatGlow: clampNumber(Number(context.beatGlow ?? 0), 0, 1.7),
			beatPulse: clampNumber(Number(context.beatPulse ?? 0), 0, 1.4),
			bass: clampNumber(Number(context.bass ?? 0), 0, 1.2),
		},
		playback: {
			time: timeSeconds,
			duration: durationSeconds,
			rate: clampNumber(Number(context.playbackRate ?? 1), 0.25, 4),
		},
	};
}

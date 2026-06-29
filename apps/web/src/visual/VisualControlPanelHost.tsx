import { useCallback, useRef, useState, type ReactElement } from "react";
import { FX_DEFAULTS, type FxState } from "@mineradio/visual-engine";

const PRESETS = [
	{ id: 0, name: "Emily", desc: "封面粒子 · 歌词舞台" },
	{ id: 1, name: "隧穿", desc: "Tunnel drift" },
	{ id: 2, name: "轨道", desc: "Orbit lines" },
	{ id: 3, name: "虚空", desc: "Void field" },
	{ id: 4, name: "黑胶", desc: "Vinyl pulse" },
	{ id: 5, name: "星河", desc: "Wallpaper preview" },
	{ id: 6, name: "安魂", desc: "骷髅 · YUI7W" },
] as const;

type NumberKey = Extract<keyof FxState, string>;
type BooleanKey = Extract<keyof FxState, string>;

interface SliderDef {
	key: NumberKey;
	id: string;
	label: string;
	min: number;
	max: number;
	step: number;
}

interface ToggleDef {
	key: BooleanKey;
	id: string;
	label: string;
	disabled?: boolean;
	badge?: string;
	title?: string;
}

const MAIN_SLIDERS: SliderDef[] = [
	{ key: "backgroundOpacity", id: "fx-bgopacity", label: "背景透明度", min: 0, max: 1, step: 0.01 },
	{ key: "controlGlassChromaticOffset", id: "fx-glassaberration", label: "控制台玻璃色差", min: 0, max: 140, step: 1 },
	{ key: "intensity", id: "fx-intensity", label: "律动强度", min: 0.2, max: 1.6, step: 0.01 },
	{ key: "depth", id: "fx-depth", label: "立体感", min: 0.2, max: 1.8, step: 0.01 },
	{ key: "coverResolution", id: "fx-coverres", label: "封面清晰度", min: 0.75, max: 1.55, step: 0.01 },
	{ key: "cinemaShake", id: "fx-cineshake", label: "镜头晃动", min: 0, max: 1.8, step: 0.01 },
	{ key: "lyricGlowStrength", id: "fx-lyricglow", label: "歌词溢光", min: 0, max: 0.85, step: 0.01 },
];

const LYRIC_LAYOUT_SLIDERS: SliderDef[] = [
	{ key: "lyricLetterSpacing", id: "fx-lyricspacing", label: "字间距", min: -0.04, max: 0.18, step: 0.005 },
	{ key: "lyricLineHeight", id: "fx-lyriclineheight", label: "行距", min: 0.86, max: 1.35, step: 0.01 },
	{ key: "lyricWeight", id: "fx-lyricweight", label: "字重", min: 500, max: 900, step: 50 },
	{ key: "lyricScale", id: "fx-lyricscale", label: "歌词大小", min: 0.35, max: 1.65, step: 0.01 },
	{ key: "lyricOffsetX", id: "fx-lyricx", label: "水平位置", min: -2, max: 2, step: 0.01 },
	{ key: "lyricOffsetY", id: "fx-lyricy", label: "垂直位置", min: -1.2, max: 1.35, step: 0.01 },
	{ key: "lyricOffsetZ", id: "fx-lyricz", label: "景深位置", min: -1.6, max: 1.6, step: 0.01 },
	{ key: "lyricTiltX", id: "fx-lyrictiltx", label: "上下角度", min: -42, max: 42, step: 1 },
	{ key: "lyricTiltY", id: "fx-lyrictilty", label: "左右角度", min: -42, max: 42, step: 1 },
];

const ADVANCED_SLIDERS: SliderDef[] = [
	{ key: "point", id: "fx-point", label: "粒子尺寸", min: 0.5, max: 2.2, step: 0.01 },
	{ key: "speed", id: "fx-speed", label: "流速", min: 0.2, max: 2.5, step: 0.01 },
	{ key: "twist", id: "fx-twist", label: "扭曲", min: 0, max: 0.6, step: 0.01 },
	{ key: "color", id: "fx-color", label: "色彩张力", min: 0.5, max: 2, step: 0.01 },
	{ key: "bloomStrength", id: "fx-bloom", label: "溢光强度", min: 0, max: 1.6, step: 0.01 },
	{ key: "scatter", id: "fx-scatter", label: "离散感", min: 0, max: 0.5, step: 0.01 },
	{ key: "bgFade", id: "fx-bgfade", label: "背景压缩", min: 0, max: 1.2, step: 0.01 },
];

const OVERLAY_TOGGLES: ToggleDef[] = [
	{ key: "cinema", id: "t-cinema", label: "电影镜头" },
	{ key: "lyricGlow", id: "t-lyricGlow", label: "歌词溢光" },
	{ key: "lyricGlowBeat", id: "t-lyricGlowBeat", label: "鼓点溢光" },
	{ key: "lyricGlowParticles", id: "t-lyricGlowParticles", label: "歌词光粒" },
	{ key: "lyricCameraLock", id: "t-lyricCameraLock", label: "歌词镜头绑定" },
	{ key: "bloom", id: "t-bloom", label: "粒子溢光" },
	{ key: "edge", id: "t-edge", label: "轮廓高亮" },
	{ key: "desktopLyrics", id: "t-desktopLyrics", label: "桌面歌词" },
	{ key: "desktopLyricsClickThrough", id: "t-desktopLyricsClickThrough", label: "桌面歌词锁定" },
	{ key: "desktopLyricsCinema", id: "t-desktopLyricsCinema", label: "桌面歌词电影震动" },
	{ key: "desktopLyricsHighlight", id: "t-desktopLyricsHighlight", label: "桌面歌词高亮跟随" },
	{ key: "wallpaperMode", id: "t-wallpaperMode", label: "壁纸模式", disabled: true, badge: "开发中", title: "开发中，暂不可用" },
];

const LYRIC_FONTS = [
	["sans", "默认"],
	["hei", "黑体"],
	["song", "宋体"],
	["bold-song", "粗宋"],
	["stone-song", "石印宋"],
	["kai-song", "楷宋"],
	["serif-en", "Serif"],
	["gothic", "Gothic"],
	["editorial", "Editorial"],
	["humanist", "Humanist"],
	["mono", "等宽"],
	["display", "标题"],
] as const;

export interface VisualControlPanelHostProps {
	preset?: number;
	intensity?: number;
	settings?: Partial<FxState>;
	onPresetChange?: (preset: number) => void;
	onNumberSettingChange?: (key: keyof FxState, value: number) => void;
	onBooleanSettingChange?: (key: keyof FxState, value: boolean) => void;
	onStringSettingChange?: (key: keyof FxState, value: string) => void;
}

function numberValue(props: VisualControlPanelHostProps, key: keyof FxState): number {
	if (key === "intensity" && typeof props.intensity === "number") return props.intensity;
	const value = props.settings?.[key] ?? FX_DEFAULTS[key];
	return typeof value === "number" ? value : 0;
}

function booleanValue(props: VisualControlPanelHostProps, key: keyof FxState): boolean {
	const value = props.settings?.[key] ?? FX_DEFAULTS[key];
	return value === true;
}

function Slider(props: {
	def: SliderDef;
	hostProps: VisualControlPanelHostProps;
	onNumberSettingChange?: (key: keyof FxState, value: number) => void;
}): ReactElement {
	const value = numberValue(props.hostProps, props.def.key);
	const lastEmittedRef = useRef<string | null>(null);
	const emit = useCallback((raw: string) => {
		if (lastEmittedRef.current === raw) return;
		lastEmittedRef.current = raw;
		props.onNumberSettingChange?.(props.def.key, Number(raw));
	}, [props]);
	return (
		<div className="fx-slider">
			<label htmlFor={props.def.id}>{props.def.label}</label>
			<input
				id={props.def.id}
				type="range"
				min={props.def.min}
				max={props.def.max}
				step={props.def.step}
				value={value}
				onInput={(event) => emit(event.currentTarget.value)}
				onChange={(event) => emit(event.currentTarget.value)}
			/>
			<output>{formatOutput(value, props.def.step)}</output>
			<span aria-hidden="true" />
		</div>
	);
}

function formatOutput(value: number, step: number): string {
	if (step >= 1) return String(Math.round(value));
	if (step < 0.01) return value.toFixed(3);
	return value.toFixed(2);
}

export function VisualControlPanelHost(props: VisualControlPanelHostProps): ReactElement {
	const [open, setOpen] = useState(false);
	const preset = Math.max(0, Math.min(6, Math.round(props.preset ?? 0)));
	const changePreset = useCallback((next: number) => {
		props.onPresetChange?.(next);
	}, [props]);
	const toggleBoolean = useCallback((def: ToggleDef) => {
		if (def.disabled) return;
		props.onBooleanSettingChange?.(def.key, !booleanValue(props, def.key));
	}, [props]);
	const slider = (def: SliderDef) => (
		<Slider key={def.id} def={def} hostProps={props} onNumberSettingChange={props.onNumberSettingChange} />
	);

	return (
		<>
			<button id="fx-fab" className={open ? "active" : ""} title="视觉控制台" aria-label="视觉控制台" type="button" onClick={() => setOpen((v) => !v)}>
				<svg width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h8" /><path d="M16 7h4" /><circle cx="14" cy="7" r="2" /><path d="M4 17h4" /><path d="M12 17h8" /><circle cx="10" cy="17" r="2" /></svg>
			</button>
			<button id="fx-fab-hide-btn" type="button" title="自动隐藏视觉控制台" aria-label="自动隐藏视觉控制台">‹</button>
			<div id="fx-panel" className={open ? "show" : ""}>
				<div className="fx-head">
					<div>
						<div className="fx-title">视觉控制台</div>
						<div className="fx-sub">MINERADIO VISUALS · 鼠标移开自动隐藏</div>
					</div>
				</div>

				<div className="fx-section-label">视觉预设</div>
				<div className="preset-grid" id="preset-grid">
					{PRESETS.map((item) => (
						<button key={item.id} type="button" className={preset === item.id ? "preset-card active" : "preset-card"} data-preset={item.id} onClick={() => changePreset(item.id)}>
							<span className="pc-icon">{item.id === 6 ? "✦" : "◌"}</span>
							<span className="pc-name">{item.name}</span>
							<span className="pc-desc">{item.id === 6 ? <>骷髅 · <span className="pc-yui7w">YUI7W</span></> : item.desc}</span>
						</button>
					))}
				</div>
				<div className="fx-section-label">用户存档</div>
				<div className="user-archive-grid" id="user-archive-grid" />
				<div className="fx-section-label">自定义颜色</div>
				<div className="lyric-color-row">
					<input id="ui-accent-picker" className="lyric-color-picker" type="color" value={props.settings?.uiAccentColor ?? FX_DEFAULTS.uiAccentColor} onChange={() => {}} title="界面高亮色" />
					<div className="fx-color-row-label">界面高亮<small id="ui-accent-value">{props.settings?.uiAccentColor ?? FX_DEFAULTS.uiAccentColor}</small></div>
					<button className="fx-mini-btn ghost" type="button">默认</button>
				</div>
				<div className="lyric-color-row visual-tint-row">
					<input id="visual-tint-picker" className="lyric-color-picker" type="color" value={props.settings?.visualTintColor ?? FX_DEFAULTS.visualTintColor} onChange={() => {}} title="视觉主色" />
					<div className="fx-color-row-label">视觉主色<small id="visual-tint-value">封面取色</small></div>
					<button className="fx-mini-btn ghost" id="visual-tint-auto-btn" type="button">封面</button>
					<button className="fx-mini-btn ghost" type="button">默认</button>
				</div>
				{MAIN_SLIDERS.slice(0, 2).map(slider)}
				<div className="fx-section-label">主控</div>
				{MAIN_SLIDERS.slice(2).map(slider)}

				<div className="fx-fold open" id="fx-lyric-fold">
					<div className="fx-fold-head">
						<span className="fx-fold-title"><strong>歌词外观</strong><small>颜色 / 来源 / 位置</small></span><span className="arrow">▶</span>
					</div>
					<div className="fx-fold-body">
						<div className="fx-section-label">歌词字体</div>
						<div className="fx-font-grid expanded" id="lyric-font-grid">
							{LYRIC_FONTS.map(([key, label]) => (
								<button
									key={key}
									type="button"
									data-font={key}
									className={(props.settings?.lyricFont ?? FX_DEFAULTS.lyricFont) === key ? "active" : ""}
									onClick={() => props.onStringSettingChange?.("lyricFont", key)}
								>
									{label}
								</button>
							))}
						</div>
						{LYRIC_LAYOUT_SLIDERS.map(slider)}
					</div>
				</div>

				<div className="fx-fold open" id="fx-overlay-fold">
					<div className="fx-fold-head">
						<span className="fx-fold-title"><strong>叠加效果</strong><small>粒子 / 镜头 / 溢光</small></span><span className="arrow">▶</span>
					</div>
					<div className="fx-fold-body">
						<div className="fx-toggle-grid">
							{OVERLAY_TOGGLES.map((def) => (
								<button
									key={def.id}
									type="button"
									id={def.id}
									className={`${booleanValue(props, def.key) ? "fx-toggle on" : "fx-toggle"}${def.disabled ? " dev-locked" : ""}`}
									disabled={def.disabled}
									title={def.title}
									onClick={() => toggleBoolean(def)}
								>
									<span>{def.label}{def.badge ? <em className="fx-dev-badge">{def.badge}</em> : null}</span><span className="dot" />
								</button>
							))}
						</div>
					</div>
				</div>

				<div className="fx-fold open" id="fx-stage-fold">
					<div className="fx-fold-head">
						<span className="fx-fold-title"><strong>3D / 手势</strong><small>歌单架 / 摄像头交互</small></span><span className="arrow">▶</span>
					</div>
					<div className="fx-fold-body">
						<div className="fx-section-label">3D 歌单架</div>
						<div className="fx-seg" id="shelf-seg">
							<button type="button" data-shelf="off">关闭</button>
							<button type="button" data-shelf="side" className="active">侧栏</button>
							<button type="button" data-shelf="stage">舞台</button>
						</div>
						<div className="fx-section-label">摄像头交互</div>
						<div className="fx-seg" id="cam-seg">
							<button type="button" data-cam="off" className="active">关闭</button>
						</div>
					</div>
				</div>

				<div className="fx-advanced open" id="fx-advanced">
					<div className="fx-advanced-head"><span>高级参数</span><span className="arrow">▶</span></div>
					<div className="fx-advanced-body">
						<div className="fx-section-label">画质档位</div>
						<div className="fx-seg" id="performance-quality-seg">
							<button type="button" data-performance-quality="eco">低</button>
							<button type="button" data-performance-quality="balanced">中</button>
							<button type="button" data-performance-quality="high" className="active">高</button>
							<button type="button" data-performance-quality="ultra">超高</button>
						</div>
						{ADVANCED_SLIDERS.map(slider)}
					</div>
				</div>
			</div>
		</>
	);
}

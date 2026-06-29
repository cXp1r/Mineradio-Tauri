import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { FX_DEFAULTS, type FxState } from "@mineradio/visual-engine";

const FX_FAB_AUTO_HIDE_STORE_KEY = "mineradio-fx-fab-auto-hide-v1";

const PRESETS = [
  { id: 0, name: "Emily", desc: "封面粒子 · 歌词舞台" },
  { id: 1, name: "隧穿", desc: "Tunnel drift" },
  { id: 2, name: "轨道", desc: "Orbit lines" },
  { id: 3, name: "虚空", desc: "Void field" },
  { id: 4, name: "黑胶", desc: "Vinyl pulse" },
  { id: 5, name: "星河", desc: "静默流光" },
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

interface SegmentOption {
  value: string | number;
  label: string;
}

const MAIN_SLIDERS: SliderDef[] = [
  {
    key: "backgroundOpacity",
    id: "fx-bgopacity",
    label: "背景透明度",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "controlGlassChromaticOffset",
    id: "fx-glassaberration",
    label: "控制台玻璃色差",
    min: 0,
    max: 140,
    step: 1,
  },
  {
    key: "intensity",
    id: "fx-intensity",
    label: "律动强度",
    min: 0.2,
    max: 1.6,
    step: 0.01,
  },
  {
    key: "depth",
    id: "fx-depth",
    label: "立体感",
    min: 0.2,
    max: 1.8,
    step: 0.01,
  },
  {
    key: "coverResolution",
    id: "fx-coverres",
    label: "封面清晰度",
    min: 0.75,
    max: 1.55,
    step: 0.01,
  },
  {
    key: "cinemaShake",
    id: "fx-cineshake",
    label: "镜头晃动",
    min: 0,
    max: 1.8,
    step: 0.01,
  },
  {
    key: "lyricGlowStrength",
    id: "fx-lyricglow",
    label: "歌词溢光",
    min: 0,
    max: 0.85,
    step: 0.01,
  },
];

const LYRIC_LAYOUT_SLIDERS: SliderDef[] = [
  {
    key: "lyricLetterSpacing",
    id: "fx-lyricspacing",
    label: "字间距",
    min: -0.04,
    max: 0.18,
    step: 0.005,
  },
  {
    key: "lyricLineHeight",
    id: "fx-lyriclineheight",
    label: "行距",
    min: 0.86,
    max: 1.35,
    step: 0.01,
  },
  {
    key: "lyricWeight",
    id: "fx-lyricweight",
    label: "字重",
    min: 500,
    max: 900,
    step: 50,
  },
  {
    key: "lyricScale",
    id: "fx-lyricscale",
    label: "歌词大小",
    min: 0.35,
    max: 1.65,
    step: 0.01,
  },
  {
    key: "lyricOffsetX",
    id: "fx-lyricx",
    label: "水平位置",
    min: -2,
    max: 2,
    step: 0.01,
  },
  {
    key: "lyricOffsetY",
    id: "fx-lyricy",
    label: "垂直位置",
    min: -1.2,
    max: 1.35,
    step: 0.01,
  },
  {
    key: "lyricOffsetZ",
    id: "fx-lyricz",
    label: "景深位置",
    min: -1.6,
    max: 1.6,
    step: 0.01,
  },
  {
    key: "lyricTiltX",
    id: "fx-lyrictiltx",
    label: "上下角度",
    min: -42,
    max: 42,
    step: 1,
  },
  {
    key: "lyricTiltY",
    id: "fx-lyrictilty",
    label: "左右角度",
    min: -42,
    max: 42,
    step: 1,
  },
];

const DESKTOP_SLIDERS: SliderDef[] = [
  {
    key: "desktopLyricsSize",
    id: "fx-desktoplyricssize",
    label: "桌面歌词大小",
    min: 0.72,
    max: 1.55,
    step: 0.01,
  },
  {
    key: "desktopLyricsOpacity",
    id: "fx-desktoplyricsopacity",
    label: "桌面歌词透明",
    min: 0.28,
    max: 1,
    step: 0.01,
  },
  {
    key: "desktopLyricsY",
    id: "fx-desktoplyricsy",
    label: "桌面歌词高度",
    min: 0.08,
    max: 0.92,
    step: 0.01,
  },
];

const ADVANCED_SLIDERS: SliderDef[] = [
  {
    key: "point",
    id: "fx-point",
    label: "粒子尺寸",
    min: 0.5,
    max: 2.2,
    step: 0.01,
  },
  {
    key: "speed",
    id: "fx-speed",
    label: "流速",
    min: 0.2,
    max: 2.5,
    step: 0.01,
  },
  { key: "twist", id: "fx-twist", label: "扭曲", min: 0, max: 0.6, step: 0.01 },
  {
    key: "color",
    id: "fx-color",
    label: "色彩张力",
    min: 0.5,
    max: 2,
    step: 0.01,
  },
  {
    key: "bloomStrength",
    id: "fx-bloom",
    label: "溢光强度",
    min: 0,
    max: 1.6,
    step: 0.01,
  },
  {
    key: "scatter",
    id: "fx-scatter",
    label: "离散感",
    min: 0,
    max: 0.5,
    step: 0.01,
  },
  {
    key: "bgFade",
    id: "fx-bgfade",
    label: "背景压缩",
    min: 0,
    max: 1.2,
    step: 0.01,
  },
];

const OVERLAY_TOGGLES: ToggleDef[] = [
  { key: "cinema", id: "t-cinema", label: "电影镜头" },
  { key: "lyricGlow", id: "t-lyricGlow", label: "歌词溢光" },
  { key: "lyricGlowBeat", id: "t-lyricGlowBeat", label: "鼓点溢光" },
  { key: "lyricGlowParticles", id: "t-lyricGlowParticles", label: "歌词光粒" },
  { key: "lyricCameraLock", id: "t-lyricCameraLock", label: "歌词镜头绑定" },
  { key: "bloom", id: "t-bloom", label: "粒子溢光" },
  { key: "edge", id: "t-edge", label: "轮廓高亮" },
  {
    key: "aiDepth",
    id: "t-aidepth",
    label: "AI 立体增强",
    title: "首次会下载深度模型",
  },
  { key: "desktopLyrics", id: "t-desktopLyrics", label: "桌面歌词" },
  {
    key: "desktopLyricsClickThrough",
    id: "t-desktopLyricsClickThrough",
    label: "桌面歌词锁定",
  },
  {
    key: "desktopLyricsCinema",
    id: "t-desktopLyricsCinema",
    label: "桌面歌词电影震动",
  },
  {
    key: "desktopLyricsHighlight",
    id: "t-desktopLyricsHighlight",
    label: "桌面歌词高亮跟随",
  },
];

const SHELF_CONTENT_TOGGLES: ToggleDef[] = [
  {
    key: "shelfShowPodcasts",
    id: "t-shelfShowPodcasts",
    label: "显示播客歌单",
    title: "关闭后 3D 歌单架不显示播客收藏",
  },
  {
    key: "shelfMergeCollections",
    id: "t-shelfMergeCollections",
    label: "合并收藏歌单",
    title: "开启后我的歌单与收藏歌单按一条线连续滚动",
  },
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
  onNotice?: (message: string) => void;
}

function readFxFabAutoHidePreference(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(FX_FAB_AUTO_HIDE_STORE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveFxFabAutoHidePreference(value: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FX_FAB_AUTO_HIDE_STORE_KEY, value ? "1" : "0");
  } catch {
  }
}

function numberValue(
  props: VisualControlPanelHostProps,
  key: keyof FxState,
): number {
  if (key === "intensity" && typeof props.intensity === "number")
    return props.intensity;
  const value = props.settings?.[key] ?? FX_DEFAULTS[key];
  return typeof value === "number" ? value : 0;
}

function booleanValue(
  props: VisualControlPanelHostProps,
  key: keyof FxState,
): boolean {
  const value = props.settings?.[key] ?? FX_DEFAULTS[key];
  return value === true;
}

function stringValue(
  props: VisualControlPanelHostProps,
  key: keyof FxState,
): string {
  const value = props.settings?.[key] ?? FX_DEFAULTS[key];
  return typeof value === "string" ? value : "";
}

function hexSettingValue(
  props: VisualControlPanelHostProps,
  key: keyof FxState,
): string {
  const raw = props.settings?.[key] ?? FX_DEFAULTS[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  const normalized = value.startsWith("#") ? value : `#${value}`;
  const fallback = String(FX_DEFAULTS[key] ?? "#000000");
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : fallback;
}

function Slider(props: {
  def: SliderDef;
  hostProps: VisualControlPanelHostProps;
  onNumberSettingChange?: (key: keyof FxState, value: number) => void;
}): ReactElement {
  const value = numberValue(props.hostProps, props.def.key);
  const lastEmittedRef = useRef<string | null>(null);
  const emit = useCallback(
    (raw: string) => {
      if (lastEmittedRef.current === raw) return;
      lastEmittedRef.current = raw;
      props.onNumberSettingChange?.(props.def.key, Number(raw));
    },
    [props],
  );
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

function Segment(props: {
  id: string;
  keyName: keyof FxState;
  value: string | number;
  options: readonly SegmentOption[];
  dataName: string;
  onStringSettingChange?: (key: keyof FxState, value: string) => void;
  onNumberSettingChange?: (key: keyof FxState, value: number) => void;
}): ReactElement {
  return (
    <div className="fx-seg" id={props.id}>
      {props.options.map((option) => {
        const active = String(option.value) === String(props.value);
        const dataAttributes = { [`data-${props.dataName}`]: option.value };
        return (
          <button
            key={String(option.value)}
            type="button"
            className={active ? "active" : ""}
            {...dataAttributes}
            onClick={() => {
              if (typeof option.value === "number")
                props.onNumberSettingChange?.(props.keyName, option.value);
              else props.onStringSettingChange?.(props.keyName, option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function formatOutput(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  if (step < 0.01) return value.toFixed(3);
  return value.toFixed(2);
}

export function VisualControlPanelHost(
  props: VisualControlPanelHostProps,
): ReactElement {
  const [open, setOpen] = useState(false);
  const [autoHide, setAutoHide] = useState(readFxFabAutoHidePreference);
  const [peek, setPeek] = useState(false);
  const revealArmedRef = useRef(true);
  const previousAutoHideRef = useRef(autoHide);
  const preset = Math.max(0, Math.min(6, Math.round(props.preset ?? 0)));
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("fx-fab-auto-hide", autoHide);
    document.body.classList.toggle("fx-fab-peek", autoHide && (peek || open));
    return () => {
      document.body.classList.remove("fx-fab-auto-hide", "fx-fab-peek");
    };
  }, [autoHide, open, peek]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!autoHide) {
      revealArmedRef.current = true;
      previousAutoHideRef.current = false;
      setPeek(false);
      return;
    }
    if (!previousAutoHideRef.current) revealArmedRef.current = false;
    previousAutoHideRef.current = true;
    const updateFromPointer = (event: MouseEvent) => {
      const nearBottomRight = event.clientX > window.innerWidth - 126 && event.clientY > window.innerHeight - 158;
      if (!nearBottomRight) revealArmedRef.current = true;
      setPeek(open || (nearBottomRight && revealArmedRef.current));
    };
    const clearPeek = () => {
      revealArmedRef.current = true;
      setPeek(false);
    };
    window.addEventListener("mousemove", updateFromPointer);
    window.addEventListener("mouseleave", clearPeek);
    return () => {
      window.removeEventListener("mousemove", updateFromPointer);
      window.removeEventListener("mouseleave", clearPeek);
    };
  }, [autoHide, open]);
  const changePreset = useCallback(
    (next: number) => {
      props.onPresetChange?.(next);
    },
    [props],
  );
  const toggleBoolean = useCallback(
    (def: ToggleDef) => {
      if (def.disabled) return;
      props.onBooleanSettingChange?.(def.key, !booleanValue(props, def.key));
    },
    [props],
  );
  const toggle = (def: ToggleDef) => (
    <button
      key={def.id}
      type="button"
      id={def.id}
      className={`${booleanValue(props, def.key) ? "fx-toggle on" : "fx-toggle"}${def.disabled ? " dev-locked" : ""}`}
      disabled={def.disabled}
      title={def.title}
      onClick={() => toggleBoolean(def)}
    >
      <span>
        {def.label}
        {def.badge ? <em className="fx-dev-badge">{def.badge}</em> : null}
      </span>
      <span className="dot" />
    </button>
  );
  const slider = (def: SliderDef) => (
    <Slider
      key={def.id}
      def={def}
      hostProps={props}
      onNumberSettingChange={props.onNumberSettingChange}
    />
  );
  const setUiAccentColor = useCallback(
    (color: string) => {
      props.onStringSettingChange?.("uiAccentColor", color.toLowerCase());
    },
    [props],
  );
  const toggleAutoHide = useCallback(() => {
    const next = !autoHide;
    saveFxFabAutoHidePreference(next);
    revealArmedRef.current = !next;
    setAutoHide(next);
    setPeek(false);
    props.onNotice?.(next ? "视觉控制台按钮已自动隐藏" : "视觉控制台按钮已固定显示");
  }, [autoHide, props]);
  const resetUiAccentColor = useCallback(() => {
    props.onStringSettingChange?.("uiAccentColor", FX_DEFAULTS.uiAccentColor);
  }, [props]);
  const setVisualTintCustom = useCallback(
    (color: string) => {
      props.onStringSettingChange?.("visualTintMode", "custom");
      props.onStringSettingChange?.("visualTintColor", color.toLowerCase());
    },
    [props],
  );
  const setVisualTintAuto = useCallback(() => {
    props.onStringSettingChange?.("visualTintMode", "auto");
  }, [props]);
  const resetVisualTintColor = useCallback(() => {
    props.onStringSettingChange?.("visualTintMode", "auto");
    props.onStringSettingChange?.("visualTintColor", FX_DEFAULTS.visualTintColor);
  }, [props]);
  const setLyricColorCustom = useCallback(
    (color: string) => {
      props.onStringSettingChange?.("lyricColorMode", "custom");
      props.onStringSettingChange?.("lyricColor", color.toLowerCase());
    },
    [props],
  );
  const setLyricColorAuto = useCallback(() => {
    props.onStringSettingChange?.("lyricColorMode", "auto");
  }, [props]);
  const setLyricHighlightCustom = useCallback(
    (color: string) => {
      props.onStringSettingChange?.("lyricHighlightMode", "custom");
      props.onStringSettingChange?.("lyricHighlightColor", color.toLowerCase());
    },
    [props],
  );
  const setLyricHighlightAuto = useCallback(() => {
    props.onStringSettingChange?.("lyricHighlightMode", "auto");
  }, [props]);
  const toggleLyricGlowLinked = useCallback(() => {
    props.onBooleanSettingChange?.("lyricGlowLinked", !booleanValue(props, "lyricGlowLinked"));
  }, [props]);
  const setLyricGlowColor = useCallback(
    (color: string) => {
      props.onStringSettingChange?.("lyricGlowColor", color.toLowerCase());
    },
    [props],
  );
  const uiAccentColor = hexSettingValue(props, "uiAccentColor");
  const visualTintColor = hexSettingValue(props, "visualTintColor");
  const visualTintAuto = stringValue(props, "visualTintMode") !== "custom";
  const lyricColor = hexSettingValue(props, "lyricColor");
  const lyricColorAuto = stringValue(props, "lyricColorMode") !== "custom";
  const lyricHighlightColor = hexSettingValue(props, "lyricHighlightColor");
  const lyricHighlightAuto = stringValue(props, "lyricHighlightMode") !== "custom";
  const lyricGlowColor = hexSettingValue(props, "lyricGlowColor");
  const lyricGlowLinked = booleanValue(props, "lyricGlowLinked");

  return (
    <>
      <button
        id="fx-fab"
        className={open ? "active" : ""}
        title="视觉控制台"
        aria-label="视觉控制台"
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="21"
          height="21"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M4 7h8" />
          <path d="M16 7h4" />
          <circle cx="14" cy="7" r="2" />
          <path d="M4 17h4" />
          <path d="M12 17h8" />
          <circle cx="10" cy="17" r="2" />
        </svg>
      </button>
      <button
        id="fx-fab-hide-btn"
        className={autoHide ? "on" : ""}
        type="button"
        title={autoHide ? "取消自动隐藏视觉控制台" : "自动隐藏视觉控制台"}
        aria-label={autoHide ? "取消自动隐藏视觉控制台" : "自动隐藏视觉控制台"}
        aria-pressed={autoHide}
        onClick={toggleAutoHide}
      >
        {autoHide ? "›" : "‹"}
      </button>
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
            <button
              key={item.id}
              type="button"
              className={
                preset === item.id ? "preset-card active" : "preset-card"
              }
              data-preset={item.id}
              onClick={() => changePreset(item.id)}
            >
              <span className="pc-icon">{item.id === 6 ? "✦" : "◌"}</span>
              <span className="pc-name">{item.name}</span>
              <span className="pc-desc">
                {item.id === 6 ? (
                  <>
                    骷髅 · <span className="pc-yui7w">YUI7W</span>
                  </>
                ) : (
                  item.desc
                )}
              </span>
            </button>
          ))}
        </div>
        <div className="fx-section-label">用户存档</div>
        <div className="user-archive-grid" id="user-archive-grid" />
        <div className="fx-section-label">自定义颜色</div>
        <div className="lyric-color-row">
          <input
            id="ui-accent-picker"
            className="lyric-color-picker"
            type="color"
            value={uiAccentColor}
            onInput={(event) => setUiAccentColor(event.currentTarget.value)}
            title="界面高亮色"
          />
          <div className="fx-color-row-label">
            界面高亮
            <small id="ui-accent-value">
              {uiAccentColor.toUpperCase()}
            </small>
          </div>
          <button id="ui-accent-default-btn" className="fx-mini-btn ghost" type="button" onClick={resetUiAccentColor}>
            默认
          </button>
        </div>
        <div className="lyric-color-row visual-tint-row">
          <input
            id="visual-tint-picker"
            className="lyric-color-picker"
            type="color"
            value={visualTintColor}
            onInput={(event) => setVisualTintCustom(event.currentTarget.value)}
            title="视觉主色"
          />
          <div className="fx-color-row-label">
            视觉主色<small id="visual-tint-value">{visualTintAuto ? "封面取色" : visualTintColor.toUpperCase()}</small>
          </div>
          <button
            className={visualTintAuto ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"}
            id="visual-tint-auto-btn"
            type="button"
            onClick={setVisualTintAuto}
          >
            封面
          </button>
          <button id="visual-tint-default-btn" className="fx-mini-btn ghost" type="button" onClick={resetVisualTintColor}>
            默认
          </button>
        </div>
        {MAIN_SLIDERS.slice(0, 2).map(slider)}
        <div className="fx-section-label">主控</div>
        {MAIN_SLIDERS.slice(2).map(slider)}

        <div className="fx-fold open" id="fx-lyric-fold">
          <div className="fx-fold-head">
            <span className="fx-fold-title">
              <strong>歌词外观</strong>
              <small>颜色 / 来源 / 位置</small>
            </span>
            <span className="arrow">▶</span>
          </div>
          <div className="fx-fold-body">
            <div className="fx-section-label">歌词颜色</div>
            <div className="lyric-color-row">
              <input
                id="lyric-color-picker"
                className="lyric-color-picker"
                type="color"
                value={lyricColor}
                onInput={(event) => setLyricColorCustom(event.currentTarget.value)}
                title="歌词主色"
              />
              <div className="fx-color-row-label">
                歌词主色<small id="lyric-color-value">{lyricColorAuto ? "封面取色" : lyricColor.toUpperCase()}</small>
              </div>
              <button id="lyric-color-auto-btn" className={lyricColorAuto ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"} type="button" onClick={setLyricColorAuto}>
                封面
              </button>
            </div>
            <div className="lyric-color-row">
              <input
                id="lyric-highlight-picker"
                className="lyric-color-picker"
                type="color"
                value={lyricHighlightColor}
                onInput={(event) => setLyricHighlightCustom(event.currentTarget.value)}
                title="歌词高亮色"
              />
              <div className="fx-color-row-label">
                歌词高亮<small id="lyric-highlight-value">{lyricHighlightAuto ? "封面取色" : lyricHighlightColor.toUpperCase()}</small>
              </div>
              <button id="lyric-highlight-auto-btn" className={lyricHighlightAuto ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"} type="button" onClick={setLyricHighlightAuto}>
                封面
              </button>
            </div>
            <div className="lyric-color-row">
              <input
                id="lyric-glow-picker"
                className="lyric-color-picker"
                type="color"
                value={lyricGlowColor}
                onInput={(event) => setLyricGlowColor(event.currentTarget.value)}
                title="歌词溢光色"
              />
              <div className="fx-color-row-label">
                溢光色<small id="lyric-glow-value">{lyricGlowLinked ? "跟随高亮" : lyricGlowColor.toUpperCase()}</small>
              </div>
              <button id="lyric-glow-linked" className={lyricGlowLinked ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"} type="button" onClick={toggleLyricGlowLinked}>
                链接
              </button>
            </div>
            <div className="fx-section-label">歌词字体</div>
            <div className="fx-font-grid expanded" id="lyric-font-grid">
              {LYRIC_FONTS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  data-font={key}
                  className={
                    (props.settings?.lyricFont ?? FX_DEFAULTS.lyricFont) === key
                      ? "active"
                      : ""
                  }
                  onClick={() =>
                    props.onStringSettingChange?.("lyricFont", key)
                  }
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
            <span className="fx-fold-title">
              <strong>叠加效果</strong>
              <small>粒子 / 镜头 / 溢光</small>
            </span>
            <span className="arrow">▶</span>
          </div>
          <div className="fx-fold-body">
            <div className="fx-toggle-grid">{OVERLAY_TOGGLES.map(toggle)}</div>
            <div className="fx-section-label">桌面歌词</div>
            {DESKTOP_SLIDERS.map(slider)}
            <div className="fx-section-label">桌面帧数</div>
            <Segment
              id="desktop-lyrics-fps-seg"
              keyName="desktopLyricsFps"
              value={numberValue(props, "desktopLyricsFps")}
              dataName="desktop-lyrics-fps"
              options={[
                { value: 24, label: "24" },
                { value: 30, label: "30" },
                { value: 60, label: "60" },
                { value: 120, label: "120" },
                { value: 0, label: "无上限" },
              ]}
              onNumberSettingChange={props.onNumberSettingChange}
            />
          </div>
        </div>

        <div className="fx-fold open" id="fx-stage-fold">
          <div className="fx-fold-head">
            <span className="fx-fold-title">
              <strong>3D 歌单架</strong>
              <small>模式 / 内容</small>
            </span>
            <span className="arrow">▶</span>
          </div>
          <div className="fx-fold-body">
            <div className="fx-section-label">3D 歌单架</div>
            <Segment
              id="shelf-seg"
              keyName="shelf"
              value={stringValue(props, "shelf") || "side"}
              dataName="shelf"
              options={[
                { value: "off", label: "关闭" },
                { value: "side", label: "侧栏" },
                { value: "stage", label: "舞台" },
              ]}
              onStringSettingChange={props.onStringSettingChange}
            />
            <div className="fx-section-label">歌单架镜头</div>
            <Segment
              id="shelf-camera-seg"
              keyName="shelfCameraMode"
              value={stringValue(props, "shelfCameraMode") || "static"}
              dataName="shelf-camera"
              options={[
                { value: "dynamic", label: "动态镜头" },
                { value: "static", label: "静态镜头" },
              ]}
              onStringSettingChange={props.onStringSettingChange}
            />
            <div className="fx-section-label">歌单架显示</div>
            <Segment
              id="shelf-presence-seg"
              keyName="shelfPresence"
              value={stringValue(props, "shelfPresence") || "always"}
              dataName="shelf-presence"
              options={[
                { value: "auto", label: "自动隐藏" },
                { value: "always", label: "常驻" },
              ]}
              onStringSettingChange={props.onStringSettingChange}
            />
            <div className="fx-section-label">歌单架内容</div>
            <div className="fx-toggle-grid">
              {SHELF_CONTENT_TOGGLES.map(toggle)}
            </div>
          </div>
        </div>

        <div className="fx-advanced open" id="fx-advanced">
          <div className="fx-advanced-head">
            <span>高级参数</span>
            <span className="arrow">▶</span>
          </div>
          <div className="fx-advanced-body">
            <div className="fx-section-label">直播 / 后台</div>
            <Segment
              id="performance-background-seg"
              keyName="performanceBackground"
              value={stringValue(props, "performanceBackground") || "auto"}
              dataName="performance-background"
              options={[
                { value: "auto", label: "自动优化" },
                { value: "keep", label: "保持运行" },
                { value: "release", label: "停止释放" },
              ]}
              onStringSettingChange={props.onStringSettingChange}
            />
            <div className="fx-section-label">画质档位</div>
            <Segment
              id="performance-quality-seg"
              keyName="performanceQuality"
              value={stringValue(props, "performanceQuality") || "high"}
              dataName="performance-quality"
              options={[
                { value: "eco", label: "低" },
                { value: "balanced", label: "中" },
                { value: "high", label: "高" },
                { value: "ultra", label: "超高" },
              ]}
              onStringSettingChange={props.onStringSettingChange}
            />
            {ADVANCED_SLIDERS.map(slider)}
          </div>
        </div>
      </div>
    </>
  );
}

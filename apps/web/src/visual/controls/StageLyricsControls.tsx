import { type ReactElement } from "react";
import {
  DEFAULT_STAGE_LYRICS_SETTINGS,
  type FxStatePatch,
  type StageLyricsSettings,
} from "@mineradio/visual-engine";

interface StageLyricsControlsProps {
  readonly settings?: FxStatePatch;
  readonly onFxPatchChange?: (patch: FxStatePatch) => void;
}

type NumericStageLyricsKey = {
  [Key in keyof StageLyricsSettings]-?: StageLyricsSettings[Key] extends number
    ? Key
    : never;
}[keyof StageLyricsSettings];

interface StageLyricsSliderDefinition {
  readonly key: NumericStageLyricsKey;
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

interface StageLyricsToggleDefinition {
  readonly key:
    | "glitchCameraBind"
    | "verticalFloat"
    | "backgroundStarRiver"
    | "pauseHold";
  readonly id: string;
  readonly label: string;
}

const DISPLAY_MODE_OPTIONS = [
  ["single", "单行"],
  ["dual", "双行"],
  ["triple", "三行"],
  ["cinema", "影院"],
  ["custom", "自定义"],
] as const satisfies ReadonlyArray<readonly [StageLyricsSettings["displayMode"], string]>;

const TRANSLATION_MODE_OPTIONS = [
  ["off", "关闭"],
  ["current", "当前"],
  ["dual", "双行"],
  ["multi", "多行"],
] as const satisfies ReadonlyArray<readonly [StageLyricsSettings["translationMode"], string]>;

const MOTION_STYLE_OPTIONS = [
  ["glass", "玻璃"],
  ["smooth", "柔和"],
  ["float", "浮动"],
  ["quick", "快速"],
  ["shine", "闪耀"],
  ["glitch", "故障"],
] as const satisfies ReadonlyArray<readonly [StageLyricsSettings["motionStyle"], string]>;

/** Stage 控件与设置搜索共用的唯一文案目录。 */
export const STAGE_LYRICS_CONTROL_DEFINITIONS = Object.freeze({
  title: "舞台歌词 2.0",
  summary: "行数 / 翻译 / 动效",
  displayMode: Object.freeze({
    label: "显示模式",
    options: DISPLAY_MODE_OPTIONS,
  }),
  translationMode: Object.freeze({
    label: "翻译显示",
    options: TRANSLATION_MODE_OPTIONS,
  }),
  motionStyle: Object.freeze({
    label: "动效",
    options: MOTION_STYLE_OPTIONS,
  }),
  sliders: Object.freeze([
    { key: "customLineCount", id: "stage-custom-line-count", label: "自定义行数", min: 1, max: 10, step: 1 },
    { key: "contextOpacity", id: "stage-context-opacity", label: "上下文透明度", min: 0.25, max: 1, step: 0.01 },
    { key: "contextSpread", id: "stage-context-spread", label: "上下文间距", min: 0.6, max: 2.4, step: 0.01 },
    { key: "translationGap", id: "stage-translation-gap", label: "翻译间距", min: 0.28, max: 2.2, step: 0.01 },
    { key: "translationScale", id: "stage-translation-scale", label: "翻译缩放", min: 0.46, max: 1.12, step: 0.01 },
    { key: "translationOpacity", id: "stage-translation-opacity", label: "翻译透明度", min: 0.2, max: 1, step: 0.01 },
    { key: "edgeFade", id: "stage-edge-fade", label: "边缘淡化", min: 0, max: 1, step: 0.01 },
    { key: "motionSoftness", id: "stage-motion-softness", label: "动效柔和度", min: 0.15, max: 1.2, step: 0.01 },
    { key: "glitchIntensity", id: "stage-glitch-intensity", label: "故障强度", min: 0, max: 1.5, step: 0.01 },
    { key: "glitchSlice", id: "stage-glitch-slice", label: "故障切片", min: 0, max: 1.4, step: 0.01 },
    { key: "textureClarity", id: "stage-texture-clarity", label: "纹理清晰度", min: 1, max: 4, step: 1 },
  ] satisfies readonly StageLyricsSliderDefinition[]),
  toggles: Object.freeze([
    { key: "verticalFloat", id: "t-stage-vertical-float", label: "垂直漂浮" },
    { key: "backgroundStarRiver", id: "t-stage-star-river", label: "背景星河" },
    { key: "glitchCameraBind", id: "t-stage-glitch-camera-bind", label: "故障镜头绑定" },
    { key: "pauseHold", id: "t-stage-pause-hold", label: "暂停保持" },
  ] satisfies readonly StageLyricsToggleDefinition[]),
});

export const STAGE_LYRICS_SETTINGS_SEARCH_TERMS = Object.freeze([
  STAGE_LYRICS_CONTROL_DEFINITIONS.title,
  STAGE_LYRICS_CONTROL_DEFINITIONS.summary,
  STAGE_LYRICS_CONTROL_DEFINITIONS.displayMode.label,
  ...STAGE_LYRICS_CONTROL_DEFINITIONS.displayMode.options.map(([, label]) => label),
  STAGE_LYRICS_CONTROL_DEFINITIONS.translationMode.label,
  ...STAGE_LYRICS_CONTROL_DEFINITIONS.translationMode.options.map(([, label]) => label),
  STAGE_LYRICS_CONTROL_DEFINITIONS.motionStyle.label,
  ...STAGE_LYRICS_CONTROL_DEFINITIONS.motionStyle.options.map(([, label]) => label),
  ...STAGE_LYRICS_CONTROL_DEFINITIONS.sliders.map(({ label }) => label),
  ...STAGE_LYRICS_CONTROL_DEFINITIONS.toggles.map(({ label }) => label),
]);

interface SliderProps {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (value: number) => void;
}

function Slider(props: SliderProps): ReactElement {
  return (
    <div className="fx-slider">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(event) => props.onChange(Number(event.currentTarget.value))}
      />
      <output>{props.step >= 1 ? Math.round(props.value) : props.value.toFixed(2)}</output>
      <span aria-hidden="true" />
    </div>
  );
}

/**
 * 只提交完整设置快照，不直接访问 visual engine；归一化统一由 visual store 完成。
 */
export function StageLyricsControls(props: StageLyricsControlsProps): ReactElement {
  const stage = {
    ...DEFAULT_STAGE_LYRICS_SETTINGS,
    ...props.settings?.stageLyrics,
  } as StageLyricsSettings;
  const patch = (next: Partial<StageLyricsSettings>) => {
    props.onFxPatchChange?.({ stageLyrics: { ...stage, ...next } });
  };
  const patchNumber = (key: NumericStageLyricsKey, value: number) => {
    const normalized = key === "textureClarity"
      ? Math.round(value) as StageLyricsSettings["textureClarity"]
      : value;
    patch({ [key]: normalized } as Partial<StageLyricsSettings>);
  };
  const toggle = ({ key, label, id }: StageLyricsToggleDefinition) => (
    <button
      id={id}
      key={key}
      type="button"
      className={stage[key] ? "fx-toggle on" : "fx-toggle"}
      onClick={() => patch({ [key]: !stage[key] })}
    >
      <span>{label}</span><span className="dot" />
    </button>
  );

  return (
    <div className="fx-fold open" id="fx-stage-lyrics-fold">
      <div className="fx-fold-head">
        <span className="fx-fold-title"><strong>{STAGE_LYRICS_CONTROL_DEFINITIONS.title}</strong><small>{STAGE_LYRICS_CONTROL_DEFINITIONS.summary}</small></span>
        <span className="arrow">▶</span>
      </div>
      <div className="fx-fold-body">
        <div className="fx-section-label">{STAGE_LYRICS_CONTROL_DEFINITIONS.displayMode.label}</div>
        <div className="fx-seg" id="stage-display-mode-seg">
          {STAGE_LYRICS_CONTROL_DEFINITIONS.displayMode.options.map(([value, label]) => <button key={value} type="button" data-stage-display-mode={value} className={stage.displayMode === value ? "active" : ""} onClick={() => patch({ displayMode: value })}>{label}</button>)}
        </div>
        <div className="fx-section-label">{STAGE_LYRICS_CONTROL_DEFINITIONS.translationMode.label}</div>
        <div className="fx-seg" id="stage-translation-mode-seg">
          {STAGE_LYRICS_CONTROL_DEFINITIONS.translationMode.options.map(([value, label]) => <button key={value} type="button" data-stage-translation-mode={value} className={stage.translationMode === value ? "active" : ""} onClick={() => patch({ translationMode: value })}>{label}</button>)}
        </div>
        <div className="fx-section-label">{STAGE_LYRICS_CONTROL_DEFINITIONS.motionStyle.label}</div>
        <div className="fx-seg" id="stage-motion-style-seg">
          {STAGE_LYRICS_CONTROL_DEFINITIONS.motionStyle.options.map(([value, label]) => <button key={value} type="button" data-stage-motion-style={value} className={stage.motionStyle === value ? "active" : ""} onClick={() => patch({ motionStyle: value })}>{label}</button>)}
        </div>
        {STAGE_LYRICS_CONTROL_DEFINITIONS.sliders.map((control) => (
          <Slider
            key={control.key}
            id={control.id}
            label={control.label}
            value={stage[control.key]}
            min={control.min}
            max={control.max}
            step={control.step}
            onChange={(value) => patchNumber(control.key, value)}
          />
        ))}
        <div className="fx-toggle-grid">
          {STAGE_LYRICS_CONTROL_DEFINITIONS.toggles.map(toggle)}
        </div>
      </div>
    </div>
  );
}

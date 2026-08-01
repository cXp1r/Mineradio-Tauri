import { type ReactElement } from "react";
import {
  SONIC_WORKSHOP_DEFAULTS,
  SONIC_WORKSHOP_THEME_COLORS,
  normalizeSonicWorkshopSettings,
  type FxStatePatch,
  type SonicWorkshopSettings,
  type SonicWorkshopTheme,
} from "@mineradio/visual-engine";

interface SonicWorkshopControlsProps {
  readonly settings?: FxStatePatch;
  readonly onFxPatchChange?: (patch: FxStatePatch) => void;
}

interface WorkshopSliderDefinition {
  readonly key: "inputGain" | "audioIntensity" | "responseRange" | "peakIntensity";
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

const WORKSHOP_SLIDERS = Object.freeze([
  { key: "inputGain", id: "workshop-input-gain", label: "输入增益", min: 40, max: 100, step: 1 },
  { key: "audioIntensity", id: "workshop-audio-intensity", label: "音频强度", min: 0.3, max: 2.5, step: 0.01 },
  { key: "responseRange", id: "workshop-response-range", label: "响应范围", min: 0.3, max: 2, step: 0.01 },
  { key: "peakIntensity", id: "workshop-peak-intensity", label: "峰值强度", min: 0, max: 1.4, step: 0.01 },
] as const satisfies readonly WorkshopSliderDefinition[]);

const PUBLIC_THEMES = Object.freeze([
  { value: "coral-mirage", label: "珊瑚" },
  { value: "ocean-deep", label: "深海" },
  { value: "arctic-aurora", label: "冰蓝" },
  { value: "cyber-forest", label: "翠绿" },
  { value: "minimal-monochrome", label: "极简" },
] as const satisfies ReadonlyArray<{ value: SonicWorkshopTheme; label: string }>);

const COLOR_FIELDS = Object.freeze([
  { key: "primary", id: "workshop-color-primary", label: "主色" },
  { key: "base", id: "workshop-color-base", label: "基底" },
  { key: "warm", id: "workshop-color-warm", label: "暖区" },
  { key: "cool", id: "workshop-color-cool", label: "冷区" },
  { key: "ripple", id: "workshop-color-ripple", label: "涟漪" },
  { key: "peak", id: "workshop-color-peak", label: "峰值" },
] as const satisfies ReadonlyArray<{
  key: keyof SonicWorkshopSettings["colors"];
  id: string;
  label: string;
}>);

export const SONIC_WORKSHOP_SETTINGS_SEARCH_TERMS = Object.freeze([
  "音域回响 Wallpaper Engine",
  "Sonic Workshop",
  "CmzYa",
  ...WORKSHOP_SLIDERS.map(({ label }) => label),
  ...PUBLIC_THEMES.map(({ label }) => label),
  "封面取色",
  "主题配色",
  "自定义颜色",
  ...COLOR_FIELDS.map(({ label }) => label),
  "显示封面",
]);

function formatWorkshopOutput(value: number, step: number): string {
  return step >= 1 ? String(Math.round(value)) : value.toFixed(2);
}

function WorkshopSlider(props: {
  readonly definition: WorkshopSliderDefinition;
  readonly value: number;
  readonly onChange: (value: number) => void;
}): ReactElement {
  return (
    <div className="fx-slider">
      <label htmlFor={props.definition.id}>{props.definition.label}</label>
      <input
        id={props.definition.id}
        type="range"
        min={props.definition.min}
        max={props.definition.max}
        step={props.definition.step}
        value={props.value}
        onInput={(event) => props.onChange(Number(event.currentTarget.value))}
      />
      <output>{formatWorkshopOutput(props.value, props.definition.step)}</output>
      <span aria-hidden="true" />
    </div>
  );
}

/**
 * Workshop 只编辑公开设置快照；运行时资源与音频生命周期仍由视觉引擎拥有。
 */
export function SonicWorkshopControls(
  props: SonicWorkshopControlsProps,
): ReactElement {
  const workshop = normalizeSonicWorkshopSettings(
    props.settings?.workshop ?? SONIC_WORKSHOP_DEFAULTS,
  );
  const patch = (next: Partial<SonicWorkshopSettings>): void => {
    props.onFxPatchChange?.({ workshop: { ...workshop, ...next } });
  };
  const selectTheme = (theme: SonicWorkshopTheme): void => {
    patch({
      theme,
      colors: {
        mode: "theme",
        ...SONIC_WORKSHOP_THEME_COLORS[theme],
      },
    });
  };

  return (
    <div className="fx-fold open" id="fx-sonic-workshop-fold">
      <div className="fx-fold-head">
        <span className="fx-fold-title">
          <strong>音域回响 Wallpaper Engine</strong>
          <small>CmzYa · 频谱柱阵 / 涟漪 / 峰值</small>
        </span>
        <span className="arrow">▶</span>
      </div>
      <div className="fx-fold-body">
        <div className="fx-section-label">音频响应</div>
        {WORKSHOP_SLIDERS.map((definition) => (
          <WorkshopSlider
            key={definition.key}
            definition={definition}
            value={workshop[definition.key]}
            onChange={(value) => patch({ [definition.key]: value })}
          />
        ))}

        <div className="fx-section-label">公开主题</div>
        <div className="fx-seg" id="workshop-theme-seg">
          {PUBLIC_THEMES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={workshop.theme === value ? "active" : ""}
              data-workshop-theme={value}
              onClick={() => selectTheme(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="fx-section-label">区域颜色</div>
        <div className="fx-seg" id="workshop-color-mode-seg">
          {([
            ["cover", "封面取色"],
            ["theme", "主题配色"],
            ["custom", "自定义"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={workshop.colors.mode === value ? "active" : ""}
              data-workshop-color-mode={value}
              onClick={() => patch({ colors: { ...workshop.colors, mode: value } })}
            >
              {label}
            </button>
          ))}
        </div>
        {COLOR_FIELDS.map(({ key, id, label }) => (
          <div key={key} className="lyric-color-row">
            <input
              id={id}
              className="lyric-color-picker"
              type="color"
              value={workshop.colors[key]}
              onInput={(event) =>
                patch({
                  colors: {
                    ...workshop.colors,
                    mode: "custom",
                    [key]: event.currentTarget.value.toLowerCase(),
                  },
                })
              }
            />
            <div className="fx-color-row-label">{label}</div>
          </div>
        ))}

        <div className="fx-toggle-grid">
          <button
            id="t-workshop-show-cover"
            type="button"
            className={workshop.showCover ? "fx-toggle on" : "fx-toggle"}
            onClick={() => patch({ showCover: !workshop.showCover })}
          >
            <span>显示封面</span>
            <span className="dot" />
          </button>
        </div>
      </div>
    </div>
  );
}

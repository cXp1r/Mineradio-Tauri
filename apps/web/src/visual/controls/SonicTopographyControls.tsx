import { type ReactElement } from "react";
import {
  SONIC_TOPOGRAPHY_DEFAULTS,
  type FxStatePatch,
  type SonicTopographySettings,
} from "@mineradio/visual-engine";

interface SonicTopographyControlsProps {
  readonly settings?: FxStatePatch;
  readonly onFxPatchChange?: (patch: FxStatePatch) => void;
}

interface SonicSliderDefinition<Key extends string> {
  readonly key: Key;
  readonly id: string;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
}

const TERRAIN_SLIDERS = [
  { key: "amplitude", id: "sonic-terrain-amplitude", label: "地形振幅" },
  { key: "motionSpeed", id: "sonic-terrain-motion-speed", label: "地形速度" },
  { key: "density", id: "sonic-terrain-density", label: "网格密度" },
  { key: "range", id: "sonic-terrain-range", label: "地形范围" },
  { key: "lower", id: "sonic-terrain-lower", label: "低谷" },
  { key: "depth", id: "sonic-terrain-depth", label: "景深" },
  { key: "autoRotate", id: "sonic-terrain-autoRotate", label: "自动旋转" },
] as const satisfies ReadonlyArray<SonicSliderDefinition<keyof SonicTopographySettings["terrain"]>>;

const EQ_SLIDERS = [
  { key: "subBass", id: "sonic-eq-subBass", label: "超低频" },
  { key: "bass", id: "sonic-eq-bass", label: "低频" },
  { key: "lowMid", id: "sonic-eq-lowMid", label: "低中频" },
  { key: "mid", id: "sonic-eq-mid", label: "中频" },
  { key: "highMid", id: "sonic-eq-highMid", label: "高中频" },
  { key: "presence", id: "sonic-eq-presence", label: "临场感" },
  { key: "brilliance", id: "sonic-eq-brilliance", label: "明亮度" },
  { key: "air", id: "sonic-eq-air", label: "空气感" },
] as const satisfies ReadonlyArray<SonicSliderDefinition<keyof SonicTopographySettings["eq"]>>;

const FLOATING_SLIDERS = [
  { key: "count", id: "sonic-floating-count", label: "浮块数量" },
  { key: "intensity", id: "sonic-floating-intensity", label: "浮块强度" },
] as const satisfies ReadonlyArray<SonicSliderDefinition<Exclude<keyof SonicTopographySettings["floating"], "enabled">>>;

const TRIGGER_SLIDERS = [
  { key: "sensitivity", id: "sonic-trigger-sensitivity", label: "触发灵敏度", min: 0, max: 100 },
  { key: "bandStart", id: "sonic-trigger-band-start", label: "起始频段", min: 0, max: 510 },
  { key: "bandEnd", id: "sonic-trigger-band-end", label: "结束频段", min: 2, max: 512 },
  { key: "threshold", id: "sonic-trigger-threshold", label: "触发阈值", min: 0, max: 100 },
] as const satisfies ReadonlyArray<SonicSliderDefinition<Exclude<keyof SonicTopographySettings["trigger"], "monitorEnabled" | "autoTrack">>>;

/** Sonic 控件与设置搜索共用的唯一文案目录。 */
export const SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS = Object.freeze({
  title: "Sonic Topography",
  summary: "地形 / 频段 / 触发",
  terrain: Object.freeze({ label: "地形", sliders: TERRAIN_SLIDERS }),
  equalizer: Object.freeze({ label: "八段均衡", sliders: EQ_SLIDERS }),
  colors: Object.freeze({
    label: "颜色",
    modes: Object.freeze([
      { value: "cover", label: "封面" },
      { value: "custom", label: "自定义" },
    ] as const satisfies ReadonlyArray<{ value: SonicTopographySettings["colors"]["mode"]; label: string }>),
    fields: Object.freeze([
      { key: "base", id: "sonic-base-color", label: "地形底色" },
      { key: "accent", id: "sonic-accent-color", label: "高亮色" },
    ] as const satisfies ReadonlyArray<{ key: "base" | "accent"; id: string; label: string }>),
    glow: Object.freeze({ id: "sonic-color-glow", label: "颜色辉光" }),
  }),
  floatingAndTrigger: Object.freeze({
    label: "浮块与触发",
    toggles: Object.freeze({
      floating: Object.freeze({ id: "t-sonic-floating", label: "浮动方块" }),
      monitor: Object.freeze({ id: "t-sonic-monitor", label: "音频监视" }),
      autoTrack: Object.freeze({ id: "t-sonic-auto-track", label: "自动跟踪" }),
    }),
    floatingSliders: FLOATING_SLIDERS,
    triggerSliders: TRIGGER_SLIDERS,
  }),
});

export const SONIC_TOPOGRAPHY_SETTINGS_SEARCH_TERMS = Object.freeze([
  SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.title,
  SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.summary,
  SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.terrain.label,
  ...SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.terrain.sliders.map(({ label }) => label),
  SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.equalizer.label,
  ...SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.equalizer.sliders.map(({ label }) => label),
  SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.label,
  ...SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.modes.map(({ label }) => label),
  ...SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.fields.map(({ label }) => label),
  SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.glow.label,
  SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.label,
  ...Object.values(SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.toggles).map(({ label }) => label),
  ...SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.floatingSliders.map(({ label }) => label),
  ...SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.triggerSliders.map(({ label }) => label),
]);

function SonicSlider(props: { id: string; label: string; value: number; onChange: (value: number) => void; min?: number; max?: number }): ReactElement {
  return <div className="fx-slider"><label htmlFor={props.id}>{props.label}</label><input id={props.id} type="range" min={props.min ?? 0} max={props.max ?? 100} step="1" value={props.value} onInput={(event) => props.onChange(Number(event.currentTarget.value))} /><output>{Math.round(props.value)}</output><span aria-hidden="true" /></div>;
}

/** Sonic 仍处于 dormant 阶段；本控件只编辑快照，不会开放 preset 7。 */
export function SonicTopographyControls(props: SonicTopographyControlsProps): ReactElement {
  const supplied = props.settings?.sonic;
  const sonic = {
    ...SONIC_TOPOGRAPHY_DEFAULTS,
    ...supplied,
    terrain: { ...SONIC_TOPOGRAPHY_DEFAULTS.terrain, ...supplied?.terrain },
    eq: { ...SONIC_TOPOGRAPHY_DEFAULTS.eq, ...supplied?.eq },
    colors: { ...SONIC_TOPOGRAPHY_DEFAULTS.colors, ...supplied?.colors },
    floating: { ...SONIC_TOPOGRAPHY_DEFAULTS.floating, ...supplied?.floating },
    trigger: { ...SONIC_TOPOGRAPHY_DEFAULTS.trigger, ...supplied?.trigger },
  } as SonicTopographySettings;
  const patch = (next: Partial<SonicTopographySettings>) => props.onFxPatchChange?.({ sonic: { ...sonic, ...next } });
  const terrain = (key: keyof SonicTopographySettings["terrain"], value: number) => patch({ terrain: { ...sonic.terrain, [key]: value } });
  const eq = (key: keyof SonicTopographySettings["eq"], value: number) => patch({ eq: { ...sonic.eq, [key]: value } });
  const floating = (key: Exclude<keyof SonicTopographySettings["floating"], "enabled">, value: number) => patch({ floating: { ...sonic.floating, [key]: value } });
  const trigger = (key: Exclude<keyof SonicTopographySettings["trigger"], "monitorEnabled" | "autoTrack">, value: number) => patch({ trigger: { ...sonic.trigger, [key]: value } });

  return <div className="fx-fold open" id="fx-sonic-fold">
    <div className="fx-fold-head"><span className="fx-fold-title"><strong>{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.title}</strong><small>{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.summary}</small></span><span className="arrow">▶</span></div>
    <div className="fx-fold-body">
      <div className="fx-section-label">{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.terrain.label}</div>
      {SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.terrain.sliders.map((control) => <SonicSlider key={control.key} id={control.id} label={control.label} value={sonic.terrain[control.key]} onChange={(value) => terrain(control.key, value)} />)}
      <div className="fx-section-label">{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.equalizer.label}</div>
      {SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.equalizer.sliders.map((control) => <SonicSlider key={control.key} id={control.id} label={control.label} value={sonic.eq[control.key]} onChange={(value) => eq(control.key, value)} />)}
      <div className="fx-section-label">{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.label}</div>
      <div className="fx-seg" id="sonic-color-mode-seg">{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.modes.map(({ value, label }) => <button key={value} type="button" className={sonic.colors.mode === value ? "active" : ""} data-sonic-color-mode={value} onClick={() => patch({ colors: { ...sonic.colors, mode: value } })}>{label}</button>)}</div>
      {SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.fields.map(({ key, id, label }) => <div key={key} className="lyric-color-row"><input id={id} className="lyric-color-picker" type="color" value={sonic.colors[key]} onInput={(event) => patch({ colors: { ...sonic.colors, [key]: event.currentTarget.value } })} /><div className="fx-color-row-label">{label}</div></div>)}
      <SonicSlider id={SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.glow.id} label={SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.colors.glow.label} value={sonic.colors.glow} onChange={(glow) => patch({ colors: { ...sonic.colors, glow } })} />
      <div className="fx-section-label">{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.label}</div>
      <div className="fx-toggle-grid"><button id={SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.toggles.floating.id} type="button" className={sonic.floating.enabled ? "fx-toggle on" : "fx-toggle"} onClick={() => patch({ floating: { ...sonic.floating, enabled: !sonic.floating.enabled } })}><span>{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.toggles.floating.label}</span><span className="dot" /></button><button id={SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.toggles.monitor.id} type="button" className={sonic.trigger.monitorEnabled ? "fx-toggle on" : "fx-toggle"} onClick={() => patch({ trigger: { ...sonic.trigger, monitorEnabled: !sonic.trigger.monitorEnabled } })}><span>{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.toggles.monitor.label}</span><span className="dot" /></button><button id={SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.toggles.autoTrack.id} type="button" className={sonic.trigger.autoTrack ? "fx-toggle on" : "fx-toggle"} onClick={() => patch({ trigger: { ...sonic.trigger, autoTrack: !sonic.trigger.autoTrack } })}><span>{SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.toggles.autoTrack.label}</span><span className="dot" /></button></div>
      {SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.floatingSliders.map((control) => <SonicSlider key={control.key} id={control.id} label={control.label} value={sonic.floating[control.key]} onChange={(value) => floating(control.key, value)} />)}
      {SONIC_TOPOGRAPHY_CONTROL_DEFINITIONS.floatingAndTrigger.triggerSliders.map((control) => <SonicSlider key={control.key} id={control.id} label={control.label} value={sonic.trigger[control.key]} min={control.min} max={control.max} onChange={(value) => trigger(control.key, value)} />)}
    </div>
  </div>;
}

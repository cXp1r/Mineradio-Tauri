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
  const terrainSliders = [["amplitude", "地形振幅"], ["motionSpeed", "地形速度"], ["density", "网格密度"], ["range", "地形范围"], ["lower", "低谷"], ["depth", "景深"], ["autoRotate", "自动旋转"]] as const;
  const eqSliders = [["subBass", "超低频"], ["bass", "低频"], ["lowMid", "低中频"], ["mid", "中频"], ["highMid", "高中频"], ["presence", "临场感"], ["brilliance", "明亮度"], ["air", "空气感"]] as const;

  return <div className="fx-fold open" id="fx-sonic-fold">
    <div className="fx-fold-head"><span className="fx-fold-title"><strong>Sonic Topography</strong><small>地形 / 频段 / 触发</small></span><span className="arrow">▶</span></div>
    <div className="fx-fold-body">
      <div className="fx-section-label">地形</div>
      {terrainSliders.map(([key, label]) => <SonicSlider key={key} id={`sonic-terrain-${key === "motionSpeed" ? "motion-speed" : key}`} label={label} value={sonic.terrain[key]} onChange={(value) => terrain(key, value)} />)}
      <div className="fx-section-label">八段均衡</div>
      {eqSliders.map(([key, label]) => <SonicSlider key={key} id={`sonic-eq-${key}`} label={label} value={sonic.eq[key]} onChange={(value) => eq(key, value)} />)}
      <div className="fx-section-label">颜色</div>
      <div className="fx-seg" id="sonic-color-mode-seg"><button type="button" className={sonic.colors.mode === "cover" ? "active" : ""} data-sonic-color-mode="cover" onClick={() => patch({ colors: { ...sonic.colors, mode: "cover" } })}>封面</button><button type="button" className={sonic.colors.mode === "custom" ? "active" : ""} data-sonic-color-mode="custom" onClick={() => patch({ colors: { ...sonic.colors, mode: "custom" } })}>自定义</button></div>
      <div className="lyric-color-row"><input id="sonic-base-color" className="lyric-color-picker" type="color" value={sonic.colors.base} onInput={(event) => patch({ colors: { ...sonic.colors, base: event.currentTarget.value } })} /><div className="fx-color-row-label">地形底色</div></div>
      <div className="lyric-color-row"><input id="sonic-accent-color" className="lyric-color-picker" type="color" value={sonic.colors.accent} onInput={(event) => patch({ colors: { ...sonic.colors, accent: event.currentTarget.value } })} /><div className="fx-color-row-label">高亮色</div></div>
      <SonicSlider id="sonic-color-glow" label="颜色辉光" value={sonic.colors.glow} onChange={(glow) => patch({ colors: { ...sonic.colors, glow } })} />
      <div className="fx-section-label">浮块与触发</div>
      <div className="fx-toggle-grid"><button id="t-sonic-floating" type="button" className={sonic.floating.enabled ? "fx-toggle on" : "fx-toggle"} onClick={() => patch({ floating: { ...sonic.floating, enabled: !sonic.floating.enabled } })}><span>浮动方块</span><span className="dot" /></button><button id="t-sonic-monitor" type="button" className={sonic.trigger.monitorEnabled ? "fx-toggle on" : "fx-toggle"} onClick={() => patch({ trigger: { ...sonic.trigger, monitorEnabled: !sonic.trigger.monitorEnabled } })}><span>音频监视</span><span className="dot" /></button><button id="t-sonic-auto-track" type="button" className={sonic.trigger.autoTrack ? "fx-toggle on" : "fx-toggle"} onClick={() => patch({ trigger: { ...sonic.trigger, autoTrack: !sonic.trigger.autoTrack } })}><span>自动跟踪</span><span className="dot" /></button></div>
      <SonicSlider id="sonic-floating-count" label="浮块数量" value={sonic.floating.count} onChange={(value) => floating("count", value)} />
      <SonicSlider id="sonic-floating-intensity" label="浮块强度" value={sonic.floating.intensity} onChange={(value) => floating("intensity", value)} />
      <SonicSlider id="sonic-trigger-sensitivity" label="触发灵敏度" value={sonic.trigger.sensitivity} onChange={(value) => trigger("sensitivity", value)} />
      <SonicSlider id="sonic-trigger-band-start" label="起始频段" value={sonic.trigger.bandStart} min={0} max={510} onChange={(value) => trigger("bandStart", value)} />
      <SonicSlider id="sonic-trigger-band-end" label="结束频段" value={sonic.trigger.bandEnd} min={2} max={512} onChange={(value) => trigger("bandEnd", value)} />
      <SonicSlider id="sonic-trigger-threshold" label="触发阈值" value={sonic.trigger.threshold} onChange={(value) => trigger("threshold", value)} />
    </div>
  </div>;
}

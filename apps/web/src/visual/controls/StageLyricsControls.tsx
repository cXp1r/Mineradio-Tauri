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
  const modeOptions = [
    ["single", "单行"],
    ["dual", "双行"],
    ["triple", "三行"],
    ["cinema", "影院"],
    ["custom", "自定义"],
  ] as const;
  const translationOptions = [["off", "关闭"], ["current", "当前"], ["dual", "双行"], ["multi", "多行"]] as const;
  const motionOptions = [["glass", "玻璃"], ["smooth", "柔和"], ["float", "浮动"], ["quick", "快速"], ["shine", "闪耀"], ["glitch", "故障"]] as const;
  const toggle = (key: "glitchCameraBind" | "verticalFloat" | "backgroundStarRiver" | "pauseHold", label: string, id: string) => (
    <button
      id={id}
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
        <span className="fx-fold-title"><strong>舞台歌词 2.0</strong><small>行数 / 翻译 / 动效</small></span>
        <span className="arrow">▶</span>
      </div>
      <div className="fx-fold-body">
        <div className="fx-section-label">显示模式</div>
        <div className="fx-seg" id="stage-display-mode-seg">
          {modeOptions.map(([value, label]) => <button key={value} type="button" data-stage-display-mode={value} className={stage.displayMode === value ? "active" : ""} onClick={() => patch({ displayMode: value })}>{label}</button>)}
        </div>
        <div className="fx-section-label">翻译显示</div>
        <div className="fx-seg" id="stage-translation-mode-seg">
          {translationOptions.map(([value, label]) => <button key={value} type="button" data-stage-translation-mode={value} className={stage.translationMode === value ? "active" : ""} onClick={() => patch({ translationMode: value })}>{label}</button>)}
        </div>
        <div className="fx-section-label">动效</div>
        <div className="fx-seg" id="stage-motion-style-seg">
          {motionOptions.map(([value, label]) => <button key={value} type="button" data-stage-motion-style={value} className={stage.motionStyle === value ? "active" : ""} onClick={() => patch({ motionStyle: value })}>{label}</button>)}
        </div>
        <Slider id="stage-custom-line-count" label="自定义行数" value={stage.customLineCount} min={1} max={10} step={1} onChange={(customLineCount) => patch({ customLineCount })} />
        <Slider id="stage-context-opacity" label="上下文透明度" value={stage.contextOpacity} min={0.25} max={1} step={0.01} onChange={(contextOpacity) => patch({ contextOpacity })} />
        <Slider id="stage-context-spread" label="上下文间距" value={stage.contextSpread} min={0.6} max={2.4} step={0.01} onChange={(contextSpread) => patch({ contextSpread })} />
        <Slider id="stage-translation-gap" label="翻译间距" value={stage.translationGap} min={0.28} max={2.2} step={0.01} onChange={(translationGap) => patch({ translationGap })} />
        <Slider id="stage-translation-scale" label="翻译缩放" value={stage.translationScale} min={0.46} max={1.12} step={0.01} onChange={(translationScale) => patch({ translationScale })} />
        <Slider id="stage-translation-opacity" label="翻译透明度" value={stage.translationOpacity} min={0.2} max={1} step={0.01} onChange={(translationOpacity) => patch({ translationOpacity })} />
        <Slider id="stage-edge-fade" label="边缘淡化" value={stage.edgeFade} min={0} max={1} step={0.01} onChange={(edgeFade) => patch({ edgeFade })} />
        <Slider id="stage-motion-softness" label="动效柔和度" value={stage.motionSoftness} min={0.15} max={1.2} step={0.01} onChange={(motionSoftness) => patch({ motionSoftness })} />
        <Slider id="stage-glitch-intensity" label="故障强度" value={stage.glitchIntensity} min={0} max={1.5} step={0.01} onChange={(glitchIntensity) => patch({ glitchIntensity })} />
        <Slider id="stage-glitch-slice" label="故障切片" value={stage.glitchSlice} min={0} max={1.4} step={0.01} onChange={(glitchSlice) => patch({ glitchSlice })} />
        <Slider id="stage-texture-clarity" label="纹理清晰度" value={stage.textureClarity} min={1} max={4} step={1} onChange={(textureClarity) => patch({ textureClarity: Math.round(textureClarity) as 1 | 2 | 3 | 4 })} />
        <div className="fx-toggle-grid">
          {toggle("verticalFloat", "垂直漂浮", "t-stage-vertical-float")}
          {toggle("backgroundStarRiver", "背景星河", "t-stage-star-river")}
          {toggle("glitchCameraBind", "故障镜头绑定", "t-stage-glitch-camera-bind")}
          {toggle("pauseHold", "暂停保持", "t-stage-pause-hold")}
        </div>
      </div>
    </div>
  );
}

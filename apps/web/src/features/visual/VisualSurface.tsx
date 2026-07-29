import type { ComponentProps, ReactElement } from "react";
import { GuideParticlesHost } from "../../components/shell/GuideParticlesHost";
import { VisualControlPanelHost } from "../../visual/VisualControlPanelHost";
import {
  VisualEngineHost,
  type VisualEngineHostProps,
} from "../../visual/VisualEngineHost";
import {
  WallpaperEngineBackground,
  type WallpaperEngineBackgroundProps,
} from "../wallpaper-engine/WallpaperEngineBackground";

export interface VisualSurfaceProps {
  VisualComponent: (props: VisualEngineHostProps) => ReactElement | null;
  engineProps: VisualEngineHostProps;
  wallpaperEngineBackgroundProps: WallpaperEngineBackgroundProps;
  controlPanelProps: ComponentProps<typeof VisualControlPanelHost>;
  aiDepthChip: {
    visible: boolean;
    text: string;
  };
}

export function VisualSurface({
  VisualComponent = VisualEngineHost,
  engineProps,
  wallpaperEngineBackgroundProps,
  controlPanelProps,
  aiDepthChip,
}: VisualSurfaceProps): ReactElement {
  return (
    <>
      <WallpaperEngineBackground {...wallpaperEngineBackgroundProps} />
      <VisualComponent {...engineProps} />
      <GuideParticlesHost />
      <div id="ai-depth-chip" className={aiDepthChip.visible ? "show" : ""}>
        <div className="mini-spin" />
        <span id="ai-depth-text">{aiDepthChip.text}</span>
      </div>
      <VisualControlPanelHost {...controlPanelProps} />
    </>
  );
}

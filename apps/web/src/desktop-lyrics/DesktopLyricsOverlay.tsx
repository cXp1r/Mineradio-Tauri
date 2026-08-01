import type { CSSProperties, PointerEvent } from "react";
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DesktopLyricsHotBoundsSchema,
  DesktopLyricsPayloadSchema,
  type DesktopLyricsHotBounds,
  type DesktopLyricsPayload,
} from "@mineradio/shared";
import {
  computeDesktopLyricsCinemaMotion,
  createDesktopLyricsFrameGate,
  normalizeDesktopLyricsBeatMap,
  projectDesktopLyricsPlayback,
  shouldAdvanceDesktopLyricsFrame,
  type DesktopLyricsCinemaMotion,
} from "./desktop-lyrics-clock";
import {
  CUSTOM_LYRIC_FONT_STORE_KEY,
  pruneCustomLyricFontRegistrations,
  registerCustomLyricFontForFamily,
} from "./custom-lyric-font";

export type DesktopLyricsInput = Partial<DesktopLyricsPayload>;

export interface DesktopLyricsDragCallbacks {
  onToggleLock?: () => void;
  onMoveBy?: (dx: number, dy: number) => void;
  onHotBoundsChange?: (bounds: DesktopLyricsHotBounds) => void;
}

export interface DesktopLyricsOverlayProps extends DesktopLyricsDragCallbacks {
  payload: DesktopLyricsInput | null | undefined;
}

export type DesktopLyricsStyle = CSSProperties &
  Record<`--desktop-lyrics-${string}`, string>;

export interface DesktopLyricsViewport {
  width: number;
  height: number;
}

export interface DesktopLyricsLayoutOptions {
  viewport?: DesktopLyricsViewport;
  measureText?: (
    text: string,
    fontSize: number,
    payload: DesktopLyricsPayload,
  ) => number;
}

export interface DesktopLyricsLayout {
  baseFontSize: number;
  renderedFontSize: number;
  fitPasses: number;
  fitScaleX: number;
  edgeWidth: number;
  maskEdgeWidth: number;
  verticalFeather: number;
  viewportWidth: number;
  clearWidth: number;
  scrollNeeded: boolean;
  scrollLimit: number;
  scrollX: number;
  letterSpacingPx: number;
}

export function normalizeDesktopLyricsPayload(
  payload: DesktopLyricsInput | null | undefined,
): DesktopLyricsPayload {
  return DesktopLyricsPayloadSchema.parse(payload ?? {});
}

export function shouldRenderDesktopLyrics(
  payload: DesktopLyricsInput | null | undefined,
): boolean {
  const normalized = normalizeDesktopLyricsPayload(payload);
  return normalized.enabled && normalized.text.trim().length > 0;
}

export function computeDesktopLyricsStyle(
  payload: DesktopLyricsPayload,
  layout = computeDesktopLyricsLayout(payload),
  cinemaMotion: DesktopLyricsCinemaMotion = computeDesktopLyricsCinemaMotion(
    payload,
    payload.playback.time,
  ),
): DesktopLyricsStyle {
  return {
    left: `${payload.position.x}px`,
    top: `calc(${Math.round(payload.y * 100)}vh)`,
    "--desktop-lyrics-progress": `${Math.round(payload.progress * 100)}%`,
    "--desktop-lyrics-size": String(payload.size),
    "--desktop-lyrics-primary": payload.colors.primary,
    "--desktop-lyrics-secondary": payload.colors.secondary,
    "--desktop-lyrics-highlight": payload.colors.highlight,
    "--desktop-lyrics-background": payload.colors.background,
    "--desktop-lyrics-glow": payload.colors.glow,
    "--desktop-lyrics-opacity": String(payload.opacity),
    "--desktop-lyrics-font-family": payload.fontFamily || payload.font.family,
    "--desktop-lyrics-font-weight": String(payload.fontWeight ?? payload.font.weight),
    "--desktop-lyrics-font-size": `${layout.renderedFontSize}px`,
    "--desktop-lyrics-lines": String(payload.font.fit.maxLines),
    "--desktop-lyrics-letter-spacing": `${layout.letterSpacingPx.toFixed(2)}px`,
    "--desktop-lyrics-line-height": String(payload.lineHeight),
    "--desktop-lyrics-lyric-scale": String(payload.lyricScale),
    "--desktop-lyrics-feather": String(payload.feather),
    "--desktop-lyrics-fit-x": layout.fitScaleX.toFixed(4),
    "--desktop-lyrics-scroll-x": `${layout.scrollX.toFixed(2)}px`,
    "--desktop-lyrics-edge-width": `${layout.edgeWidth}px`,
    "--desktop-lyrics-mask-edge-width": `${layout.maskEdgeWidth}px`,
    "--desktop-lyrics-vertical-feather": `${layout.verticalFeather}px`,
    "--desktop-lyrics-viewport-width": `${layout.viewportWidth}px`,
    "--desktop-lyrics-glow-strength": String(payload.motion.lyricGlowStrength),
    "--desktop-lyrics-high-bloom": String(cinemaMotion.highBloom),
    "--desktop-lyrics-beat-glow": String(cinemaMotion.beatGlow),
    "--desktop-lyrics-beat-pulse": String(cinemaMotion.beatPulse),
    "--desktop-lyrics-bass": String(cinemaMotion.bass),
    "--desktop-lyrics-float-x": `${cinemaMotion.floatX.toFixed(2)}px`,
    "--desktop-lyrics-float-y": `${cinemaMotion.floatY.toFixed(2)}px`,
    "--desktop-lyrics-float-rotate": `${cinemaMotion.floatRotate.toFixed(3)}deg`,
    "--desktop-lyrics-cinema-x": `${cinemaMotion.cameraX.toFixed(2)}px`,
    "--desktop-lyrics-cinema-y": `${cinemaMotion.cameraY.toFixed(2)}px`,
    "--desktop-lyrics-cinema-rotate": `${cinemaMotion.cameraRotate.toFixed(3)}deg`,
    "--desktop-lyrics-cinema-scale": cinemaMotion.cinemaScale.toFixed(4),
    "--desktop-lyrics-camera-energy": cinemaMotion.cameraEnergy.toFixed(4),
    "--desktop-lyrics-pulse-energy": cinemaMotion.pulseEnergy.toFixed(4),
  };
}

export function computeDesktopLyricsLayout(
  payload: DesktopLyricsPayload,
  options: DesktopLyricsLayoutOptions = {},
): DesktopLyricsLayout {
  const viewport = options.viewport ?? getDefaultDesktopLyricsViewport();
  const text = String(payload.text || "MineRadio-Tauri").replace(/\s+/g, " ").trim() || "MineRadio-Tauri";
  const safeWidth = Math.max(300, viewport.width - 8);
  const edgeWidth = Math.round(clamp(safeWidth * 0.085, 54, 116));
  const viewportWidth = Math.round(
    Math.max(
      280,
      Math.min(
        safeWidth - 12,
        viewport.width - Math.min(240, Math.max(88, viewport.width * 0.13)),
      ),
    ),
  );
  const clearWidth = Math.max(160, viewportWidth - edgeWidth * 2);
  const maxHeight = Math.max(64, viewport.height - 188);
  const baseFontSize = Math.round(58 * clamp(payload.size, 0.72, 1.55));
  const minSize = Math.max(24, Math.min(32, baseFontSize * 0.55));
  const maxScrollableWidth = clearWidth * 1.76;
  const measureText = options.measureText ?? measureDesktopLyricsTextFallback;

  let fitPasses = 0;
  let size = baseFontSize;
  for (; fitPasses < 24; fitPasses += 1) {
    const width = measureLineWidth(text, size, payload, measureText);
    const height = size * payload.lineHeight;
    if ((width <= maxScrollableWidth && height <= maxHeight) || size <= minSize) {
      break;
    }
    size = Math.max(minSize, size - Math.max(1.25, size * 0.062));
  }

  const measuredWidth = measureLineWidth(text, size, payload, measureText);
  const maxRenderedWidth = clearWidth * 1.82;
  const fitScaleX =
    measuredWidth > maxRenderedWidth
      ? Math.max(0.72, maxRenderedWidth / measuredWidth)
      : 1;
  const scaledWidth = measuredWidth * fitScaleX;
  const travelWidth = Math.max(0, scaledWidth - clearWidth);
  const clearTailMargin = Math.max(58, Math.min(edgeWidth * 1.18, size * 1.08));
  const centeredTailLimit =
    scaledWidth > clearWidth * 1.28
      ? Math.max(0, scaledWidth / 2 - clearWidth * 0.18)
      : 0;
  const scrollLimit =
    travelWidth > 0
      ? Math.max(travelWidth / 2 + clearTailMargin, centeredTailLimit)
      : 0;
  const scrollNeeded = travelWidth > Math.max(16, size * 0.18);
  const maskEdgeWidth = scrollNeeded
    ? Math.round(clamp(edgeWidth * 0.44, 26, 58))
    : edgeWidth;
  const scrollX = scrollNeeded
    ? computeDesktopLyricsScrollOffset({
        limit: scrollLimit,
        progress: payload.progress,
        progressSpan: payload.progressSpan,
        viewportWidth: viewport.width,
      })
    : 0;

  return {
    baseFontSize,
    renderedFontSize: Math.round(size),
    fitPasses,
    fitScaleX,
    edgeWidth,
    maskEdgeWidth,
    verticalFeather: Math.round(clamp(size * 0.92, 38, 72)),
    viewportWidth,
    clearWidth,
    scrollNeeded,
    scrollLimit,
    scrollX,
    letterSpacingPx: Math.round(size) * payload.letterSpacing,
  };
}

export function lyricScrollEase(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function lyricScrollInitialHoldMs(progressSpan: number): number {
  return Math.round(clamp(progressSpan * 130, 140, 520));
}

export function computeDesktopLyricsScrollOffset(input: {
  limit: number;
  progress: number;
  progressSpan: number;
  viewportWidth: number;
  rawProgress?: number;
  holdActive?: boolean;
}): number {
  const limit = Math.max(0, input.limit);
  if (limit <= 0) return 0;
  let progress = clamp(input.progress, 0, 1);
  const rawProgress = clamp(input.rawProgress ?? progress, 0, 1);
  const finalCatch = clamp((rawProgress - 0.88) / 0.12, 0, 1);
  progress = Math.max(progress, rawProgress - 0.10 * finalCatch);
  const spanMs = Math.max(450, input.progressSpan * 1000);
  const startGate = clamp(lyricScrollInitialHoldMs(input.progressSpan) / spanMs, 0.035, 0.18);
  const longLineBias = clamp(limit / Math.max(260, input.viewportWidth), 0, 0.30);
  const shortLineBias = clamp((4.8 - input.progressSpan) / 8, 0, 0.16);
  let endGate = clamp(0.84 - longLineBias * 0.38 - shortLineBias * 0.50, 0.62, 0.88);
  if (endGate <= startGate + 0.12) endGate = startGate + 0.12;
  if (input.holdActive && progress < startGate) return 0;
  if (progress >= endGate) return -limit;
  return -limit * lyricScrollEase((progress - startGate) / (endGate - startGate));
}

function getDefaultDesktopLyricsViewport(): DesktopLyricsViewport {
  if (typeof window !== "undefined") {
    return {
      width: window.innerWidth || 1280,
      height: window.innerHeight || 220,
    };
  }
  return { width: 1280, height: 220 };
}

function measureLineWidth(
  text: string,
  fontSize: number,
  payload: DesktopLyricsPayload,
  measureText: NonNullable<DesktopLyricsLayoutOptions["measureText"]>,
): number {
  return Math.max(1, measureText(text, fontSize, payload)) +
    Math.max(0, Array.from(text).length - 1) * fontSize * payload.letterSpacing;
}

function measureDesktopLyricsTextFallback(
  text: string,
  fontSize: number,
): number {
  let units = 0;
  for (const char of Array.from(text || "MineRadio-Tauri")) {
    units += /[^\x00-\xff]/.test(char) ? 0.96 : 0.56;
  }
  return Math.max(1, units * fontSize);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : useLayoutEffect;

function desktopLyricsMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;
}

function useDesktopLyricsAutonomousPayload(
  input: DesktopLyricsInput | null | undefined,
): {
  payload: DesktopLyricsPayload;
  cinemaMotion: DesktopLyricsCinemaMotion;
} {
  const normalized = useMemo(() => normalizeDesktopLyricsPayload(input), [input]);
  const anchor = useMemo(
    () => ({ payload: normalized, receivedAtMs: desktopLyricsMonotonicNow() }),
    [normalized],
  );
  const [frameNowMs, setFrameNowMs] = useState(anchor.receivedAtMs);
  const visible = shouldRenderDesktopLyrics(anchor.payload);

  useEffect(() => {
    setFrameNowMs(anchor.receivedAtMs);
  }, [anchor.receivedAtMs]);

  useEffect(() => {
    if (
      !visible ||
      !anchor.payload.playing ||
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      return;
    }
    const gate = createDesktopLyricsFrameGate();
    let requestId = 0;
    const tick = (nowMs: number) => {
      if (
        shouldAdvanceDesktopLyricsFrame(
          gate,
          nowMs,
          anchor.payload.frameRate,
        )
      ) {
        setFrameNowMs(nowMs);
      }
      requestId = window.requestAnimationFrame(tick);
    };
    requestId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(requestId);
  }, [anchor.payload.frameRate, anchor.payload.playing, visible]);

  const projection = projectDesktopLyricsPlayback(
    anchor.payload,
    anchor.receivedAtMs,
    Math.max(frameNowMs, anchor.receivedAtMs),
  );
  const livePayload = useMemo(
    () => ({
      ...anchor.payload,
      progress: projection.progress,
      playback: {
        ...anchor.payload.playback,
        time: projection.playbackTime,
      },
    }),
    [anchor.payload, projection.playbackTime, projection.progress],
  );
  const beatMap = useMemo(
    () => normalizeDesktopLyricsBeatMap(livePayload.beatMap),
    [livePayload.beatMap, livePayload.beatMapKey],
  );

  return {
    payload: livePayload,
    cinemaMotion: computeDesktopLyricsCinemaMotion(
      livePayload,
      projection.playbackTime,
      beatMap,
    ),
  };
}

export function computeDesktopLyricsHotBounds(
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
): DesktopLyricsHotBounds {
  const width = Math.max(1, rect.right - rect.left);
  const height = Math.max(1, rect.bottom - rect.top);
  const padX = clamp(width * 0.08, 26, 72);
  const padY = clamp(height * 0.35, 24, 56);
  return DesktopLyricsHotBoundsSchema.parse({
    left: rect.left - padX,
    top: rect.top - padY,
    right: rect.right + padX,
    bottom: rect.bottom + padY,
  });
}

export async function reportDesktopLyricsHotBounds(
  node: Pick<HTMLElement, "getBoundingClientRect"> | null | undefined,
  bridge:
    | Pick<DesktopLyricsDragCallbacks, "onHotBoundsChange">
    | {
        setHotBounds?: (bounds: DesktopLyricsHotBounds) => Promise<void> | void;
      },
): Promise<void> {
  if (!node) return;
  const rect = node.getBoundingClientRect();
  if (rect.right <= rect.left || rect.bottom <= rect.top) return;
  const bounds = computeDesktopLyricsHotBounds(rect);
  if ("setHotBounds" in bridge && bridge.setHotBounds) {
    await bridge.setHotBounds(bounds);
    return;
  }
  if ("onHotBoundsChange" in bridge) {
    bridge.onHotBoundsChange?.(bounds);
  }
}

export function areDesktopLyricsHotBoundsEqual(
  left: DesktopLyricsHotBounds | null | undefined,
  right: DesktopLyricsHotBounds | null | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.left === right.left &&
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom
  );
}

export function shouldReportDesktopLyricsHotBounds(
  previous: DesktopLyricsHotBounds | null | undefined,
  next: DesktopLyricsHotBounds,
): boolean {
  return !areDesktopLyricsHotBoundsEqual(previous, next);
}

export function createDesktopLyricsPointerHandlers(
  payload: DesktopLyricsPayload,
  callbacks: DesktopLyricsDragCallbacks,
  drag: { current: { x: number; y: number } | null },
) {
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (event.button === 1) {
        if (!payload.clickThrough) {
          callbacks.onToggleLock?.();
        }
        return;
      }
      if (event.button !== 0 || payload.clickThrough) {
        return;
      }
      drag.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (!drag.current || payload.clickThrough) {
        return;
      }
      const dx = event.clientX - drag.current.x;
      const dy = event.clientY - drag.current.y;
      drag.current = { x: event.clientX, y: event.clientY };
      if (dx !== 0 || dy !== 0) {
        callbacks.onMoveBy?.(dx, dy);
      }
    },
    onPointerUp() {
      drag.current = null;
    },
  };
}

export function DesktopLyricsOverlay({
  payload,
  onToggleLock,
  onMoveBy,
  onHotBoundsChange,
}: DesktopLyricsOverlayProps) {
  const autonomous = useDesktopLyricsAutonomousPayload(payload);
  const normalized = autonomous.payload;
  const drag = useRef<{ x: number; y: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const lastHotBoundsRef = useRef<DesktopLyricsHotBounds | null>(null);
  const [fontRevision, setFontRevision] = useState(0);

  const shouldRender = shouldRenderDesktopLyrics(normalized);

  useEffect(() => {
    let disposed = false;
    const syncFont = () => {
      pruneCustomLyricFontRegistrations();
      void registerCustomLyricFontForFamily(normalized.fontFamily).then((loaded) => {
        if (!disposed && loaded) setFontRevision((value) => value + 1);
      });
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === CUSTOM_LYRIC_FONT_STORE_KEY) syncFont();
    };
    syncFont();
    window.addEventListener("storage", handleStorage);
    return () => {
      disposed = true;
      window.removeEventListener("storage", handleStorage);
    };
  }, [normalized.fontFamily]);

  useIsomorphicLayoutEffect(() => {
    if (!shouldRender) {
      lastHotBoundsRef.current = null;
      return;
    }
    const node = overlayRef.current;
    if (!node) return;
    const reportBounds = (force = false) => {
      const rect = node.getBoundingClientRect();
      if (rect.right <= rect.left || rect.bottom <= rect.top) return;
      const bounds = computeDesktopLyricsHotBounds(rect);
      if (
        !force &&
        !shouldReportDesktopLyricsHotBounds(lastHotBoundsRef.current, bounds)
      ) {
        return;
      }
      lastHotBoundsRef.current = bounds;
      onHotBoundsChange?.(bounds);
    };
    reportBounds();

    const handleViewportChange = () => reportBounds(true);
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(handleViewportChange)
      : null;
    resizeObserver?.observe(node);
    if (typeof window !== "undefined") {
      window.addEventListener("resize", handleViewportChange);
      window.visualViewport?.addEventListener("resize", handleViewportChange);
    }
    return () => {
      resizeObserver?.disconnect();
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", handleViewportChange);
        window.visualViewport?.removeEventListener("resize", handleViewportChange);
      }
    };
  }, [
    shouldRender,
    onHotBoundsChange,
    normalized.text,
    normalized.position.x,
    normalized.position.y,
    normalized.size,
    normalized.y,
    normalized.fontFamily,
    normalized.fontWeight,
    normalized.letterSpacing,
    normalized.lineHeight,
    normalized.lyricScale,
    normalized.font.fit.minPx,
    normalized.font.fit.maxPx,
    normalized.font.fit.maxLines,
    fontRevision,
  ]);

  if (!shouldRender) {
    return null;
  }

  const layout = computeDesktopLyricsLayout(normalized);
  const handlers = createDesktopLyricsPointerHandlers(
    normalized,
    { onToggleLock, onMoveBy },
    drag,
  );

  return (
    <div
      ref={overlayRef}
      className={[
        "desktop-lyrics-overlay",
        normalized.clickThrough
          ? "desktop-lyrics-locked"
          : "desktop-lyrics-unlocked",
      ].join(" ")}
      data-click-through={normalized.clickThrough ? "true" : "false"}
      style={computeDesktopLyricsStyle(
        normalized,
        layout,
        autonomous.cinemaMotion,
      )}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerUp}
    >
      <span className="desktop-lyrics-viewport">
        <span className="desktop-lyrics-scroll">
          <span key={normalized.text} className="desktop-lyrics-text">
            {normalized.text}
          </span>
        </span>
      </span>
    </div>
  );
}

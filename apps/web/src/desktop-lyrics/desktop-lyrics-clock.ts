import type { DesktopLyricsPayload } from "@mineradio/shared";

export interface DesktopLyricsPlaybackProjection {
  elapsedSeconds: number;
  playbackTime: number;
  progress: number;
}

export interface DesktopLyricsFrameGate {
  nextFrameAt: number | null;
}

export interface DesktopLyricsBeatEvent {
  time: number;
  strength: number;
  impact: number;
  body: number;
}

export interface DesktopLyricsBeatMap {
  camera: DesktopLyricsBeatEvent[];
  pulse: DesktopLyricsBeatEvent[];
}

export interface DesktopLyricsCinemaMotion {
  floatX: number;
  floatY: number;
  floatRotate: number;
  cameraX: number;
  cameraY: number;
  cameraRotate: number;
  cinemaScale: number;
  cameraEnergy: number;
  pulseEnergy: number;
  beatGlow: number;
  beatPulse: number;
  bass: number;
  highBloom: number;
}

export function createDesktopLyricsFrameGate(): DesktopLyricsFrameGate {
  return { nextFrameAt: null };
}

/**
 * rAF 可能比目标帧率快或慢；保留下一帧截止点可避免 24fps 被量化成 20fps。
 */
export function shouldAdvanceDesktopLyricsFrame(
  gate: DesktopLyricsFrameGate,
  nowMs: number,
  frameRate: number,
): boolean {
  const now = finiteNumber(nowMs);
  const interval = 1000 / normalizeDesktopLyricsFrameRate(frameRate);
  if (gate.nextFrameAt === null || now + interval < gate.nextFrameAt) {
    gate.nextFrameAt = now + interval;
    return true;
  }
  if (now < gate.nextFrameAt) return false;
  do {
    gate.nextFrameAt += interval;
  } while (gate.nextFrameAt <= now);
  return true;
}

export function normalizeDesktopLyricsBeatMap(map: unknown): DesktopLyricsBeatMap {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { camera: [], pulse: [] };
  }
  const record = map as Record<string, unknown>;
  return {
    camera: normalizeDesktopLyricsBeatList(record, ["cameraBeats", "beats", "kicks"]),
    pulse: normalizeDesktopLyricsBeatList(record, ["pulseBeats", "kicks"]),
  };
}

export function computeDesktopLyricsCinemaMotion(
  payload: DesktopLyricsPayload,
  playbackTime: number,
  beatMap = normalizeDesktopLyricsBeatMap(payload.beatMap),
): DesktopLyricsCinemaMotion {
  const time = Math.max(0, finiteNumber(playbackTime));
  const reduceMotion = payload.motion.reduceMotion;
  const floatX = reduceMotion ? 0 : Math.sin(time * 0.58 + 0.7) * 3.2;
  const floatY = reduceMotion ? 0 : Math.cos(time * 0.43 + 0.2) * 2.2;
  const floatRotate = reduceMotion ? 0 : Math.sin(time * 0.31 + 1.1) * 0.24;
  const staticMotion = {
    floatX,
    floatY,
    floatRotate,
    cameraX: 0,
    cameraY: 0,
    cameraRotate: 0,
    cinemaScale: 1,
    cameraEnergy: 0,
    pulseEnergy: 0,
  };
  if (!payload.cinema || reduceMotion) {
    return {
      ...staticMotion,
      beatGlow: 0,
      beatPulse: 0,
      bass: 0,
      highBloom: 0,
    };
  }
  const cameraBeat = desktopLyricsBeatEnvelope(beatMap.camera, time, 0.075, 0.34);
  const pulseBeat = desktopLyricsBeatEnvelope(beatMap.pulse, time, 0.035, 0.26);
  const cameraEnergy = clamp(cameraBeat.energy, 0, 1);
  const pulseEnergy = clamp(pulseBeat.energy, 0, 1);
  const directionX = Math.sin(cameraBeat.seed * 2.173 + 0.7);
  const directionY = Math.cos(cameraBeat.seed * 1.619 + 0.35);
  const cameraX = clamp(
    directionX * cameraEnergy * 12.5 + directionY * cameraBeat.body * 1.5,
    -14,
    14,
  );
  const cameraY = clamp(
    directionY * cameraEnergy * 7.8 - cameraBeat.body * 1.2,
    -9,
    9,
  );
  const cameraRotate = clamp(
    Math.sin(cameraBeat.seed * 2.947 + 1.2) * cameraEnergy * 1.45,
    -1.6,
    1.6,
  );
  const cinemaScale = 1 + clamp(
    pulseEnergy * 0.055 + cameraEnergy * 0.025,
    0,
    0.08,
  );
  return {
    ...staticMotion,
    cameraX,
    cameraY,
    cameraRotate,
    cinemaScale,
    cameraEnergy,
    pulseEnergy,
    beatGlow: clamp(
      Math.max(
        payload.motion.beatGlow,
        pulseEnergy * 1.35,
        cameraEnergy * 0.9,
      ),
      0,
      1.7,
    ),
    beatPulse: clamp(
      Math.max(payload.motion.beatPulse, pulseEnergy * 1.35),
      0,
      1.4,
    ),
    bass: clamp(
      Math.max(payload.motion.bass, cameraBeat.body, pulseBeat.body) * 1.05,
      0,
      1.2,
    ),
    highBloom: clamp(
      Math.max(
        payload.motion.highBloom,
        cameraEnergy * 0.8 + pulseEnergy * 0.4,
      ),
      0,
      1.45,
    ),
  };
}

/**
 * 以 payload 抵达 Overlay 的单调时刻作为锚点，独立外推播放时间和当前行进度。
 */
export function projectDesktopLyricsPlayback(
  payload: DesktopLyricsPayload,
  receivedAtMs: number,
  nowMs: number,
): DesktopLyricsPlaybackProjection {
  const elapsedSeconds = Math.max(0, finiteNumber(nowMs) - finiteNumber(receivedAtMs)) / 1000;
  const baseTime = Math.max(0, finiteNumber(payload.playback.time));
  const duration = Math.max(0, finiteNumber(payload.playback.duration));
  const rate = clamp(finiteNumber(payload.playback.rate), 0.25, 4);
  const projectedTime = payload.playing
    ? baseTime + elapsedSeconds * rate
    : baseTime;
  const playbackTime = duration > 0
    ? clamp(projectedTime, 0, duration)
    : Math.max(0, projectedTime);
  const playbackAdvance = Math.max(0, playbackTime - baseTime);
  const progressSpan = Math.max(0, finiteNumber(payload.progressSpan));
  const progress = progressSpan > 0
    ? clamp(payload.progress + playbackAdvance / progressSpan, 0, 1)
    : clamp(payload.progress, 0, 1);

  return {
    elapsedSeconds,
    playbackTime,
    progress,
  };
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeDesktopLyricsBeatList(
  map: Record<string, unknown>,
  keys: readonly string[],
): DesktopLyricsBeatEvent[] {
  let source: unknown[] | null = null;
  for (const key of keys) {
    const value = map[key];
    if (Array.isArray(value) && value.length > 0) {
      source = value;
      break;
    }
  }
  if (!source) return [];
  return source
    .map(normalizeDesktopLyricsBeatEvent)
    .filter((event): event is DesktopLyricsBeatEvent => event !== null)
    .sort((left, right) => left.time - right.time);
}

function normalizeDesktopLyricsBeatEvent(value: unknown): DesktopLyricsBeatEvent | null {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? {
          time: Math.max(0, value),
          strength: 0.42,
          impact: 0.42,
          body: 0,
        }
      : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const time = optionalFiniteNumber(record.t ?? record.time ?? record.at ?? record.sec);
  if (time === null) return null;
  const strength = clamp(
    optionalFiniteNumber(record.strength ?? record.s) ?? 0.42,
    0,
    1,
  );
  return {
    time: Math.max(0, time),
    strength,
    impact: clamp(
      optionalFiniteNumber(record.impact ?? record.i) ?? strength,
      0,
      1,
    ),
    body: clamp(optionalFiniteNumber(record.body ?? record.b) ?? 0, 0, 1),
  };
}

function desktopLyricsBeatEnvelope(
  events: readonly DesktopLyricsBeatEvent[],
  playbackTime: number,
  lookahead: number,
  decaySeconds: number,
): { energy: number; body: number; seed: number } {
  let energy = 0;
  let body = 0;
  let seed = playbackTime;
  const tail = decaySeconds * 4.5;
  let low = 0;
  let high = events.length;
  const latestVisibleTime = playbackTime + lookahead;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].time <= latestVisibleTime) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const event = events[index];
    const delta = playbackTime - event.time;
    if (delta > tail) break;
    const envelope = delta < 0
      ? 1 - clamp(Math.abs(delta) / Math.max(0.001, lookahead), 0, 1) * 0.3
      : Math.exp(-delta / Math.max(0.001, decaySeconds));
    const eventEnergy = Math.max(event.strength, event.impact) * envelope;
    if (eventEnergy <= energy) continue;
    energy = eventEnergy;
    body = event.body * envelope;
    seed = event.time + index * 0.137;
  }
  return { energy, body, seed };
}

function optionalFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDesktopLyricsFrameRate(value: unknown): 24 | 30 | 60 | 120 {
  const fps = finiteNumber(value);
  if (fps <= 0) return 120;
  if (fps > 0 && fps <= 26) return 24;
  if (fps <= 45) return 30;
  if (fps <= 90) return 60;
  return 120;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

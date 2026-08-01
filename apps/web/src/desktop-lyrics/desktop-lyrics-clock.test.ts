import { expect, test } from "bun:test";
import { DesktopLyricsPayloadSchema } from "@mineradio/shared";
import {
  computeDesktopLyricsCinemaMotion,
  createDesktopLyricsFrameGate,
  normalizeDesktopLyricsBeatMap,
  projectDesktopLyricsPlayback,
  shouldAdvanceDesktopLyricsFrame,
} from "./desktop-lyrics-clock";

test("projectDesktopLyricsPlayback advances from the monotonic payload arrival clock", () => {
  const payload = DesktopLyricsPayloadSchema.parse({
    enabled: true,
    text: "仍在播放",
    playing: true,
    progress: 0.25,
    progressSpan: 4,
    playback: {
      time: 8,
      duration: 10,
      rate: 1.5,
    },
  });

  expect(projectDesktopLyricsPlayback(payload, 1_000, 2_000)).toEqual({
    elapsedSeconds: 1,
    playbackTime: 9.5,
    progress: 0.625,
  });
  expect(projectDesktopLyricsPlayback(payload, 1_000, 4_000)).toEqual({
    elapsedSeconds: 3,
    playbackTime: 10,
    progress: 0.75,
  });
});

test("desktop lyrics frame gate honors 24/30/60/120 fps without losing remainder", () => {
  const gate24 = createDesktopLyricsFrameGate();
  expect(shouldAdvanceDesktopLyricsFrame(gate24, 0, 24)).toBe(true);
  expect(shouldAdvanceDesktopLyricsFrame(gate24, 16.7, 24)).toBe(false);
  expect(shouldAdvanceDesktopLyricsFrame(gate24, 33.4, 24)).toBe(false);
  expect(shouldAdvanceDesktopLyricsFrame(gate24, 50.1, 24)).toBe(true);
  expect(shouldAdvanceDesktopLyricsFrame(gate24, 83.5, 24)).toBe(true);

  for (const fps of [30, 60, 120] as const) {
    const gate = createDesktopLyricsFrameGate();
    expect(shouldAdvanceDesktopLyricsFrame(gate, 100, fps)).toBe(true);
    expect(shouldAdvanceDesktopLyricsFrame(gate, 100 + 1000 / fps - 1, fps)).toBe(false);
    expect(shouldAdvanceDesktopLyricsFrame(gate, 100 + 1000 / fps + 0.1, fps)).toBe(true);
  }

  const uncapped = createDesktopLyricsFrameGate();
  expect(shouldAdvanceDesktopLyricsFrame(uncapped, 0, 0)).toBe(true);
  expect(shouldAdvanceDesktopLyricsFrame(uncapped, 7, 0)).toBe(false);
  expect(shouldAdvanceDesktopLyricsFrame(uncapped, 8.4, 0)).toBe(true);
});

test("normalizeDesktopLyricsBeatMap accepts camera pulse and kicks baseline shapes", () => {
  expect(normalizeDesktopLyricsBeatMap({
    cameraBeats: [{ t: 2.4, strength: 0.8, impact: 0.6 }, 1.2],
    pulseBeats: [{ time: 1.5, impact: 0.7 }],
    kicks: [9],
  })).toEqual({
    camera: [
      { time: 1.2, strength: 0.42, impact: 0.42, body: 0 },
      { time: 2.4, strength: 0.8, impact: 0.6, body: 0 },
    ],
    pulse: [
      { time: 1.5, strength: 0.42, impact: 0.7, body: 0 },
    ],
  });
  expect(normalizeDesktopLyricsBeatMap({ kicks: [3] })).toEqual({
    camera: [{ time: 3, strength: 0.42, impact: 0.42, body: 0 }],
    pulse: [{ time: 3, strength: 0.42, impact: 0.42, body: 0 }],
  });
});

test("computeDesktopLyricsCinemaMotion keeps float bounded and zeros beat motion when cinema is off", () => {
  const payload = DesktopLyricsPayloadSchema.parse({
    enabled: true,
    text: "cinema off",
    cinema: false,
    motion: {
      highBloom: 1.2,
      beatGlow: 1.5,
      beatPulse: 1.2,
      bass: 1,
    },
    beatMap: {
      cameraBeats: [{ time: 10, strength: 1, impact: 1 }],
      pulseBeats: [{ time: 10, strength: 1, impact: 1 }],
    },
  });

  const motion = computeDesktopLyricsCinemaMotion(payload, 10);
  expect(Math.abs(motion.floatX)).toBeLessThanOrEqual(4);
  expect(Math.abs(motion.floatY)).toBeLessThanOrEqual(3);
  expect(Math.abs(motion.floatRotate)).toBeLessThanOrEqual(0.35);
  expect({
    cameraX: motion.cameraX,
    cameraY: motion.cameraY,
    cameraRotate: motion.cameraRotate,
    cinemaScale: motion.cinemaScale,
    cameraEnergy: motion.cameraEnergy,
    pulseEnergy: motion.pulseEnergy,
    beatGlow: motion.beatGlow,
    beatPulse: motion.beatPulse,
    bass: motion.bass,
    highBloom: motion.highBloom,
  }).toEqual({
    cameraX: 0,
    cameraY: 0,
    cameraRotate: 0,
    cinemaScale: 1,
    cameraEnergy: 0,
    pulseEnergy: 0,
    beatGlow: 0,
    beatPulse: 0,
    bass: 0,
    highBloom: 0,
  });
});

test("computeDesktopLyricsCinemaMotion turns local beat events into bounded decaying motion", () => {
  const payload = DesktopLyricsPayloadSchema.parse({
    enabled: true,
    text: "cinema on",
    cinema: true,
    motion: {
      highBloom: 0.2,
      beatGlow: 0.1,
      beatPulse: 0.1,
      bass: 0.1,
    },
    beatMap: {
      cameraBeats: [{ time: 10, strength: 0.9, impact: 0.8, body: 0.7 }],
      pulseBeats: [{ time: 10, strength: 0.8, impact: 0.9, body: 0.6 }],
    },
  });

  const atBeat = computeDesktopLyricsCinemaMotion(payload, 10);
  const afterBeat = computeDesktopLyricsCinemaMotion(payload, 10.8);

  expect(atBeat.cameraEnergy).toBeGreaterThanOrEqual(0.8);
  expect(atBeat.pulseEnergy).toBeGreaterThanOrEqual(0.8);
  expect(Math.max(Math.abs(atBeat.cameraX), Math.abs(atBeat.cameraY))).toBeGreaterThan(0.5);
  expect(Math.abs(atBeat.cameraX)).toBeLessThanOrEqual(14);
  expect(Math.abs(atBeat.cameraY)).toBeLessThanOrEqual(9);
  expect(Math.abs(atBeat.cameraRotate)).toBeLessThanOrEqual(1.6);
  expect(atBeat.cinemaScale).toBeGreaterThan(1);
  expect(atBeat.cinemaScale).toBeLessThanOrEqual(1.08);
  expect(atBeat.beatGlow).toBeGreaterThan(0.1);
  expect(atBeat.beatGlow).toBeLessThanOrEqual(1.7);
  expect(atBeat.beatPulse).toBeLessThanOrEqual(1.4);
  expect(atBeat.bass).toBeLessThanOrEqual(1.2);
  expect(afterBeat.cameraEnergy).toBeLessThan(atBeat.cameraEnergy);
  expect(afterBeat.pulseEnergy).toBeLessThan(atBeat.pulseEnergy);
});

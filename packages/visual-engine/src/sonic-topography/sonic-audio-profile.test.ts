import { expect, test } from "bun:test";
import { M4_SONIC_AUDIO_FRAMES } from "../fixtures/m4/sonic-audio-frames";
import {
	SONIC_BAND_HZ,
	SONIC_SPECTRUM_BIN_COUNT,
	analyzeSonicBands,
	analyzeSonicSpectrum,
	createSonicAudioProfile,
	createSonicSpectrumFrame,
	type SonicBand,
} from "./sonic-audio-profile";

test("Sonic spectrum frames own one immutable 512-bin copy", () => {
	const source = M4_SONIC_AUDIO_FRAMES.kick.createBins();
	const frame = createSonicSpectrumFrame({
		bins: source,
		sampleRate: M4_SONIC_AUDIO_FRAMES.kick.sampleRate,
		fftSize: M4_SONIC_AUDIO_FRAMES.kick.fftSize,
		currentTimeSeconds: M4_SONIC_AUDIO_FRAMES.kick.currentTimeSeconds,
		playing: M4_SONIC_AUDIO_FRAMES.kick.playing,
	});

	expect(frame.binCount).toBe(SONIC_SPECTRUM_BIN_COUNT);
	expect(frame.bin(2)).toBe(255);
	expect(frame.mean(1, 5)).toBeCloseTo((240 + 255 + 220 + 180) / 4, 8);
	expect(frame.bin(-1)).toBe(0);
	expect(frame.bin(512)).toBe(0);
	expect(Object.values(frame).some((value) => value instanceof Uint8Array)).toBe(false);
	expect(Object.isFrozen(frame)).toBe(true);

	source.fill(0);
	expect(frame.bin(2)).toBe(255);
});

test("Sonic detailed monitoring projects the fixed 32..16000 Hz bands", () => {
	for (const [expectedBand, [startHz, endHz]] of Object.entries(SONIC_BAND_HZ) as [SonicBand, readonly [number, number]][]) {
		const bins = new Uint8Array(SONIC_SPECTRUM_BIN_COUNT);
		const binHz = 48_000 / 2 / SONIC_SPECTRUM_BIN_COUNT;
		for (let index = Math.ceil(startHz / binHz); index < Math.ceil(endHz / binHz); index += 1) {
			bins[index] = 255;
		}
		const bands = analyzeSonicBands(createSonicSpectrumFrame({
			bins,
			sampleRate: 48_000,
			fftSize: 1024,
			currentTimeSeconds: 1,
			playing: true,
		}));
		const strongest = (Object.entries(bands) as [SonicBand, number][])
			.sort((left, right) => right[1] - left[1])[0];
		expect(strongest?.[0]).toBe(expectedBand);
		expect(strongest?.[1] ?? 0).toBeGreaterThan(0.99);
		expect(Object.isFrozen(bands)).toBe(true);
	}
});

test("Sonic spectrum analysis derives kick, body, vocal, snap, and timbre features", () => {
	const makeFixtureFrame = (name: "kick" | "bright") => {
		const fixture = M4_SONIC_AUDIO_FRAMES[name];
		return createSonicSpectrumFrame({
			bins: fixture.createBins(),
			sampleRate: fixture.sampleRate,
			fftSize: fixture.fftSize,
			currentTimeSeconds: fixture.currentTimeSeconds,
			playing: fixture.playing,
		});
	};
	const kick = analyzeSonicSpectrum(makeFixtureFrame("kick"));
	const bright = analyzeSonicSpectrum(makeFixtureFrame("bright"));

	expect(kick.kickSub).toBeGreaterThan(0.9);
	expect(kick.kickCore).toBeGreaterThan(kick.kickSub);
	expect(kick.kickPunch).toBeGreaterThan(0.4);
	expect(kick.lowDrive).toBeGreaterThan(kick.vocal);
	expect(kick.warmth).toBeGreaterThan(kick.brightness);
	expect(bright.snap).toBeGreaterThan(0.05);
	expect(bright.brightness).toBeGreaterThan(bright.warmth);
	expect(bright.sharpness).toBeGreaterThan(0.05);
	expect(kick.energy).toBeGreaterThan(0);
	expect(kick.dominance).toBeGreaterThan(0.5);
	expect(Object.isFrozen(kick)).toBe(true);
});

test("Sonic trigger hysteresis fires at 0.58 and rearms below 0.32", () => {
	const profile = createSonicAudioProfile();
	const frame = (name: "silence" | "kick", time: number) => {
		const fixture = M4_SONIC_AUDIO_FRAMES[name];
		return createSonicSpectrumFrame({
			bins: fixture.createBins(),
			sampleRate: fixture.sampleRate,
			fftSize: fixture.fftSize,
			currentTimeSeconds: time,
			playing: true,
		});
	};
	const update = (name: "silence" | "kick", time: number) => profile.update({
		spectrum: frame(name, time),
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: false,
	});

	expect(update("silence", 0).onset).toBe(0);
	const firstKick = update("kick", 1 / 60);
	expect(firstKick.lowDrive).toBeGreaterThan(0.58);
	expect(firstKick.onset).toBeGreaterThan(0);
	expect(firstKick.triggerPulse).toBeGreaterThan(0);
	expect(update("kick", 2 / 60).onset).toBe(0);
	expect(update("silence", 3 / 60).onset).toBe(0);
	expect(update("kick", 4 / 60).onset).toBeGreaterThan(0);
});

test("Sonic monitor-off mode falls back to the existing generic audio snapshot", () => {
	const profile = createSonicAudioProfile();
	const snapshot = profile.update({
		spectrum: null,
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: false,
		reducedMotion: false,
		fallback: {
			bass: 0.82,
			mid: 0.46,
			treble: 0.28,
			energy: 0.63,
			beatPulse: 0.7,
		},
	});

	expect(snapshot.spectrum).toBeNull();
	expect(snapshot.kickCore).toBeGreaterThan(0.7);
	expect(snapshot.vocal).toBeGreaterThan(0.2);
	expect(snapshot.snap).toBeGreaterThan(0.1);
	expect(snapshot.energy).toBeCloseTo(0.63, 8);
	expect(snapshot.onset).toBe(0);
	expect(snapshot.triggerPulse).toBeCloseTo(0.7, 8);
	expect(Object.isFrozen(snapshot.bands)).toBe(true);
});

test("paused Sonic frames decay without onset while reduced motion keeps analysis", () => {
	const makeFrame = (name: "silence" | "kick", time: number, playing: boolean) => {
		const fixture = M4_SONIC_AUDIO_FRAMES[name];
		return createSonicSpectrumFrame({
			bins: fixture.createBins(),
			sampleRate: fixture.sampleRate,
			fftSize: fixture.fftSize,
			currentTimeSeconds: time,
			playing,
		});
	};
	const pausedProfile = createSonicAudioProfile();
	pausedProfile.update({
		spectrum: makeFrame("silence", 0, true),
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: false,
	});
	const paused = pausedProfile.update({
		spectrum: makeFrame("kick", 1 / 60, false),
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: false,
	});
	expect(paused.onset).toBe(0);
	expect(paused.flux).toBe(0);
	expect(paused.lowDrive).toBe(0);

	const reducedProfile = createSonicAudioProfile();
	reducedProfile.update({
		spectrum: makeFrame("silence", 0, true),
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: true,
	});
	const reduced = reducedProfile.update({
		spectrum: makeFrame("kick", 1 / 60, true),
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: true,
	});
	expect(reduced.lowDrive).toBeGreaterThan(0.58);
	expect(reduced.onset).toBeGreaterThan(0);
	expect(reduced.triggerPulse).toBe(0);
});

test("Sonic timeline discontinuities reset flux and hysteresis before accepting a new onset", () => {
	const makeFrame = (name: "silence" | "kick", time: number, sampleRate = 48_000, fftSize = 1024) => {
		const fixture = M4_SONIC_AUDIO_FRAMES[name];
		return createSonicSpectrumFrame({
			bins: fixture.createBins(),
			sampleRate,
			fftSize,
			currentTimeSeconds: time,
			playing: true,
		});
	};
	const runResetCase = (resetInput: Parameters<ReturnType<typeof createSonicAudioProfile>["update"]>[0]) => {
		const profile = createSonicAudioProfile();
		profile.update({
			spectrum: makeFrame("silence", 10),
			dtSeconds: 1 / 60,
			trackKey: "track-a",
			monitorEnabled: true,
			reducedMotion: false,
		});
		expect(profile.update({
			spectrum: makeFrame("kick", 10 + 1 / 60),
			dtSeconds: 1 / 60,
			trackKey: "track-a",
			monitorEnabled: true,
			reducedMotion: false,
		}).onset).toBeGreaterThan(0);
		const resetFrame = profile.update(resetInput);
		expect(resetFrame.onset).toBe(0);
		expect(resetFrame.flux).toBe(0);
	};

	runResetCase({
		spectrum: makeFrame("kick", 10.1),
		dtSeconds: 1 / 60,
		trackKey: "track-b",
		monitorEnabled: true,
		reducedMotion: false,
	});
	runResetCase({
		spectrum: makeFrame("kick", 1),
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: false,
	});
	runResetCase({
		spectrum: makeFrame("kick", 10.1, 44_100, 1024),
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: false,
	});
	runResetCase({
		spectrum: makeFrame("kick", 10.1, 48_000, 2048),
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: false,
	});
	runResetCase({
		spectrum: null,
		dtSeconds: 1 / 60,
		trackKey: "track-a",
		monitorEnabled: true,
		reducedMotion: false,
	});
});

test("Sonic feature smoothing is stable across 30 and 60 FPS steps", () => {
	const rawFixture = M4_SONIC_AUDIO_FRAMES.kick;
	const rawFrame = createSonicSpectrumFrame({
		bins: rawFixture.createBins(),
		sampleRate: rawFixture.sampleRate,
		fftSize: rawFixture.fftSize,
		currentTimeSeconds: 1,
		playing: true,
	});
	const rawLowDrive = analyzeSonicSpectrum(rawFrame).lowDrive;
	const run = (dtSeconds: number) => {
		const profile = createSonicAudioProfile();
		profile.update({
			spectrum: createSonicSpectrumFrame({
				bins: M4_SONIC_AUDIO_FRAMES.silence.createBins(),
				sampleRate: 48_000,
				fftSize: 1024,
				currentTimeSeconds: 0,
				playing: true,
			}),
			dtSeconds,
			trackKey: "track-a",
			monitorEnabled: true,
			reducedMotion: false,
		});
		let current = profile.getSnapshot();
		const steps = Math.round(0.1 / dtSeconds);
		for (let index = 1; index <= steps; index += 1) {
			current = profile.update({
				spectrum: createSonicSpectrumFrame({
					bins: rawFixture.createBins(),
					sampleRate: rawFixture.sampleRate,
					fftSize: rawFixture.fftSize,
					currentTimeSeconds: index * dtSeconds,
					playing: true,
				}),
				dtSeconds,
				trackKey: "track-a",
				monitorEnabled: true,
				reducedMotion: false,
			});
		}
		return current.lowDrive;
	};
	const at30Fps = run(1 / 30);
	const at60Fps = run(1 / 60);

	expect(at30Fps).toBeCloseTo(at60Fps, 6);
	expect(at60Fps).toBeLessThan(rawLowDrive);
	expect(at60Fps).toBeGreaterThan(0.8);
});

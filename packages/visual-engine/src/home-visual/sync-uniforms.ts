import type { FxState } from "./fx-defaults";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import { SKULL_PRESET_INDEX } from "./preset-state";

export interface SyncUniformsOpts {
	lerpK?: number;
	dt?: number;
}

export interface UniformSlot {
	value: number | { x: number; y: number; set: (x: number, y: number) => void } | unknown;
}

export interface UniformContainer {
	uBass?: UniformSlot;
	uMid?: UniformSlot;
	uTreble?: UniformSlot;
	uBeat?: UniformSlot;
	uEnergy?: UniformSlot;
	uMouseXY?: UniformSlot;
	uMouseActive?: UniformSlot;
	uVinylSpin?: UniformSlot;
	uParticleDim?: UniformSlot;
	uBurstAmt?: UniformSlot;
	[key: string]: UniformSlot | undefined;
}

export function lerp(value: number, target: number, k: number): number {
	const clampedK = Math.min(1, Math.max(0, k));
	return value + (target - value) * clampedK;
}

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

function numValue(slot: UniformSlot | undefined, fallback: number): number {
	if (slot && typeof slot.value === "number") return slot.value as number;
	return fallback;
}

export function syncFxUniforms(
	fx: FxState,
	snapshot: AudioSnapshot,
	uniforms: UniformContainer,
	opts?: SyncUniformsOpts,
): void {
	const dt = opts?.dt ?? 1 / 60;

	const smoothBass = (snapshot.bass - snapshot.beatPulse * 0.18) / 1.05;
	const smoothMid = snapshot.mid / 1.12;
	const smoothTreb = snapshot.treble / 1.20;

	let bass = snapshot.bass * fx.intensity;
	let mid = snapshot.mid * fx.intensity;
	let treble = snapshot.treble * fx.intensity;
	let beatPulse = snapshot.beatPulse;
	const audioEnergy = snapshot.energy;

	if (fx.preset >= 4) {
		const wallpaperAudio = fx.preset === 5;
		const ringBass = smoothBass * (wallpaperAudio ? 1.10 : 1.58) + beatPulse * (wallpaperAudio ? 0.18 : 0.42) - smoothMid * 0.16 - smoothTreb * 0.06;
		const ringMid = smoothMid * (wallpaperAudio ? 1.16 : 1.82) - smoothBass * 0.14 - smoothTreb * 0.07;
		const ringTreble = smoothTreb * (wallpaperAudio ? 1.34 : 2.28) - smoothMid * 0.10 - smoothBass * 0.05;
		bass = Math.pow(clamp01((ringBass - 0.050) / 0.58), 0.72) * fx.intensity;
		mid = Math.pow(clamp01((ringMid - 0.045) / 0.46), 0.78) * fx.intensity;
		treble = Math.pow(clamp01((ringTreble - 0.030) / 0.34), 0.84) * fx.intensity;
		if (wallpaperAudio) {
			bass = Math.min(bass, 0.46 * fx.intensity);
			mid = Math.min(mid, 0.40 * fx.intensity);
			treble = Math.min(treble, 0.36 * fx.intensity);
			beatPulse *= 0.34;
		}
	}

	if (uniforms.uBass) uniforms.uBass.value = bass;
	if (uniforms.uMid) uniforms.uMid.value = mid;
	if (uniforms.uTreble) uniforms.uTreble.value = treble;
	if (uniforms.uBeat) uniforms.uBeat.value = beatPulse;
	if (uniforms.uEnergy) uniforms.uEnergy.value = audioEnergy;
	if (uniforms.uMouseActive) uniforms.uMouseActive.value = fx.mouseActive ? 1 : 0;
	if (uniforms.uMouseXY) {
		const cur = uniforms.uMouseXY.value;
		if (cur && typeof (cur as { set?: unknown }).set === "function") (cur as { set: (x: number, y: number) => void }).set(fx.mouseXy.x, fx.mouseXy.y);
		else uniforms.uMouseXY.value = { x: fx.mouseXy.x, y: fx.mouseXy.y };
	}

	const vinylSpeedMul = Number.isFinite(fx.speed) ? Math.max(0.05, fx.speed) : 1;
	const vinylSpinSpeed = (0.40 + smoothBass * 0.09) * vinylSpeedMul;
	const curVinyl = numValue(uniforms.uVinylSpin, 0);
	if (uniforms.uVinylSpin) uniforms.uVinylSpin.value = (curVinyl + dt * vinylSpinSpeed) % (Math.PI * 2);

	const skullBackdropDim = fx.preset === SKULL_PRESET_INDEX ? 0.58 : 1;
	const targetDim = skullBackdropDim;
	const curDim = numValue(uniforms.uParticleDim, 1);
	const easeK = targetDim < curDim ? 0.18 : 0.10;
	if (uniforms.uParticleDim) uniforms.uParticleDim.value = lerp(curDim, targetDim, Math.min(1, easeK * Math.max(1, dt * 60)));

	const curBurst = numValue(uniforms.uBurstAmt, 0);
	if (uniforms.uBurstAmt) uniforms.uBurstAmt.value = curBurst * 0.90;
}
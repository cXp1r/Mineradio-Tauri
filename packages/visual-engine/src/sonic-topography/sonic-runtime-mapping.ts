/**
 * Sonic Topography 视觉层的 Tauri 修改版本。
 * 直接上游：XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224，public/sonic-topography-preset.js。
 * 原始项目：yin-yizhen/sonic-topography@3ff303e，作者 Ajin；适用 Non-Commercial Learning License。
 * 完整来源、许可范围与修改告知见 THIRD_PARTY_NOTICES.md。
 */
import type { SonicEqSettings, SonicTerrainSettings } from "./sonic-settings";

export interface SonicGroundLayout {
	readonly scale: number;
	readonly y: number;
	readonly z: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	const safe = Number.isFinite(value) ? value : 0;
	return Math.max(minimum, Math.min(maximum, safe));
}

function roundLayout(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

export function applySonicEqBandValue(
	value: number,
	eqValue: number,
	maximum = 1,
): number {
	const delta = (clamp(eqValue, 0, 100) - 50) / 50;
	if (delta >= 0) return clamp(value * (1 + delta * 1.8), 0, maximum);
	const dullness = Math.abs(delta);
	return clamp(Math.max(0, value - dullness * 0.35) * (1 - dullness * 0.35), 0, maximum);
}

export function writeSonicGroundEqTarget(
	target: Float32Array,
	bands: Float32Array,
	kickEnvelope: number,
	eq: SonicEqSettings,
): Float32Array {
	const safeKick = clamp(kickEnvelope, 0, 0.75);
	const normalizedKick = safeKick / 0.75;
	target[0] = applySonicEqBandValue(clamp01(bands[0] ?? 0) * 0.22 + normalizedKick * 1.28, eq.subBass, 1.2);
	target[1] = applySonicEqBandValue(clamp01(bands[1] ?? 0) * 0.20 + normalizedKick * 1.15, eq.bass, 1.15);
	target[2] = applySonicEqBandValue(clamp01(bands[2] ?? 0), eq.lowMid);
	target[3] = applySonicEqBandValue(clamp01(bands[3] ?? 0), eq.mid);
	target[4] = applySonicEqBandValue(clamp01(bands[4] ?? 0), eq.highMid);
	target[5] = applySonicEqBandValue(clamp01(bands[5] ?? 0), eq.presence);
	target[6] = applySonicEqBandValue(clamp01(bands[6] ?? 0), eq.brilliance);
	target[7] = applySonicEqBandValue(clamp01(bands[7] ?? 0), eq.air);
	return target;
}

export function smoothSonicGroundBands(
	current: Float32Array,
	target: Float32Array,
	motionSpeed: number,
	dtSeconds: number,
): Float32Array {
	const responseRate = 2.2 + (60 - 2.2) * (clamp(motionSpeed, 0, 100) / 100);
	const blend = clamp01(1 - Math.exp(-responseRate * Math.max(0.001, dtSeconds)));
	for (let index = 0; index < 8; index += 1) {
		const previous = current[index] ?? 0;
		current[index] = previous + ((target[index] ?? 0) - previous) * blend;
	}
	return current;
}

export function resolveSonicGroundLayout(settings: SonicTerrainSettings): SonicGroundLayout {
	const range = clamp(settings.range, 0, 100);
	const lower = clamp(settings.lower, 0, 100);
	const depth = clamp(settings.depth, 0, 100);
	return Object.freeze({
		scale: roundLayout(0.096 + range * 0.00072),
		y: roundLayout(-4.05 - lower * 0.034),
		z: roundLayout(-4.2 - depth * 0.055),
	});
}

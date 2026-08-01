/**
 * Sonic Topography 视觉层的 Tauri 修改版本。
 * 直接上游：XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224，public/sonic-topography-preset.js。
 * 原始项目：yin-yizhen/sonic-topography@3ff303e，作者 Ajin；适用 Non-Commercial Learning License。
 * 完整来源、许可范围与修改告知见 THIRD_PARTY_NOTICES.md。
 */
import {
	AdditiveBlending,
	Color,
	NormalBlending,
	ShaderMaterial,
	Vector4,
	type IUniform,
} from "three";
import type { SonicPalette } from "./sonic-palette";

export const SONIC_RIPPLE_CAP = 10 as const;

export interface SonicTerrainUniforms {
	readonly [key: string]: IUniform;
	readonly uTime: IUniform<number>;
	readonly uAmplitude: IUniform<number>;
	readonly uMotionSpeed: IUniform<number>;
	readonly uBands: IUniform<Float32Array>;
	readonly uEq: IUniform<Float32Array>;
	readonly uKickEnvelope: IUniform<number>;
	readonly uEnergy: IUniform<number>;
	readonly uSharpness: IUniform<number>;
	readonly uSmoothness: IUniform<number>;
	readonly uDensity: IUniform<number>;
	readonly uWarmth: IUniform<number>;
	readonly uBrightness: IUniform<number>;
	readonly uRippleCount: IUniform<number>;
	readonly uRipples: IUniform<Vector4[]>;
	readonly uBaseColor1: IUniform<Color>;
	readonly uBaseColor2: IUniform<Color>;
	readonly uFogColor: IUniform<Color>;
	readonly uCoolCore: IUniform<Color>;
	readonly uCoolEdge: IUniform<Color>;
	readonly uWarmCore: IUniform<Color>;
	readonly uWarmEdge: IUniform<Color>;
	readonly uRippleColor: IUniform<Color>;
	readonly uGlowIntensity: IUniform<number>;
	// 保留旧名称，避免组合层在迁移期间发生破坏性变化。
	readonly uBaseColor: IUniform<Color>;
	readonly uCoolColor: IUniform<Color>;
	readonly uWarmColor: IUniform<Color>;
	readonly uAccentColor: IUniform<Color>;
	readonly uGlow: IUniform<number>;
	readonly uFogNear: IUniform<number>;
	readonly uFogFar: IUniform<number>;
}

export type SonicTerrainMaterial = ShaderMaterial & {
	readonly uniforms: SonicTerrainUniforms;
};

const TERRAIN_VERTEX_SHADER = `
	precision highp float;
	uniform float uTime;
	uniform float uAmplitude;
	uniform float uMotionSpeed;
	uniform float uBands[8];
	uniform float uEq[8];
	uniform float uKickEnvelope;
	uniform float uEnergy;
	uniform float uSmoothness;
	uniform float uDensity;
	uniform int uRippleCount;
	uniform vec4 uRipples[10];
	varying vec2 vUv;
	varying float vElevation;
	varying float vDistance;
	varying vec2 vRippleAnim;
	varying vec3 vNormal;
	varying float vRelativeY;
	varying vec2 vInstancePos;

	vec3 mod289(vec3 value) {
		return value - floor(value * (1.0 / 289.0)) * 289.0;
	}

	vec2 mod289(vec2 value) {
		return value - floor(value * (1.0 / 289.0)) * 289.0;
	}

	vec3 permute(vec3 value) {
		return mod289(((value * 34.0) + 1.0) * value);
	}

	float snoise(vec2 value) {
		const vec4 coefficients = vec4(
			0.211324865405187,
			0.366025403784439,
			-0.577350269189626,
			0.024390243902439
		);
		vec2 cell = floor(value + dot(value, coefficients.yy));
		vec2 origin = value - cell + dot(cell, coefficients.xx);
		vec2 corner = origin.x > origin.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
		vec4 offsets = origin.xyxy + coefficients.xxzz;
		offsets.xy -= corner;
		cell = mod289(cell);
		vec3 permutation = permute(
			permute(cell.y + vec3(0.0, corner.y, 1.0)) + cell.x + vec3(0.0, corner.x, 1.0)
		);
		vec3 attenuation = max(
			0.5 - vec3(
				dot(origin, origin),
				dot(offsets.xy, offsets.xy),
				dot(offsets.zw, offsets.zw)
			),
			0.0
		);
		attenuation *= attenuation;
		attenuation *= attenuation;
		vec3 gradientX = 2.0 * fract(permutation * coefficients.www) - 1.0;
		vec3 gradientH = abs(gradientX) - 0.5;
		vec3 gradientOffset = floor(gradientX + 0.5);
		vec3 gradient = gradientX - gradientOffset;
		attenuation *= 1.79284291400159
			- 0.85373472095314 * (gradient * gradient + gradientH * gradientH);
		vec3 contribution;
		contribution.x = gradient.x * origin.x + gradientH.x * origin.y;
		contribution.yz = gradient.yz * offsets.xz + gradientH.yz * offsets.yw;
		return 130.0 * dot(attenuation, contribution);
	}

	float random(vec2 value) {
		return fract(sin(dot(value.xy, vec2(12.9898, 78.233))) * 43758.5453123);
	}

	void main() {
		vUv = uv;
		vNormal = normal;
		vec4 instancePosition = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
		vec2 position2d = instancePosition.xz;
		vInstancePos = position2d;
		float centerDistance = length(position2d);
		vDistance = centerDistance;
		float seed = random(position2d);
		float sonicTime = uTime;
		vec2 movingPosition = position2d * 0.05 + vec2(sonicTime * 0.1, sonicTime * 0.05);
		float baseNoise = (snoise(movingPosition) + 1.0) * 0.5;
		float wave = sin(position2d.x * 0.15 + position2d.y * 0.1 - sonicTime * 0.6) * 0.5 + 0.5;
		float globalFalloff = smoothstep(60.0, 30.0, centerDistance);
		float idleElevation = mix(baseNoise, wave, uSmoothness * 0.5 + 0.2) * 0.8 * globalFalloff;

		float subBass = clamp(uBands[0], 0.0, 1.2);
		float bass = clamp(uBands[1], 0.0, 1.15);
		float lowMid = clamp(uBands[2], 0.0, 1.0);
		float mid = clamp(uBands[3], 0.0, 1.0);
		float highMid = clamp(uBands[4], 0.0, 1.0);
		float subRegion = smoothstep(25.0, 0.0, centerDistance);
		float subLift = subBass * subRegion * 5.0;
		float bassNoise = snoise(position2d * 0.1 - vec2(0.0, sonicTime * 0.2));
		float bassRegion = smoothstep(35.0, 5.0, centerDistance + bassNoise * 5.0);
		float bassLift = bass * bassRegion * smoothstep(0.0, 1.0, seed + uDensity * 0.5) * 4.0;
		float lowMidNoise = snoise(position2d * 0.05 + vec2(sonicTime * 0.1, 0.0));
		float lowMidLift = lowMid * (lowMidNoise * 0.5 + 0.5) * 2.5;
		float riverFlow = sin(
			position2d.x * 0.2 + position2d.y * 0.2 + snoise(position2d * 0.1) * 2.0 - sonicTime * 2.0
		);
		float midLift = mid * max(0.0, riverFlow) * 3.0;
		float highMidRegion = smoothstep(10.0, 45.0, centerDistance);
		float highMidLift = 0.0;
		if (fract(seed * 13.3) > 0.8) highMidLift = highMid * highMidRegion * fract(seed * 7.7) * 2.5;
		float audioElevation = subLift + bassLift + lowMidLift + midLift + highMidLift;
		if (seed > 0.99) audioElevation += uEnergy * 5.0;
		audioElevation *= globalFalloff;
		audioElevation = max(0.0, audioElevation - 0.2) * uAmplitude;
		float elevation = idleElevation + audioElevation;

		float rippleElevation = 0.0;
		float normalRippleIntensity = 0.0;
		float whiteRippleIntensity = 0.0;
		for (int index = 0; index < 10; index += 1) {
			if (index >= uRippleCount) break;
			vec4 ripple = uRipples[index];
			bool whiteRipple = ripple.w < 0.0;
			float rippleStrength = abs(ripple.w);
			float distanceFromWave = distance(position2d, ripple.xy) - ripple.z;
			float rippleWidth = whiteRipple ? 1.35 : 5.5;
			float ripplePulse = exp(-distanceFromWave * distanceFromWave / rippleWidth) * rippleStrength;
			rippleElevation += ripplePulse * (whiteRipple ? 1.15 : 3.35);
			if (whiteRipple) whiteRippleIntensity += ripplePulse;
			else normalRippleIntensity += ripplePulse;
		}
		elevation += rippleElevation;
		vRippleAnim = vec2(
			clamp(normalRippleIntensity, 0.0, 1.0),
			clamp(whiteRippleIntensity, 0.0, 1.0)
		);
		vElevation = elevation;
		float localY = position.y + 0.5;
		vRelativeY = localY;
		float totalHeight = 1.0 + elevation;
		vec3 transformed = position;
		transformed.y = -0.5 + localY * totalHeight;
		vec4 worldPosition = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
		gl_Position = projectionMatrix * viewMatrix * worldPosition;
	}
`;

const TERRAIN_FRAGMENT_SHADER = `
	precision highp float;
	uniform float uTime;
	uniform float uBands[8];
	uniform float uWarmth;
	uniform float uBrightness;
	uniform float uSharpness;
	uniform vec3 uBaseColor1;
	uniform vec3 uBaseColor2;
	uniform vec3 uFogColor;
	uniform vec3 uCoolCore;
	uniform vec3 uCoolEdge;
	uniform vec3 uWarmCore;
	uniform vec3 uWarmEdge;
	uniform vec3 uRippleColor;
	uniform float uGlowIntensity;
	varying vec2 vUv;
	varying float vElevation;
	varying float vDistance;
	varying vec2 vRippleAnim;
	varying vec3 vNormal;
	varying float vRelativeY;
	varying vec2 vInstancePos;

	float random(vec2 value) {
		return fract(sin(dot(value.xy, vec2(12.9898, 78.233))) * 43758.5453123);
	}

	void main() {
		bool isTop = vNormal.y > 0.5;
		float distanceFromTop = 1.0 - vRelativeY;
		float seed = random(vInstancePos);
		float centerDistance = length(vInstancePos);
		float normalizedElevation = clamp(vElevation / 8.0, 0.0, 1.0);
		float warmMix = smoothstep(0.0, 1.0, uWarmth * 1.5 + (0.5 - centerDistance / 80.0));
		vec3 zoneCore = mix(uCoolCore, uWarmCore, warmMix);
		vec3 zoneEdge = mix(uCoolEdge, uWarmEdge, warmMix);
		vec3 targetGlow = mix(zoneCore, zoneEdge, fract(seed * 11.0));
		float distanceFade = 1.0 - smoothstep(40.0, 75.0, centerDistance);
		vec3 brightCool = mix(uCoolCore, vec3(1.0), 0.24);
		targetGlow = mix(targetGlow, brightCool, uBrightness * 0.6);
		vec3 currentGlow = mix(uBaseColor2, targetGlow, normalizedElevation) * uGlowIntensity * distanceFade;
		currentGlow = mix(currentGlow, uRippleColor, clamp(vRippleAnim.x * 0.82, 0.0, 0.72));
		currentGlow = mix(currentGlow, vec3(1.0), vRippleAnim.y);
		vec3 bodyColor = mix(uBaseColor1, uBaseColor2, vRelativeY * distanceFade);
		vec3 finalColor;
		if (isTop) {
			float topIntensity = smoothstep(0.0, 0.4, normalizedElevation);
			float twinkleDistanceFalloff = smoothstep(60.0, 30.0, centerDistance);
			float twinkleMultiplier = mix(
				twinkleDistanceFalloff,
				1.0,
				smoothstep(0.01, 0.1, normalizedElevation)
			);
			if (fract(seed * 31.0) > 0.95 && normalizedElevation < 0.1) {
				topIntensity += uBands[7] * 2.0 * twinkleMultiplier;
			}
			finalColor = mix(uBaseColor2, currentGlow, topIntensity);
			float edgeX = smoothstep(0.05, 0.01, vUv.x) + smoothstep(0.95, 0.99, vUv.x);
			float edgeY = smoothstep(0.05, 0.01, vUv.y) + smoothstep(0.95, 0.99, vUv.y);
			float edge = min(edgeX + edgeY, 1.0);
			finalColor += currentGlow * edge * 0.8 * (topIntensity + 0.3);
			float flashChance = smoothstep(0.3, 1.0, uBands[5]);
			if (fract(seed * 53.0) > 0.98 - flashChance * 0.1) {
				float flashSync = sin(uTime * 40.0 + seed * 100.0) * 0.5 + 0.5;
				finalColor += mix(vec3(1.0), vec3(0.5, 1.0, 1.0), seed)
					* flashSync * uBands[5] * (1.0 + uSharpness * 2.0) * twinkleMultiplier;
			}
			if (edge > 0.5 && fract(seed * 89.0 + uTime * 2.0) > 0.98) {
				finalColor += vec3(1.0) * uBands[6] * 3.0 * twinkleMultiplier;
			}
		} else {
			float verticalFalloff = mix(1.0, 3.0, uSharpness);
			float sideGlow = smoothstep(0.5 / verticalFalloff, 0.0, distanceFromTop) * normalizedElevation;
			if (normalizedElevation < 0.02) sideGlow = 0.0;
			finalColor = mix(bodyColor, currentGlow, sideGlow * 1.5);
			float rimGlow = smoothstep(0.03, 0.0, distanceFromTop) * normalizedElevation;
			finalColor += currentGlow * rimGlow;
		}
		finalColor += uRippleColor * vRippleAnim.x * 0.86;
		finalColor += vec3(1.0) * vRippleAnim.y * 1.2;
		float aerialFog = smoothstep(30.0, 65.0, vDistance);
		vec3 atmosphericColor = mix(uBaseColor1, uBaseColor2, 0.4);
		finalColor = mix(finalColor, atmosphericColor, aerialFog * 0.35);
		float alphaFade = 1.0 - smoothstep(55.0, 78.0, vDistance);
		finalColor = mix(finalColor, uFogColor, (1.0 - alphaFade) * 0.45);
		gl_FragColor = vec4(finalColor, alphaFade);
	}
`;

const FLOATING_VERTEX_SHADER = `
	precision highp float;
	uniform float uPulse;
	varying vec2 vUv;
	varying float vElevation;
	varying float vDistance;
	varying vec2 vRippleAnim;
	varying vec3 vNormal;
	varying float vRelativeY;
	varying vec2 vInstancePos;
	void main() {
		vUv = uv;
		vNormal = normal;
		vec4 instancePosition = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
		vec2 position2d = instancePosition.xz;
		vInstancePos = position2d;
		vDistance = length(position2d);
		vRippleAnim = vec2(uPulse * 0.8, uPulse * 0.3);
		vElevation = uPulse * 20.0;
		vRelativeY = position.y + 0.5;
		vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
		gl_Position = projectionMatrix * viewMatrix * worldPosition;
	}
`;

const SIMPLE_VERTEX_SHADER = `
	uniform float uTime;
	uniform float uPulse;
	varying float vAlpha;
	void main() {
		vec3 transformed = position;
		float shimmer = 1.0 + sin(uTime * 1.7 + instanceMatrix[3].x * 0.8) * 0.06;
		transformed *= shimmer * (1.0 + uPulse * 0.12);
		vec4 worldPosition = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
		vAlpha = clamp(0.45 + uPulse * 0.5, 0.0, 1.0);
		gl_Position = projectionMatrix * viewMatrix * worldPosition;
	}
`;

const SIMPLE_FRAGMENT_SHADER = `
	uniform vec3 uColor;
	uniform float uOpacity;
	varying float vAlpha;
	void main() {
		gl_FragColor = vec4(uColor, uOpacity * vAlpha);
	}
`;

export interface SonicSimpleUniforms {
	readonly [key: string]: IUniform;
	readonly uTime: IUniform<number>;
	readonly uPulse: IUniform<number>;
	readonly uColor: IUniform<Color>;
	readonly uOpacity: IUniform<number>;
}

export type SonicSimpleMaterial = ShaderMaterial & {
	readonly uniforms: SonicSimpleUniforms;
};

export interface SonicFloatingUniforms extends SonicTerrainUniforms {
	readonly uPulse: IUniform<number>;
}

export type SonicFloatingMaterial = ShaderMaterial & {
	readonly uniforms: SonicFloatingUniforms;
};

function createSonicTerrainUniforms(palette: SonicPalette): SonicTerrainUniforms {
	const baseColor1 = { value: palette.base.clone() };
	const baseColor2 = { value: palette.base.clone().lerp(new Color("#ffffff"), 0.12) };
	const fogColor = { value: palette.base.clone() };
	const coolCore = { value: palette.cool.clone() };
	const coolEdge = { value: palette.cool.clone().lerp(palette.base, 0.34) };
	const warmCore = { value: palette.warm.clone() };
	const warmEdge = { value: palette.warm.clone().lerp(palette.base, 0.26) };
	const rippleColor = { value: palette.accent.clone() };
	const glowIntensity = {
		value: Math.max(0.45, Math.min(2.2, 0.55 + palette.glow * 1.4)),
	};
	return {
		uTime: { value: 0 },
		uAmplitude: { value: 1 },
		uMotionSpeed: { value: 1.3 },
		uBands: { value: new Float32Array(8) },
		uEq: { value: new Float32Array(8).fill(50) },
		uKickEnvelope: { value: 0 },
		uEnergy: { value: 0 },
		uSharpness: { value: 0 },
		uSmoothness: { value: 0 },
		uDensity: { value: 0 },
		uWarmth: { value: 0.5 },
		uBrightness: { value: 0.5 },
		uRippleCount: { value: 0 },
		uRipples: {
			value: Array.from({ length: SONIC_RIPPLE_CAP }, () => new Vector4()),
		},
		uBaseColor1: baseColor1,
		uBaseColor2: baseColor2,
		uFogColor: fogColor,
		uCoolCore: coolCore,
		uCoolEdge: coolEdge,
		uWarmCore: warmCore,
		uWarmEdge: warmEdge,
		uRippleColor: rippleColor,
		uGlowIntensity: glowIntensity,
		uBaseColor: baseColor1,
		uCoolColor: coolCore,
		uWarmColor: warmCore,
		uAccentColor: rippleColor,
		uGlow: glowIntensity,
		uFogNear: { value: 4 },
		uFogFar: { value: 14 },
	};
}

export function createSonicTerrainMaterial(palette: SonicPalette): SonicTerrainMaterial {
	const uniforms = createSonicTerrainUniforms(palette);
	return new ShaderMaterial({
		uniforms,
		vertexShader: TERRAIN_VERTEX_SHADER,
		fragmentShader: TERRAIN_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: true,
		depthTest: true,
		blending: NormalBlending,
	}) as SonicTerrainMaterial;
}

export function createSonicFloatingMaterial(palette: SonicPalette): SonicFloatingMaterial {
	const uniforms: SonicFloatingUniforms = {
		...createSonicTerrainUniforms(palette),
		uPulse: { value: 0 },
	};
	return new ShaderMaterial({
		uniforms,
		vertexShader: FLOATING_VERTEX_SHADER,
		fragmentShader: TERRAIN_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: true,
		blending: NormalBlending,
	}) as SonicFloatingMaterial;
}

export function createSonicSimpleMaterial(
	color: Color,
	opacity: number,
	additive = false,
): SonicSimpleMaterial {
	const uniforms: SonicSimpleUniforms = {
		uTime: { value: 0 },
		uPulse: { value: 0 },
		uColor: { value: color.clone() },
		uOpacity: { value: opacity },
	};
	return new ShaderMaterial({
		uniforms,
		vertexShader: SIMPLE_VERTEX_SHADER,
		fragmentShader: SIMPLE_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: true,
		blending: additive ? AdditiveBlending : NormalBlending,
	}) as SonicSimpleMaterial;
}

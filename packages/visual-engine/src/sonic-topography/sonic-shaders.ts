import {
	AdditiveBlending,
	NormalBlending,
	ShaderMaterial,
	Vector4,
	type Color,
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
	readonly uRippleCount: IUniform<number>;
	readonly uRipples: IUniform<Vector4[]>;
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
	uniform float uTime;
	uniform float uAmplitude;
	uniform float uMotionSpeed;
	uniform float uBands[8];
	uniform int uRippleCount;
	uniform vec4 uRipples[10];
	varying float vSignal;
	varying vec3 vWorldPosition;

	void main() {
		vec3 cell = instanceMatrix[3].xyz;
		float radial = length(cell.xz) * 0.16;
		float bands = 0.0;
		for (int index = 0; index < 8; index += 1) {
			float weight = 1.0 - abs(float(index) - clamp(radial * 7.0, 0.0, 7.0)) / 7.0;
			bands += uBands[index] * max(0.0, weight) * 0.18;
		}
		float drift = sin(cell.x * 0.72 + uTime * uMotionSpeed)
			+ cos(cell.z * 0.61 - uTime * uMotionSpeed * 0.83);
		float ripple = 0.0;
		for (int index = 0; index < 10; index += 1) {
			if (index >= uRippleCount) break;
			vec4 wave = uRipples[index];
			float distanceFromWave = abs(distance(cell.xz, wave.xy) - wave.z);
			ripple += exp(-distanceFromWave * 5.5) * wave.w;
		}
		float height = max(0.06, 0.10 + (bands + drift * 0.055 + ripple * 0.42) * uAmplitude);
		vec3 transformed = position;
		transformed.y *= height;
		vec4 worldPosition = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
		vWorldPosition = worldPosition.xyz;
		vSignal = clamp(height / max(0.001, 1.0 + uAmplitude), 0.0, 1.0);
		gl_Position = projectionMatrix * viewMatrix * worldPosition;
	}
`;

const TERRAIN_FRAGMENT_SHADER = `
	uniform vec3 uBaseColor;
	uniform vec3 uCoolColor;
	uniform vec3 uWarmColor;
	uniform vec3 uAccentColor;
	uniform float uGlow;
	uniform float uFogNear;
	uniform float uFogFar;
	varying float vSignal;
	varying vec3 vWorldPosition;

	void main() {
		float warmMix = smoothstep(0.32, 0.92, vSignal);
		vec3 signalColor = mix(uCoolColor, uWarmColor, warmMix);
		vec3 color = mix(uBaseColor, signalColor, 0.42 + vSignal * 0.48);
		color += uAccentColor * uGlow * pow(vSignal, 2.0) * 0.35;
		float distanceFade = 1.0 - smoothstep(uFogNear, uFogFar, length(vWorldPosition.xz));
		gl_FragColor = vec4(color, clamp(distanceFade * (0.48 + vSignal * 0.52), 0.0, 1.0));
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

export function createSonicTerrainMaterial(palette: SonicPalette): SonicTerrainMaterial {
	const uniforms: SonicTerrainUniforms = {
		uTime: { value: 0 },
		uAmplitude: { value: 1 },
		uMotionSpeed: { value: 1 },
		uBands: { value: new Float32Array(8) },
		uRippleCount: { value: 0 },
		uRipples: {
			value: Array.from({ length: SONIC_RIPPLE_CAP }, () => new Vector4()),
		},
		uBaseColor: { value: palette.base.clone() },
		uCoolColor: { value: palette.cool.clone() },
		uWarmColor: { value: palette.warm.clone() },
		uAccentColor: { value: palette.accent.clone() },
		uGlow: { value: palette.glow },
		uFogNear: { value: 4 },
		uFogFar: { value: 14 },
	};
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

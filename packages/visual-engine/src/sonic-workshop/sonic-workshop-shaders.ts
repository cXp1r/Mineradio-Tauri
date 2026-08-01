import {
	Color,
	NormalBlending,
	ShaderMaterial,
	Vector4,
	type IUniform,
} from "three";
import type { SonicWorkshopPalette } from "./sonic-workshop-palette";

export const SONIC_WORKSHOP_RIPPLE_CAP = 8 as const;

export interface SonicWorkshopTerrainUniforms {
	readonly [key: string]: IUniform;
	readonly uTime: IUniform<number>;
	readonly uBands: IUniform<Float32Array>;
	readonly uInputGain: IUniform<number>;
	readonly uAudioIntensity: IUniform<number>;
	readonly uResponseRange: IUniform<number>;
	readonly uPeakIntensity: IUniform<number>;
	readonly uRippleCount: IUniform<number>;
	readonly uRipples: IUniform<Vector4[]>;
	readonly uPrimary: IUniform<Color>;
	readonly uBase: IUniform<Color>;
	readonly uWarm: IUniform<Color>;
	readonly uCool: IUniform<Color>;
	readonly uRipple: IUniform<Color>;
	readonly uPeak: IUniform<Color>;
}

export type SonicWorkshopTerrainMaterial = ShaderMaterial & {
	readonly uniforms: SonicWorkshopTerrainUniforms;
};

const TERRAIN_VERTEX_SHADER = `
	precision highp float;
	uniform float uTime;
	uniform float uBands[8];
	uniform float uInputGain;
	uniform float uAudioIntensity;
	uniform float uResponseRange;
	uniform int uRippleCount;
	uniform vec4 uRipples[8];
	varying float vHeight;
	varying float vRipple;
	varying float vRadius;

	float selectBand(float index) {
		if (index < 1.0) return uBands[0];
		if (index < 2.0) return uBands[1];
		if (index < 3.0) return uBands[2];
		if (index < 4.0) return uBands[3];
		if (index < 5.0) return uBands[4];
		if (index < 6.0) return uBands[5];
		if (index < 7.0) return uBands[6];
		return uBands[7];
	}

	void main() {
		vec4 origin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
		vec2 field = origin.xz;
		float radius = clamp(length(field) / 68.0, 0.0, 1.0);
		float band = selectBand(clamp(radius * 8.0 / max(0.3, uResponseRange), 0.0, 7.999));
		float shaped = pow(clamp(band * uInputGain, 0.0, 1.0), 1.32) * uAudioIntensity;
		float idle = 0.34
			+ sin(field.x * 0.17 + uTime * 0.46) * 0.11
			+ cos(field.y * 0.14 - uTime * 0.34) * 0.09;
		float rippleLift = 0.0;
		for (int index = 0; index < 8; index += 1) {
			if (index >= uRippleCount) break;
			vec4 ripple = uRipples[index];
			float waveDistance = distance(field, ripple.xy) - ripple.z;
			rippleLift += exp(-waveDistance * waveDistance / 2.8) * ripple.w;
		}
		float edgeFade = 1.0 - smoothstep(0.72, 1.0, radius);
		float height = max(0.16, idle + shaped * (5.4 - radius * 2.2) + rippleLift * 2.8) * edgeFade;
		vec3 transformed = position;
		transformed.y = -0.5 + (position.y + 0.5) * height;
		vHeight = height;
		vRipple = clamp(rippleLift, 0.0, 1.0);
		vRadius = radius;
		gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(transformed, 1.0);
	}
`;

const TERRAIN_FRAGMENT_SHADER = `
	precision highp float;
	uniform vec3 uPrimary;
	uniform vec3 uBase;
	uniform vec3 uWarm;
	uniform vec3 uCool;
	uniform vec3 uRipple;
	uniform vec3 uPeak;
	uniform float uPeakIntensity;
	varying float vHeight;
	varying float vRipple;
	varying float vRadius;

	void main() {
		float body = smoothstep(0.15, 2.8, vHeight);
		float crest = smoothstep(2.4, 6.8, vHeight);
		vec3 color = mix(uBase, uPrimary, body);
		color = mix(color, mix(uWarm, uCool, vRadius), body * 0.72);
		color = mix(color, uPeak, crest * uPeakIntensity);
		color = mix(color, uRipple, vRipple * 0.86);
		float alpha = 1.0 - smoothstep(0.82, 1.0, vRadius);
		gl_FragColor = vec4(color, alpha);
	}
`;

export function createSonicWorkshopTerrainMaterial(
	palette: SonicWorkshopPalette,
): SonicWorkshopTerrainMaterial {
	const uniforms: SonicWorkshopTerrainUniforms = {
		uTime: { value: 0 },
		uBands: { value: new Float32Array(8) },
		uInputGain: { value: 0.82 },
		uAudioIntensity: { value: 1.15 },
		uResponseRange: { value: 1.3 },
		uPeakIntensity: { value: 0.62 },
		uRippleCount: { value: 0 },
		uRipples: {
			value: Array.from({ length: SONIC_WORKSHOP_RIPPLE_CAP }, () => new Vector4()),
		},
		uPrimary: { value: palette.primary.clone() },
		uBase: { value: palette.base.clone() },
		uWarm: { value: palette.warm.clone() },
		uCool: { value: palette.cool.clone() },
		uRipple: { value: palette.ripple.clone() },
		uPeak: { value: palette.peak.clone() },
	};
	return new ShaderMaterial({
		uniforms,
		vertexShader: TERRAIN_VERTEX_SHADER,
		fragmentShader: TERRAIN_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: true,
		depthTest: true,
		blending: NormalBlending,
	}) as SonicWorkshopTerrainMaterial;
}

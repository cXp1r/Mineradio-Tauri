import type * as THREE from "three";
import type { ThreeFactory } from "../runtime/renderer-setup";
import type { CoverCanvasLike } from "./cover-colors";
import { paintBackCoverColorsFromCover } from "./cover-colors";

export const BACK_COVER_COUNT = 3000;
export const BACK_COVER_PLANE_SIZE = 4.8;

const DEFAULT_THREE_FACTORY: ThreeFactory = async () => await import("three");

export interface BackCoverLayerUniforms {
	uTime: { value: number };
	uBass: { value: number };
	uMid: { value: number };
	uTreble: { value: number };
	uBeat: { value: number };
	uEnergy: { value: number };
	uPixel: { value: number };
	uDotTex: { value: THREE.Texture };
	uAlpha: { value: number };
}

export interface BackCoverLayerOptions {
	scene: THREE.Scene;
	uniforms: BackCoverLayerUniforms;
	threeFactory?: ThreeFactory;
	random?: () => number;
}

export interface BackCoverLayer {
	getPoints(): THREE.Points;
	getColorArray(): Float32Array;
	refreshColorsFromCover(coverCanvas: CoverCanvasLike | null | undefined): boolean;
	dispose(): void;
}

export async function createBackCoverLayer(opts: BackCoverLayerOptions): Promise<BackCoverLayer> {
	const THREE = await (opts.threeFactory ?? DEFAULT_THREE_FACTORY)();
	const random = opts.random ?? Math.random;
	const geometry = new THREE.BufferGeometry();
	const positions = new Float32Array(BACK_COVER_COUNT * 3);
	const colors = new Float32Array(BACK_COVER_COUNT * 3);
	const rand = new Float32Array(BACK_COVER_COUNT);
	const uv = new Float32Array(BACK_COVER_COUNT * 2);

	for (let i = 0; i < BACK_COVER_COUNT; i++) {
		const u = random();
		const v = random();
		positions[i * 3] = (u - 0.5) * BACK_COVER_PLANE_SIZE;
		positions[i * 3 + 1] = (v - 0.5) * BACK_COVER_PLANE_SIZE;
		positions[i * 3 + 2] = -1.5 - random() * 0.4;
		uv[i * 2] = 1.0 - u;
		uv[i * 2 + 1] = v;
		rand[i] = random();
		colors[i * 3] = 0.7;
		colors[i * 3 + 1] = 0.6;
		colors[i * 3 + 2] = 0.8;
	}

	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
	geometry.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
	geometry.setAttribute("aUv", new THREE.BufferAttribute(uv, 2));

	const material = new THREE.ShaderMaterial({
		uniforms: {
			uTime: opts.uniforms.uTime,
			uBass: opts.uniforms.uBass,
			uMid: opts.uniforms.uMid,
			uTreble: opts.uniforms.uTreble,
			uBeat: opts.uniforms.uBeat,
			uEnergy: opts.uniforms.uEnergy,
			uPixel: opts.uniforms.uPixel,
			uDotTex: opts.uniforms.uDotTex,
			uAlpha: opts.uniforms.uAlpha,
		},
		vertexShader: BACK_COVER_VERTEX_SHADER,
		fragmentShader: BACK_COVER_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		blending: THREE.NormalBlending,
	});
	const points = new THREE.Points(geometry, material);
	points.frustumCulled = false;
	opts.scene.add(points);

	let disposed = false;

	return {
		getPoints() {
			return points;
		},
		getColorArray() {
			return colors;
		},
		refreshColorsFromCover(coverCanvas) {
			const ok = paintBackCoverColorsFromCover(coverCanvas, uv, colors);
			if (ok) {
				const attr = geometry.attributes.aColor as THREE.BufferAttribute | undefined;
				if (attr) attr.needsUpdate = true;
			}
			return ok;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			opts.scene.remove(points);
			geometry.dispose();
			material.dispose();
		},
	};
}

export const BACK_COVER_VERTEX_SHADER = `
	    precision highp float;
	    uniform float uTime, uBass, uMid, uTreble, uBeat, uEnergy, uPixel, uAlpha;
	    attribute vec3 aColor;
	    attribute vec2 aUv;
	    attribute float aRand;
	    varying vec3 vC;
	    varying float vA;
	    void main(){
	      vec3 pos = position;
	      // 音频驱动呼吸，静音时只保留很轻的漂移。
	      float audioDrive = clamp(uEnergy * 0.42 + uBass * 0.58 + uBeat * 0.85, 0.0, 1.45);
	      float highFlicker = 0.5 + 0.5 * sin(uTime * (1.4 + uTreble * 1.2) + aRand * 9.0);
	      pos.x += sin(uTime * 0.20 + aRand * 8.0) * (0.055 + uMid * 0.20 + uBeat * 0.090);
	      pos.y += cos(uTime * 0.18 + aRand * 6.0) * (0.060 + uTreble * 0.18 + uBeat * 0.080);
	      pos.z += sin(uTime * 0.12 + aRand * 5.0) * (0.055 + uEnergy * 0.070);
	      pos.z += uBass * 0.18 * sin(aRand * 11.0) + uBeat * 0.16 * (0.65 + 0.35 * sin(aRand * 13.0));
	      vC = aColor;
	      vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
	      float dist = -mvPos.z;
	      vA = clamp(0.18 + audioDrive * 0.24 + highFlicker * (0.055 + audioDrive * 0.18) + uBeat * 0.20, 0.10, 0.78);
	      float sz = clamp((46.0 / max(0.5, dist)) * (1.0 + uBeat * 0.22 + uBass * 0.10 + uTreble * 0.06 * highFlicker), 1.4, 4.9);
	      gl_PointSize = sz * uPixel;
	      gl_Position = projectionMatrix * mvPos;
	    }
	  `;

export const BACK_COVER_FRAGMENT_SHADER = `
	    precision highp float;
	    uniform sampler2D uDotTex;
	    uniform float uAlpha;
	    varying vec3 vC;
	    varying float vA;
	    void main(){
	      vec4 tex = texture2D(uDotTex, gl_PointCoord);
	      if (tex.a < 0.02) discard;
	      gl_FragColor = vec4(vC, tex.a * vA * uAlpha);
	    }
	  `;

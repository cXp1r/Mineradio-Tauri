import type * as THREE from "three";
import type { ThreeFactory, ThreeModule } from "../runtime/renderer-setup";
import type { FrameContext } from "../runtime/frame-context";

export const LYRIC_PARTICLE_COUNT = 132;

export interface LyricParticlesOptions {
	scene: THREE.Scene;
	threeFactory?: ThreeFactory;
	pixelScale?: number;
}

export interface LyricParticles {
	readonly object: THREE.Points | null;
	update(ctx: FrameContext): void;
	reset(seed?: number): void;
	setGlowStrength(value: number): void;
	setBurst(burst: number): void;
	dispose(): void;
}

const DEFAULT_THREE_FACTORY: ThreeFactory = async () => await import("three");

const LYRIC_VERTEX_SHADER = `
attribute float aRand;
attribute float aOffset;
uniform float uTime;
varying float vRand;
void main(){
	vRand = aRand;
	vec3 p = position;
	p.y += sin(uTime + aOffset * 6.2831) * 0.20;
	vec4 mv = modelViewMatrix * vec4(p, 1.0);
	gl_PointSize = 4.0 * (1.0 + aRand * 2.0);
	gl_Position = projectionMatrix * mv;
}
`;

const LYRIC_FRAGMENT_SHADER = `
precision mediump float;
varying float vRand;
void main(){
	vec2 d = gl_PointCoord - 0.5;
	float r = length(d);
	float a = smoothstep(0.5, 0.0, r) * (0.45 + vRand * 0.55);
	gl_FragColor = vec4(0.85, 0.78, 0.55, a);
}
`;

type UniformsRecord = {
	uTime: THREE.IUniform<number>;
	uBass: THREE.IUniform<number>;
	uEnergy: THREE.IUniform<number>;
	uBurstAmt: THREE.IUniform<number>;
	uPixel: THREE.IUniform<number>;
	uLyricLineTransition: THREE.IUniform<number>;
	uGlowStrength: THREE.IUniform<number>;
};

function buildGeometry(THREE: ThreeModule, count: number, seed: number): THREE.BufferGeometry {
	const positions = new Float32Array(count * 3);
	const rands = new Float32Array(count);
	const offsets = new Float32Array(count);
	const rng = makeSeededRng(seed);
	for (let i = 0; i < count; i++) {
		positions[i * 3] = (rng() - 0.5) * 2.0;
		positions[i * 3 + 1] = (rng() - 0.5) * 1.2;
		positions[i * 3 + 2] = (rng() - 0.5) * 0.6;
		rands[i] = rng();
		offsets[i] = rng();
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geo.setAttribute("aRand", new THREE.BufferAttribute(rands, 1));
	geo.setAttribute("aOffset", new THREE.BufferAttribute(offsets, 1));
	return geo;
}

function makeSeededRng(seed: number): () => number {
	let s = (seed | 0) || 1;
	return () => {
		s = (s * 1664525 + 1013904223) | 0;
		const u = s >>> 0;
		return u / 4294967296;
	};
}

export async function createLyricParticles(
	opts: LyricParticlesOptions,
): Promise<LyricParticles> {
	const factory = opts.threeFactory ?? DEFAULT_THREE_FACTORY;
	const THREE = await factory();
	const pixelScale = opts.pixelScale ?? 1;
	const geo = buildGeometry(THREE, LYRIC_PARTICLE_COUNT, 0);
	const uniforms: UniformsRecord = {
		uTime: { value: 0 },
		uBass: { value: 0 },
		uEnergy: { value: 0 },
		uBurstAmt: { value: 0 },
		uPixel: { value: pixelScale },
		uLyricLineTransition: { value: 0 },
		uGlowStrength: { value: 0.28 },
	};
	const material = new THREE.ShaderMaterial({
		uniforms,
		vertexShader: LYRIC_VERTEX_SHADER,
		fragmentShader: LYRIC_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});
	const points = new THREE.Points(geo, material);
	points.frustumCulled = false;
	points.renderOrder = 0;
	opts.scene.add(points);

	let currentSeed = 0;

	return {
		object: points,
		update(ctx) {
			uniforms.uTime.value = ctx.uniforms.uTime.value;
			uniforms.uBass.value = ctx.snapshot.bass;
			uniforms.uEnergy.value = ctx.snapshot.energy;
			uniforms.uBurstAmt.value = ctx.snapshot.beatPulse;
		},
		reset(seed) {
			currentSeed = seed ?? (currentSeed + 1);
			const rng = makeSeededRng(currentSeed | 0);
			const posAttr = geo.attributes.position as unknown as THREE.BufferAttribute;
			const randAttr = geo.attributes.aRand as unknown as THREE.BufferAttribute;
			const offAttr = geo.attributes.aOffset as unknown as THREE.BufferAttribute;
			const positions = posAttr.array as Float32Array;
			const rands = randAttr.array as Float32Array;
			const offsets = offAttr.array as Float32Array;
			for (let i = 0; i < LYRIC_PARTICLE_COUNT; i++) {
				positions[i * 3] = (rng() - 0.5) * 2.0;
				positions[i * 3 + 1] = (rng() - 0.5) * 1.2;
				positions[i * 3 + 2] = (rng() - 0.5) * 0.6;
				rands[i] = rng();
				offsets[i] = rng();
			}
			posAttr.needsUpdate = true;
			randAttr.needsUpdate = true;
			offAttr.needsUpdate = true;
		},
		setGlowStrength(value) {
			uniforms.uGlowStrength.value = value;
		},
		setBurst(burst) {
			uniforms.uBurstAmt.value = burst;
		},
		dispose() {
			opts.scene.remove(points);
			geo.dispose();
			material.dispose();
			;(this as { object: THREE.Points | null }).object = null;
		},
	};
}
import type * as THREE from "three";
import type { ThreeFactory, ThreeModule } from "../runtime/renderer-setup";
import type { FrameContext } from "../runtime/frame-context";

export const CONNECTOR_PARTICLE_COUNT = 36;

export interface ConnectorParticlesOptions {
	scene: THREE.Scene;
	threeFactory?: ThreeFactory;
	pixelScale?: number;
}

export interface ConnectorParticles {
	readonly object: THREE.Points | null;
	update(ctx: FrameContext): void;
	setIntensity(value: number): void;
	setTrackScale(value: number): void;
	reset(seed?: number): void;
	dispose(): void;
}

const DEFAULT_THREE_FACTORY: ThreeFactory = async () => await import("three");

const CONNECTOR_VERTEX_SHADER = `
attribute float aRand;
attribute float aT;
uniform float uTime;
uniform float uTrackScale;
varying float vT;
varying float vRand;
void main(){
	vT = aT;
	vRand = aRand;
	vec3 p = position;
	p.y += sin(uTime * 0.6 + aT * 6.2831) * 0.10;
	p.x += cos(uTime * 0.5 + aT * 6.2831) * 0.10;
	vec4 mv = modelViewMatrix * vec4(p, 1.0);
	gl_PointSize = (3.0 + aRand * 1.5) * uTrackScale;
	gl_Position = projectionMatrix * mv;
}
`;

const CONNECTOR_FRAGMENT_SHADER = `
precision mediump float;
varying float vT;
varying float vRand;
void main(){
	vec2 d = gl_PointCoord - 0.5;
	float r = length(d);
	float a = smoothstep(0.5, 0.0, r) * (0.35 + vRand * 0.65);
	vec3 c = mix(vec3(0.72, 0.55, 0.30), vec3(0.95, 0.85, 0.65), vT);
	gl_FragColor = vec4(c, a);
}
`;

type UniformsRecord = {
	uTime: THREE.IUniform<number>;
	uEnergy: THREE.IUniform<number>;
	uIntensity: THREE.IUniform<number>;
	uColorMix: THREE.IUniform<number>;
	uPixel: THREE.IUniform<number>;
	uTrackScale: THREE.IUniform<number>;
};

function makeSeededRng(seed: number): () => number {
	let s = (seed | 0) || 1;
	return () => {
		s = (s * 1664525 + 1013904223) | 0;
		const u = s >>> 0;
		return u / 4294967296;
	};
}

function buildGeometry(THREE: ThreeModule, count: number, seed: number): THREE.BufferGeometry {
	const positions = new Float32Array(count * 3);
	const rands = new Float32Array(count);
	const ts = new Float32Array(count);
	const rng = makeSeededRng(seed);
	for (let i = 0; i < count; i++) {
		const t = (i + 0.5) / count;
		ts[i] = t;
		rands[i] = rng();
		positions[i * 3] = 0;
		positions[i * 3 + 1] = t * 2.0 - 1.0;
		positions[i * 3 + 2] = (rng() - 0.5) * 0.25;
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geo.setAttribute("aRand", new THREE.BufferAttribute(rands, 1));
	geo.setAttribute("aT", new THREE.BufferAttribute(ts, 1));
	return geo;
}

export async function createConnectorParticles(
	opts: ConnectorParticlesOptions,
): Promise<ConnectorParticles> {
	const factory = opts.threeFactory ?? DEFAULT_THREE_FACTORY;
	const THREE = await factory();
	const pixelScale = opts.pixelScale ?? 1;
	const geo = buildGeometry(THREE, CONNECTOR_PARTICLE_COUNT, 0);
	const uniforms: UniformsRecord = {
		uTime: { value: 0 },
		uEnergy: { value: 0 },
		uIntensity: { value: 0 },
		uColorMix: { value: 0 },
		uPixel: { value: pixelScale },
		uTrackScale: { value: 1 },
	};
	const material = new THREE.ShaderMaterial({
		uniforms,
		vertexShader: CONNECTOR_VERTEX_SHADER,
		fragmentShader: CONNECTOR_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: false,
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
			uniforms.uEnergy.value = ctx.snapshot.energy;
		},
		setIntensity(value) {
			uniforms.uIntensity.value = value;
		},
		setTrackScale(value) {
			uniforms.uTrackScale.value = value;
		},
		reset(seed) {
			currentSeed = seed ?? (currentSeed + 1);
			const rng = makeSeededRng(currentSeed | 0);
			const posAttr = geo.attributes.position as unknown as THREE.BufferAttribute;
			const randAttr = geo.attributes.aRand as unknown as THREE.BufferAttribute;
			const tAttr = geo.attributes.aT as unknown as THREE.BufferAttribute;
			const positions = posAttr.array as Float32Array;
			const rands = randAttr.array as Float32Array;
			const ts = tAttr.array as Float32Array;
			for (let i = 0; i < CONNECTOR_PARTICLE_COUNT; i++) {
				ts[i] = (i + 0.5) / CONNECTOR_PARTICLE_COUNT + (rng() - 0.5) * 0.02;
				rands[i] = rng();
				positions[i * 3] = (rng() - 0.5) * 0.25;
				positions[i * 3 + 1] = ts[i] * 2.0 - 1.0;
				positions[i * 3 + 2] = (rng() - 0.5) * 0.25;
			}
			posAttr.needsUpdate = true;
			randAttr.needsUpdate = true;
			tAttr.needsUpdate = true;
		},
		dispose() {
			opts.scene.remove(points);
			geo.dispose();
			material.dispose();
			;(this as { object: THREE.Points | null }).object = null;
		},
	};
}
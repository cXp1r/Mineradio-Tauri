import type * as THREE from "three";
import type { FrameContext } from "../runtime/frame-context";
import type { ThreeFactory } from "../runtime/renderer-setup";
import type { FxState } from "./fx-defaults";
import type { SkullMouthTransform } from "../stage-lyrics/lifecycle";

export const SKULL_MODEL_BASE_ROTATION_X = -0.26;
export const SKULL_MODEL_BASE_ROTATION_Y = 0.0;
export const SKULL_MODEL_SCALE = 2.34;
export const SKULL_MODEL_BASE_POSITION = { x: 0, y: 0.22, z: 0.10 };
export const SKULL_SHELF_COMPOSITION_POSITION = { x: -1.18, y: 0.32, z: 0.10 };
export const SKULL_SHELF_COMPOSITION_SCALE = 3.02;
export const SKULL_LYRIC_MOUTH_LOCAL = { x: 0.025, y: -0.72, z: 0.62 };

export interface SkullParticleControllerOptions {
	scene: THREE.Scene;
	threeFactory?: ThreeFactory;
	uniforms: Record<string, THREE.IUniform>;
	assetData?: Float32Array | null;
}

export interface SkullParticleController {
	update(ctx: FrameContext, fx: FxState): void;
	setShelfCompositionActive(active: boolean): void;
	getObject(): THREE.Points | null;
	getMouthTransform(): SkullMouthTransform | null;
	dispose(): void;
}

const DEFAULT_THREE_FACTORY: ThreeFactory = async () => await import("three");

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
}

function buildGeometryFromAsset(THREE: typeof import("three"), points: Float32Array): THREE.BufferGeometry {
	const count = Math.floor((points?.length ?? 0) / 5);
	const geo = new THREE.BufferGeometry();
	const positions = new Float32Array(count * 3);
	const seeds = new Float32Array(count);
	const kinds = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		positions[i * 3] = points[i * 5];
		positions[i * 3 + 1] = points[i * 5 + 1];
		positions[i * 3 + 2] = points[i * 5 + 2];
		kinds[i] = points[i * 5 + 3];
		seeds[i] = points[i * 5 + 4];
	}
	geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
	geo.setAttribute("kind", new THREE.BufferAttribute(kinds, 1));
	return geo;
}

export function skullBreathOffset(t: number, shelfComposition = false): { x: number; y: number; z: number } {
	const strength = shelfComposition ? 0.70 : 1.0;
	return {
		x: strength * (Math.sin(t * 0.33 + 1.7) * 0.028 + Math.sin(t * 0.61 + 0.4) * 0.010),
		y: strength * (Math.sin(t * 0.38 + 0.2) * 0.036 + Math.sin(t * 0.83 + 2.1) * 0.012),
		z: strength * (Math.sin(t * 0.24 + 2.6) * 0.026),
	};
}

function multiplyQuat(
	a: { x: number; y: number; z: number; w: number },
	b: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
	return {
		x: a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
		y: a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
		z: a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

function quatFromEulerXYZ(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
	const cx = Math.cos(x / 2);
	const cy = Math.cos(y / 2);
	const cz = Math.cos(z / 2);
	const sx = Math.sin(x / 2);
	const sy = Math.sin(y / 2);
	const sz = Math.sin(z / 2);
	return {
		x: sx * cy * cz + cx * sy * sz,
		y: cx * sy * cz - sx * cy * sz,
		z: cx * cy * sz + sx * sy * cz,
		w: cx * cy * cz - sx * sy * sz,
	};
}

function applyQuat(v: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
	const x = v.x;
	const y = v.y;
	const z = v.z;
	const qx = q.x;
	const qy = q.y;
	const qz = q.z;
	const qw = q.w;
	const ix = qw * x + qy * z - qz * y;
	const iy = qw * y + qz * x - qx * z;
	const iz = qw * z + qx * y - qy * x;
	const iw = -qx * x - qy * y - qz * z;
	return {
		x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
		y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
		z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
	};
}

function makeSkullMaterial(THREE: typeof import("three"), uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		uniforms: {
			uMap: uniforms.uDotTex,
			uTime: uniforms.uTime,
			uPixel: uniforms.uPixel,
			uBass: uniforms.uBass,
			uMid: uniforms.uMid,
			uTreble: uniforms.uTreble,
			uBeat: uniforms.uBeat,
			uJawOpen: { value: 0 },
			uSkullFlash: { value: 0 },
			uPointScale: uniforms.uPointScale,
			uBloomStrength: uniforms.uBloomStrength,
			uColorBoost: uniforms.uColorBoost,
			uOpacity: { value: 0 },
			uColorA: { value: new THREE.Color("#b8ae98") },
			uColorB: { value: new THREE.Color("#fff4d8") },
			uShadow: { value: new THREE.Color("#100d0d") },
			uLight: { value: new THREE.Color("#ffe3a0") },
		},
		vertexShader: SKULL_PARTICLE_VERTEX_SHADER,
		fragmentShader: SKULL_PARTICLE_FRAGMENT_SHADER,
		transparent: true,
		depthWrite: false,
		depthTest: true,
		blending: THREE.NormalBlending,
	});
}

export async function createSkullParticleController(
	opts: SkullParticleControllerOptions,
): Promise<SkullParticleController> {
	const THREE = await (opts.threeFactory ?? DEFAULT_THREE_FACTORY)();
	const asset = opts.assetData && opts.assetData.length >= 5 ? opts.assetData : null;
	let object: THREE.Points | null = null;
	let opacity = 0;
	let ampPulse = 0;
	let beatFlash = 0;
	let jawOpen = 0;
	let shelfCompositionActive = false;
	let shelfMix = 0;

	function ensureObject(): THREE.Points | null {
		if (object) return object;
		if (!asset) return null;
		const geometry = buildGeometryFromAsset(THREE, asset);
		const material = makeSkullMaterial(THREE, opts.uniforms);
		object = new THREE.Points(geometry, material);
		object.frustumCulled = false;
		object.visible = false;
		object.userData.source = "asset";
		object.position.set(SKULL_MODEL_BASE_POSITION.x, SKULL_MODEL_BASE_POSITION.y, SKULL_MODEL_BASE_POSITION.z);
		object.scale.setScalar(SKULL_MODEL_SCALE);
		object.rotation.x = SKULL_MODEL_BASE_ROTATION_X;
		object.rotation.y = SKULL_MODEL_BASE_ROTATION_Y;
		object.renderOrder = 32;
		opts.scene.add(object);
		return object;
	}

	function setUniform(name: string, value: number): void {
		const u = (object?.material as unknown as { uniforms?: Record<string, { value: unknown }> } | null)?.uniforms;
		if (u?.[name]) u[name].value = value;
	}

	return {
		update(ctx, fx) {
			const active = fx.preset === 6;
			if (active) ensureObject();
			if (!object) return;
			const target = active ? 1 : 0;
			opacity += (target - opacity) * Math.min(1, ctx.dt * (active ? 3.2 : 2.4));
			if (opacity < 0.006 && !active) {
				object.visible = false;
				return;
			}
			object.visible = true;
			const intensity = Number.isFinite(fx.intensity) ? fx.intensity : 0.85;
			setUniform("uOpacity", opacity * clamp(0.78 + intensity * 0.18, 0.56, 1.0));
			const beatTransient = clamp((Math.max(0, ctx.snapshot.beatPulse - 0.16)) / 0.84, 0, 1.35);
			const flashTarget = clamp(Math.pow(beatTransient, 1.34) * 1.08 + Math.max(0, ctx.snapshot.bass - 0.60) * 0.18 * beatTransient, 0, 1);
			beatFlash += (flashTarget - beatFlash) * Math.min(1, ctx.dt * (flashTarget > beatFlash ? 24.0 : 6.2));
			setUniform("uSkullFlash", beatFlash);
			const uTime = Number(opts.uniforms.uTime?.value) || 0;
			const jawTarget = clamp(0.60 + (0.5 + 0.5 * Math.sin(uTime * 0.50)) * 0.050 + ctx.snapshot.bass * 0.060 + beatFlash * 0.090, 0.52, 0.88);
			jawOpen += (jawTarget - jawOpen) * Math.min(1, ctx.dt * (jawTarget > jawOpen ? 7.8 : 3.4));
			setUniform("uJawOpen", jawOpen);
			const shelfMixTarget = shelfCompositionActive ? 1 : 0;
			shelfMix += (shelfMixTarget - shelfMix) * Math.min(1, ctx.dt * (shelfMixTarget > shelfMix ? 4.6 : 5.8));
			if (Math.abs(shelfMix - shelfMixTarget) < 0.002) shelfMix = shelfMixTarget;
			const drift = skullBreathOffset(uTime, shelfCompositionActive);
			const ampTarget = clamp(ctx.snapshot.bass * 0.006 + ctx.snapshot.mid * 0.004 + beatFlash * 0.070, 0, 0.090);
			ampPulse += (ampTarget - ampPulse) * Math.min(1, ctx.dt * (ampTarget > ampPulse ? 11.0 : 4.0));
			const baseScale = SKULL_MODEL_SCALE + (SKULL_SHELF_COMPOSITION_SCALE - SKULL_MODEL_SCALE) * shelfMix;
			const targetScale = baseScale * (1 + ampPulse);
			const targetX = SKULL_MODEL_BASE_POSITION.x + (SKULL_SHELF_COMPOSITION_POSITION.x - SKULL_MODEL_BASE_POSITION.x) * shelfMix + drift.x;
			const targetY = SKULL_MODEL_BASE_POSITION.y + (SKULL_SHELF_COMPOSITION_POSITION.y - SKULL_MODEL_BASE_POSITION.y) * shelfMix + drift.y;
			const targetZ = SKULL_MODEL_BASE_POSITION.z + (SKULL_SHELF_COMPOSITION_POSITION.z - SKULL_MODEL_BASE_POSITION.z) * shelfMix + drift.z;
			object.position.x += (targetX - object.position.x) * Math.min(1, ctx.dt * 4.2);
			object.position.y += (targetY - object.position.y) * Math.min(1, ctx.dt * 4.8);
			object.position.z += (targetZ - object.position.z) * Math.min(1, ctx.dt * 4.2);
			object.scale.x += (targetScale - object.scale.x) * Math.min(1, ctx.dt * 4.6);
			object.scale.y = object.scale.x;
			object.scale.z = object.scale.x;
			const rotEase = Math.min(1, ctx.dt * 7.4);
			object.rotation.y += (SKULL_MODEL_BASE_ROTATION_Y - object.rotation.y) * rotEase;
			object.rotation.x += (SKULL_MODEL_BASE_ROTATION_X - object.rotation.x) * rotEase;
			object.rotation.z += (0 - object.rotation.z) * Math.min(1, ctx.dt * 6.0);
		},
		getObject() {
			return object;
		},
		setShelfCompositionActive(active) {
			shelfCompositionActive = !!active;
		},
		getMouthTransform() {
			if (!object || !object.visible) return null;
			const scale = Number.isFinite(object.scale.x) ? object.scale.x : SKULL_MODEL_SCALE;
			const rot = object.rotation ?? { x: 0, y: 0, z: 0 };
			const q = multiplyQuat(
				multiplyQuat(quatFromEulerXYZ(rot.x || 0, 0, 0), quatFromEulerXYZ(0, rot.y || 0, 0)),
				quatFromEulerXYZ(0, 0, rot.z || 0),
			);
			const local = applyQuat({
				x: SKULL_LYRIC_MOUTH_LOCAL.x * scale,
				y: SKULL_LYRIC_MOUTH_LOCAL.y * scale,
				z: SKULL_LYRIC_MOUTH_LOCAL.z * scale,
			}, q);
			return {
				visible: object.visible,
				position: {
					x: object.position.x + local.x,
					y: object.position.y + local.y,
					z: object.position.z + local.z,
				},
				quaternion: q,
			};
		},
		dispose() {
			if (!object) return;
			opts.scene.remove(object);
			(object.geometry as { dispose?: () => void }).dispose?.();
			(object.material as { dispose?: () => void }).dispose?.();
			object = null;
		},
	};
}

export const SKULL_PARTICLE_VERTEX_SHADER = [
	"precision highp float;",
	"attribute float seed,kind;",
	"uniform float uTime,uPixel,uPointScale,uBloomStrength,uColorBoost;",
	"uniform float uBass,uMid,uTreble,uBeat,uJawOpen,uSkullFlash;",
	"varying float vKind,vLight,vRim,vAmp,vDensity,vFlash;",
	"void main(){",
	"  vec3 pos = position;",
	"  float jawGroup = step(1.0, kind);",
	"  float boneKind = fract(kind);",
	"  vKind = boneKind;",
	"  vec3 n = normalize(vec3(position.x * 0.82, position.y * 0.68, position.z * 1.22 + 0.16));",
	"  float toothBand = smoothstep(0.48, 0.70, position.z) * (1.0 - smoothstep(0.27, 0.48, abs(position.x))) * (1.0 - smoothstep(0.18, 0.46, abs(position.y + 0.72)));",
	"  float toothNoise = fract(sin(seed * 21.731 + floor((position.x + 0.52) * 21.0) * 5.137) * 43758.5453);",
	"  pos.y += toothBand * (toothNoise - 0.5) * 0.020;",
	"  pos.z += toothBand * (fract(sin(seed * 17.923 + position.y * 31.0) * 24634.6345) - 0.5) * 0.012;",
	"  float jawMask = jawGroup;",
	"  float jawSideAnchor = smoothstep(0.36, 0.66, abs(position.x)) * (1.0 - smoothstep(0.78, 0.98, abs(position.x))) * smoothstep(-0.34, -0.74, position.y) * (1.0 - smoothstep(0.62, 0.86, position.z));",
	"  float jawMotion = jawMask * (1.0 - jawSideAnchor * 0.32);",
	"  vec2 jawHinge = vec2(-0.45, 0.18);",
	"  float jawAngle = uJawOpen * 0.52 * jawMotion;",
	"  float jc = cos(jawAngle);",
	"  float js = sin(jawAngle);",
	"  vec2 jr = pos.yz - jawHinge;",
	"  vec2 openedJaw = vec2(jr.x * jc - jr.y * js, jr.x * js + jr.y * jc) + jawHinge;",
	"  pos.yz = mix(pos.yz, openedJaw, jawMotion);",
	"  float jawDrop = jawMotion * smoothstep(-0.32, -0.88, position.y) * (0.58 + smoothstep(0.18, 0.62, abs(position.x)) * 0.04);",
	"  float openDrive = clamp(uJawOpen, 0.0, 1.25);",
	"  pos.y -= jawDrop * (0.038 + openDrive * 0.100);",
	"  pos.z += jawDrop * (0.003 + openDrive * 0.014);",
	"  float ampDrive = smoothstep(0.20, 0.82, uBass * 0.44 + uMid * 0.22 + uBeat * 0.72);",
	"  float ampPhase = 0.50 + 0.50 * sin(uTime * (1.05 + uMid * 0.30) + seed * 6.2831);",
	"  vFlash = clamp(uSkullFlash * (0.68 + ampPhase * 0.32), 0.0, 1.0);",
	"  vAmp = clamp(ampDrive * 0.045 + vFlash * 0.92 + uTreble * 0.012, 0.0, 1.0);",
	"  vec4 mv = modelViewMatrix * vec4(pos, 1.0);",
	"  float dist = max(0.55, -mv.z);",
	"  vec3 vn = normalize(normalMatrix * n);",
	"  vec3 keyDir = normalize(vec3(-0.48, 0.64, 0.60));",
	"  vec3 rimDir = normalize(vec3(0.88, 0.18, -0.44));",
	"  float key = pow(max(dot(vn, keyDir), 0.0), 1.18);",
	"  float gothicShadow = smoothstep(-0.10, 0.36, dot(vn, normalize(vec3(0.44, -0.06, -0.58))));",
	"  vRim = pow(max(dot(vn, rimDir), 0.0), 2.50) * (0.24 + uBloomStrength * 0.08 + vFlash * 0.62);",
	"  float dust = fract(sin(seed * 13.871 + position.x * 19.7 + position.y * 7.1) * 43758.5453);",
	"  vDensity = clamp(0.30 + key * 0.70 + vRim * 0.24 - gothicShadow * 0.24 + dust * 0.025 + vFlash * 0.08, 0.16, 1.20);",
	"  vLight = clamp(0.115 + key * 1.02 + boneKind * 0.070 + vAmp * 0.56 - gothicShadow * 0.08, 0.035, 1.72);",
	"  float scaleCtl = clamp(uPointScale, 0.48, 2.35);",
	"  float size = (0.035 + boneKind * 0.026) * (0.84 + vDensity * 0.22 + vLight * 0.13 + uBloomStrength * 0.030 + vFlash * 0.18);",
	"  gl_PointSize = clamp(size * uPixel * scaleCtl * 128.0 / dist, 0.95, 7.60);",
	"  gl_Position = projectionMatrix * mv;",
	"}",
].join("\n");

export const SKULL_PARTICLE_FRAGMENT_SHADER = [
	"precision highp float;",
	"uniform sampler2D uMap;",
	"uniform vec3 uColorA,uColorB,uShadow,uLight;",
	"uniform float uOpacity,uBloomStrength,uColorBoost;",
	"varying float vKind,vLight,vRim,vAmp,vDensity,vFlash;",
	"void main(){",
	"  vec4 tex = texture2D(uMap, gl_PointCoord);",
	"  if(tex.a < 0.070) discard;",
	"  float contrast = clamp(uColorBoost, 0.50, 2.00);",
	"  float lit = clamp(pow(vLight, mix(1.18, 0.74, (contrast - 0.50) / 1.50)), 0.0, 1.28);",
	"  vec3 bone = mix(uColorA, uColorB, clamp((vKind - 0.34) * 2.0 + lit * 0.18, 0.0, 1.0));",
	"  vec3 col = mix(uShadow, bone, clamp(lit, 0.0, 1.0));",
	"  col = mix(col, uLight, clamp(vRim * (0.14 + uBloomStrength * 0.035 + vFlash * 0.40), 0.0, 0.54));",
	"  col = mix(col, uLight, clamp(vAmp * (0.09 + uBloomStrength * 0.025) + vFlash * 0.56, 0.0, 0.68));",
	"  float alpha = tex.a * uOpacity * clamp(0.20 + lit * 0.44 + vDensity * 0.40 + vRim * 0.10 + vFlash * 0.46, 0.12, 1.56);",
	"  gl_FragColor = vec4(col, alpha);",
	"}",
].join("\n");

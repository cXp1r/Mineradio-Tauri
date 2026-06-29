import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeFactory, ThreeModule } from "../runtime/renderer-setup";
import type { GsapLike, GsapTimelineLike, GsapTweenLike } from "../control/control-console-motion";
import type { FrameContext } from "../runtime/frame-context";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import { createStageLyricsLifecycle, type StageLyricsLifecycle } from "./lifecycle";
import { RenderStepSlot } from "../runtime/render-step-slot";

type RecordedCall = { method: string; args: unknown[] };

function makeFakeThree(): ThreeFactory {
	function makeVector3(x = 0, y = 0, z = 0) {
		return {
			x, y, z,
			set(this: { x: number; y: number; z: number }, nx: number, ny: number, nz: number) {
				this.x = nx; this.y = ny; this.z = nz; return this;
			},
			copy(this: { x: number; y: number; z: number }, other: { x: number; y: number; z: number }) {
				this.x = other.x; this.y = other.y; this.z = other.z; return this;
			},
			addScaledVector(this: { x: number; y: number; z: number }, other: { x: number; y: number; z: number }, scale: number) {
				this.x += other.x * scale; this.y += other.y * scale; this.z += other.z * scale; return this;
			},
			normalize(this: { x: number; y: number; z: number }) {
				const len = Math.hypot(this.x, this.y, this.z) || 1;
				this.x /= len; this.y /= len; this.z /= len; return this;
			},
			applyQuaternion(this: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }) {
				const x0 = this.x, y0 = this.y, z0 = this.z;
				const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
				const ix = qw * x0 + qy * z0 - qz * y0;
				const iy = qw * y0 + qz * x0 - qx * z0;
				const iz = qw * z0 + qx * y0 - qy * x0;
				const iw = -qx * x0 - qy * y0 - qz * z0;
				this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
				this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
				this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
				return this;
			},
			lerp(this: { x: number; y: number; z: number }, other: { x: number; y: number; z: number }, a: number) {
				this.x += (other.x - this.x) * a; this.y += (other.y - this.y) * a; this.z += (other.z - this.z) * a; return this;
			},
		};
	}
	function makeQuaternion(x = 0, y = 0, z = 0, w = 1) {
		return {
			x, y, z, w,
			copy(this: { x: number; y: number; z: number; w: number }, other: { x: number; y: number; z: number; w: number }) {
				this.x = other.x; this.y = other.y; this.z = other.z; this.w = other.w; return this;
			},
			multiply(this: { x: number; y: number; z: number; w: number }, other: { x: number; y: number; z: number; w: number }) {
				const ax = this.x, ay = this.y, az = this.z, aw = this.w;
				const bx = other.x, by = other.y, bz = other.z, bw = other.w;
				this.x = ax * bw + aw * bx + ay * bz - az * by;
				this.y = ay * bw + aw * by + az * bx - ax * bz;
				this.z = az * bw + aw * bz + ax * by - ay * bx;
				this.w = aw * bw - ax * bx - ay * by - az * bz;
				return this;
			},
			setFromEuler(this: { x: number; y: number; z: number; w: number }, e: { x: number; y: number; z: number }) {
				const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
				const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
				this.x = s1 * c2 * c3 + c1 * s2 * s3;
				this.y = c1 * s2 * c3 - s1 * c2 * s3;
				this.z = c1 * c2 * s3 - s1 * s2 * c3;
				this.w = c1 * c2 * c3 + s1 * s2 * s3;
				return this;
			},
			slerp(this: { x: number; y: number; z: number; w: number }, other: { x: number; y: number; z: number; w: number }, a: number) {
				this.x += (other.x - this.x) * a; this.y += (other.y - this.y) * a; this.z += (other.z - this.z) * a; this.w += (other.w - this.w) * a; return this;
			},
		};
	}
	function Euler(x = 0, y = 0, z = 0, order = "YXZ") {
		return {
			x, y, z, order,
			set(this: { x: number; y: number; z: number; order: string }, nx: number, ny: number, nz: number, nextOrder?: string) {
				this.x = nx; this.y = ny; this.z = nz; this.order = nextOrder ?? this.order; return this;
			},
		};
	}
	function Group() {
		return {
			isGroup: true,
			renderOrder: 0,
			children: [] as unknown[],
			userData: {} as Record<string, unknown>,
			parent: null as unknown,
			position: makeVector3(),
			rotation: { x: 0, y: 0, z: 0 },
			scale: {
				x: 1, y: 1, z: 1,
				setScalar(this: { x: number; y: number; z: number }, s: number) {
					this.x = s; this.y = s; this.z = s;
				},
				set(this: { x: number; y: number; z: number }, x: number, y: number, z: number) {
					this.x = x; this.y = y; this.z = z;
				},
			},
			quaternion: makeQuaternion(),
			add(child: unknown) {
				(this as { children: unknown[] }).children.push(child);
				(child as { parent: unknown }).parent = this;
			},
			remove(child: unknown) {
				const arr = (this as { children: unknown[] }).children;
				const idx = arr.indexOf(child);
				if (idx >= 0) arr.splice(idx, 1);
				(child as { parent: unknown }).parent = null;
			},
		};
	}
	function PlaneGeometry() {
		return { isBufferGeometry: true, isPlaneGeometry: true, disposed: false, dispose() { (this as { disposed: boolean }).disposed = true; } };
	}
	function BufferGeometry() {
		return {
			isBufferGeometry: true,
			attributes: {} as Record<string, { array: Float32Array; itemSize: number; count: number; needsUpdate: boolean }>,
			disposed: false,
			setAttribute(name: string, attr: { array: Float32Array; itemSize: number; count: number }) {
				(this as { attributes: Record<string, { array: Float32Array; itemSize: number; count: number; needsUpdate: boolean }> }).attributes[name] = { ...attr, needsUpdate: false };
			},
			dispose() { (this as { disposed: boolean }).disposed = true; },
		};
	}
	function BufferAttribute(arr: Float32Array, itemSize: number) {
		return { array: arr, itemSize, count: arr.length / itemSize, needsUpdate: false };
	}
	function MeshBasicMaterial(params: Record<string, unknown>) {
		return {
			isMaterial: true,
			transparent: params.transparent,
			opacity: params.opacity,
			depthWrite: params.depthWrite,
			depthTest: params.depthTest,
			side: params.side,
			blending: params.blending,
			map: params.map,
			color: params.color,
			disposed: false,
			dispose() { (this as { disposed: boolean }).disposed = true; },
		};
	}
	function ShaderMaterial(params: Record<string, unknown>) {
		return {
			isMaterial: true,
			isShaderMaterial: true,
			uniforms: params.uniforms,
			vertexShader: params.vertexShader,
			fragmentShader: params.fragmentShader,
			transparent: params.transparent,
			depthWrite: params.depthWrite,
			depthTest: params.depthTest,
			side: params.side,
			blending: params.blending,
			disposed: false,
			dispose() { (this as { disposed: boolean }).disposed = true; },
		};
	}
	function Mesh(geometry: unknown, material: unknown) {
		return {
			isMesh: true,
			geometry,
			material,
			renderOrder: 0,
			visible: true,
			userData: {} as Record<string, unknown>,
			position: { x: 0, y: 0, z: 0, set(this: { x: number; y: number; z: number }, x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
			scale: { x: 1, y: 1, z: 1, set(this: { x: number; y: number; z: number }, x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
		};
	}
	function Points(geometry: unknown, material: unknown) {
		return {
			isPoints: true,
			geometry,
			material,
			renderOrder: 0,
			visible: true,
			frustumCulled: true,
			position: { x: 0, y: 0, z: 0 },
			scale: { x: 1, y: 1, z: 1 },
			rotation: { x: 0, y: 0, z: 0 },
			updateMatrixWorld() {},
		};
	}
	function Color(r: number, g: number, b: number) {
		return {
			r, g, b, isColor: true,
			copy(this: { r: number; g: number; b: number }, other: { r: number; g: number; b: number }) {
				this.r = other.r; this.g = other.g; this.b = other.b; return this;
			},
			lerp(this: { r: number; g: number; b: number }, other: { r: number; g: number; b: number }, a: number) {
				this.r += (other.r - this.r) * a; this.g += (other.g - this.g) * a; this.b += (other.b - this.b) * a; return this;
			},
			setRGB(this: { r: number; g: number; b: number }, r: number, g: number, b: number) {
				this.r = r; this.g = g; this.b = b; return this;
			},
		};
	}
	function CanvasTexture(image: HTMLCanvasElement) {
		return { image, isTexture: true, minFilter: 0, magFilter: 0, generateMipmaps: false, anisotropy: 1, disposed: false, dispose() { (this as { disposed: boolean }).disposed = true; }, userData: {} };
	}
	function Texture() {
		return { isTexture: true, minFilter: 0, magFilter: 0, disposed: false, dispose() { (this as { disposed: boolean }).disposed = true; } };
	}
	const module = {
		Group, PlaneGeometry, BufferGeometry, BufferAttribute, Vector3: makeVector3, Quaternion: makeQuaternion, Euler,
		MeshBasicMaterial, ShaderMaterial, Mesh, Points, Color,
		CanvasTexture, Texture,
		LinearFilter: 1006, NearestFilter: 1003,
		DoubleSide: 2, AdditiveBlending: 2, NormalBlending: 1,
	};
	return (() => module) as unknown as ThreeFactory;
}

function makeFakeCamera(position = { x: 0, y: 0, z: 0 }, quaternion = { x: 0, y: 0, z: 0, w: 1 }) {
	return {
		isPerspectiveCamera: true,
		fov: 45,
		aspect: 16 / 9,
		position: { ...position },
		quaternion: { ...quaternion },
		getWorldDirection(target: { x: number; y: number; z: number; normalize?: () => unknown }) {
			target.x = 0; target.y = 0; target.z = -1;
			target.normalize?.();
			return target;
		},
	};
}

function makeFakeGsap(recorder: RecordedCall[]): GsapLike {
	const timelineNode = (): GsapTimelineLike => {
		const node: GsapTimelineLike = {
			to(target, vars, position) {
				recorder.push({ method: "tl.to", args: [target, vars, position] });
				return node;
			},
			fromTo(target, from, to, position) {
				recorder.push({ method: "tl.fromTo", args: [target, from, to, position] });
				return node;
			},
			kill() {
				recorder.push({ method: "tl.kill", args: [] });
				return node;
			},
		};
		return node;
	};
	return {
		to(target, vars) {
			recorder.push({ method: "to", args: [target, vars] });
			return { kill: () => recorder.push({ method: "tween.kill", args: [target] }) } as GsapTweenLike;
		},
		fromTo(target, from, to) {
			recorder.push({ method: "fromTo", args: [target, from, to] });
			return { kill: () => recorder.push({ method: "tween.kill", args: [target] }) } as GsapTweenLike;
		},
		set(target, vars) {
			recorder.push({ method: "set", args: [target, vars] });
		},
		killTweensOf(target, _props) {
			recorder.push({ method: "killTweensOf", args: [target] });
		},
		timeline(vars) {
			recorder.push({ method: "timeline", args: [vars] });
			return timelineNode();
		},
	};
}

function makeFakeDotTexture() {
	return { isTexture: true, disposed: false, dispose() {} } as never;
}

function makeFakeScene() {
	return {
		children: [] as unknown[],
		parent: null,
		add(child: unknown) {
			(this as { children: unknown[] }).children.push(child);
			(child as { parent: unknown }).parent = this;
		},
		remove(child: unknown) {
			const arr = (this as { children: unknown[] }).children;
			const idx = arr.indexOf(child);
			if (idx >= 0) arr.splice(idx, 1);
			(child as { parent: unknown }).parent = null;
		},
	} as { children: unknown[]; add(c: unknown): void; remove(c: unknown): void };
}

function makeCtx(now: number, dt: number, snap?: Partial<AudioSnapshot>): FrameContext {
	const snapshot: AudioSnapshot = {
		bass: 0, mid: 0, treble: 0, energy: 0, rb: 0, rm: 0, rt: 0, re: 0,
		beatPulse: 0, scheduledBeatPulse: 0, beatOnsetFlag: false,
		...snap,
	};
	return {
		dt, now, snapshot,
		uniforms: { uTime: { value: now } } as never,
		scene: null as never,
		camera: null as never,
		pointerParallax: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
	};
}

async function buildLifecycleWithCurrent(opts: {
	lyrics: Array<{ t: number; text: string }>;
	currentTime: number;
	playing?: boolean;
	shelfVisibility?: number;
	gsapRecorder?: RecordedCall[];
}): Promise<{ lifecycle: StageLyricsLifecycle; scene: { children: unknown[]; add(c: unknown): void; remove(c: unknown): void }; recorder: RecordedCall[]; setNow: (v: number) => void }> {
	const recorder: RecordedCall[] = [];
	const scene = makeFakeScene();
	let mutableTime = opts.currentTime;
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap(opts.gsapRecorder ?? recorder),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => opts.lyrics as never,
		currentTimeSupplier: () => mutableTime,
		isPlayingSupplier: () => opts.playing ?? true,
		getShelfVisibility: () => opts.shelfVisibility ?? 0,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		getBeatCamKick: () => null,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines(opts.lyrics as never);
	lifecycle.setShelfVisibility(opts.shelfVisibility ?? 0);
	lifecycle.update(makeCtx(opts.currentTime, 0.1));
	await lifecycle.whenIdle();
	return {
		lifecycle,
		scene,
		recorder: opts.gsapRecorder ?? recorder,
		setNow: (v: number) => {
			mutableTime = v;
		},
	};
}

test("lifecycle.slot === RenderStepSlot.StageLyrics", () => {
	const lc = createStageLyricsLifecycle({ threeFactory: makeFakeThree(), });
	expect(lc.slot).toBe(RenderStepSlot.StageLyrics);
});

test("mount() creates a group with renderOrder=38 and adds to scene", async () => {
	const scene = makeFakeScene();
	const lc = createStageLyricsLifecycle({ scene: scene as never, threeFactory: makeFakeThree(), });
	const group = await lc.mount(scene as never);
	expect(group).not.toBeNull();
	expect((group as unknown as { renderOrder: number }).renderOrder).toBe(38);
	expect((scene.children as unknown[]).length).toBe(1);
});

test("tickLyricsParticles advances currentIdx to 1 when currentTime reaches line B", async () => {
	const { lifecycle, scene } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "A" }, { t: 2, text: "B" }],
		currentTime: 2,
	});
	expect(lifecycle.getCurrentIdx()).toBe(1);
	expect(lifecycle.getCurrentText()).toBe("B");
	lifecycle.dispose();
	expect((scene.children as unknown[]).length).toBe(0);
});

test("tickLyricsParticles passes live lyric text options into the built lyric group and rebuilds when they change", async () => {
	const textOptions = {
		lyricFont: "stone-song",
		lyricLetterSpacing: 0.12,
		lyricLineHeight: 1.24,
		lyricWeight: 800,
	};
	const scene = makeFakeScene();
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "Stone lyric" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricTextOptionsSupplier: () => textOptions,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "Stone lyric" }]);
	lifecycle.update(makeCtx(0.5, 0.1));
	await lifecycle.whenIdle();
	const groupA = lifecycle.group as unknown as { children: Array<{ userData: { lyric?: { mask?: { fontSize: number; lineHeight: number }; textMat?: { uniforms?: { uTextOptionsSignature?: { value: string } } } } } }> };
	const firstLyric = groupA.children[0]?.userData.lyric;
	expect(firstLyric?.textMat?.uniforms?.uTextOptionsSignature?.value).toBe("stone-song|0.12|1.24|800");
	expect(firstLyric?.mask?.lineHeight).toBeGreaterThan((firstLyric?.mask?.fontSize ?? 0) * 1.2);

	textOptions.lyricLetterSpacing = 0.03;
	lifecycle.update(makeCtx(0.6, 0.1));
	await lifecycle.whenIdle();
	const groupB = lifecycle.group as unknown as { children: Array<{ userData: { lyric?: { textMat?: { uniforms?: { uTextOptionsSignature?: { value: string } } } } } }> };
	expect(groupB.children[0]?.userData.lyric?.textMat?.uniforms?.uTextOptionsSignature?.value).toBe("stone-song|0.03|1.24|800");
	lifecycle.dispose();
});

test("update applies baseline free lyric layout scale, offsets, and tilt to the stage group", async () => {
	const layout = {
		lyricScale: 1.35,
		lyricOffsetX: 0.45,
		lyricOffsetY: -0.25,
		lyricOffsetZ: 0.72,
		lyricTiltX: 12,
		lyricTiltY: -18,
	};
	const scene = makeFakeScene();
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "Layout lyric" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => layout,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "Layout lyric" }]);
	lifecycle.update(makeCtx(0.5, 0.1));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(0.6, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		quaternion: { x: number; y: number; z: number; w: number };
		scale: { x: number; y: number; z: number };
	};
	expect(group.position.x).toBeCloseTo(0.45, 6);
	expect(group.position.y).toBeCloseTo(-0.25, 6);
	expect(group.position.z).toBeCloseTo(0.72, 6);
	expect(group.scale.x).toBeCloseTo(1.35, 6);
	expect(group.scale.y).toBeCloseTo(1.35, 6);
	expect(group.scale.z).toBeCloseTo(1.35, 6);
	const tiltX = 12 * Math.PI / 180;
	const tiltY = -18 * Math.PI / 180;
	expect(group.quaternion.x).toBeCloseTo(Math.sin(tiltX / 2) * Math.cos(tiltY / 2), 6);
	expect(group.quaternion.y).toBeCloseTo(Math.cos(tiltX / 2) * Math.sin(tiltY / 2), 6);
	expect(group.quaternion.z).toBeCloseTo(-Math.sin(tiltX / 2) * Math.sin(tiltY / 2), 6);
	expect(group.quaternion.w).toBeCloseTo(Math.cos(tiltX / 2) * Math.cos(tiltY / 2), 6);
	lifecycle.dispose();
});

test("free lyric layout binds the stage group to the cover particle world transform", async () => {
	const scene = makeFakeScene();
	const cover = {
		updateMatrixWorldCalled: false,
		position: { x: 10, y: 20, z: 30 },
		quaternion: { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) },
		updateMatrixWorld(force?: boolean) {
			this.updateMatrixWorldCalled = force === true;
		},
		getWorldPosition(target: { x: number; y: number; z: number }) {
			target.x = this.position.x;
			target.y = this.position.y;
			target.z = this.position.z;
			return target;
		},
		getWorldQuaternion(target: { x: number; y: number; z: number; w: number }) {
			target.x = this.quaternion.x;
			target.y = this.quaternion.y;
			target.z = this.quaternion.z;
			target.w = this.quaternion.w;
			return target;
		},
	};
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "Cover axis lyric" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: false,
			lyricScale: 1,
			lyricOffsetX: 0.25,
			lyricOffsetY: -0.5,
			lyricOffsetZ: 0.75,
			lyricTiltX: 0,
			lyricTiltY: 0,
		}),
		coverWorldTransformSupplier: () => cover,
		rand: () => 0.35,
	} as never);
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "Cover axis lyric" }]);
	lifecycle.update(makeCtx(0.5, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		quaternion: { x: number; y: number; z: number; w: number };
	};
	expect(cover.updateMatrixWorldCalled).toBe(true);
	expect(group.position.x).toBeCloseTo(10.75, 6);
	expect(group.position.y).toBeCloseTo(19.5, 6);
	expect(group.position.z).toBeCloseTo(29.75, 6);
	expect(group.quaternion.x).toBeCloseTo(cover.quaternion.x, 6);
	expect(group.quaternion.y).toBeCloseTo(cover.quaternion.y, 6);
	expect(group.quaternion.z).toBeCloseTo(cover.quaternion.z, 6);
	expect(group.quaternion.w).toBeCloseTo(cover.quaternion.w, 6);
	lifecycle.dispose();
});

test("newly built current lyric is processed by the stage tick before it can render", async () => {
	const { lifecycle } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "First frame lyric" }],
		currentTime: 0.5,
	});
	const group = lifecycle.group as unknown as { children: Array<{ userData: { lyric?: { textMat?: { uniforms?: { uOpacity?: { value: number } } } } } }> };
	const current = group.children[0];
	expect(current.userData.lyric?.textMat?.uniforms?.uOpacity?.value ?? 0).toBeGreaterThan(0);
	lifecycle.dispose();
});

test("update applies baseline non-skull shelf-detail lyric offset when side detail is open", async () => {
	const scene = makeFakeScene();
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "Shelf detail lyric" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: false,
			lyricScale: 1.4,
			lyricOffsetX: 0.2,
			lyricOffsetY: -0.1,
			lyricOffsetZ: 0.3,
			lyricTiltX: 0,
			lyricTiltY: 0,
		}),
		getShelfMode: () => "side",
		getShelfHasOpenContent: () => true,
		getSkullShelfOpen: () => false,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0.5, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	};
	expect(group.scale.x).toBeCloseTo(1.4 * 0.56, 6);
	expect(group.scale.y).toBeCloseTo(1.4 * 0.56, 6);
	expect(group.scale.z).toBeCloseTo(1.4 * 0.56, 6);
	expect(group.position.x).toBeCloseTo(0.2 - 1.78, 6);
	expect(group.position.y).toBeCloseTo(-0.1 + 0.18, 6);
	expect(group.position.z).toBeCloseTo(0.3 + 0.84, 6);
	lifecycle.dispose();
});

test("update applies baseline camera-locked lyric layout from camera basis with lock easing", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 1, y: 2, z: 3 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "Camera lock lyric" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: true,
			lyricScale: 1,
			lyricOffsetX: 0.5,
			lyricOffsetY: -0.25,
			lyricOffsetZ: 0.75,
			lyricTiltX: 10,
			lyricTiltY: -5,
		}),
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0.5, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		quaternion: { x: number; y: number; z: number; w: number };
	};
	expect(group.position.x).toBeCloseTo(1.5 * 0.24, 6);
	expect(group.position.y).toBeCloseTo(1.75 * 0.24, 6);
	expect(group.position.z).toBeCloseTo((-2.6) * 0.24, 6);
	expect(group.quaternion.x).toBeCloseTo(0.0870727897926938 * 0.22, 6);
	expect(group.quaternion.y).toBeCloseTo(-0.0434534024273578 * 0.22, 6);
	expect(group.quaternion.z).toBeCloseTo(0.0038016801040236755 * 0.22, 6);
	expect(group.quaternion.w).toBeLessThan(1);
	lifecycle.dispose();
});

test("update applies baseline camera-lock fit scale cap and shrink easing", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: true,
			lyricScale: 1.65,
			lyricOffsetX: 1.4,
			lyricOffsetY: 0.9,
			lyricOffsetZ: 0,
			lyricTiltX: 0,
			lyricTiltY: 0,
		}),
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		scale: { x: number; y: number; z: number };
	};
	const visibleH = 2 * Math.tan((45 * Math.PI / 180) * 0.5) * 4.85;
	const visibleW = visibleH * (16 / 9);
	const safeW = Math.max(visibleW * 0.42, visibleW * 0.84 - 1.4 * 1.22);
	const safeH = Math.max(visibleH * 0.18, visibleH * 0.44 - 0.9 * 0.82);
	const viewportFit = Math.min(1, safeW / (5.4 * 1.65), safeH / (0.78 * 1.65));
	const lockFit = Math.max(0.42, Math.min(1, viewportFit, 0.80 / 1.65));
	const firstFrameLockFitScale = 1 + (lockFit - 1) * 0.18;
	expect(group.scale.x).toBeCloseTo(1.65 * firstFrameLockFitScale, 6);
	expect(group.scale.y).toBeCloseTo(group.scale.x, 6);
	expect(group.scale.z).toBeCloseTo(group.scale.x, 6);
	lifecycle.dispose();
});

test("update applies baseline non-wallpaper camera-lock shelf avoid layout", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: true,
			lyricScale: 1.1,
			lyricOffsetX: 0.4,
			lyricOffsetY: -0.2,
			lyricOffsetZ: 0.1,
			lyricTiltX: 0,
			lyricTiltY: 0,
			preset: 0,
		}),
		getShelfMode: () => "side",
		getShelfHasOpenContent: () => false,
		getShelfVisibility: () => 0.4,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	};
	const layoutScale = 1.1 * 0.72;
	const layoutX = 0.4 - 1.36;
	const layoutY = -0.2 + 0.06;
	const layoutZ = 0.1 + 0.72;
	const distance = 4.85 + layoutZ;
	const visibleH = 2 * Math.tan((45 * Math.PI / 180) * 0.5) * distance;
	const visibleW = visibleH * (16 / 9);
	const safeW = Math.max(visibleW * 0.42, visibleW * 0.84 - Math.abs(layoutX) * 1.22);
	const safeH = Math.max(visibleH * 0.18, visibleH * 0.44 - Math.abs(layoutY) * 0.82);
	const viewportFit = Math.min(1, safeW / (5.4 * layoutScale), safeH / (0.78 * layoutScale));
	const lockFit = Math.max(0.42, Math.min(1, viewportFit, 0.80 / layoutScale));
	const firstFrameLockFitScale = 1 + (lockFit - 1) * (lockFit < 1 ? 0.18 : 0.10);
	expect(group.scale.x).toBeCloseTo(layoutScale * firstFrameLockFitScale, 6);
	expect(group.position.x).toBeCloseTo(layoutX * 0.24, 6);
	expect(group.position.y).toBeCloseTo(layoutY * 0.24, 6);
	expect(group.position.z).toBeCloseTo((-distance) * 0.24, 6);
	lifecycle.dispose();
});

test("update applies baseline skull edge-guard lockFit without camera lock", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: false,
			lyricScale: 1.65,
			lyricOffsetX: 1.45,
			lyricOffsetY: 0.9,
			lyricOffsetZ: 0.3,
			lyricTiltX: 0,
			lyricTiltY: 0,
			preset: 6,
			skullLyricEdgeGuard: true,
		} as never),
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	};
	const distance = 4.85 + 0.3;
	const visibleH = 2 * Math.tan((45 * Math.PI / 180) * 0.5) * distance;
	const visibleW = visibleH * (16 / 9);
	const safeW = Math.max(visibleW * 0.42, visibleW * 0.84 - 1.45 * 1.22);
	const safeH = Math.max(visibleH * 0.18, visibleH * 0.44 - 0.9 * 0.82);
	const viewportFit = Math.min(1, safeW / (5.4 * 1.65), safeH / (0.78 * 1.65));
	const lockFit = Math.max(0.42, Math.min(1, viewportFit, 0.80 / 1.65));
	const firstFrameLockFitScale = 1 + (lockFit - 1) * 0.18;
	expect(group.scale.x).toBeCloseTo(1.65 * firstFrameLockFitScale, 6);
	expect(group.position.x).toBeCloseTo(1.45, 6);
	expect(group.position.y).toBeCloseTo(0.9, 6);
	expect(group.position.z).toBeCloseTo(0.3, 6);
	lifecycle.dispose();
});

test("update applies baseline skull-mouth scale and lockFit distance", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: false,
			lyricScale: 1.25,
			lyricOffsetX: 0.2,
			lyricOffsetY: 0.1,
			lyricOffsetZ: 0.4,
			lyricTiltX: 0,
			lyricTiltY: 0,
			preset: 6,
			skullMouthLyrics: true,
		} as never),
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	};
	const layoutScale = 1.25 * 0.66;
	const distance = Math.max(2.2, 4.4 + 0.4);
	const visibleH = 2 * Math.tan((45 * Math.PI / 180) * 0.5) * distance;
	const visibleW = visibleH * (16 / 9);
	const safeW = Math.max(visibleW * 0.42, visibleW * 0.84 - 0.2 * 1.22);
	const safeH = Math.max(visibleH * 0.18, visibleH * 0.44 - 0.1 * 0.82);
	const viewportFit = Math.min(1, safeW / (5.4 * layoutScale), safeH / (0.78 * layoutScale));
	const lockFit = Math.min(Math.max(0.42, Math.min(1, viewportFit, 0.80 / layoutScale)), 1.12);
	const firstFrameLockFitScale = 1 + (lockFit - 1) * (lockFit < 1 ? 0.18 : 0.10);
	expect(group.scale.x).toBeCloseTo(layoutScale * firstFrameLockFitScale, 6);
	expect(group.position.x).toBeCloseTo(0.2, 6);
	expect(group.position.y).toBeCloseTo(0.1, 6);
	expect(group.position.z).toBeCloseTo(0.4, 6);
	lifecycle.dispose();
});

test("update applies baseline skull-mouth shelf avoid offsets", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: false,
			lyricScale: 1.2,
			lyricOffsetX: 0.1,
			lyricOffsetY: -0.05,
			lyricOffsetZ: 0.2,
			lyricTiltX: 0,
			lyricTiltY: 0,
			preset: 6,
			skullMouthLyrics: true,
		} as never),
		getShelfMode: () => "side",
		getShelfHasOpenContent: () => false,
		getShelfVisibility: () => 0.4,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	};
	const layoutScale = 1.2 * 0.58;
	const layoutX = 0.1 - 0.36;
	const layoutY = -0.05 + 0.02;
	const layoutZ = 0.2 + 0.18;
	const distance = Math.max(2.2, 4.4 + layoutZ);
	const visibleH = 2 * Math.tan((45 * Math.PI / 180) * 0.5) * distance;
	const visibleW = visibleH * (16 / 9);
	const safeW = Math.max(visibleW * 0.42, visibleW * 0.84 - Math.abs(layoutX) * 1.22);
	const safeH = Math.max(visibleH * 0.18, visibleH * 0.44 - Math.abs(layoutY) * 0.82);
	const viewportFit = Math.min(1, safeW / (5.4 * layoutScale), safeH / (0.78 * layoutScale));
	const lockFit = Math.min(Math.max(0.42, Math.min(1, viewportFit, 0.80 / layoutScale)), 1.12);
	const firstFrameLockFitScale = 1 + (lockFit - 1) * (lockFit < 1 ? 0.18 : 0.10);
	expect(group.scale.x).toBeCloseTo(layoutScale * firstFrameLockFitScale, 6);
	expect(group.position.x).toBeCloseTo(layoutX, 6);
	expect(group.position.y).toBeCloseTo(layoutY, 6);
	expect(group.position.z).toBeCloseTo(layoutZ, 6);
	lifecycle.dispose();
});

test("update applies baseline skull-mouth shelf detail scale without avoid offset", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: false,
			lyricScale: 1.2,
			lyricOffsetX: 0.1,
			lyricOffsetY: -0.05,
			lyricOffsetZ: 0.2,
			lyricTiltX: 0,
			lyricTiltY: 0,
			preset: 6,
			skullMouthLyrics: true,
		} as never),
		getShelfMode: () => "side",
		getShelfHasOpenContent: () => true,
		getSkullShelfOpen: () => true,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	};
	const layoutScale = 1.2 * 0.52;
	const distance = Math.max(2.2, 4.4 + 0.2);
	const visibleH = 2 * Math.tan((45 * Math.PI / 180) * 0.5) * distance;
	const visibleW = visibleH * (16 / 9);
	const safeW = Math.max(visibleW * 0.42, visibleW * 0.84 - 0.1 * 1.22);
	const safeH = Math.max(visibleH * 0.18, visibleH * 0.44 - 0.05 * 0.82);
	const viewportFit = Math.min(1, safeW / (5.4 * layoutScale), safeH / (0.78 * layoutScale));
	const lockFit = Math.min(Math.max(0.42, Math.min(1, viewportFit, 0.80 / layoutScale)), 1.12);
	const firstFrameLockFitScale = 1 + (lockFit - 1) * (lockFit < 1 ? 0.18 : 0.10);
	expect(group.scale.x).toBeCloseTo(layoutScale * firstFrameLockFitScale, 6);
	expect(group.position.x).toBeCloseTo(0.1, 6);
	expect(group.position.y).toBeCloseTo(-0.05, 6);
	expect(group.position.z).toBeCloseTo(0.2, 6);
	lifecycle.dispose();
});

test("update locks skull-mouth lyrics to supplied mouth world transform", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	let mouth = {
		visible: true,
		position: { x: 1, y: 2, z: 3 },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
	};
	let tiltY = 0;
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: false,
			lyricScale: 1,
			lyricOffsetX: 0.2,
			lyricOffsetY: 0.1,
			lyricOffsetZ: 0.4,
			lyricTiltX: 0,
			lyricTiltY: tiltY,
			preset: 6,
			skullMouthLyrics: true,
		} as never),
		skullMouthTransformSupplier: () => mouth,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		quaternion: { x: number; y: number; z: number; w: number };
		userData: Record<string, unknown>;
	};
	expect(group.position.x).toBeCloseTo(1.2, 6);
	expect(group.position.y).toBeCloseTo(2.1, 6);
	expect(group.position.z).toBeCloseTo(3.42, 6);
	expect(group.quaternion.x).toBeCloseTo(0, 6);
	expect(group.quaternion.y).toBeCloseTo(0, 6);
	expect(group.quaternion.z).toBeCloseTo(0, 6);
	expect(group.quaternion.w).toBeCloseTo(1, 6);
	expect(group.userData.skullMouthLocked).toBe(true);

	mouth = {
		visible: true,
		position: { x: 3, y: 5, z: 7 },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
	};
	tiltY = 20;
	lifecycle.update(makeCtx(0.1, 0.1));
	const targetTiltY = Math.sin((20 * Math.PI / 180) / 2);
	const targetTiltW = Math.cos((20 * Math.PI / 180) / 2);
	expect(group.position.x).toBeCloseTo(1.2 + ((3.2) - 1.2) * 0.26, 6);
	expect(group.position.y).toBeCloseTo(2.1 + ((5.1) - 2.1) * 0.26, 6);
	expect(group.position.z).toBeCloseTo(3.42 + ((7.42) - 3.42) * 0.26, 6);
	expect(group.quaternion.x).toBeCloseTo(0, 6);
	expect(group.quaternion.y).toBeCloseTo(targetTiltY * 0.30, 6);
	expect(group.quaternion.z).toBeCloseTo(0, 6);
	expect(group.quaternion.w).toBeCloseTo(1 + (targetTiltW - 1) * 0.30, 6);
	lifecycle.dispose();
});

test("update resets skull-mouth snap state when leaving mouth layout", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	let skullMouthLyrics = true;
	let lyricCameraLock = false;
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock,
			lyricScale: 1,
			lyricOffsetX: 0,
			lyricOffsetY: 0,
			lyricOffsetZ: 0,
			lyricTiltX: 0,
			lyricTiltY: 0,
			preset: skullMouthLyrics ? 6 : 0,
			skullMouthLyrics,
		} as never),
		skullMouthTransformSupplier: () => ({
			visible: true,
			position: { x: 1, y: 2, z: 3 },
			quaternion: { x: 0, y: 0, z: 0, w: 1 },
		}),
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as { userData: Record<string, unknown> };
	expect(group.userData.skullMouthLocked).toBe(true);

	skullMouthLyrics = false;
	lyricCameraLock = true;
	lifecycle.update(makeCtx(0.1, 0.1));
	expect(group.userData.skullMouthLocked).toBe(false);
	lifecycle.dispose();
});

test("update applies baseline wallpaper camera-lock layout and distance when shelf dims wallpaper", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: true,
			lyricScale: 1.2,
			lyricOffsetX: 0.15,
			lyricOffsetY: 0.1,
			lyricOffsetZ: -0.2,
			lyricTiltX: 0,
			lyricTiltY: 0,
			preset: 5,
		}),
		getShelfMode: () => "side",
		getShelfHasOpenContent: () => true,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
	};
	const layoutScale = 1.2 * 0.60;
	const layoutX = 0.15 - 1.34;
	const layoutY = 0.1 - 0.04;
	const layoutZ = -0.2 + 1.02;
	const distance = 5.58 + layoutZ;
	const visibleH = 2 * Math.tan((45 * Math.PI / 180) * 0.5) * distance;
	const visibleW = visibleH * (16 / 9);
	const safeW = Math.max(visibleW * 0.42, visibleW * 0.84 - Math.abs(layoutX) * 1.22);
	const safeH = Math.max(visibleH * 0.18, visibleH * 0.44 - Math.abs(layoutY) * 0.82);
	const viewportFit = Math.min(1, safeW / (5.4 * layoutScale), safeH / (0.78 * layoutScale));
	const lockFit = Math.max(0.42, Math.min(1, viewportFit, 0.80 / layoutScale));
	const firstFrameLockFitScale = 1 + (lockFit - 1) * (lockFit < 1 ? 0.18 : 0.10);
	expect(group.scale.x).toBeCloseTo(layoutScale * firstFrameLockFitScale, 6);
	expect(group.position.x).toBeCloseTo(layoutX * 0.42, 6);
	expect(group.position.y).toBeCloseTo(layoutY * 0.42, 6);
	expect(group.position.z).toBeCloseTo((-distance) * 0.42, 6);
	lifecycle.dispose();
});

test("update applies baseline wallpaper camera-lock easing when shelf is not dimming wallpaper", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 0, y: 0, z: 0 });
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: true,
			lyricScale: 1,
			lyricOffsetX: 0.2,
			lyricOffsetY: 0.1,
			lyricOffsetZ: 0,
			lyricTiltX: 12,
			lyricTiltY: -8,
			preset: 5,
		}),
		getShelfMode: () => "side",
		getShelfHasOpenContent: () => false,
		getShelfVisibility: () => 0,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		quaternion: { x: number; y: number; z: number; w: number };
	};
	const layoutX = 0.2;
	const layoutY = 0.1 + 0.08;
	const layoutZ = 1.15;
	const targetZ = -(4.85 + layoutZ);
	expect(group.position.x).toBeCloseTo(layoutX * 0.34, 6);
	expect(group.position.y).toBeCloseTo(layoutY * 0.34, 6);
	expect(group.position.z).toBeCloseTo(targetZ * 0.34, 6);
	const targetQuatX = Math.sin((12 * Math.PI / 180) / 2) * Math.cos((-8 * Math.PI / 180) / 2);
	expect(group.quaternion.x).toBeCloseTo(targetQuatX * 0.36, 6);
	lifecycle.dispose();
});

test("tickLyricsParticles intro fallback sets currentIdx=-2 when currentTime < first line t", async () => {
	const intros: RecordedCall[] = [];
	const lc = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap(intros),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 5, text: "later" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		fallbackTextSupplier: () => "Song A - Artist",
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	});
	const scene = makeFakeScene();
	await lc.mount(scene as never);
	lc.setLyricLines([{ t: 5, text: "later" }]);
	lc.update(makeCtx(0.5, 0.1));
	await lc.whenIdle();
	expect(lc.getCurrentIdx()).toBe(-2);
	expect(lc.getCurrentText()).toBe("Song A - Artist");
	lc.dispose();
});

test("tickLyricsParticles clears stage when no fallback text and currentTime < first line t", async () => {
	const lc = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 5, text: "later" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		fallbackTextSupplier: () => "",
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	});
	const scene = makeFakeScene();
	await lc.mount(scene as never);
	lc.setLyricLines([{ t: 5, text: "later" }]);
	lc.update(makeCtx(0.5, 0.1));
	await lc.whenIdle();
	expect(lc.getCurrentIdx()).toBe(-1);
	expect(lc.getCurrentText()).toBe("");
	lc.dispose();
});

test("update() drives uOpacity toward 0.38 when shelfVisibility > 0.5 (non-skull)", async () => {
	const { lifecycle } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "hello world" }],
		currentTime: 0.5,
		shelfVisibility: 0.8,
	});
	lifecycle.setShelfVisibility(0.8);
	for (let i = 0; i < 60; i++) {
		lifecycle.update(makeCtx(0.5 + i * 0.016, 0.016, { beatPulse: 0 }));
	}
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(5, 0.016, { beatPulse: 0 }));
	const group = lifecycle.group as unknown as { children: unknown[] };
	const current = group.children[0] as { userData: { lyric?: { textMat?: { uniforms?: { uOpacity?: { value: number } } } } } };
	const opacity = current.userData.lyric?.textMat?.uniforms?.uOpacity?.value ?? 0;
	expect(opacity).toBeGreaterThan(0.30);
	expect(opacity).toBeLessThanOrEqual(0.38 + 0.005);
	lifecycle.dispose();
});

test("update() drives uOpacity toward 0.30 when shelfVisibility > 0.5 with skullShelfDetailOpen", async () => {
	const { lifecycle } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "dark mode" }],
		currentTime: 0.5,
		shelfVisibility: 0.8,
	});
	const lc2 = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "dark mode" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		getShelfVisibility: () => 0.8,
		getSkullShelfOpen: () => true,
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene2 = makeFakeScene();
	await lc2.mount(scene2 as never);
	lc2.setLyricLines([{ t: 0, text: "dark mode" }]);
	lc2.update(makeCtx(0.5, 0.016, { beatPulse: 0 }));
	await lc2.whenIdle();
	lc2.setShelfVisibility(0.8);
	for (let i = 0; i < 80; i++) {
		lc2.update(makeCtx(0.5 + i * 0.016, 0.016, { beatPulse: 0 }));
	}
	await lc2.whenIdle();
	const g2 = lc2.group as unknown as { children: unknown[] };
	const cur2 = g2.children[0] as { userData: { lyric?: { textMat?: { uniforms?: { uOpacity?: { value: number } } } } } };
	const opacity = cur2.userData.lyric?.textMat?.uniforms?.uOpacity?.value ?? 0;
	expect(opacity).toBeGreaterThan(0.25);
	expect(opacity).toBeLessThanOrEqual(0.30 + 0.005);
	lc2.dispose();
	(async () => { void lifecycle.dispose(); })();
});

test("getMotionSnapshot exposes clamped live bloom and audio fields for desktop lyrics", async () => {
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "motion" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0.85,
		lyricGlowBeatFlagSupplier: () => true,
		lyricSunEnergyHolder: { get: () => 1.2, set: () => {} },
		getBeatCamKick: () => ({
			thetaKick: 0,
			phiKick: 0,
			rollKick: 0,
			radiusKick: 1.1,
			punch: 0.9,
		}),
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "motion" }]);
	lifecycle.update(makeCtx(0.5, 0.016, { beatPulse: 1.1, bass: 0.64 }));

	const snapshot = lifecycle.getMotionSnapshot();

	expect(snapshot.highBloom).toBeGreaterThan(0);
	expect(snapshot.highBloom).toBeLessThanOrEqual(1.45);
	expect(snapshot.beatGlow).toBeGreaterThan(0);
	expect(snapshot.beatGlow).toBeLessThanOrEqual(1.7);
	expect(snapshot.beatPulse).toBe(1.1);
	expect(snapshot.bass).toBe(0.64);
	lifecycle.dispose();
});

test("skull preset lyric bloom uses baseline skull flash formula and faster attack", async () => {
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0.85,
		lyricGlowBeatFlagSupplier: () => true,
		lyricSunEnergyHolder: { get: () => 1.2, set: () => {} },
		getBeatCamKick: () => ({
			thetaKick: 0,
			phiKick: 0,
			rollKick: 0,
			radiusKick: 1.1,
			punch: 0.9,
		}),
		lyricLayoutOptionsSupplier: () => ({
			lyricCameraLock: false,
			lyricScale: 1,
			lyricOffsetX: 0,
			lyricOffsetY: 0,
			lyricOffsetZ: 0,
			lyricTiltX: 0,
			lyricTiltY: 0,
			preset: 6,
		}),
		skullBeatFlashSupplier: () => 1,
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0.5, 0.016, { beatPulse: 1.1, bass: 0.64 }));

	const snapshot = lifecycle.getMotionSnapshot();

	expect(snapshot.highBloom).toBeGreaterThan(0.25);
	expect(snapshot.highBloom).toBeLessThanOrEqual(1.45);
	lifecycle.dispose();
});

test("setLyricLines replaces the active fixture set", async () => {
	const { lifecycle, setNow } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "A" }, { t: 2, text: "B" }],
		currentTime: 2,
	});
	lifecycle.setLyricLines([{ t: 10, text: "X" }, { t: 20, text: "Y" }]);
	lifecycle.setShelfVisibility(0);
	setNow(20);
	lifecycle.update(makeCtx(20, 0.1));
	await lifecycle.whenIdle();
	expect(lifecycle.getCurrentText()).toBe("Y");
	lifecycle.dispose();
});

test("dispose kills active timelines + removes group from scene", async () => {
	const rec: RecordedCall[] = [];
	const { lifecycle: helperLifecycle, scene } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "A" }],
		currentTime: 0.5,
		gsapRecorder: rec,
	});
	helperLifecycle.dispose();
	const sceneAny = scene as unknown as { children: unknown[] };
	expect(sceneAny.children.length).toBe(0);
	const lc = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap(rec),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "D" }] as never,
		currentTimeSupplier: () => 1,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		rand: () => 0.5,
	});
	await lc.mount(scene as never);
	expect(sceneAny.children.length).toBe(1);
	lc.setLyricLines([{ t: 0, text: "D" }]);
	lc.update(makeCtx(1, 0.1));
	await lc.whenIdle();
	lc.dispose();
	const killsAfterDispose = rec.filter((r) => r.method === "tl.kill").length;
	expect(killsAfterDispose).toBeGreaterThanOrEqual(1);
	expect((sceneAny.children as unknown[]).length).toBe(0);
});

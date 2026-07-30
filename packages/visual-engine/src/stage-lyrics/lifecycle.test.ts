import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { ThreeFactory, ThreeModule } from "../runtime/renderer-setup";
import type { GsapLike, GsapTimelineLike, GsapTweenLike } from "../control/control-console-motion";
import type { FrameContext } from "../runtime/frame-context";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import { createStageLyricsLifecycle, type StageLyricsLifecycle } from "./lifecycle";
import { RenderStepSlot } from "../runtime/render-step-slot";
import { createBudgetTaskQueue } from "../runtime/budget-task-queue";
import { createVisualResourceLedger } from "../runtime/resource-ledger";
import {
	__inspectVisualResourceScopeForTests,
	createVisualResourceScope,
	type VisualResourceRegistration,
	type VisualResourceScope,
} from "../runtime/resource-scope";
import { createCancellationScope } from "../runtime/cancellation-scope";
import { createVisualSubsystemDiagnosticsRegistry } from "../runtime/subsystem-diagnostics";

type RecordedCall = { method: string; args: unknown[] };
type ThreeConstructorCalls = {
	group: number;
	geometry: number;
	material: number;
	points: number;
};

function makeFakeThree(constructorCalls?: ThreeConstructorCalls): ThreeFactory {
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
		if (constructorCalls) constructorCalls.group += 1;
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
		if (constructorCalls) constructorCalls.geometry += 1;
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
		if (constructorCalls) constructorCalls.material += 1;
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
			rotation: { x: 0, y: 0, z: 0 },
			scale: { x: 1, y: 1, z: 1, set(this: { x: number; y: number; z: number }, x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
		};
	}
	function Points(geometry: unknown, material: unknown) {
		if (constructorCalls) constructorCalls.points += 1;
		return {
			isPoints: true,
			geometry,
			material,
			renderOrder: 0,
			visible: true,
			frustumCulled: true,
			position: { x: 0, y: 0, z: 0, set(this: { x: number; y: number; z: number }, x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
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

async function makeDisposalTrackedThree(): Promise<{
	three: ThreeModule;
	resetDisposeCalls(): void;
	getDisposeCalls(): number;
}> {
	const three = await makeFakeThree()();
	const constructors = three as unknown as Record<string, new (...args: unknown[]) => { dispose?: () => void }>;
	let disposeCalls = 0;
	for (const name of ["PlaneGeometry", "BufferGeometry", "MeshBasicMaterial", "ShaderMaterial", "CanvasTexture", "Texture"]) {
		const Original = constructors[name];
		constructors[name] = function TrackedDisposable(...args: unknown[]) {
			const resource = Reflect.construct(Original, args) as { dispose?: () => void };
			const dispose = resource.dispose?.bind(resource);
			if (dispose) {
				resource.dispose = () => {
					disposeCalls += 1;
					dispose();
				};
			}
			return resource;
		} as unknown as new (...args: unknown[]) => { dispose?: () => void };
	}
	return {
		three,
		resetDisposeCalls() {
			disposeCalls = 0;
		},
		getDisposeCalls() {
			return disposeCalls;
		},
	};
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

function makeCtx(now: number, dt: number, snap?: Partial<AudioSnapshot>, uniformTime = now): FrameContext {
	const snapshot: AudioSnapshot = {
		bass: 0, mid: 0, treble: 0, energy: 0, rb: 0, rm: 0, rt: 0, re: 0,
		beatPulse: 0, scheduledBeatPulse: 0, beatOnsetFlag: false,
		...snap,
	};
	return {
		dt, now, snapshot,
		uniforms: { uTime: { value: uniformTime } } as never,
		scene: null as never,
		camera: null as never,
		pointerParallax: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
	};
}

function findLyricChild(group: { children: Array<{ userData?: { lyric?: unknown; lastLyricProgress?: number } }> }) {
	return group.children.find((c) => c.userData?.lyric);
}

async function buildLifecycleWithCurrent(opts: {
	lyrics: Array<{ t: number; text: string }>;
	currentTime: number;
	playing?: boolean;
	pauseHold?: boolean;
	shelfVisibility?: number;
	gsapRecorder?: RecordedCall[];
}): Promise<{ lifecycle: StageLyricsLifecycle; scene: { children: unknown[]; add(c: unknown): void; remove(c: unknown): void }; recorder: RecordedCall[]; setNow: (v: number) => void; setPlaying: (v: boolean) => void }> {
	const recorder: RecordedCall[] = [];
	const scene = makeFakeScene();
	let mutableTime = opts.currentTime;
	let mutablePlaying = opts.playing ?? true;
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap(opts.gsapRecorder ?? recorder),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => opts.lyrics as never,
		currentTimeSupplier: () => mutableTime,
		isPlayingSupplier: () => mutablePlaying,
		stageLyricsSettingsSupplier: () => ({ pauseHold: opts.pauseHold ?? true }),
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
		setPlaying: (v: boolean) => {
			mutablePlaying = v;
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

test("getWorldLookAtTarget exposes a finite Stage group world position only while lyrics are visible", async () => {
	const { lifecycle } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "hello" }],
		currentTime: 0.2,
	});
	const group = lifecycle.group as unknown as {
		position: { x: number; y: number; z: number };
		updateMatrixWorld?: (force?: boolean) => void;
		getWorldPosition?: (target: { x: number; y: number; z: number }) => { x: number; y: number; z: number };
	};
	let updateCalls = 0;
	group.position.x = 0.4;
	group.position.y = 0.2;
	group.position.z = -0.3;
	group.updateMatrixWorld = () => { updateCalls += 1; };
	group.getWorldPosition = (target) => {
		target.x = group.position.x;
		target.y = group.position.y;
		target.z = group.position.z;
		return target;
	};

	expect(lifecycle.getWorldLookAtTarget()).toEqual({ x: 0.4, y: 0.2, z: -0.3 });
	expect(updateCalls).toBe(1);

	group.position.x = Number.NaN;
	expect(lifecycle.getWorldLookAtTarget()).toBeNull();
	lifecycle.dispose();
	expect(lifecycle.getWorldLookAtTarget()).toBeNull();
});

test("getWorldLookAtTarget uses a real Three.js Vector3 target", async () => {
	const THREE = await import("three");
	const scene = new THREE.Scene();
	const lifecycle = createStageLyricsLifecycle({
		scene,
		threeFactory: async () => THREE,
		currentTimeSupplier: () => 0.2,
		isPlayingSupplier: () => true,
		particleLyricsFlagSupplier: () => true,
		rand: () => 0.5,
	});
	await lifecycle.mount(scene);
	lifecycle.setLyricLines([{ t: 0, text: "真实 Three 目标" }]);
	lifecycle.update(makeCtx(0.2, 0.1));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(0.3, 0.1));

	const target = lifecycle.getWorldLookAtTarget();
	expect(target).not.toBeNull();
	expect(Number.isFinite(target?.x)).toBe(true);
	expect(Number.isFinite(target?.y)).toBe(true);
	expect(Number.isFinite(target?.z)).toBe(true);
	lifecycle.dispose();
});

test("dispose while mount awaits Three.js prevents late stage lyric revival", async () => {
	const scene = makeFakeScene();
	const constructorCalls = {
		group: 0,
		geometry: 0,
		material: 0,
		points: 0,
	};
	const trackedThree = await makeFakeThree(constructorCalls)();
	let resolveThree!: (three: ThreeModule) => void;
	const pendingThree = new Promise<ThreeModule>((resolve) => {
		resolveThree = resolve;
	});
	let factoryCalls = 0;
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: () => {
			factoryCalls += 1;
			return pendingThree;
		},
	});

	const mountPromise = lifecycle.mount(scene as never);
	const mountResultPromise = mountPromise.then(
		() => ({ status: "fulfilled" as const, error: null }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	);
	expect(factoryCalls).toBe(1);
	lifecycle.dispose();
	lifecycle.dispose();
	resolveThree(trackedThree);

	const mountResult = await mountResultPromise;
	expect(mountResult.status).toBe("rejected");
	expect(mountResult.error).toBeInstanceOf(Error);
	expect(lifecycle.group).toBeNull();
	expect(scene.children).toHaveLength(0);
	expect(constructorCalls).toEqual({
		group: 0,
		geometry: 0,
		material: 0,
		points: 0,
	});
});

test("mount() creates baseline lyric star river under the stage group", async () => {
	const scene = makeFakeScene();
	const lc = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
	});
	const group = await lc.mount(scene as never) as unknown as { children: Array<{ isPoints?: boolean; renderOrder?: number; frustumCulled?: boolean; position?: { x: number; y: number; z: number }; geometry?: { attributes?: Record<string, { count: number }> }; material?: { uniforms?: Record<string, { value: unknown }> } }> };
	const river = group.children.find((child) => child.isPoints && child.renderOrder === 45);
	expect(river).not.toBeUndefined();
	expect(river?.frustumCulled).toBe(false);
	expect(river?.position?.x).toBe(0);
	expect(river?.position?.y).toBeCloseTo(0.20, 6);
	expect(river?.position?.z).toBeCloseTo(1.53, 6);
	expect(river?.geometry?.attributes?.seed?.count).toBe(420);
	expect(river?.geometry?.attributes?.lane?.count).toBe(420);
	expect(river?.geometry?.attributes?.depthSeed?.count).toBe(420);
	expect(river?.material?.uniforms?.uOpacity?.value).toBe(0);
	expect(river?.material?.uniforms?.uWidth?.value).toBeCloseTo(4.2, 6);
	expect(river?.material?.uniforms?.uHeight?.value).toBeCloseTo(0.58, 6);
	lc.dispose();
});

test("update uses render-loop uTime seconds for stage lyric motion instead of performance.now milliseconds", async () => {
	const scene = makeFakeScene();
	const lc = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowParticlesSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0.85,
		lyricGlowBeatFlagSupplier: () => false,
		rand: () => 0.35,
	});
	const group = await lc.mount(scene as never) as unknown as { children: Array<{ isPoints?: boolean; renderOrder?: number; material?: { uniforms?: Record<string, { value: number }> } }> };
	lc.update(makeCtx(5000, 0.016, { beatPulse: 0.4 }, 1.25));
	const river = group.children.find((child) => child.isPoints && child.renderOrder === 45);
	expect(river?.material?.uniforms?.uTime?.value).toBe(1.25);
	lc.dispose();
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

test("pause hold keeps the committed lyric and progress visible", async () => {
	const { lifecycle, setNow, setPlaying } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "A" }, { t: 2, text: "B" }],
		currentTime: 1,
		pauseHold: true,
	});
	const group = lifecycle.group as unknown as { children: Array<{ userData?: { lyric?: unknown; lastLyricProgress?: number } }> };
	const before = findLyricChild(group);
	const beforeProgress = before?.userData?.lastLyricProgress;
	setPlaying(false);
	setNow(3);
	lifecycle.update(makeCtx(3, 0.1));
	await lifecycle.whenIdle();
	expect(lifecycle.getCurrentIdx()).toBe(0);
	expect(findLyricChild(group)).toBe(before);
	expect(before?.userData?.lastLyricProgress).toBe(beforeProgress);
});

test("pause hold can be disabled to preserve the legacy hide-on-pause behavior", async () => {
	const { lifecycle, setPlaying } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "A" }],
		currentTime: 0.5,
		pauseHold: false,
	});
	setPlaying(false);
	lifecycle.update(makeCtx(1, 0.1));
	expect(lifecycle.getCurrentIdx()).toBe(-1);
	expect(lifecycle.getCurrentText()).toBe("");
});

test("seek selection chooses the last duplicate timestamp", async () => {
	const { lifecycle } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "A" }, { t: 2, text: "B" }, { t: 2, text: "C" }],
		currentTime: 2,
	});
	expect(lifecycle.getCurrentIdx()).toBe(2);
	expect(lifecycle.getCurrentText()).toBe("C");
});

test("setLyricLines sorts interleaved input before stage line selection", async () => {
	const { lifecycle } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 2, text: "C" }, { t: 0, text: "A" }, { t: 1, text: "B" }],
		currentTime: 1.2,
	});
	expect(lifecycle.getCurrentIdx()).toBe(1);
	expect(lifecycle.getCurrentText()).toBe("B");
	lifecycle.dispose();
});

test("setLyricLines keeps current stage line when the lyric payload content is unchanged", async () => {
	const { lifecycle } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "A" }, { t: 2, text: "B" }],
		currentTime: 2.2,
	});
	expect(lifecycle.getCurrentIdx()).toBe(1);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	expect(lifecycle.getCurrentIdx()).toBe(1);
	expect(lifecycle.getCurrentText()).toBe("B");
	lifecycle.dispose();
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
	const firstLyric = findLyricChild(groupA)?.userData?.lyric as { mask?: { fontSize: number; lineHeight: number }; textMat?: { uniforms?: { uTextOptionsSignature?: { value: string } } } } | undefined;
	expect(firstLyric?.textMat?.uniforms?.uTextOptionsSignature?.value).toBe("stone-song|0.12|1.24|900");
	expect(firstLyric?.mask?.lineHeight).toBeGreaterThan((firstLyric?.mask?.fontSize ?? 0) * 1.2);

	textOptions.lyricLetterSpacing = 0.03;
	lifecycle.update(makeCtx(0.6, 0.1));
	await lifecycle.whenIdle();
	const groupB = lifecycle.group as unknown as { children: Array<{ userData: { lyric?: { textMat?: { uniforms?: { uTextOptionsSignature?: { value: string } } } } } }> };
	expect((findLyricChild(groupB)?.userData?.lyric as { textMat?: { uniforms?: { uTextOptionsSignature?: { value: string } } } } | undefined)?.textMat?.uniforms?.uTextOptionsSignature?.value).toBe("stone-song|0.03|1.24|900");
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
	const current = findLyricChild(group) as { userData: { lyric?: { textMat?: { uniforms?: { uOpacity?: { value: number } } } } } };
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

test("update applies baseline skull shelf-detail lyric offset even when skull shelf helper is false", async () => {
	const scene = makeFakeScene();
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "Skull shelf detail lyric" }] as never,
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
			preset: 6,
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
	expect(group.scale.x).toBeCloseTo(1.4 * 0.70, 6);
	expect(group.scale.y).toBeCloseTo(1.4 * 0.70, 6);
	expect(group.scale.z).toBeCloseTo(1.4 * 0.70, 6);
	expect(group.position.x).toBeCloseTo(0.2 - 1.58, 6);
	expect(group.position.y).toBeCloseTo(-0.1 + 0.08, 6);
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

test("requestCameraSnap makes camera-locked lyrics copy target for requested frames", async () => {
	const scene = makeFakeScene();
	const camera = makeFakeCamera({ x: 1, y: 2, z: 3 });
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
			lyricOffsetX: 0.5,
			lyricOffsetY: -0.25,
			lyricOffsetZ: 0.75,
			lyricTiltX: 0,
			lyricTiltY: 0,
		}),
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.requestCameraSnap(2);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as { position: { x: number; y: number; z: number } };
	expect(group.position.x).toBeCloseTo(1.5, 6);
	expect(group.position.y).toBeCloseTo(1.75, 6);
	expect(group.position.z).toBeCloseTo(-2.6, 6);
	camera.position.x = 2;
	lifecycle.update(makeCtx(0.1, 0.1));
	expect(group.position.x).toBeCloseTo(2.5, 6);
	camera.position.x = 3;
	lifecycle.update(makeCtx(0.2, 0.1));
	expect(group.position.x).toBeCloseTo(2.5 + (3.5 - 2.5) * 0.24, 6);
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

test("skull preset camera-lock fit uses baseline skull safe bounds and cap", async () => {
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
			preset: 6,
		}),
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as { scale: { x: number; y: number; z: number } };
	const visibleH = 2 * Math.tan((45 * Math.PI / 180) * 0.5) * 4.85;
	const visibleW = visibleH * (16 / 9);
	const safeW = Math.max(visibleW * 0.36, visibleW * 0.70 - 1.4 * 1.36);
	const safeH = Math.max(visibleH * 0.16, visibleH * 0.34 - 0.9 * 0.98);
	const viewportFit = Math.min(1, safeW / (5.4 * 1.65), safeH / (0.78 * 1.65));
	const lockFit = Math.max(0.36, Math.min(1, viewportFit, 0.94 / 1.65));
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

test("update avoids non-wallpaper camera-locked lyrics when side shelf is always visible", async () => {
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
		getShelfVisibility: () => 0,
		getShelfAlwaysVisible: () => true,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	} as Parameters<typeof createStageLyricsLifecycle>[0] & { getShelfAlwaysVisible: () => boolean });
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

test("update avoids non-wallpaper camera-locked lyrics when side shelf hover cue is active", async () => {
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
		getShelfVisibility: () => 0,
		getShelfHoverCueValue: () => 0.29,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	} as Parameters<typeof createStageLyricsLifecycle>[0] & { getShelfHoverCueValue: () => number });
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as { position: { x: number; y: number; z: number } };
	expect(group.position.x).toBeCloseTo((0.4 - 1.36) * 0.24, 6);
	expect(group.position.y).toBeCloseTo((-0.2 + 0.06) * 0.24, 6);
	expect(group.position.z).toBeCloseTo(-(4.85 + 0.1 + 0.72) * 0.24, 6);
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
	const safeW = Math.max(visibleW * 0.36, visibleW * 0.70 - 1.45 * 1.36);
	const safeH = Math.max(visibleH * 0.16, visibleH * 0.34 - 0.9 * 0.98);
	const viewportFit = Math.min(1, safeW / (5.4 * 1.65), safeH / (0.78 * 1.65));
	const lockFit = Math.max(0.36, Math.min(1, viewportFit, 0.94 / 1.65));
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
	const safeW = Math.max(visibleW * 0.36, visibleW * 0.70 - 0.2 * 1.36);
	const safeH = Math.max(visibleH * 0.16, visibleH * 0.34 - 0.1 * 0.98);
	const viewportFit = Math.min(1, safeW / (5.4 * layoutScale), safeH / (0.78 * layoutScale));
	const lockFit = Math.min(Math.max(0.36, Math.min(1, viewportFit, 0.94 / layoutScale)), 1.12);
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

test("update keeps wallpaper camera-lock lyrics undimmed for side shelf auto visibility alone", async () => {
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
		getShelfVisibility: () => 0.4,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as { position: { x: number; y: number; z: number } };
	expect(group.position.x).toBeCloseTo(0.2 * 0.34, 6);
	expect(group.position.y).toBeCloseTo((0.1 + 0.08) * 0.34, 6);
	expect(group.position.z).toBeCloseTo(-(4.85 + 1.15) * 0.34, 6);
	lifecycle.dispose();
});

test("update dims wallpaper camera-lock lyrics when side shelf is pinned open", async () => {
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
		getShelfHasOpenContent: () => false,
		getShelfPinnedOpen: () => true,
		cameraSupplier: () => camera as never,
		rand: () => 0.35,
	} as Parameters<typeof createStageLyricsLifecycle>[0] & { getShelfPinnedOpen: () => boolean });
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0, 0.1));
	const group = lifecycle.group as unknown as { position: { x: number; y: number; z: number } };
	expect(group.position.x).toBeCloseTo((0.15 - 1.34) * 0.42, 6);
	expect(group.position.y).toBeCloseTo((0.1 - 0.04) * 0.42, 6);
	expect(group.position.z).toBeCloseTo(-(5.58 + -0.2 + 1.02) * 0.42, 6);
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

test("update() drives uOpacity toward 0.38 when side shelf detail content is open (non-skull)", async () => {
	const scene = makeFakeScene();
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "hello world" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		getShelfHasOpenContent: () => true,
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "hello world" }]);
	lifecycle.update(makeCtx(0.5, 0.016, { beatPulse: 0 }));
	await lifecycle.whenIdle();
	for (let i = 0; i < 60; i++) {
		lifecycle.update(makeCtx(0.5 + i * 0.016, 0.016, { beatPulse: 0 }));
	}
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(5, 0.016, { beatPulse: 0 }));
	const group = lifecycle.group as unknown as { children: Array<{ userData?: { lyric?: unknown } }> };
	const current = findLyricChild(group) as { userData: { lyric?: { textMat?: { uniforms?: { uOpacity?: { value: number } } } } } };
	const opacity = current.userData.lyric?.textMat?.uniforms?.uOpacity?.value ?? 0;
	expect(opacity).toBeGreaterThan(0.30);
	expect(opacity).toBeLessThanOrEqual(0.38 + 0.005);
	lifecycle.dispose();
});

test("update() drives uOpacity toward 0.30 when skull shelf detail content is open", async () => {
	const lc2 = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "dark mode" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		getShelfHasOpenContent: () => true,
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({ preset: 6 }),
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene2 = makeFakeScene();
	await lc2.mount(scene2 as never);
	lc2.setLyricLines([{ t: 0, text: "dark mode" }]);
	lc2.update(makeCtx(0.5, 0.016, { beatPulse: 0 }));
	await lc2.whenIdle();
	for (let i = 0; i < 80; i++) {
		lc2.update(makeCtx(0.5 + i * 0.016, 0.016, { beatPulse: 0 }));
	}
	await lc2.whenIdle();
	const g2 = lc2.group as unknown as { children: Array<{ userData?: { lyric?: unknown } }> };
	const cur2 = findLyricChild(g2) as { userData: { lyric?: { textMat?: { uniforms?: { uOpacity?: { value: number } } } } } };
	const opacity = cur2.userData.lyric?.textMat?.uniforms?.uOpacity?.value ?? 0;
	expect(opacity).toBeGreaterThan(0.25);
	expect(opacity).toBeLessThanOrEqual(0.30 + 0.005);
	lc2.dispose();
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

test("update drives baseline star river width height opacity and hides it for skull preset", async () => {
	let preset = 0;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		lyricGlowParticlesSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0.85,
		lyricGlowBeatFlagSupplier: () => true,
		lyricSunEnergyHolder: { get: () => 1.1, set: () => {} },
		getBeatCamKick: () => ({ thetaKick: 0, phiKick: 0, rollKick: 0, radiusKick: 1, punch: 1 }),
		lyricLayoutOptionsSupplier: () => ({ preset }),
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "star river lyric" }]);
	lifecycle.update(makeCtx(0.5, 0.1, { beatPulse: 1, bass: 0.4 }));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(0.6, 0.1, { beatPulse: 1, bass: 0.4 }));
	const group = lifecycle.group as unknown as { children: Array<{ isPoints?: boolean; renderOrder?: number; visible?: boolean; material?: { uniforms?: Record<string, { value: number }> } }> };
	const river = group.children.find((child) => child.isPoints && child.renderOrder === 45);
	expect(river).not.toBeUndefined();
	expect(river?.visible).toBe(true);
	expect(river?.material?.uniforms?.uWidth?.value).toBeGreaterThan(4.2);
	expect(river?.material?.uniforms?.uHeight?.value).toBeGreaterThan(0.58);
	expect(river?.material?.uniforms?.uOpacity?.value).toBeGreaterThan(0);

	preset = 6;
	lifecycle.update(makeCtx(0.7, 0.1, { beatPulse: 1, bass: 0.4 }));
	expect(river?.visible).toBe(false);
	expect(river?.material?.uniforms?.uOpacity?.value).toBe(0);
	lifecycle.dispose();
});

test("shelf detail open lowers stage lyric renderOrder from 38 to 24 using open-content state", async () => {
	let open = false;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		getShelfVisibility: () => 0,
		getShelfHasOpenContent: () => open,
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.update(makeCtx(0.5, 0.016));
	expect((lifecycle.group as unknown as { renderOrder: number }).renderOrder).toBe(38);
	open = true;
	lifecycle.update(makeCtx(0.6, 0.016));
	expect((lifecycle.group as unknown as { renderOrder: number }).renderOrder).toBe(24);
	lifecycle.dispose();
});

test("current lyric mesh uses baseline local breathing and spark/sun/glow motion", async () => {
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		lyricGlowParticlesSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0.85,
		lyricGlowBeatFlagSupplier: () => true,
		lyricSunEnergyHolder: { get: () => 1.2, set: () => {} },
		getBeatCamKick: () => ({ thetaKick: 0.5, phiKick: 0.25, rollKick: 0.2, radiusKick: 0.8, punch: 0.9 }),
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "moving lyric" }]);
	lifecycle.update(makeCtx(0.5, 0.1, { beatPulse: 1, bass: 0.5, mid: 0.4 }));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(1.0, 0.1, { beatPulse: 1, bass: 0.5, mid: 0.4 }));
	const group = lifecycle.group as unknown as { children: Array<{ userData?: { lyric?: unknown }; position?: { y: number; z: number }; scale?: { x: number }; rotation?: { z: number } }> };
	const current = findLyricChild(group) as unknown as {
		position: { x: number; y: number; z: number };
		scale: { x: number; y: number; z: number };
		rotation: { z: number };
		userData: {
			lyric: {
				glow: { position: { x: number; y: number; z: number }; rotation: { z: number } };
				sun: { position: { x: number; y: number; z: number }; rotation: { z: number }; scale: { x: number; y: number; z: number } };
				sparks: { visible: boolean; position: { x: number; y: number; z: number }; rotation: { x: number; z: number }; geometry: { attributes: { position: { array: Float32Array; needsUpdate: boolean } } } };
				basePositions: Float32Array;
				sparkMat: { uniforms: { uOpacity: { value: number }; uSize: { value: number } } };
			};
		};
	};
	expect(current.position.y).toBeGreaterThan(0.18);
	expect(current.position.y).toBeLessThan(0.27);
	expect(current.position.z).toBeGreaterThan(1.45);
	expect(current.position.z).toBeLessThan(1.56);
	expect(Math.abs(current.scale.x - 0.96)).toBeGreaterThan(0.001);
	expect(Math.abs(current.rotation.z)).toBeGreaterThan(0);
	expect(Math.abs(current.userData.lyric.glow.position.x)).toBeGreaterThan(0);
	expect(current.userData.lyric.sun.scale.x).toBeGreaterThan(0.82);
	expect(current.userData.lyric.sparks.visible).toBe(true);
	expect(current.userData.lyric.sparkMat.uniforms.uOpacity.value).toBeGreaterThan(0);
	expect(current.userData.lyric.sparkMat.uniforms.uSize.value).toBeGreaterThan(0.035);
	expect(current.userData.lyric.sparks.geometry.attributes.position.needsUpdate).toBe(true);
	expect(current.userData.lyric.sparks.geometry.attributes.position.array[0]).not.toBe(current.userData.lyric.basePositions[0]);
	lifecycle.dispose();
});

test("current lyric tick updates glow sun and spark colors from baseline solar palette", async () => {
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		lyricGlowParticlesSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0.85,
		lyricGlowBeatFlagSupplier: () => true,
		lyricSunEnergyHolder: { get: () => 1.2, set: () => {} },
		getBeatCamKick: () => ({ thetaKick: 0.1, phiKick: 0.1, rollKick: 0.1, radiusKick: 0.8, punch: 0.9 }),
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "solar color lyric" }]);
	lifecycle.update(makeCtx(0.5, 0.1, { beatPulse: 1, bass: 0.5, mid: 0.4 }));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(1.0, 0.1, { beatPulse: 1, bass: 0.5, mid: 0.4 }));
	const group = lifecycle.group as unknown as { children: Array<{ userData?: { lyric?: unknown } }> };
	const current = findLyricChild(group) as unknown as {
		userData: {
			lyric: {
				glowMat: { color: { r: number; g: number; b: number } };
				sunMat: { color: { r: number; g: number; b: number } };
				sparkMat: { uniforms: { uColor: { value: { r: number; g: number; b: number } } } };
			};
		};
	};
	expect(current.userData.lyric.glowMat.color.r).toBeGreaterThan(0.70);
	expect(current.userData.lyric.sunMat.color.g).toBeGreaterThan(0.90);
	expect(current.userData.lyric.sparkMat.uniforms.uColor.value.b).toBeLessThan(0.80);
	lifecycle.dispose();
});

async function highBloomForSnapshotSun(lyricSunEnergy: number): Promise<number> {
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		lyricGlowParticlesSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0.85,
		lyricGlowBeatFlagSupplier: () => false,
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "snapshot sun lyric" }]);
	lifecycle.update(makeCtx(0.5, 0.1, { lyricSunEnergy, beatPulse: 0, bass: 0.2, mid: 0.2 }));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(0.7, 0.1, { lyricSunEnergy, beatPulse: 0, bass: 0.2, mid: 0.2 }));

	const highBloom = lifecycle.getMotionSnapshot().highBloom;
	lifecycle.dispose();
	return highBloom;
}

test("stage lyric high bloom reads lyricSunEnergy from audio snapshot when no holder is supplied", async () => {
	const low = await highBloomForSnapshotSun(0);
	const high = await highBloomForSnapshotSun(1);

	expect(high).toBeGreaterThan(low + 0.08);
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

test("showStageLine relies on baseline tickMesh motion without creating GSAP lyric timelines", async () => {
	const recorder: RecordedCall[] = [];
	const { lifecycle, setNow } = await buildLifecycleWithCurrent({
		lyrics: [{ t: 0, text: "A" }, { t: 2, text: "B" }],
		currentTime: 0.5,
		gsapRecorder: recorder,
	});
	await lifecycle.whenIdle();
	expect(recorder.some((call) => call.method === "timeline")).toBe(false);
	setNow(2.1);
	lifecycle.update(makeCtx(2.1, 0.1));
	await lifecycle.whenIdle();
	expect(lifecycle.getCurrentText()).toBe("B");
	expect(recorder.some((call) => call.method === "timeline")).toBe(false);
	lifecycle.dispose();
});

test("outgoing lyric mesh keeps baseline glow sun and spark follow motion", async () => {
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		lyricGlowParticlesSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0.85,
		lyricGlowBeatFlagSupplier: () => true,
		lyricSunEnergyHolder: { get: () => 1.2, set: () => {} },
		getBeatCamKick: () => ({ thetaKick: 0.5, phiKick: 0.25, rollKick: 0.2, radiusKick: 0.8, punch: 0.9 }),
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(0.5, 0.1, { beatPulse: 1, bass: 0.5, mid: 0.4 }));
	await lifecycle.whenIdle();
	now = 2.1;
	lifecycle.update(makeCtx(2.1, 0.1, { beatPulse: 1, bass: 0.5, mid: 0.4 }));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(2.2, 0.1, { beatPulse: 1, bass: 0.5, mid: 0.4 }));
	const group = lifecycle.group as unknown as { children: Array<{ userData?: { lyric?: unknown; state?: string } }> };
	const outgoing = group.children.find((child) => child.userData?.state === "out") as unknown as {
		userData: {
			lyric: {
				glow: { position: { x: number; y: number; z: number }; rotation: { z: number } };
				sun: { position: { x: number; y: number; z: number }; rotation: { z: number } };
				sparks: { position: { x: number; y: number; z: number }; rotation: { z: number } };
			};
		};
	} | undefined;
	expect(outgoing).not.toBeUndefined();
	expect(Math.abs(outgoing!.userData.lyric.glow.position.x)).toBeGreaterThan(0);
	expect(Math.abs(outgoing!.userData.lyric.sun.position.x)).toBeGreaterThan(Math.abs(outgoing!.userData.lyric.glow.position.x));
	expect(Math.abs(outgoing!.userData.lyric.sparks.position.x)).toBeGreaterThan(0);
	expect(Math.abs(outgoing!.userData.lyric.glow.rotation.z)).toBeGreaterThan(0);
	lifecycle.dispose();
});

test("setPalette applies baseline colors in place to current and outgoing lyrics", async () => {
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		lyricGlowParticlesSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(0.5, 0.1));
	await lifecycle.whenIdle();
	const groupA = lifecycle.group as unknown as { children: Array<{ userData?: { lyric?: unknown; state?: string } }> };
	const firstCurrent = findLyricChild(groupA);
	now = 2.1;
	lifecycle.update(makeCtx(2.1, 0.1));
	await lifecycle.whenIdle();
	const groupB = lifecycle.group as unknown as { children: Array<{ userData?: { lyric?: { textMat?: { uniforms?: Record<string, { value: { r: number; g: number; b: number } }> }; glowMat?: { color: { r: number; g: number; b: number } }; sparkMat?: { uniforms?: { uColor?: { value: { r: number; g: number; b: number } } } }; sunMat?: { color: { r: number; g: number; b: number } } }; state?: string } }> };
	const currentBefore = groupB.children.find((child) => child.userData?.state !== "out" && child.userData?.lyric);
	const outgoingBefore = groupB.children.find((child) => child.userData?.state === "out");
	expect(outgoingBefore).toBe(firstCurrent);
	lifecycle.setPalette({
		primary: "#224466",
		secondary: "#336688",
		highlight: "#ffcc66",
		glowColor: "#66ccff",
	});
	await lifecycle.whenIdle();
	const currentAfter = groupB.children.find((child) => child.userData?.state !== "out" && child.userData?.lyric);
	const outgoingAfter = groupB.children.find((child) => child.userData?.state === "out");
	expect(currentAfter).toBe(currentBefore);
	expect(outgoingAfter).toBe(outgoingBefore);
	const currentLyric = currentAfter!.userData!.lyric!;
	const outgoingLyric = outgoingAfter!.userData!.lyric!;
	expect(currentLyric.textMat?.uniforms?.uBaseColor?.value.b).toBeGreaterThan(0.35);
	expect(currentLyric.glowMat?.color.b).toBeGreaterThan(0.80);
	expect(currentLyric.sparkMat?.uniforms?.uColor?.value.r).toBeGreaterThan(0.90);
	expect(outgoingLyric.sunMat?.color.r).toBeGreaterThan(0.90);
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

test("dispose removes group from scene without stage-lyric GSAP timelines", async () => {
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
	expect(killsAfterDispose).toBe(0);
	expect((sceneAny.children as unknown[]).length).toBe(0);
});

test("Sonic preset applies the unlocked Stage lyric offset policy", async () => {
	const scene = makeFakeScene();
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		lyricLinesSupplier: () => [{ t: 0, text: "Sonic lyric" }] as never,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		dotTexture: makeFakeDotTexture(),
		particleLyricsFlagSupplier: () => true,
		lyricGlowStrengthSupplier: () => 0,
		lyricGlowBeatFlagSupplier: () => false,
		lyricSunEnergyHolder: { get: () => 0, set: () => {} },
		lyricLayoutOptionsSupplier: () => ({ preset: 7, lyricOffsetY: 0.1, lyricOffsetZ: 0.2 }),
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "Sonic lyric" }]);
	lifecycle.update(makeCtx(0.5, 0.1));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(0.6, 0.1));
	const group = lifecycle.group as unknown as { position: { y: number; z: number } };
	expect(group.position.y).toBeCloseTo(-0.24, 6);
	expect(group.position.z).toBeCloseTo(0.36, 6);
	lifecycle.dispose();
});

test("detail-open propagates the effective render base to current and outgoing lyric rows in one frame", async () => {
	let open = false;
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		getShelfHasOpenContent: () => open,
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([
		{ t: 0, text: "First row" },
		{ t: 1, text: "Second row" },
	]);
	lifecycle.update(makeCtx(now, 0.016));
	await lifecycle.whenIdle();
	now = 1.1;
	lifecycle.update(makeCtx(now, 0.016));
	await lifecycle.whenIdle();

	const rows = () => (lifecycle.group as unknown as {
		children: Array<{ renderOrder?: number; userData?: { lyric?: unknown } }>;
	}).children.filter((child) => child.userData?.lyric);
	expect(rows().length).toBe(2);
	expect(rows().map((row) => row.renderOrder)).toEqual([38, 38]);

	open = true;
	lifecycle.update(makeCtx(1.2, 0.016));
	expect(rows().map((row) => row.renderOrder)).toEqual([24, 24]);

	open = false;
	lifecycle.update(makeCtx(1.3, 0.016));
	expect(rows().map((row) => row.renderOrder)).toEqual([38, 38]);
	lifecycle.dispose();
});

test("a lyric created while detail is open starts with render base 24", async () => {
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 9999,
		particleLyricsFlagSupplier: () => true,
		getShelfHasOpenContent: () => true,
		dotTexture: makeFakeDotTexture(),
		rand: () => 0.35,
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "Detail first frame" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	await lifecycle.whenIdle();
	const row = findLyricChild(lifecycle.group as never) as { renderOrder?: number } | undefined;
	expect(row?.renderOrder).toBe(24);
	lifecycle.dispose();
});

test("shared queue and renderer upload gate keep the committed lyric until replacement textures are ready", async () => {
	const scope = createVisualResourceScope("stage-lifecycle");
	const cancellation = createCancellationScope("stage-lifecycle");
	const ledger = createVisualResourceLedger({
		budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 32, cacheBytes: 32 * 1024 * 1024 },
	});
	const queue = createBudgetTaskQueue({
		ledger,
		resourceScope: scope,
		cancellationScope: cancellation,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		cancellationScope: cancellation,
		textureUploadExecutor: () => { uploads.push(1); },
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
	} as never);
	const scene = makeFakeScene();
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	for (let step = 0; step < 6; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	// 一帧只有一次真实 renderer-backed uploader 调用。
	lifecycle.update(makeCtx(0.6, 0.016));
	expect(uploads.length).toBe(1);
	for (let frame = 0; frame < 8; frame += 1) lifecycle.update(makeCtx(0.7 + frame * 0.016, 0.016));
	const first = findLyricChild(lifecycle.group as never);
	expect(first).toBeDefined();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBeGreaterThan(0);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(2);
	expect(diagnostics.snapshot()["stage-lyrics"]?.clarityBytes).toBeGreaterThan(0);

	now = 2.1;
	lifecycle.update(makeCtx(2.1, 0.016));
	for (let step = 0; step < 6; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	// 新候选已经 rasterize，但在下一个 Stage frame 提交 GPU 前，旧 lyric 仍保持可见。
	expect(findLyricChild(lifecycle.group as never)).toBe(first);
	lifecycle.update(makeCtx(2.12, 0.016));
	for (let frame = 0; frame < 8; frame += 1) lifecycle.update(makeCtx(2.14 + frame * 0.016, 0.016));
	expect(lifecycle.getCurrentText()).toBe("B");
	const active = (lifecycle.group as unknown as {
		children: Array<{ userData?: { lyric?: unknown; state?: string } }>;
	}).children.find((child) => child.userData?.lyric && child.userData.state !== "out");
	expect(active).toBeDefined();
	expect(active).not.toBe(first);
	expect(diagnostics.snapshot()["stage-lyrics"]?.pendingUploads).toBe(0);
	// current 与 outgoing 在过渡期可临时占用一个 replacement 槽。
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(2);
	for (let frame = 0; frame < 24; frame += 1) lifecycle.update(makeCtx(2.3 + frame * 0.016, 0.016));
	// outgoing 完成后释放旧行，并把 replacement 恢复为稳定 resident。
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(1);
	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	cancellation.dispose();
	scope.dispose();
});

test("renderer upload failure releases only the pending replacement and retains the old lyric", async () => {
	const scope = createVisualResourceScope("stage-upload-failure");
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 32, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	let now = 0.5;
	let failReplacement = false;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {
			if (failReplacement) throw new Error("GPU upload failed");
		},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	for (let step = 0; step < 6; step += 1) { queue.runSlice(1); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
	for (let frame = 0; frame < 8; frame += 1) lifecycle.update(makeCtx(0.6 + frame * 0.016, 0.016));
	const first = findLyricChild(lifecycle.group as never);
	const stableResourceCount = __inspectVisualResourceScopeForTests(scope).activeResourceEntryCount;
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(2);
	failReplacement = true;
	now = 2.1;
	lifecycle.update(makeCtx(2.1, 0.016));
	for (let step = 0; step < 6; step += 1) { queue.runSlice(1); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
	lifecycle.update(makeCtx(2.12, 0.016));
	expect(findLyricChild(lifecycle.group as never)).toBe(first);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(1);
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBeLessThan(stableResourceCount);
	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("rapid line replacement keeps one tracked current and at most one outgoing clarity row", async () => {
	const scope = createVisualResourceScope("stage-rapid-replacement");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 32, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }, { t: 4, text: "C" }]);

	const settleLine = async (time: number) => {
		now = time;
		lifecycle.update(makeCtx(time, 0.016));
		for (let step = 0; step < 6; step += 1) {
			queue.runSlice(1);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		for (let frame = 0; frame < 8; frame += 1) {
			lifecycle.update(makeCtx(time + 0.02 + frame * 0.016, 0.016));
		}
	};

	await settleLine(0.5);
	await settleLine(2.1);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(3);
	await settleLine(4.1);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBeLessThanOrEqual(3);
	const outgoingCount = (lifecycle.group as unknown as {
		children: Array<{ userData?: { lyric?: unknown; state?: string } }>;
	}).children.filter((child) => child.userData?.lyric && child.userData.state === "out").length;
	expect(outgoingCount).toBeLessThanOrEqual(1);
	for (let frame = 0; frame < 30; frame += 1) lifecycle.update(makeCtx(4.4 + frame * 0.016, 0.016));
	expect(lifecycle.getCurrentText()).toBe("C");
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(2);
	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("prewarmed next row stays off the upload gate until activation", async () => {
	const scope = createVisualResourceScope("stage-prewarm-next");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 64, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	let now = 0.5;
	let detailOpen = false;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		getShelfHasOpenContent: () => detailOpen,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => { uploads.push(1); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	for (let step = 0; step < 20; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(0.6, 0.016));
	expect(lifecycle.getCurrentText()).toBe("A");
	expect(uploads).toHaveLength(1);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(2);

	// detail 边沿必须先更新仍未 attach 的预热行；激活时不得闪现旧的 38 base。
	detailOpen = true;
	lifecycle.update(makeCtx(0.7, 0.016));
	// 激活预热行时不再推进 raster queue，同一 Stage frame 只执行一次 GPU upload。
	now = 2.1;
	lifecycle.update(makeCtx(2.1, 0.016));
	expect(lifecycle.getCurrentText()).toBe("B");
	expect(uploads).toHaveLength(2);
	const rows = (lifecycle.group as unknown as {
		children: Array<{ renderOrder?: number; userData?: { lyric?: unknown } }>;
	}).children.filter((child) => child.userData?.lyric);
	expect(rows.map((row) => row.renderOrder)).toEqual([24, 24]);
	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("activating a prewarmed row promotes its resource retention before rebuildable release", async () => {
	type DisposableFlag = { disposed?: boolean };
	type ActiveLyricResources = {
		mask?: { texture?: DisposableFlag | null };
		textMesh?: { geometry?: DisposableFlag };
		readability?: { geometry?: DisposableFlag };
		glow?: { geometry?: DisposableFlag };
		sparks?: { geometry?: DisposableFlag };
		sun?: { geometry?: DisposableFlag };
		glowMat?: { uniforms?: { uMap?: { value?: DisposableFlag | null } } };
		readabilityMat?: { uniforms?: { uMap?: { value?: DisposableFlag | null } } };
	};
	type ActiveLyricChild = {
		children?: unknown[];
		userData?: { lyric?: ActiveLyricResources | null; state?: string };
	};
	const scope = createVisualResourceScope("stage-prewarm-promotion");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 64, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: (texture: unknown) => { uploads.push(texture); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	const getActiveLyric = () => (lifecycle.group as unknown as {
		children: ActiveLyricChild[];
	}).children.find((child) => child.userData?.lyric && child.userData.state !== "out");
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 20; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	let activeA: ActiveLyricChild | undefined;
	for (let frame = 0; frame < 8; frame += 1) {
		lifecycle.update(makeCtx(0.6 + frame * 0.016, 0.016));
		activeA = getActiveLyric();
		if (activeA && diagnostics.snapshot()["stage-lyrics"]?.pendingUploads === 0) break;
	}
	expect(activeA).toBeDefined();
	expect(diagnostics.snapshot()["stage-lyrics"]?.pendingUploads).toBe(0);
	expect(lifecycle.getCurrentText()).toBe("A");

	const uploadsBeforeActivation = uploads.length;
	now = 2.1;
	let activeB: ActiveLyricChild | undefined;
	for (let frame = 0; frame < 8; frame += 1) {
		lifecycle.update(makeCtx(now + frame * 0.016, 0.016));
		const candidate = getActiveLyric();
		if (
			candidate
			&& candidate !== activeA
			&& diagnostics.snapshot()["stage-lyrics"]?.pendingUploads === 0
		) {
			activeB = candidate;
			break;
		}
	}
	expect(activeB).toBeDefined();
	expect(activeB).not.toBe(activeA);
	expect(diagnostics.snapshot()["stage-lyrics"]?.pendingUploads).toBe(0);
	expect(lifecycle.getCurrentText()).toBe("B");
	expect(uploads.length).toBeGreaterThan(uploadsBeforeActivation);

	const bResources = activeB?.userData?.lyric;
	expect(bResources).toBeDefined();
	const bTextures = [...new Set([
		bResources?.mask?.texture,
		bResources?.glowMat?.uniforms?.uMap?.value,
		bResources?.readabilityMat?.uniforms?.uMap?.value,
		...uploads.slice(uploadsBeforeActivation) as DisposableFlag[],
	].filter((resource): resource is DisposableFlag => !!resource))];
	const bGeometries = [
		bResources?.textMesh?.geometry,
		bResources?.readability?.geometry,
		bResources?.glow?.geometry,
		bResources?.sparks?.geometry,
		bResources?.sun?.geometry,
	].filter((resource): resource is DisposableFlag => !!resource);
	expect(activeB?.children).toHaveLength(5);
	expect(bTextures.length).toBeGreaterThan(0);
	expect(bGeometries).toHaveLength(5);
	expect(bTextures.every((resource) => resource.disposed === false)).toBe(true);
	expect(bGeometries.every((resource) => resource.disposed === false)).toBe(true);

	scope.releaseRetention("rebuildable");
	lifecycle.update(makeCtx(2.3, 0.016));
	const activeAfterRelease = getActiveLyric();
	expect(activeAfterRelease).toBe(activeB);
	expect(activeB?.userData?.lyric).toBe(bResources);
	expect(activeB?.children).toHaveLength(5);
	expect(bTextures.every((resource) => resource.disposed === false)).toBe(true);
	expect(bGeometries.every((resource) => resource.disposed === false)).toBe(true);
	expect(lifecycle.getCurrentText()).toBe("B");

	lifecycle.dispose();
	expect(activeB?.userData?.lyric).toBeNull();
	expect(bTextures.every((resource) => resource.disposed === true)).toBe(true);
	expect(bGeometries.every((resource) => resource.disposed === true)).toBe(true);
	queue.dispose();
	scope.dispose();
});

test("production lifecycle registers current and resident prewarm allocations exactly once", async () => {
	const rawLifecycleScope = createVisualResourceScope("stage-production-reservations");
	const queueScope = createVisualResourceScope("stage-production-reservation-queue");
	const registrations: Array<{ kind: string; retention: string }> = [];
	const lifecycleScope: VisualResourceScope = {
		get name() { return rawLifecycleScope.name; },
		get closed() { return rawLifecycleScope.closed; },
		isOpen: () => rawLifecycleScope.isOpen(),
		register(registration) {
			registrations.push({ kind: registration.kind, retention: registration.retention });
			return rawLifecycleScope.register(registration);
		},
		createChild: (name) => rawLifecycleScope.createChild(name),
		releaseRetention: (retention) => rawLifecycleScope.releaseRetention(retention),
		dispose: () => rawLifecycleScope.dispose(),
	};
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 64, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: queueScope,
	});
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: lifecycleScope,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	for (let step = 0; step < 20; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	expect(registrations).toHaveLength(24);
	expect(registrations.filter((entry) => entry.retention === "persistent")).toHaveLength(12);
	expect(registrations.filter((entry) => entry.retention === "rebuildable")).toHaveLength(12);
	expect(__inspectVisualResourceScopeForTests(rawLifecycleScope).activeResourceEntryCount).toBe(24);

	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(rawLifecycleScope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	rawLifecycleScope.dispose();
	queueScope.dispose();
});

test("external rebuildable release invalidates a prewarm cache entry before activation", async () => {
	const scope = createVisualResourceScope("stage-prewarm-release-observer");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 64, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 20; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(0.6, 0.016));
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(2);

	scope.releaseRetention("rebuildable");
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(1);
	now = 2.1;
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 8; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	for (let frame = 0; frame < 4; frame += 1) lifecycle.update(makeCtx(2.2 + frame * 0.016, 0.016));
	await lifecycle.whenIdle();
	expect(lifecycle.getCurrentText()).toBe("B");
	expect((lifecycle.group as unknown as {
		children: Array<{ userData?: { lyric?: unknown; state?: string } }>;
	}).children.some((child) => child.userData?.lyric && child.userData.state !== "out")).toBe(true);

	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("balanced prewarm fills the six-row resident window without extra uploads", async () => {
	const scope = createVisualResourceScope("stage-prewarm-window");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 64 * 1024 * 1024, geometryBytes: 16 * 1024 * 1024, meshCount: 512, queuedTaskCost: 128, cacheBytes: 64 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 5.1,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => { uploads.push(1); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines(Array.from({ length: 12 }, (_, index) => ({ t: index, text: `L${index}` })));
	lifecycle.update(makeCtx(5.1, 0.016));
	for (let step = 0; step < 32; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(5.2, 0.016));
	expect(lifecycle.getCurrentText()).toBe("L5");
	expect(uploads).toHaveLength(1);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(6);
	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("balanced resident window evicts old adjacent rows and prewarms the new neighborhood", async () => {
	const scope = createVisualResourceScope("stage-prewarm-window-slide");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 64 * 1024 * 1024, geometryBytes: 16 * 1024 * 1024, meshCount: 512, queuedTaskCost: 128, cacheBytes: 64 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	let now = 2.1;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => { uploads.push(1); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines(Array.from({ length: 12 }, (_, index) => ({ t: index, text: `L${index}` })));

	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 32; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(2.2, 0.016));
	expect(lifecycle.getCurrentText()).toBe("L2");
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(6);

	// 跳到新窗口后，旧 adjacent 必须允许 LRU 驱逐，当前行与新邻接行才能进入 resident pool。
	now = 8.1;
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 40; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	for (let frame = 0; frame < 8; frame += 1) {
		lifecycle.update(makeCtx(8.2 + frame * 0.016, 0.016));
	}
	expect(lifecycle.getCurrentText()).toBe("L8");
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(6);

	// L9 已由新窗口预热；激活时无需再运行 raster queue，只进入 upload gate。
	const uploadsBeforeActivation = uploads.length;
	now = 9.1;
	lifecycle.update(makeCtx(now, 0.016));
	expect(lifecycle.getCurrentText()).toBe("L9");
	expect(uploads).toHaveLength(uploadsBeforeActivation + 1);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBeLessThanOrEqual(6);
	expect(uploads.length).toBeGreaterThanOrEqual(3);

	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("setLyricLines cancels an awaiting current lyric before late Three allocation", async () => {
	const scope = createVisualResourceScope("stage-current-build-cancel");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 64, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const tracked = await makeDisposalTrackedThree();
	let resolveBuild!: (three: ThreeModule) => void;
	const pendingBuild = new Promise<ThreeModule>((resolve) => {
		resolveBuild = resolve;
	});
	let factoryCalls = 0;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: () => {
			factoryCalls += 1;
			return factoryCalls === 1 ? tracked.three : pendingBuild;
		},
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	tracked.resetDisposeCalls();
	lifecycle.setLyricLines([{ t: 0, text: "A" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	expect(queue.runSlice(1)).toBe(1);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(queue.runSlice(1)).toBe(1);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(factoryCalls).toBe(2);

	lifecycle.setLyricLines([{ t: 0, text: "B" }]);
	resolveBuild(tracked.three);
	await lifecycle.whenIdle();
	const snapshot = diagnostics.snapshot()["stage-lyrics"];
	expect(snapshot?.pendingBuilds).toBe(0);
	expect(snapshot?.pendingUploads).toBe(0);
	expect(snapshot?.residentRows).toBe(0);
	expect(snapshot?.clarityBytes).toBe(0);
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	// generation 已失效时，factory 返回后立即在 builder gate 退出，不再创建需要释放的 Three 资源。
	expect(tracked.getDisposeCalls()).toBe(0);

	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("dispose cancels an awaiting prewarm before late Three allocation", async () => {
	const scope = createVisualResourceScope("stage-prewarm-build-cancel");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 64, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const tracked = await makeDisposalTrackedThree();
	let resolvePrewarm!: (three: ThreeModule) => void;
	const pendingPrewarm = new Promise<ThreeModule>((resolve) => {
		resolvePrewarm = resolve;
	});
	let factoryCalls = 0;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: () => {
			factoryCalls += 1;
			return factoryCalls <= 2 ? tracked.three : pendingPrewarm;
		},
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "A" }, { t: 2, text: "B" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	for (let phase = 0; phase < 4; phase += 1) {
		expect(queue.runSlice(1)).toBe(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	expect(factoryCalls).toBe(3);

	lifecycle.dispose();
	const disposeCallsAtCancellation = tracked.getDisposeCalls();
	resolvePrewarm(tracked.three);
	await lifecycle.whenIdle();
	expect(tracked.getDisposeCalls()).toBe(disposeCallsAtCancellation);
	expect(queue.getSnapshot().queued).toBe(0);
	expect(queue.getSnapshot().running).toBe(0);
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	expect(diagnostics.snapshot()["stage-lyrics"]).toBeUndefined();

	queue.dispose();
	scope.dispose();
});

test("clarity tier one bypasses the pool while keeping renderer upload behavior", async () => {
	const scope = createVisualResourceScope("stage-tier-one");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 16 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 128, queuedTaskCost: 16, cacheBytes: 16 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 1 }),
		textureUploadExecutor: () => { uploads.push(1); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "Tier one" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	for (let step = 0; step < 6; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(0.6, 0.016));
	expect(findLyricChild(lifecycle.group as never)).toBeDefined();
	expect(uploads).toHaveLength(1);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(0);
	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("runtime clarity downgrade to tier one preserves the visible lyric and keeps renderer uploads working", async () => {
	const scope = createVisualResourceScope("stage-runtime-tier-one");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 64 * 1024 * 1024, geometryBytes: 16 * 1024 * 1024, meshCount: 512, queuedTaskCost: 128, cacheBytes: 64 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	let textureClarity: 1 | 2 = 2;
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity }),
		textureUploadExecutor: () => { uploads.push(1); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines(Array.from({ length: 8 }, (_, index) => ({ t: index * 2, text: `L${index}` })));
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 32; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(0.6, 0.016));
	const visibleBeforeDowngrade = findLyricChild(lifecycle.group as never);
	expect(visibleBeforeDowngrade).toBeDefined();
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(6);
	expect(uploads).toHaveLength(1);

	textureClarity = 1;
	lifecycle.update(makeCtx(0.7, 0.016));
	expect(findLyricChild(lifecycle.group as never)).toBe(visibleBeforeDowngrade);
	for (let step = 0; step < 16; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	for (let frame = 0; frame < 4; frame += 1) {
		lifecycle.update(makeCtx(0.72 + frame * 0.016, 0.016));
	}
	await lifecycle.whenIdle();
	const downgraded = diagnostics.snapshot()["stage-lyrics"];
	expect(findLyricChild(lifecycle.group as never)).not.toBe(visibleBeforeDowngrade);
	expect(uploads).toHaveLength(2);
	expect(downgraded?.clarityTier).toBe(1);
	expect(downgraded?.clarityAdmissionEnabled).toBe(false);
	expect(downgraded?.clarityBudgetBytes).toBe(0);
	expect(downgraded?.residentRows).toBe(0);
	expect(downgraded?.pendingBuilds).toBe(0);

	now = 2.1;
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 8; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(2.2, 0.016));
	expect(lifecycle.getCurrentText()).toBe("L1");
	expect(uploads).toHaveLength(3);
	for (let frame = 0; frame < 40; frame += 1) {
		lifecycle.update(makeCtx(2.3 + frame * 0.016, 0.016));
	}
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(0);

	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("runtime clarity upgrade from tier one admits the visible current and prewarms the balanced window", async () => {
	const scope = createVisualResourceScope("stage-runtime-tier-two");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 64 * 1024 * 1024, geometryBytes: 16 * 1024 * 1024, meshCount: 512, queuedTaskCost: 128, cacheBytes: 64 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	let textureClarity: 1 | 2 = 1;
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity }),
		textureUploadExecutor: () => { uploads.push(1); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines(Array.from({ length: 8 }, (_, index) => ({ t: index * 2, text: `L${index}` })));
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 8; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(0.6, 0.016));
	const visibleBeforeUpgrade = findLyricChild(lifecycle.group as never);
	expect(visibleBeforeUpgrade).toBeDefined();
	expect(uploads).toHaveLength(1);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(0);

	textureClarity = 2;
	lifecycle.update(makeCtx(0.7, 0.016));
	expect(findLyricChild(lifecycle.group as never)).toBe(visibleBeforeUpgrade);
	for (let step = 0; step < 32; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	for (let frame = 0; frame < 4; frame += 1) {
		lifecycle.update(makeCtx(0.72 + frame * 0.016, 0.016));
	}
	await lifecycle.whenIdle();
	const upgraded = diagnostics.snapshot()["stage-lyrics"];
	expect(findLyricChild(lifecycle.group as never)).not.toBe(visibleBeforeUpgrade);
	expect(uploads).toHaveLength(2);
	expect(upgraded?.clarityTier).toBe(2);
	expect(upgraded?.clarityAdmissionEnabled).toBe(true);
	expect(upgraded?.clarityResidentLimit).toBe(6);
	expect(upgraded?.residentRows).toBe(6);

	now = 2.1;
	lifecycle.update(makeCtx(now, 0.016));
	expect(lifecycle.getCurrentText()).toBe("L1");
	expect(uploads).toHaveLength(3);

	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("runtime performance quality reconfigures the resident window from balanced to low and high", async () => {
	const scope = createVisualResourceScope("stage-runtime-quality");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 96 * 1024 * 1024, geometryBytes: 24 * 1024 * 1024, meshCount: 768, queuedTaskCost: 192, cacheBytes: 96 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	let quality: "low" | "balanced" | "high" = "balanced";
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 10.1,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => quality,
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => { uploads.push(1); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines(Array.from({ length: 16 }, (_, index) => ({ t: index * 2, text: `L${index}` })));
	lifecycle.update(makeCtx(10.1, 0.016));
	for (let step = 0; step < 32; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(10.2, 0.016));
	const visible = findLyricChild(lifecycle.group as never);
	const balanced = diagnostics.snapshot()["stage-lyrics"];
	expect(balanced?.clarityQuality).toBe("balanced");
	expect(balanced?.clarityResidentLimit).toBe(6);
	expect(balanced?.residentRows).toBe(6);

	quality = "low";
	lifecycle.update(makeCtx(10.3, 0.016));
	expect(findLyricChild(lifecycle.group as never)).toBe(visible);
	for (let step = 0; step < 24; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	const low = diagnostics.snapshot()["stage-lyrics"];
	expect(low?.clarityQuality).toBe("low");
	expect(low?.clarityResidentLimit).toBe(4);
	expect(low?.residentRows).toBe(4);
	expect(uploads).toHaveLength(1);

	quality = "high";
	lifecycle.update(makeCtx(10.4, 0.016));
	expect(findLyricChild(lifecycle.group as never)).toBe(visible);
	for (let step = 0; step < 48; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	const high = diagnostics.snapshot()["stage-lyrics"];
	expect(high?.clarityQuality).toBe("high");
	expect(high?.clarityResidentLimit).toBe(8);
	expect(high?.residentRows).toBe(8);
	expect(uploads).toHaveLength(1);

	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("runtime quality change cancels an awaiting old prewarm generation before the new window commits", async () => {
	const scope = createVisualResourceScope("stage-runtime-quality-generation");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 64 * 1024 * 1024, geometryBytes: 16 * 1024 * 1024, meshCount: 512, queuedTaskCost: 128, cacheBytes: 64 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const baseThree = await makeFakeThree()();
	const oldGenerationThree = await makeDisposalTrackedThree();
	let resolveOldPrewarm!: (three: ThreeModule) => void;
	const pendingOldPrewarm = new Promise<ThreeModule>((resolve) => {
		resolveOldPrewarm = resolve;
	});
	let factoryCalls = 0;
	let quality: "low" | "balanced" = "balanced";
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: () => {
			factoryCalls += 1;
			if (factoryCalls <= 2) return baseThree;
			if (factoryCalls === 3) return pendingOldPrewarm;
			return baseThree;
		},
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 10.1,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => quality,
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines(Array.from({ length: 12 }, (_, index) => ({ t: index * 2, text: `L${index}` })));
	lifecycle.update(makeCtx(10.1, 0.016));
	for (let phase = 0; phase < 2; phase += 1) {
		expect(queue.runSlice(1)).toBe(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(10.2, 0.016));
	const visible = findLyricChild(lifecycle.group as never);
	expect(visible).toBeDefined();
	for (let phase = 0; phase < 12 && factoryCalls < 3; phase += 1) {
		expect(queue.runSlice(1)).toBe(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	expect(factoryCalls).toBe(3);

	quality = "low";
	lifecycle.update(makeCtx(10.3, 0.016));
	expect(findLyricChild(lifecycle.group as never)).toBe(visible);
	resolveOldPrewarm(oldGenerationThree.three);
	for (let step = 0; step < 32; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	for (let frame = 0; frame < 4; frame += 1) {
		lifecycle.update(makeCtx(10.4 + frame * 0.016, 0.016));
	}
	await lifecycle.whenIdle();
	expect(oldGenerationThree.getDisposeCalls()).toBe(0);
	const settled = diagnostics.snapshot()["stage-lyrics"];
	expect(settled?.clarityQuality).toBe("low");
	expect(settled?.clarityResidentLimit).toBe(4);
	// 当前 replacement 尚在原子接管窗口内时，旧行和新行会短暂共占预算；
	// 因此只要求最新 low-quality 窗口已收敛且不越过四行上限。
	expect(settled?.residentRows).toBeGreaterThanOrEqual(3);
	expect(settled?.residentRows).toBeLessThanOrEqual(4);
	expect(settled?.pendingBuilds).toBe(0);
	expect(settled?.pendingUploads).toBe(0);

	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("runtime clarity reconfigure keeps current and outgoing GPU resources alive while the new window prewarms", async () => {
	const scope = createVisualResourceScope("stage-runtime-visible-retention");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 64 * 1024 * 1024, geometryBytes: 16 * 1024 * 1024, meshCount: 512, queuedTaskCost: 128, cacheBytes: 64 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	let quality: "low" | "balanced" = "balanced";
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => quality,
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines(Array.from({ length: 8 }, (_, index) => ({ t: index * 2, text: `L${index}` })));
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 32; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(0.6, 0.016));

	now = 2.1;
	lifecycle.update(makeCtx(now, 0.016));
	const group = lifecycle.group as unknown as {
		children: Array<{
			userData?: {
				lyric?: { textMat?: { disposed?: boolean } };
				state?: string;
			};
		}>;
	};
	const current = group.children.find((child) => child.userData?.lyric && child.userData.state !== "out");
	const outgoing = group.children.find((child) => child.userData?.state === "out");
	expect(current).toBeDefined();
	expect(outgoing).toBeDefined();
	expect(outgoing?.userData?.lyric?.textMat?.disposed).toBe(false);

	quality = "low";
	lifecycle.update(makeCtx(2.12, 0.016));
	for (let step = 0; step < 24; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	expect(group.children).toContain(current);
	expect(group.children).toContain(outgoing);
	expect(outgoing?.userData?.lyric?.textMat?.disposed).toBe(false);
	const reconfigured = diagnostics.snapshot()["stage-lyrics"];
	expect(reconfigured?.clarityQuality).toBe("low");
	expect(reconfigured?.clarityResidentLimit).toBe(4);
	expect(reconfigured?.residentRows).toBe(4);

	lifecycle.dispose();
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
	queue.dispose();
	scope.dispose();
});

test("unmount resets takeover ownership so a remount adopts only the rebuilt current", async () => {
	const scope = createVisualResourceScope("stage-remount");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 32, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const scene = makeFakeScene();
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		gsapProvider: () => makeFakeGsap([]),
		customEaseProvider: async () => null,
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	lifecycle.setLyricLines([{ t: 0, text: "Remount" }]);
	const buildCurrent = async (time: number) => {
		lifecycle.update(makeCtx(time, 0.016));
		for (let step = 0; step < 6; step += 1) {
			queue.runSlice(1);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		lifecycle.update(makeCtx(time + 0.1, 0.016));
	};

	await lifecycle.mount(scene as never);
	await buildCurrent(0.5);
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(1);
	lifecycle.unmount();
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(0);
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);

	await lifecycle.mount(scene as never);
	await buildCurrent(1);
	expect(findLyricChild(lifecycle.group as never)).toBeDefined();
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(1);
	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("lifecycle rasterizes display context and translation as independent structured rows", async () => {
	const scene = makeFakeScene();
	const lines = [
		{ t: 0, text: "上一句", translation: "Previous line" },
		{ t: 1, text: "当前句", translation: "Current line" },
		{ t: 2, text: "下一句", translation: "Next line" },
	];
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		currentTimeSupplier: () => 1.2,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 30,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		stageLyricsSettingsSupplier: () => ({
			displayMode: "triple",
			translationMode: "multi",
			contextSpread: 1.4,
			edgeFade: 0.5,
		}),
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines(lines);
	lifecycle.update(makeCtx(1.2, 0.016, undefined, 3.25));
	await lifecycle.whenIdle();

	const current = findLyricChild(lifecycle.group as never) as {
		userData?: {
			lyric?: {
				mask?: {
					rasterRows?: ReadonlyArray<{ text: string; active: boolean; translationLine: boolean }>;
				};
			};
		};
	} | undefined;
	const rows = current?.userData?.lyric?.mask?.rasterRows ?? [];
	expect(rows.length).toBeGreaterThan(1);
	expect(rows.map((row) => row.text)).toContain("上一句");
	expect(rows.map((row) => row.text)).toContain("当前句");
	expect(rows.map((row) => row.text)).toContain("Current line");
	expect(rows.map((row) => row.text)).toContain("下一句");
	expect(rows.find((row) => row.active)?.text).toBe("当前句");
	expect(rows.find((row) => row.text === "Current line")?.translationLine).toBe(true);

	lifecycle.dispose();
});

test("lifecycle drives Stage motion time and glitch uniforms from the render loop", async () => {
	const scene = makeFakeScene();
	const lifecycle = createStageLyricsLifecycle({
		scene: scene as never,
		threeFactory: makeFakeThree(),
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 30,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		stageLyricsSettingsSupplier: () => ({
			motionStyle: "glitch",
			glitchCameraBind: false,
			glitchIntensity: 1.25,
			glitchSlice: 1.1,
			glitchChroma: 1.4,
			glitchRate: 1.8,
			glitchJitter: 1.2,
		}),
		rand: () => 0.35,
	});
	await lifecycle.mount(scene as never);
	lifecycle.setLyricLines([{ t: 0, text: "glitch line" }]);
	lifecycle.update(makeCtx(0.5, 0.016, { beatPulse: 0.9 }, 2.5));
	await lifecycle.whenIdle();
	lifecycle.update(makeCtx(3, 0.1, { beatPulse: 1.1 }, 7.75));

	const current = findLyricChild(lifecycle.group as never) as {
		userData?: {
			lyric?: {
				textMat?: {
					uniforms?: Record<string, { value: number }>;
				};
			};
		};
	} | undefined;
	const uniforms = current?.userData?.lyric?.textMat?.uniforms ?? {};
	expect(uniforms.uTime?.value).toBe(7.75);
	expect(uniforms.uGlitch?.value).toBe(1.25);
	expect(uniforms.uGlitchSlice?.value).toBe(1.1);
	expect(uniforms.uGlitchChroma?.value).toBe(1.4);
	expect(uniforms.uGlitchRate?.value).toBe(1.8);
	expect(uniforms.uGlitchBurst?.value ?? 0).toBeGreaterThan(0);
	expect(Number.isFinite(uniforms.uGlitchSeed?.value)).toBe(true);

	lifecycle.dispose();
});

test("runtime clarity change cancels an awaiting current generation and rebuilds the same line", async () => {
	const scope = createVisualResourceScope("stage-current-clarity-generation");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 32, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const baseThree = await makeFakeThree()();
	const staleThree = await makeDisposalTrackedThree();
	let resolveStaleBuild!: (three: ThreeModule) => void;
	const pendingStaleBuild = new Promise<ThreeModule>((resolve) => {
		resolveStaleBuild = resolve;
	});
	let factoryCalls = 0;
	let textureClarity: 1 | 2 = 2;
	const uploads: unknown[] = [];
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: () => {
			factoryCalls += 1;
			if (factoryCalls === 1) return baseThree;
			if (factoryCalls === 2) return pendingStaleBuild;
			return baseThree;
		},
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity }),
		textureUploadExecutor: (texture: unknown) => { uploads.push(texture); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "Current generation" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	expect(queue.runSlice(1)).toBe(1);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(queue.runSlice(1)).toBe(1);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(factoryCalls).toBe(2);

	textureClarity = 1;
	lifecycle.update(makeCtx(0.6, 0.016));
	resolveStaleBuild(staleThree.three);
	for (let step = 0; step < 12; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	for (let frame = 0; frame < 4; frame += 1) {
		lifecycle.update(makeCtx(0.7 + frame * 0.016, 0.016));
	}
	await lifecycle.whenIdle();

	expect(staleThree.getDisposeCalls()).toBe(0);
	expect(factoryCalls).toBeGreaterThanOrEqual(3);
	expect(findLyricChild(lifecycle.group as never)).toBeDefined();
	expect(uploads).toHaveLength(1);
	const settled = diagnostics.snapshot()["stage-lyrics"];
	expect(settled?.clarityTier).toBe(1);
	expect(settled?.activeBuilds).toBe(0);
	expect(settled?.pendingBuilds).toBe(0);
	expect(settled?.pendingUploads).toBe(0);

	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("seek cancels the previous resident-window prewarm before the latest window commits", async () => {
	const scope = createVisualResourceScope("stage-seek-prewarm-generation");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 64 * 1024 * 1024, geometryBytes: 16 * 1024 * 1024, meshCount: 512, queuedTaskCost: 128, cacheBytes: 64 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const baseThree = await makeFakeThree()();
	const stalePrewarmThree = await makeDisposalTrackedThree();
	let resolveStalePrewarm!: (three: ThreeModule) => void;
	const pendingStalePrewarm = new Promise<ThreeModule>((resolve) => {
		resolveStalePrewarm = resolve;
	});
	let factoryCalls = 0;
	let now = 0.5;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: () => {
			factoryCalls += 1;
			if (factoryCalls <= 2) return baseThree;
			if (factoryCalls === 3) return pendingStalePrewarm;
			return baseThree;
		},
		currentTimeSupplier: () => now,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines(Array.from({ length: 16 }, (_, index) => ({ t: index * 2, text: `L${index}` })));
	lifecycle.update(makeCtx(now, 0.016));
	for (let step = 0; step < 2; step += 1) {
		expect(queue.runSlice(1)).toBe(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	lifecycle.update(makeCtx(0.6, 0.016));
	for (let step = 0; step < 16 && factoryCalls < 3; step += 1) {
		expect(queue.runSlice(1)).toBe(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	expect(factoryCalls).toBe(3);

	now = 20.1;
	lifecycle.update(makeCtx(now, 0.016));
	resolveStalePrewarm(stalePrewarmThree.three);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(stalePrewarmThree.getDisposeCalls()).toBe(0);

	for (let step = 0; step < 48; step += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	for (let frame = 0; frame < 4; frame += 1) {
		lifecycle.update(makeCtx(now + 0.1 + frame * 0.016, 0.016));
	}
	await lifecycle.whenIdle();
	expect(lifecycle.getCurrentText()).toBe("L10");
	const settled = diagnostics.snapshot()["stage-lyrics"];
	expect(settled?.residentRows).toBe(6);
	expect(settled?.pendingBuilds).toBe(0);

	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("whenIdle waits for renderer uploads and atomic takeover without deadlocking", async () => {
	const scope = createVisualResourceScope("stage-complete-idle");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 32, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploads: unknown[] = [];
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: (texture: unknown) => { uploads.push(texture); },
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "Complete idle" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	for (let phase = 0; phase < 2; phase += 1) {
		expect(queue.runSlice(1)).toBe(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	expect(diagnostics.snapshot()["stage-lyrics"]?.pendingUploads).toBeGreaterThan(0);

	let idleResolved = false;
	const idle = lifecycle.whenIdle().then(() => {
		idleResolved = true;
	});
	await Promise.resolve();
	expect(idleResolved).toBe(false);

	for (let frame = 0; frame < 8 && !idleResolved; frame += 1) {
		lifecycle.update(makeCtx(0.6 + frame * 0.016, 0.016));
		await Promise.resolve();
	}
	await Promise.race([
		idle,
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Stage lyrics whenIdle deadlocked.")), 250)),
	]);
	expect(idleResolved).toBe(true);
	expect(uploads.length).toBeGreaterThan(0);
	expect(findLyricChild(lifecycle.group as never)).toBeDefined();
	expect(diagnostics.snapshot()["stage-lyrics"]?.pendingUploads).toBe(0);

	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("whenIdle does not resolve after cooperative rasterization while the current upload is still pending", async () => {
	const scope = createVisualResourceScope("stage-idle-pending-upload");
	const queue = createBudgetTaskQueue({
		ledger: createVisualResourceLedger({
			budget: { textureBytes: 32 * 1024 * 1024, geometryBytes: 8 * 1024 * 1024, meshCount: 256, queuedTaskCost: 32, cacheBytes: 32 * 1024 * 1024 },
		}),
		resourceScope: scope,
	});
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: makeFakeThree(),
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		taskQueue: queue,
		resourceScope: scope,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: () => {},
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	lifecycle.setLyricLines([{ t: 0, text: "Pending upload" }]);
	lifecycle.update(makeCtx(0.5, 0.016));
	for (let phase = 0; phase < 3; phase += 1) {
		queue.runSlice(1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	let idleResolved = false;
	const idle = lifecycle.whenIdle().then(() => {
		idleResolved = true;
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(idleResolved).toBe(false);

	lifecycle.update(makeCtx(0.6, 0.016));
	await idle;
	expect(findLyricChild(lifecycle.group as never)).toBeDefined();

	lifecycle.dispose();
	queue.dispose();
	scope.dispose();
});

test("production lifecycle denies the current lyric before Canvas and Three allocation", async () => {
	const rawScope = createVisualResourceScope("stage-production-admission");
	let denyAdmission = false;
	let admissionAttempts = 0;
	const resourceScope: VisualResourceScope = {
		get name() { return rawScope.name; },
		get closed() { return rawScope.closed; },
		isOpen: () => rawScope.isOpen(),
		register(registration: VisualResourceRegistration) {
			admissionAttempts += 1;
			if (denyAdmission) {
				const error = new Error("Stage lyric resource admission denied by test budget.");
				error.name = "VisualResourceBudgetAdmissionError";
				throw error;
			}
			return rawScope.register(registration);
		},
		createChild: (name) => rawScope.createChild(name),
		releaseRetention: (retention) => rawScope.releaseRetention(retention),
		dispose: () => rawScope.dispose(),
	};
	const constructorCalls: ThreeConstructorCalls = {
		group: 0,
		geometry: 0,
		material: 0,
		points: 0,
	};
	const threeFactory = makeFakeThree(constructorCalls);
	let factoryCalls = 0;
	const lifecycle = createStageLyricsLifecycle({
		threeFactory: async () => {
			factoryCalls += 1;
			return await threeFactory();
		},
		currentTimeSupplier: () => 0.5,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		dotTexture: makeFakeDotTexture(),
		resourceScope,
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
	} as never);
	await lifecycle.mount(makeFakeScene() as never);
	factoryCalls = 0;
	constructorCalls.group = 0;
	constructorCalls.geometry = 0;
	constructorCalls.material = 0;
	constructorCalls.points = 0;
	admissionAttempts = 0;
	denyAdmission = true;
	let canvasCreations = 0;
	const originalCreateElement = document.createElement.bind(document);
	Object.defineProperty(document, "createElement", {
		configurable: true,
		value: (tagName: string, options?: ElementCreationOptions) => {
			if (tagName.toLowerCase() === "canvas") canvasCreations += 1;
			return originalCreateElement(tagName, options);
		},
	});

	try {
		lifecycle.setLyricLines([{ t: 0, text: "Budget denied" }]);
		lifecycle.update(makeCtx(0.5, 0.016));
		await lifecycle.whenIdle();
	} finally {
		Object.defineProperty(document, "createElement", {
			configurable: true,
			value: originalCreateElement,
		});
	}

	expect(admissionAttempts).toBe(1);
	expect(factoryCalls).toBe(0);
	expect(canvasCreations).toBe(0);
	expect(constructorCalls).toEqual({ group: 0, geometry: 0, material: 0, points: 0 });
	expect(findLyricChild(lifecycle.group as never)).toBeUndefined();
	expect(__inspectVisualResourceScopeForTests(rawScope).activeResourceEntryCount).toBe(0);

	lifecycle.dispose();
	rawScope.dispose();
});

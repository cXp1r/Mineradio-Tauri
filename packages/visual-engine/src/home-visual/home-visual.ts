import type * as THREE from "three";
import type { FrameContext } from "../runtime/frame-context";
import type { ThreeFactory } from "../runtime/renderer-setup";
import type { FxState } from "./fx-defaults";
import { cloneFxState } from "./fx-defaults";
import { applyPreset, SKULL_PRESET_INDEX, type PresetOpts } from "./preset-state";
import { syncFxUniforms, type UniformContainer } from "./sync-uniforms";
import {
	createHomeParticleField,
	type HomeParticleField,
	type HomeParticleFieldOptions,
} from "./home-particle-field";
import {
	createHomeCoverTextureController,
	type HomeAiDepthEstimator,
	type HomeAiDepthMerger,
	type HomeCoverCanvasFactory,
	type HomeCoverImage,
	type HomeCoverLoader,
	type HomeCoverTextureController,
	type HomeCoverRuntimeOptions,
} from "./cover-texture";
import { createHomeRipples, type HomeRipples } from "./ripples";
import { deriveLyricPaletteFromCover, type CoverCanvasLike } from "./cover-colors";
import type { LyricPalette } from "../stage-lyrics/palette";
import type { SkullMouthTransform } from "../stage-lyrics/lifecycle";
import { createBackCoverLayer, type BackCoverLayer } from "./back-cover-layer";
import { createSkullParticleController, type SkullParticleController } from "./skull-particles";

export interface HomeVisualOptions {
	scene: THREE.Scene;
	threeFactory?: ThreeFactory;
	coverResolution?: number;
	fx?: FxState;
	loadCoverImage?: HomeCoverLoader;
	createCoverCanvas?: HomeCoverCanvasFactory;
	buildCoverEdgeDepth?: (image: HomeCoverImage) => HomeCoverImage | null;
	estimateAiDepth?: HomeAiDepthEstimator;
	mergeAiDepth?: HomeAiDepthMerger;
	onCoverLyricPalette?: (palette: LyricPalette) => void;
	backCoverRandom?: () => number;
	skullAssetData?: Float32Array | null;
	loadSkullAsset?: () => Promise<Float32Array | null>;
	orbitCenterLockedSupplier?: () => boolean;
	runtime?: HomeCoverRuntimeOptions;
}

export interface HomeVisual {
	update(ctx: FrameContext): void;
	updateCore(ctx: FrameContext): void;
	updateRipples(dtSeconds: number): void;
	dispose(): void;
	getPreset(): number;
	setPreset(p: number, opts?: PresetOpts): void;
	getFx(): FxState;
	getField(): HomeParticleField;
	setCoverUrl(url: string | null | undefined): void;
	getCoverController(): HomeCoverTextureController;
	getRipples(): HomeRipples;
	getSkullParticles(): THREE.Points | null;
	getSkullMouthTransform(): SkullMouthTransform | null;
	getSkullBeatFlash(): number;
	setSkullShelfCompositionActive(active: boolean): void;
	setWallpaperShelfDimActive(active: boolean): void;
	setRuntimeActive(active: boolean): void;
	applySkullWheel(deltaY: number): boolean;
	getSkullWheelZoom(): number;
	applyPointerSpinDrag(dx: number, dy: number, dtSeconds: number): void;
	resetParticleRotation(syncVisual?: boolean): void;
	whenIdle(): Promise<void>;
}

let skullAssetCache: Float32Array | null | undefined;

const PARTICLE_POINTER_SPIN_X = 0.0032;
const PARTICLE_POINTER_SPIN_Y = 0.0034;
const PARTICLE_SPIN_MAX = 6.2;

function clampParticleSpinVelocity(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return Math.max(-PARTICLE_SPIN_MAX, Math.min(PARTICLE_SPIN_MAX, v));
}

function clampRange(v: number, lo: number, hi: number): number {
	if (!Number.isFinite(v)) return lo;
	return Math.max(lo, Math.min(hi, v));
}

async function defaultLoadSkullAssetData(): Promise<Float32Array | null> {
	if (skullAssetCache !== undefined) return skullAssetCache;
	if (
		typeof window === "undefined" ||
		typeof fetch !== "function" ||
		!window.location ||
		window.location.href.startsWith("about:")
	) {
		skullAssetCache = null;
		return skullAssetCache;
	}
	try {
		const url = new URL("assets/skull-decimation-points.bin?v=regular-surface-teeth-soften-20260621", window.location.href);
		const res = await fetch(url, { cache: "reload" });
		if (!res.ok) throw new Error("skull asset unavailable");
		const buf = await res.arrayBuffer();
		skullAssetCache = buf.byteLength >= 20 && buf.byteLength % 20 === 0 ? new Float32Array(buf) : null;
		return skullAssetCache;
	} catch {
		skullAssetCache = null;
		return skullAssetCache;
	}
}

export async function createHomeVisual(opts: HomeVisualOptions): Promise<HomeVisual> {
	const fx: FxState = opts.fx ?? cloneFxState();
	const fieldOpts: HomeParticleFieldOptions = {
		threeFactory: opts.threeFactory,
		coverResolution: opts.coverResolution ?? fx.coverResolution,
	};
	const field = await createHomeParticleField(opts.scene, fieldOpts);
	const skullAssetData = opts.skullAssetData !== undefined
		? opts.skullAssetData
		: await (opts.loadSkullAsset ?? defaultLoadSkullAssetData)();
	const particleSpin = { vx: 0, vy: 0, damping: 0.90 };
	const gestureRotation = { x: 0, y: 0 };
	let skullWheelZoom = 0;
	let skullWheelZoomTarget = 0;
	let latestHeadParallax = { active: false, x: 0, y: 0 };
	const skullParticles: SkullParticleController = await createSkullParticleController({
		scene: opts.scene,
		threeFactory: opts.threeFactory,
		uniforms: field.materialUniforms,
		assetData: skullAssetData,
		wheelZoomSupplier: () => skullWheelZoom,
		headParallaxSupplier: () => latestHeadParallax,
		gestureRotationSupplier: () => gestureRotation,
		orbitCenterLockedSupplier: opts.orbitCenterLockedSupplier,
	});
	const coverController = createHomeCoverTextureController({
		uniforms: field.materialUniforms as never,
		loadImage: opts.loadCoverImage,
		coverResolution: fieldOpts.coverResolution,
		createCanvas: opts.createCoverCanvas,
		buildEdgeDepth: opts.buildCoverEdgeDepth,
		aiDepthEnabled: fx.aiDepth,
		estimateAiDepth: opts.estimateAiDepth,
		mergeAiDepth: opts.mergeAiDepth,
		runtime: opts.runtime,
		onCoverPrepared(image) {
			latestPreparedCover = image;
			backCoverLayer?.refreshColorsFromCover(image as CoverCanvasLike);
			if (!opts.onCoverLyricPalette) return;
			const palette = deriveLyricPaletteFromCover(image as CoverCanvasLike);
			if (!palette) return;
			opts.onCoverLyricPalette({
				primary: palette.primary,
				secondary: palette.secondary,
				highlight: palette.highlight,
				glowColor: palette.glow,
			});
		},
	});
	const ripples = createHomeRipples(field.materialUniforms as never);
	let wallpaperShelfDimActive = false;
	let backCoverLayer: BackCoverLayer | null = null;
	let backCoverPending: Promise<void> | null = null;
	let latestPreparedCover: HomeCoverImage | null = null;
	let runtimeActive = true;
	let disposed = false;
	let backCoverGeneration = 0;
	let runtimeWakePending = false;
	field.applyFxState(fx);
	field.bloomPoints.visible = !!(fx.bloom && fx.bloomStrength > 0.01) && fx.preset !== SKULL_PRESET_INDEX;
	field.points.visible = fx.preset !== SKULL_PRESET_INDEX;

	function syncBackCoverLayer(): void {
		if (!runtimeActive || disposed) return;
		if (fx.backCover) {
			if (!backCoverLayer && !backCoverPending) {
				const generation = ++backCoverGeneration;
				const pending = createBackCoverLayer({
					scene: opts.scene,
					threeFactory: opts.threeFactory,
					uniforms: field.materialUniforms as never,
					random: opts.backCoverRandom,
				}).then((layer) => {
					if (disposed || !runtimeActive || generation !== backCoverGeneration || !fx.backCover) {
						layer.dispose();
						return;
					}
					backCoverLayer = layer;
					if (latestPreparedCover) layer.refreshColorsFromCover(latestPreparedCover as CoverCanvasLike);
				}).catch(() => {
					// 后景层是可重建增强；失败后清空 pending，下一帧允许重试。
				}).finally(() => {
					if (backCoverPending === pending) backCoverPending = null;
				});
				backCoverPending = pending;
			}
			return;
		}
		if (backCoverLayer) {
			backCoverLayer.dispose();
			backCoverLayer = null;
		}
	}

	function rebaseParticleRotationAxis(axis: "x" | "y"): void {
		const limit = Math.PI * 10;
		if (Math.abs(gestureRotation[axis]) < limit) return;
		const offset = Math.round(gestureRotation[axis] / (Math.PI * 2)) * Math.PI * 2;
		gestureRotation[axis] -= offset;
		field.points.rotation[axis] -= offset;
		field.bloomPoints.rotation[axis] -= offset;
		backCoverLayer?.getPoints().rotation && (backCoverLayer.getPoints().rotation[axis] -= offset);
		const skull = skullParticles.getObject();
		if (skull) skull.rotation[axis] -= offset;
	}

	function copyRotation(target: { x: number; y: number; z: number; copy?: (...args: any[]) => unknown }, source: { x: number; y: number; z: number }): void {
		if (typeof target.copy === "function") {
			target.copy(source);
			return;
		}
		target.x = source.x;
		target.y = source.y;
		target.z = source.z;
	}

	function setRotation(target: { x: number; y: number; z: number; set?: (x: number, y: number, z: number) => unknown }, x: number, y: number, z: number): void {
		if (typeof target.set === "function") {
			target.set(x, y, z);
			return;
		}
		target.x = x;
		target.y = y;
		target.z = z;
	}

	function tickPointerRotation(dtSeconds: number): void {
		const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(0.08, dtSeconds)) : 1 / 60;
		if (Math.abs(particleSpin.vx) > 0.0001 || Math.abs(particleSpin.vy) > 0.0001) {
			gestureRotation.x += particleSpin.vx * dt;
			gestureRotation.y += particleSpin.vy * dt;
			rebaseParticleRotationAxis("x");
			rebaseParticleRotationAxis("y");
		}
		particleSpin.vx *= Math.pow(particleSpin.damping, dt * 60);
		particleSpin.vy *= Math.pow(particleSpin.damping, dt * 60);
		if (Math.abs(particleSpin.vx) < 0.01) particleSpin.vx = 0;
		if (Math.abs(particleSpin.vy) < 0.01) particleSpin.vy = 0;

		field.points.rotation.y += (gestureRotation.y - field.points.rotation.y) * 0.055;
		field.points.rotation.x += (gestureRotation.x - field.points.rotation.x) * 0.055;
		copyRotation(field.bloomPoints.rotation, field.points.rotation);
		const backCoverPoints = backCoverLayer?.getPoints();
		if (backCoverPoints) copyRotation(backCoverPoints.rotation, field.points.rotation);
	}

	function stepBody(ctx: FrameContext): void {
		if (runtimeWakePending) {
			runtimeWakePending = false;
			const coverUrl = coverController.getCurrentUrl();
			if (coverUrl) coverController.setCoverUrl(coverUrl);
		}
		field.applyFxState(fx);
		coverController.setAiDepthEnabled(fx.aiDepth);
		field.points.visible = fx.preset !== SKULL_PRESET_INDEX;
		const bloomAllowed = !!(fx.bloom && fx.bloomStrength > 0.01) && fx.preset !== SKULL_PRESET_INDEX;
		field.bloomPoints.visible = bloomAllowed;
		syncBackCoverLayer();

		syncFxUniforms(fx, ctx.snapshot, ctx.uniforms as unknown as UniformContainer, { dt: ctx.dt, wallpaperShelfDim: wallpaperShelfDimActive });
		syncFxUniforms(fx, ctx.snapshot, field.materialUniforms as unknown as UniformContainer, { dt: ctx.dt, wallpaperShelfDim: wallpaperShelfDimActive });

		const tU = field.materialUniforms.uTime as { value: unknown } | undefined;
		if (tU && typeof ctx.uniforms.uTime.value === "number") tU.value = ctx.uniforms.uTime.value;
		const alphaUniform = field.materialUniforms.uAlpha as { value: unknown } | undefined;
		if (alphaUniform && typeof alphaUniform.value === "number") {
			const target = 0.96;
			const dt = Number.isFinite(ctx.dt) ? Math.max(0, ctx.dt) : 0;
			const ease = Math.min(1, dt * 4.8);
			alphaUniform.value += (target - alphaUniform.value) * ease;
		}
		coverController.advanceColorMix(ctx.dt);
		coverController.advanceDepth(ctx.dt);
		tickPointerRotation(ctx.dt);
		latestHeadParallax = {
			active: fx.mouseActive === true,
			x: Number(ctx.pointerParallax?.x) || 0,
			y: Number(ctx.pointerParallax?.y) || 0,
		};
		if (fx.preset !== SKULL_PRESET_INDEX) skullWheelZoomTarget = 0;
		skullWheelZoom += (skullWheelZoomTarget - skullWheelZoom) * Math.min(1, ctx.dt * 8.0);
		skullParticles.update(ctx, fx);
	}

	return {
		update(ctx) {
			stepBody(ctx);
			ripples.update(ctx.dt);
		},
		updateCore: stepBody,
		updateRipples(dtSeconds) {
			ripples.update(dtSeconds);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			runtimeActive = false;
			backCoverGeneration += 1;
			coverController.dispose();
			backCoverLayer?.dispose();
			backCoverLayer = null;
			skullParticles.dispose();
			field.dispose();
		},
		getPreset() {
			return fx.preset;
		},
		setPreset(p, setOpts) {
			const next = applyPreset(fx, p, setOpts);
			fx.preset = next.preset;
			field.applyFxState(fx);
			field.points.visible = fx.preset !== SKULL_PRESET_INDEX;
			field.bloomPoints.visible = !!(fx.bloom && fx.bloomStrength > 0.01) && fx.preset !== SKULL_PRESET_INDEX;
		},
		getFx() {
			return fx;
		},
		getField() {
			return field;
		},
		setCoverUrl(url) {
			coverController.setCoverUrl(url);
		},
		getCoverController() {
			return coverController;
		},
		getRipples() {
			return ripples;
		},
		getSkullParticles() {
			return skullParticles.getObject();
		},
		getSkullMouthTransform() {
			return skullParticles.getMouthTransform();
		},
		getSkullBeatFlash() {
			return skullParticles.getBeatFlash();
		},
		setSkullShelfCompositionActive(active) {
			skullParticles.setShelfCompositionActive(active);
		},
		setWallpaperShelfDimActive(active) {
			wallpaperShelfDimActive = !!active;
		},
		setRuntimeActive(active) {
			if (disposed || runtimeActive === !!active) return;
			runtimeActive = !!active;
			coverController.setRuntimeActive(runtimeActive);
			if (!runtimeActive) {
				runtimeWakePending = false;
				backCoverGeneration += 1;
				backCoverLayer?.dispose();
				backCoverLayer = null;
			} else {
				runtimeWakePending = true;
			}
		},
		applySkullWheel(deltaY) {
			if (fx.preset !== SKULL_PRESET_INDEX) return false;
			skullWheelZoomTarget = clampRange(skullWheelZoomTarget + deltaY * 0.00155, -0.95, 1.28);
			return true;
		},
		getSkullWheelZoom() {
			return skullWheelZoom;
		},
		applyPointerSpinDrag(dx, dy, dtSeconds) {
			const dt = Math.max(1 / 120, Math.min(0.08, Number(dtSeconds) || 1 / 60));
			const rx = dy * PARTICLE_POINTER_SPIN_X;
			const ry = dx * PARTICLE_POINTER_SPIN_Y;
			gestureRotation.x += rx;
			gestureRotation.y += ry;
			particleSpin.vx = clampParticleSpinVelocity((rx / dt) * 0.46);
			particleSpin.vy = clampParticleSpinVelocity((ry / dt) * 0.46);
		},
		resetParticleRotation(syncVisual = false) {
			gestureRotation.x = 0;
			gestureRotation.y = 0;
			particleSpin.vx = 0;
			particleSpin.vy = 0;
			if (syncVisual) {
				setRotation(field.points.rotation, 0, 0, 0);
				setRotation(field.bloomPoints.rotation, 0, 0, 0);
				const backCoverPoints = backCoverLayer?.getPoints();
				if (backCoverPoints) setRotation(backCoverPoints.rotation, 0, 0, 0);
			}
		},
		whenIdle() {
			return backCoverPending ?? Promise.resolve();
		},
	};
}

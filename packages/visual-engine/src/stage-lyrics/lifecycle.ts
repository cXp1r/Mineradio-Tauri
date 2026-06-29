import type * as THREE from "three";
import type { ThreeFactory } from "../runtime/renderer-setup";
import type { FrameContext } from "../runtime/frame-context";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import { RenderStepSlot } from "../runtime/render-step-slot";
import type {
	GsapLike,
	GsapProvider,
	GsapTimelineLike,
} from "../control/control-console-motion";
import {
	type LyricGroup,
	buildLyricGroup,
	disposeLyricGroup,
	updateLyricGroupProgress,
} from "./lyric-builder";
import type { LyricPalette } from "./palette";
import { DEFAULT_LYRIC_PALETTE, resolveLyricPalette } from "./palette";
import { LyricPaletteRuntime } from "./palette-runtime";
import { createLyricPaletteDriver, type PaletteDriver } from "./palette-driver";
import {
	type CustomEaseCreator,
	type LyricTransitionEasings,
	createTransitionEasings,
	defaultTransitionEasings,
	playStageLineBobTimeline,
	playStageLineInTimeline,
	playStageLineOutTimeline,
} from "./transitions";
import {
	getLyricLineProgress,
	type LyricLine,
} from "./lyric-line-progress";
import { normalizeFontKey, type LyricTextOptions } from "./lyric-text";

export interface StageLyricsLifecycleOpts {
	scene?: THREE.Scene | null;
	threeFactory?: ThreeFactory;
	gsapProvider?: GsapProvider;
	customEaseProvider?: () => Promise<CustomEaseCreator | null>;
	lyricLinesSupplier?: () => LyricLine[];
	currentTimeSupplier?: () => number;
	audioDurationSupplier?: () => number;
	isPlayingSupplier?: () => boolean;
	palette?: Partial<LyricPalette>;
	getShelfVisibility?: () => number;
	getShelfMode?: () => string | null | undefined;
	getShelfHasOpenContent?: () => boolean;
	getSkullShelfOpen?: () => boolean;
	dotTexture?: THREE.Texture;
	pixelScale?: number;
	lyricGlowParticlesSupplier?: () => boolean;
	lyricGlowStrengthSupplier?: () => number;
	lyricGlowBeatFlagSupplier?: () => boolean;
	lyricTextOptionsSupplier?: () => LyricTextOptions;
	lyricLayoutOptionsSupplier?: () => LyricLayoutOptions;
	cameraSupplier?: () => THREE.PerspectiveCamera | null;
	lyricSunEnergyHolder?: { get(): number; set(v: number): void };
	getBeatCamKick?: () => {
		thetaKick: number;
		phiKick: number;
		rollKick: number;
		radiusKick: number;
		punch: number;
	} | null;
	fallbackTextSupplier?: () => string;
	particleLyricsFlagSupplier?: () => boolean;
	lyricsHasNativeKaraoke?: boolean;
	reduceMotion?: () => boolean;
	rand?: () => number;
}

export type { LyricLine } from "./lyric-line-progress";
export { type PaletteDriver, createLyricPaletteDriver } from "./palette-driver";
export { LyricPaletteRuntime } from "./palette-runtime";

export interface StageLyricsLifecycle {
	readonly slot: RenderStepSlot;
	readonly group: THREE.Group | null;
	mount(parent?: THREE.Scene): Promise<THREE.Group>;
	unmount(): void;
	setLyricLines(lines: LyricLine[]): void;
	update(ctx: FrameContext): void;
	setPalette(palette: Partial<LyricPalette>): void;
	setShelfVisibility(v: number): void;
	getCurrentIdx(): number;
	getCurrentText(): string;
	whenIdle(): Promise<void>;
	dispose(): void;
}

type Vec3Like = { x: number; y: number; z: number };
export interface LyricLayoutOptions {
	lyricCameraLock?: boolean;
	lyricScale?: number;
	lyricOffsetX?: number;
	lyricOffsetY?: number;
	lyricOffsetZ?: number;
	lyricTiltX?: number;
	lyricTiltY?: number;
	preset?: number;
}
function clamp(v: number, lo: number, hi: number): number {
	if (!isFinite(v)) return lo;
	return Math.max(lo, Math.min(hi, v));
}
function finiteOr(v: number, d: number): number {
	return isFinite(v) ? v : d;
}
function fallbackNumber(v: number | undefined, d: number): number {
	return typeof v === "number" && isFinite(v) ? v : d;
}
function normalizeVec(v: Vec3Like): Vec3Like {
	const len = Math.hypot(v.x, v.y, v.z) || 1;
	v.x /= len;
	v.y /= len;
	v.z /= len;
	return v;
}
function applyQuaternionToVec(v: Vec3Like, q: { x: number; y: number; z: number; w: number }): Vec3Like {
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
	v.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
	v.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
	v.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
	return v;
}
function tiltQuaternionYXZ(tiltX: number, tiltY: number): { x: number; y: number; z: number; w: number } {
	const x = tiltX * Math.PI / 180;
	const y = tiltY * Math.PI / 180;
	const c1 = Math.cos(x / 2);
	const c2 = Math.cos(y / 2);
	const s1 = Math.sin(x / 2);
	const s2 = Math.sin(y / 2);
	return {
		x: s1 * c2,
		y: c1 * s2,
		z: -s1 * s2,
		w: c1 * c2,
	};
}
function multiplyQuaternions(
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

const defaultGsapProvider: GsapProvider = async () => {
	const mod = await import("gsap");
	const g = (mod as { gsap?: GsapLike; default?: GsapLike }).gsap ?? (mod as { default?: GsapLike }).default;
	if (!g) throw new Error("stage-lyrics lifecycle: gsap factory could not resolve a gsap instance");
	return g;
};

const defaultCustomEaseProvider: () => Promise<CustomEaseCreator | null> = async () => {
	try {
		const mod = (await import("gsap/CustomEase")) as unknown as { default?: CustomEaseCreator; CustomEase?: CustomEaseCreator };
		const CustomEase = mod.default ?? mod.CustomEase ?? null;
		if (!CustomEase) return null;
		const create: CustomEaseCreator = (id, path) => {
			const created = (
				(CustomEase as unknown) as { create?: (id: string, path: string) => string | void }
			).create?.(id, path);
			return typeof created === "string" ? created : id;
		};
		return create;
	} catch {
		return null;
	}
};

const DEFAULT_THREE_FACTORY: ThreeFactory = async () => await import("three");

type SizeOfMaterial = {
	value: number;
} & Record<string, unknown>;
type UniformsOf<TMat> = { uniforms?: Partial<Record<string, SizeOfMaterial>> } & TMat;

export function createStageLyricsLifecycle(opts: StageLyricsLifecycleOpts): StageLyricsLifecycle {
	const state = {
		group: null as THREE.Group | null,
		current: null as LyricGroup | null,
		outgoing: [] as Array<{
			lyric: LyricGroup;
			timeline: GsapTimelineLike | null;
			age: number;
		}>,
		currentIdx: -1,
		currentText: "",
		highBloom: 0,
		beatGlow: 0,
		glowFollowX: 0,
		glowFollowY: 0,
		glowFollowRoll: 0,
		starRiver: null as THREE.Object3D | null,
		shelfVisibility: 0,
		lines: [] as LyricLine[],
		gsap: null as GsapLike | null,
		easings: null as LyricTransitionEasings | null,
		gsapReady: false,
		preparingGsap: false,
		activeInTimeline: null as GsapTimelineLike | null,
		activeBobTimeline: null as GsapTimelineLike | null,
		buildToken: 0,
		activeBuilds: 0,
		textOptionsSignature: "",
		lockFitScale: 1,
		pendingBuildPromise: null as Promise<void> | null,
		paletteRuntime: new LyricPaletteRuntime(opts.palette),
		reduceMotionFlag: false,
		disposed: false,
	};

	const threeFactory: ThreeFactory = opts.threeFactory ?? DEFAULT_THREE_FACTORY;
	const goLerp = (cur: number, target: number, ease: number) => cur + (target - cur) * ease;

	async function ensureGsap(): Promise<GsapLike> {
		if (state.gsap && state.gsapReady) return state.gsap;
		if (state.preparingGsap) {
			await state.pendingBuildPromise;
			if (state.gsap) return state.gsap;
		}
		state.preparingGsap = true;
		const provider = opts.gsapProvider ?? defaultGsapProvider;
		const g = await provider();
		state.gsap = g;
		let customEase: CustomEaseCreator | null = null;
		try {
			const easeProvider = opts.customEaseProvider ?? defaultCustomEaseProvider;
			customEase = await easeProvider();
			const register = (g as unknown as { registerPlugin?: (p: unknown) => void }).registerPlugin;
			if (register && customEase) {
				try {
					const easeMod = (await import("gsap/CustomEase")) as unknown as { default?: unknown; CustomEase?: unknown };
					register(easeMod.default ?? easeMod.CustomEase);
				} catch {
					void 0;
				}
			}
		} catch {
			customEase = null;
		}
		state.easings = customEase ? createTransitionEasings(customEase) : defaultTransitionEasings();
		state.gsapReady = true;
		state.preparingGsap = false;
		return g;
	}

	function getShelfVisibility(): number {
		if (typeof opts.getShelfVisibility === "function") return opts.getShelfVisibility();
		return state.shelfVisibility;
	}

	function getShelfMode(): string {
		return opts.getShelfMode?.() ?? "side";
	}

	function getShelfHasOpenContent(): boolean {
		return typeof opts.getShelfHasOpenContent === "function" ? !!opts.getShelfHasOpenContent() : false;
	}

	function getSkullShelfOpen(): boolean {
		return typeof opts.getSkullShelfOpen === "function" ? !!opts.getSkullShelfOpen() : false;
	}

	function getLyricTextOptions(): LyricTextOptions {
		const raw = opts.lyricTextOptionsSupplier?.() ?? {};
		return {
			lyricFont: normalizeFontKey(raw.lyricFont),
			lyricLetterSpacing: clamp(Number(raw.lyricLetterSpacing) || 0, -0.04, 0.18),
			lyricLineHeight: clamp(Number(raw.lyricLineHeight) || 1, 0.86, 1.35),
			lyricWeight: Math.round(clamp(Number(raw.lyricWeight) || 900, 500, 900) / 50) * 50,
		};
	}

	function textOptionsSignature(opts0: LyricTextOptions): string {
		return `${opts0.lyricFont ?? ""}|${opts0.lyricLetterSpacing ?? ""}|${opts0.lyricLineHeight ?? ""}|${opts0.lyricWeight ?? ""}`;
	}

	function shouldDimWallpaperForShelf(): boolean {
		if (getShelfMode() !== "side") return false;
		if (getShelfHasOpenContent()) return true;
		return getShelfVisibility() > 0.24;
	}

	function getLyricLayoutOptions(): Required<LyricLayoutOptions> & { lockBaseDistance: number } {
		const raw = opts.lyricLayoutOptionsSupplier?.() ?? {};
		const layout = {
			lyricCameraLock: !!raw.lyricCameraLock,
			lyricScale: clamp(Number(raw.lyricScale) || 1, 0.35, 1.65),
			lyricOffsetX: clamp(Number(raw.lyricOffsetX) || 0, -2, 2),
			lyricOffsetY: clamp(Number(raw.lyricOffsetY) || 0, -1.2, 1.35),
			lyricOffsetZ: clamp(Number(raw.lyricOffsetZ) || 0, -1.6, 1.6),
			lyricTiltX: clamp(Number(raw.lyricTiltX) || 0, -42, 42),
			lyricTiltY: clamp(Number(raw.lyricTiltY) || 0, -42, 42),
			preset: Number(raw.preset) || 0,
			lockBaseDistance: 4.85,
		};
		const wallpaperLyricLock = layout.preset === 5 && layout.lyricCameraLock;
		if (wallpaperLyricLock) {
			const dimForShelf = shouldDimWallpaperForShelf();
			layout.lyricScale *= dimForShelf ? 0.60 : 0.84;
			layout.lyricOffsetX = clamp(layout.lyricOffsetX + (dimForShelf ? -1.34 : 0), -2, 2);
			layout.lyricOffsetY = clamp(layout.lyricOffsetY + (dimForShelf ? -0.04 : 0.08), -1.2, 1.35);
			layout.lyricOffsetZ = clamp(layout.lyricOffsetZ + (dimForShelf ? 1.02 : 1.15), -1.6, 1.6);
			layout.lockBaseDistance = dimForShelf ? 5.58 : 4.85;
		} else if (
			!layout.lyricCameraLock &&
			getShelfMode() === "side" &&
			getShelfHasOpenContent() &&
			!getSkullShelfOpen()
		) {
			layout.lyricScale *= 0.56;
			layout.lyricOffsetX = clamp(layout.lyricOffsetX - 1.78, -2, 2);
			layout.lyricOffsetY = clamp(layout.lyricOffsetY + 0.18, -1.2, 1.35);
			layout.lyricOffsetZ = clamp(layout.lyricOffsetZ + 0.84, -1.6, 1.6);
		}
		return layout;
	}

	function getStageLyricLockBounds(): { w: number; h: number } {
		let maxW = 0;
		let maxH = 0;
		function take(lyric: LyricGroup | null | undefined): void {
			if (!lyric) return;
			const group = lyric.group as unknown as {
				userData?: { lyric?: { textWorldW?: number; worldW?: number; textWorldH?: number; worldH?: number } };
				scale?: { x?: number; y?: number };
			};
			const data = group.userData?.lyric;
			if (!data) return;
			const meshScale = Math.max(
				typeof group.scale?.x === "number" && isFinite(group.scale.x) ? group.scale.x : 1,
				typeof group.scale?.y === "number" && isFinite(group.scale.y) ? group.scale.y : 1,
			);
			maxW = Math.max(maxW, (data.textWorldW || data.worldW || 6.1) * meshScale);
			maxH = Math.max(maxH, (data.textWorldH || data.worldH || 1.0) * meshScale);
		}
		take(state.current);
		for (const entry of state.outgoing) take(entry.lyric);
		return { w: maxW || 5.4, h: maxH || 0.78 };
	}

	function lyricCameraLockFit(
		camera: THREE.PerspectiveCamera,
		layoutScale: number,
		layoutX: number,
		layoutY: number,
		distance: number,
	): number {
		const scale = Math.max(0.1, layoutScale || 1);
		const fov = ((camera.fov || 45) * Math.PI) / 180;
		const dist = Math.max(1.4, distance || 4.85);
		const visibleH = 2 * Math.tan(fov * 0.5) * dist;
		const visibleW = visibleH * (camera.aspect || 1.78);
		const bounds = getStageLyricLockBounds();
		const safeW = Math.max(visibleW * 0.42, visibleW * 0.84 - Math.abs(layoutX || 0) * 1.22);
		const safeH = Math.max(visibleH * 0.18, visibleH * 0.44 - Math.abs(layoutY || 0) * 0.82);
		const scaledW = Math.max(0.01, bounds.w * scale);
		const scaledH = Math.max(0.01, bounds.h * scale);
		const viewportFit = Math.min(1, safeW / scaledW, safeH / scaledH);
		const lockScaleCap = Math.min(1, 0.80 / scale);
		return clamp(Math.min(viewportFit, lockScaleCap), 0.42, 1);
	}

	function setGroupPosition(
		group: {
			position?: { set?: (x: number, y: number, z: number) => void; x: number; y: number; z: number };
		},
		x: number,
		y: number,
		z: number,
	): void {
		if (group.position?.set) group.position.set(x, y, z);
		else if (group.position) {
			group.position.x = x;
			group.position.y = y;
			group.position.z = z;
		}
	}

	function setGroupScale(
		group: {
			scale?: { setScalar?: (s: number) => void; set?: (x: number, y: number, z: number) => void; x: number; y: number; z: number };
		},
		scale: number,
	): void {
		if (group.scale?.setScalar) group.scale.setScalar(scale);
		else if (group.scale?.set) group.scale.set(scale, scale, scale);
		else if (group.scale) {
			group.scale.x = scale;
			group.scale.y = scale;
			group.scale.z = scale;
		}
	}

	function applyStageLyricLayout(): void {
		if (!state.group) return;
		const layout = getLyricLayoutOptions();
		const group = state.group as unknown as {
			position?: { set?: (x: number, y: number, z: number) => void; lerp?: (v: Vec3Like, a: number) => void; x: number; y: number; z: number };
			quaternion?: { x: number; y: number; z: number; w: number; slerp?: (q: { x: number; y: number; z: number; w: number }, a: number) => void };
			rotation?: { x: number; y: number; z: number };
			scale?: { setScalar?: (s: number) => void; set?: (x: number, y: number, z: number) => void; x: number; y: number; z: number };
		};
		setGroupScale(group, layout.lyricScale);
		const camera = layout.lyricCameraLock ? opts.cameraSupplier?.() ?? null : null;
		if (camera) {
			const lockDistance = layout.lockBaseDistance + layout.lyricOffsetZ;
			const lockFit = lyricCameraLockFit(camera, layout.lyricScale, layout.lyricOffsetX, layout.lyricOffsetY, lockDistance);
			state.lockFitScale += (lockFit - state.lockFitScale) * (lockFit < state.lockFitScale ? 0.18 : 0.10);
			state.lockFitScale = finiteOr(state.lockFitScale, 1);
			setGroupScale(group, layout.lyricScale * state.lockFitScale);
			const q = camera.quaternion as { x: number; y: number; z: number; w: number };
			const dir = { x: 0, y: 0, z: -1 };
			const right = normalizeVec(applyQuaternionToVec({ x: 1, y: 0, z: 0 }, q));
			const up = normalizeVec(applyQuaternionToVec({ x: 0, y: 1, z: 0 }, q));
			const worldDir = typeof camera.getWorldDirection === "function"
				? camera.getWorldDirection({ x: 0, y: 0, z: 0, normalize() { return normalizeVec(this); } } as never) as unknown as Vec3Like
				: applyQuaternionToVec(dir, q);
			const forward = normalizeVec({ x: worldDir.x, y: worldDir.y, z: worldDir.z });
			const x = camera.position.x + forward.x * layout.lockBaseDistance + right.x * layout.lyricOffsetX + up.x * layout.lyricOffsetY + forward.x * layout.lyricOffsetZ;
			const y = camera.position.y + forward.y * layout.lockBaseDistance + right.y * layout.lyricOffsetX + up.y * layout.lyricOffsetY + forward.y * layout.lyricOffsetZ;
			const z = camera.position.z + forward.z * layout.lockBaseDistance + right.z * layout.lyricOffsetX + up.z * layout.lyricOffsetY + forward.z * layout.lyricOffsetZ;
			if (group.position?.lerp) group.position.lerp({ x, y, z }, 0.24);
			else setGroupPosition(group, x, y, z);
			const targetQuat = multiplyQuaternions(q, tiltQuaternionYXZ(layout.lyricTiltX, layout.lyricTiltY));
			if (group.quaternion?.slerp) group.quaternion.slerp(targetQuat, 0.22);
			else if (group.quaternion) {
				group.quaternion.x = targetQuat.x;
				group.quaternion.y = targetQuat.y;
				group.quaternion.z = targetQuat.z;
				group.quaternion.w = targetQuat.w;
			}
			return;
		}
		state.lockFitScale = 1;
		const x = layout.lyricOffsetX;
		const y = 0.2 + layout.lyricOffsetY;
		const z = 1.46 + layout.lyricOffsetZ;
		setGroupPosition(group, x, y, z);
		if (group.rotation) {
			group.rotation.x = layout.lyricTiltX * Math.PI / 180;
			group.rotation.y = layout.lyricTiltY * Math.PI / 180;
		}
	}

	function getShelfProfile() {
		const sv = getShelfVisibility();
		const shelfDetailOpen = sv > 0.5;
		const skullShelfDetailOpen = shelfDetailOpen && getSkullShelfOpen();
		const profile = shelfDetailOpen
			? {
					opacity: skullShelfDetailOpen ? 0.30 : 0.38,
					readability: skullShelfDetailOpen ? 0.20 : 0.26,
					bloom: skullShelfDetailOpen ? 0.20 : 0.24,
					glowCap: skullShelfDetailOpen ? 0.050 : 0.070,
					outgoing: skullShelfDetailOpen ? 0.34 : 0.42,
					easeDown: 0.34,
				}
			: {
					opacity: 0.96,
					readability: 0.86,
					bloom: 1,
					glowCap: 1.0,
					outgoing: 1,
					easeDown: 0.16,
				};
		return { sv, shelfDetailOpen, skullShelfDetailOpen, profile };
	}

	function uniforms<TLyric extends LyricGroup>(lyric: TLyric, key: string): SizeOfMaterial | null {
		const u = (lyric.textMat as unknown as UniformsOf<unknown>).uniforms;
		if (!u) return null;
		const slot = u[key];
		return slot ?? null;
	}

	function disposeCurrent(): void {
		if (state.activeInTimeline) {
			try {
				state.activeInTimeline.kill();
			} catch {
				void 0;
			}
			state.activeInTimeline = null;
		}
		if (state.activeBobTimeline) {
			try {
				state.activeBobTimeline.kill();
			} catch {
				void 0;
			}
			state.activeBobTimeline = null;
		}
		if (state.current) {
			if (state.group) {
				try {
					(state.group as unknown as { remove: (c: unknown) => void }).remove(state.current.group);
				} catch {
					void 0;
				}
			}
			disposeLyricGroupSafe(state.current);
			state.current = null;
		}
	}

	function disposeLyricGroupSafe(lyric: LyricGroup): void {
		try {
			disposeLyricGroup(lyric);
		} catch {
			void 0;
		}
	}

	function clearStageLyrics(): void {
		disposeCurrent();
		state.currentIdx = -1;
		state.currentText = "";
		while (state.outgoing.length) {
			const entry = state.outgoing.pop()!;
			if (entry.timeline) {
				try {
					entry.timeline.kill();
				} catch {
					void 0;
				}
			}
			if (state.group) {
				try {
					(state.group as unknown as { remove: (c: unknown) => void }).remove(entry.lyric.group);
				} catch {
					void 0;
				}
			}
			disposeLyricGroupSafe(entry.lyric);
		}
	}

	function showStageLine(text: string, redrawOnly: boolean): void {
		if (!state.group) return;
		if (!text) {
			clearStageLyrics();
			return;
		}
		if (redrawOnly && state.current) {
			disposeCurrent();
		} else if (state.current) {
			const outgoingLyric = state.current;
			(outgoingLyric.group as unknown as { userData: Record<string, unknown> }).userData.state = "out";
			(outgoingLyric.group as unknown as { userData: Record<string, unknown> }).userData.age = 0;
			const outTl =
				state.gsap && state.easings
					? playStageLineOutTimeline(state.gsap, outgoingLyric.group, {
							easings: state.easings,
							reduceMotion: state.reduceMotionFlag,
							onComplete: () => {
								if (state.group) {
									try {
										(state.group as unknown as { remove: (c: unknown) => void }).remove(outgoingLyric.group);
									} catch {
										void 0;
									}
								}
								disposeLyricGroupSafe(outgoingLyric);
							},
						})
					: null;
			state.outgoing.push({ lyric: outgoingLyric, timeline: outTl, age: 0 });
			state.current = null;
		}
		state.currentText = text;
		const textOptions = getLyricTextOptions();
		state.textOptionsSignature = textOptionsSignature(textOptions);
		state.buildToken += 1;
		const token = state.buildToken;
		state.activeBuilds += 1;
		const promise = (async () => {
			try {
				const palette = state.paletteRuntime.get();
				const lyricsHasNativeKaraoke = !!opts.lyricsHasNativeKaraoke;
				const lyric = await buildLyricGroup(text, palette, {
					threeFactory,
					dotTexture: opts.dotTexture,
					pixelScale: opts.pixelScale,
					lyricGlowParticles: opts.lyricGlowParticlesSupplier ? opts.lyricGlowParticlesSupplier() : false,
					lyricsHasNativeKaraoke,
					...textOptions,
					rand: opts.rand,
				});
				if (state.disposed || token !== state.buildToken) {
					disposeLyricGroupSafe(lyric);
					return;
				}
				if (!state.group) {
					disposeLyricGroupSafe(lyric);
					return;
				}
				(state.group as unknown as { add: (c: unknown) => void }).add(lyric.group);
				state.current = lyric;
				try {
					await ensureGsap();
				} catch {
					void 0;
				}
				if (state.disposed || token !== state.buildToken || state.current !== lyric) {
					disposeLyricGroupSafe(lyric);
					return;
				}
				const g = state.gsap;
				const eases = state.easings ?? defaultTransitionEasings();
				state.activeInTimeline = g
					? playStageLineInTimeline(g, lyric.group, {
							easings: eases,
							reduceMotion: state.reduceMotionFlag,
						})
					: null;
				state.activeBobTimeline = g && !state.reduceMotionFlag
					? playStageLineBobTimeline(g, lyric.group, {
							easings: eases,
							reduceMotion: state.reduceMotionFlag,
						})
					: null;
			} finally {
				state.activeBuilds = Math.max(0, state.activeBuilds - 1);
			}
		})();
		state.pendingBuildPromise = promise.then(
			() => undefined,
			() => undefined,
		);
	}

	function tickLyricsParticles(nowSeconds: number): void {
		const particleLyricsFlag = opts.particleLyricsFlagSupplier ? opts.particleLyricsFlagSupplier() : true;
		if (!particleLyricsFlag) {
			if (state.current || state.currentText || state.outgoing.length) clearStageLyrics();
			return;
		}
		const playing = opts.isPlayingSupplier ? opts.isPlayingSupplier() : true;
		const lines = state.lines;
		if (!playing || lines.length === 0) {
			if (state.current) {
				const outgoingLyric = state.current;
				(outgoingLyric.group as unknown as { userData: Record<string, unknown> }).userData.state = "out";
				(outgoingLyric.group as unknown as { userData: Record<string, unknown> }).userData.age = 0;
				state.outgoing.push({ lyric: outgoingLyric, timeline: null, age: 0 });
				state.current = null;
				state.currentIdx = -1;
				state.currentText = "";
			}
			return;
		}
		let newIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].t <= nowSeconds + 0.05) newIdx = i;
			else break;
		}
		if (newIdx < 0) {
			const introText = (opts.fallbackTextSupplier ? opts.fallbackTextSupplier() : "") || "";
			if (!introText) {
				clearStageLyrics();
				return;
			}
			if (state.currentIdx !== -2 || state.currentText !== introText) {
				state.currentIdx = -2;
				showStageLine(introText, false);
			}
			if (state.current) {
				const firstLine = lines[0];
				const dur = opts.audioDurationSupplier ? opts.audioDurationSupplier() : NaN;
				const introEnd =
					firstLine && firstLine.t > 0
						? firstLine.t
						: Math.min(isFinite(dur) ? dur : 4.8, 4.8);
				const introLine: LyricLine = {
					t: 0,
					text: introText,
					duration: Math.max(0.8, introEnd),
					charCount: Math.max(1, introText.length),
					fallback: true,
				};
				const audioDur = opts.audioDurationSupplier ? opts.audioDurationSupplier() : NaN;
				updateLyricGroupProgress(
					{ group: state.current.group, textMat: state.current.textMat },
					getLyricLineProgress(introLine, null, nowSeconds, isFinite(audioDur) ? audioDur : undefined),
				);
			}
			return;
		}
		if (newIdx !== state.currentIdx) {
			state.currentIdx = newIdx;
			showStageLine(lines[newIdx].text || "", false);
		}
		if (state.current) {
			const signature = textOptionsSignature(getLyricTextOptions());
			if (state.currentText && signature !== state.textOptionsSignature) {
				const progress = (state.current.group as unknown as { userData: { lastLyricProgress?: number } }).userData.lastLyricProgress ?? 0;
				showStageLine(state.currentText, true);
				if (state.current) {
					updateLyricGroupProgress(
						{ group: state.current.group, textMat: state.current.textMat },
						progress,
					);
				}
				return;
			}
			const curLine = lines[newIdx] || ({ t: nowSeconds } as LyricLine);
			const nextLine = lines[newIdx + 1];
			const audioDur = opts.audioDurationSupplier ? opts.audioDurationSupplier() : NaN;
			const progress = getLyricLineProgress(
				curLine,
				nextLine,
				nowSeconds,
				isFinite(audioDur) ? audioDur : undefined,
			);
			updateLyricGroupProgress(
				{ group: state.current.group, textMat: state.current.textMat },
				progress,
			);
		}
	}

	function tickCurrentMesh(dt: number, shelf: ReturnType<typeof getShelfProfile>, snapshot: AudioSnapshot, t: number): void {
		const mesh = state.current;
		if (!mesh) return;
		const userData = (mesh.group as unknown as { userData: Record<string, unknown> }).userData;
		userData.age = finiteOr((userData.age as number) ?? 0, 0) + dt;
		const uOpacity = uniforms(mesh, "uOpacity");
		const uSolar = uniforms(mesh, "uSolar");
		const readabilityMat = mesh.readabilityMat as { opacity: number };
		const glowMat = mesh.glowMat as { opacity: number };
		const sunMat = mesh.sunMat as { opacity: number };
		const lyricGlowStrength = opts.lyricGlowStrengthSupplier ? Math.min(0.85, Math.max(0, opts.lyricGlowStrengthSupplier())) : 0;
		const glowDrive = Math.min(1.7, Math.max(0, lyricGlowStrength / 0.5));
		const currentOpacity = uOpacity ? uOpacity.value : 0;
		const opacityTarget = shelf.profile.opacity;
		const opacityEase =
			shelf.shelfDetailOpen && currentOpacity > opacityTarget ? shelf.profile.easeDown : 0.16;
		const newOpacity = clamp(goLerp(currentOpacity, opacityTarget, opacityEase), 0, 1);
		if (uOpacity) (uOpacity as SizeOfMaterial).value = newOpacity;
		void t;
		void snapshot;
		if (readabilityMat) {
			const readabilityTarget = newOpacity * shelf.profile.readability;
			const reassEase =
				shelf.shelfDetailOpen && readabilityMat.opacity > readabilityTarget ? 0.28 : 0.16;
			readabilityMat.opacity += (readabilityTarget - readabilityMat.opacity) * reassEase;
		}
		if (uSolar) {
			const solarTarget = state.highBloom * shelf.profile.bloom;
			const solarEase =
				shelf.shelfDetailOpen && (uSolar as SizeOfMaterial).value > solarTarget ? 0.26 : 0.12;
			(uSolar as SizeOfMaterial).value += (solarTarget - (uSolar as SizeOfMaterial).value) * solarEase;
		}
		if (glowMat) {
			const glowTarget = lyricGlowStrength > 0 ? Math.min(shelf.profile.glowCap, (0.075 + state.highBloom * 0.34 + state.beatGlow * 0.16 * shelf.profile.bloom) * Math.min(3.0, glowDrive)) : 0;
			glowMat.opacity += (glowTarget - glowMat.opacity) * (glowTarget > glowMat.opacity ? 0.095 : (shelf.shelfDetailOpen ? 0.20 : 0.055));
		}
		if (sunMat) {
			const sunTarget = lyricGlowStrength > 0 && !shelf.shelfDetailOpen ? Math.min(0.88, (Math.pow(Math.min(1.35, state.highBloom), 1.08) * 0.28 + state.beatGlow * 0.20) * Math.min(2.4, glowDrive)) : 0;
			sunMat.opacity += (sunTarget - sunMat.opacity) * (shelf.shelfDetailOpen ? 0.18 : 0.055);
		}
	}

	function tickOutgoingMeshes(dt: number, shelf: ReturnType<typeof getShelfProfile>, _snapshot: AudioSnapshot, _t: number): void {
		void _snapshot;
		void _t;
		for (let i = state.outgoing.length - 1; i >= 0; i--) {
			const entry = state.outgoing[i];
			entry.age += dt;
			const a = Math.min(1, entry.age / 0.38);
			const aSmooth = a * a * (3 - 2 * a);
			const lyric = entry.lyric;
			const userData = (lyric.group as unknown as { userData: Record<string, unknown> }).userData;
			userData.age = finiteOr((userData.age as number) ?? 0, 0);
			const uOpacity = uniforms(lyric, "uOpacity");
			const readabilityMat = lyric.readabilityMat as { opacity: number };
			const glowMat = lyric.glowMat as { opacity: number };
			const sunMat = lyric.sunMat as { opacity: number };
			const lyricGlowStrength = opts.lyricGlowStrengthSupplier ? Math.min(0.85, Math.max(0, opts.lyricGlowStrengthSupplier())) : 0;
			const opacity = (1 - aSmooth) * 0.72 * shelf.profile.outgoing;
			if (uOpacity) (uOpacity as SizeOfMaterial).value = opacity;
			if (readabilityMat) readabilityMat.opacity = opacity * (shelf.shelfDetailOpen ? shelf.profile.readability : 0.58);
			const uSolar = uniforms(lyric, "uSolar");
			if (uSolar) (uSolar as SizeOfMaterial).value *= shelf.shelfDetailOpen ? 0.72 : 0.86;
			if (glowMat) glowMat.opacity = lyricGlowStrength > 0 ? (shelf.shelfDetailOpen ? Math.min(shelf.profile.glowCap * 0.40, opacity * 0.05 * lyricGlowStrength) : opacity * 0.08 * lyricGlowStrength) : 0;
			if (sunMat) sunMat.opacity = lyricGlowStrength > 0 && !shelf.shelfDetailOpen ? opacity * 0.08 * lyricGlowStrength : 0;
			const pos = lyric.group.position as unknown as Vec3Like;
			pos.z -= dt * 0.26;
			pos.y += dt * 0.08;
			const sc = lyric.group.scale as unknown as Vec3Like;
			const scalar = 0.98 - aSmooth * 0.06;
			sc.x = scalar;
			sc.y = scalar;
			sc.z = scalar;
			if (aSmooth >= 1) {
				if (entry.timeline) {
					try {
						entry.timeline.kill();
					} catch {
						void 0;
					}
				}
				if (state.group) {
					try {
						(state.group as unknown as { remove: (c: unknown) => void }).remove(lyric.group);
					} catch {
						void 0;
					}
				}
				disposeLyricGroupSafe(lyric);
				state.outgoing.splice(i, 1);
			}
		}
	}

	function updateStageLyrics3D(dt: number, t: number, snapshot: AudioSnapshot): void {
		if (!state.group) return;
		state.highBloom = finiteOr(state.highBloom, 0);
		state.beatGlow = finiteOr(state.beatGlow, 0);
		state.glowFollowX = finiteOr(state.glowFollowX, 0);
		state.glowFollowY = finiteOr(state.glowFollowY, 0);
		state.glowFollowRoll = finiteOr(state.glowFollowRoll, 0);
		const shelf = getShelfProfile();
		const lyricGlowStrength = opts.lyricGlowStrengthSupplier ? Math.min(0.85, Math.max(0, opts.lyricGlowStrengthSupplier())) : 0;
		const glowBeatFlag = opts.lyricGlowBeatFlagSupplier ? opts.lyricGlowBeatFlagSupplier() : false;
		const glowDrive = Math.min(1.7, Math.max(0, lyricGlowStrength / 0.5));
		const glowBreath = lyricGlowStrength > 0 ? 0.5 + 0.5 * Math.sin(t * 1.05) : 0;
		const lyricSunEnergy = opts.lyricSunEnergyHolder ? opts.lyricSunEnergyHolder.get() : 0;
		const beatPulseValue = fallbackNumber(snapshot.beatPulse, 0);
		const musicBloom = Math.max(lyricSunEnergy, beatPulseValue * 0.10);
		const kicks = opts.getBeatCamKick ? opts.getBeatCamKick() : null;
		const beatGlowRaw = glowBeatFlag && lyricGlowStrength > 0
			? Math.max(beatPulseValue * 1.22, (kicks?.punch ?? 0) * 0.86 + (kicks?.radiusKick ?? 0) * 1.85)
			: 0;
		state.beatGlow += (beatGlowRaw - state.beatGlow) * (beatGlowRaw > state.beatGlow ? 0.32 : 0.10);
		state.beatGlow = finiteOr(state.beatGlow, 0);
		const solarBloom = lyricGlowStrength > 0
			? (0.18 + glowBreath * 0.16 + musicBloom * 0.90 + state.beatGlow * 1.18 + Math.sin(t * 0.37 + 1.2) * 0.035) * glowDrive
			: 0;
		const solarBloomClamped = Math.max(0, Math.min(1.45, solarBloom));
		state.highBloom += (solarBloomClamped - state.highBloom) * (solarBloomClamped > state.highBloom ? 0.075 : 0.050);
		state.highBloom = finiteOr(state.highBloom, 0);
		const followDrive = glowBeatFlag && lyricGlowStrength > 0 ? Math.min(1.35, state.beatGlow) : 0;
		const followXTarget = followDrive * ((kicks?.thetaKick ?? 0) * 34 + (kicks?.rollKick ?? 0) * 8);
		const followYTarget = followDrive * ((kicks?.phiKick ?? 0) * 42 - (kicks?.radiusKick ?? 0) * 0.48);
		const followRollTarget = followDrive * ((kicks?.rollKick ?? 0) * 22 + (kicks?.thetaKick ?? 0) * 10);
		state.glowFollowX += (followXTarget - state.glowFollowX) * 0.26;
		state.glowFollowY += (followYTarget - state.glowFollowY) * 0.24;
		state.glowFollowRoll += (followRollTarget - state.glowFollowRoll) * 0.22;
		state.glowFollowX *= 0.92;
		state.glowFollowY *= 0.92;
		state.glowFollowRoll *= 0.90;
		applyStageLyricLayout();
		tickCurrentMesh(dt, shelf, snapshot, t);
		tickOutgoingMeshes(dt, shelf, snapshot, t);
	}

	const lifecycle: StageLyricsLifecycle = {
		slot: RenderStepSlot.StageLyrics,
		get group() {
			return state.group;
		},
		async mount(parent?: THREE.Scene): Promise<THREE.Group> {
			const THREE = await threeFactory();
			const scene = parent ?? opts.scene ?? null;
			if (state.group) {
				if (scene) (scene as unknown as { add: (c: unknown) => void }).add(state.group);
				return state.group;
			}
			const group = new THREE.Group() as THREE.Group;
			(group as unknown as { renderOrder: number }).renderOrder = 38;
			(group as unknown as { userData: Record<string, unknown> }).userData = { isStageLyricsGroup: true };
			state.group = group;
			if (scene) (scene as unknown as { add: (c: unknown) => void }).add(group);
			state.reduceMotionFlag = opts.reduceMotion ? !!opts.reduceMotion() : false;
			return group;
		},
		unmount() {
			clearStageLyrics();
			if (state.group) {
				const g = state.group;
				const parent = (g as unknown as { parent?: unknown }).parent as { remove?: (c: unknown) => void } | null | undefined;
				if (parent && typeof parent.remove === "function") {
					try {
						parent.remove(g);
					} catch {
						void 0;
					}
				}
				state.group = null;
			}
		},
		setLyricLines(lines: LyricLine[]) {
			state.lines = Array.isArray(lines) ? lines.slice() : [];
			state.currentIdx = -1;
		},
update(ctx: FrameContext) {
			if (state.disposed) return;
			if (!state.group) return;
			const dt = ctx.dt;
			const t = ctx.now;
			updateStageLyrics3D(dt, t, ctx.snapshot);
			const nowSeconds = opts.currentTimeSupplier ? opts.currentTimeSupplier() : 0;
			tickLyricsParticles(nowSeconds);
		},
		setPalette(palette: Partial<LyricPalette>) {
			state.paletteRuntime.set(palette);
			if (state.current && state.currentText) {
				const progress = (state.current.group as unknown as { userData: { lastLyricProgress?: number } }).userData.lastLyricProgress ?? 0;
				showStageLine(state.currentText, true);
				if (state.current) {
					updateLyricGroupProgress(
						{ group: state.current.group, textMat: state.current.textMat },
						progress,
					);
					(state.current.group as unknown as { userData: Record<string, unknown> }).userData.age = 0.48;
				}
			}
		},
		setShelfVisibility(v: number) {
			state.shelfVisibility = Number.isFinite(v) ? v : 0;
		},
		getCurrentIdx() {
			return state.currentIdx;
		},
		getCurrentText() {
			return state.currentText;
		},
		async whenIdle() {
			while (state.activeBuilds > 0) {
				const p = state.pendingBuildPromise;
				if (p) {
					await p;
				} else {
					await Promise.resolve();
				}
			}
		},
		dispose() {
			if (state.disposed) return;
			state.disposed = true;
			clearStageLyrics();
			if (state.group) {
				const g = state.group;
				const parent = (g as unknown as { parent?: unknown }).parent as { remove?: (c: unknown) => void } | null | undefined;
				if (parent && typeof parent.remove === "function") {
					try {
						parent.remove(g);
					} catch {
						void 0;
					}
				}
				state.group = null;
			}
		},
	};

	void resolveLyricPalette;
	void DEFAULT_LYRIC_PALETTE;
	void createLyricPaletteDriver;

	return lifecycle;
}

import type * as THREE from "three";
import type { ThreeFactory, ThreeModule } from "../runtime/renderer-setup";
import type { FrameContext } from "../runtime/frame-context";
import type { AudioSnapshot } from "../audio/audio-snapshot";
import { RenderStepSlot } from "../runtime/render-step-slot";
import type {
	GsapProvider,
} from "../control/control-console-motion";
import {
	type LyricGroup,
	buildLyricGroup,
	disposeLyricGroup,
	updateLyricGroupProgress,
} from "./lyric-builder";
import type { LyricPalette } from "./palette";
import { DEFAULT_LYRIC_PALETTE, resolveLyricPalette } from "./palette";
import { lyricThreeColor } from "./color-utils";
import { makeDotTexture } from "./lyric-dot-texture";
import { LyricPaletteRuntime } from "./palette-runtime";
import { createLyricPaletteDriver, type PaletteDriver } from "./palette-driver";
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
	getShelfPinnedOpen?: () => boolean;
	getShelfAlwaysVisible?: () => boolean;
	getShelfHoverCueValue?: () => number;
	getSkullShelfOpen?: () => boolean;
	dotTexture?: THREE.Texture;
	pixelScale?: number;
	maxAnisotropy?: number;
	lyricGlowParticlesSupplier?: () => boolean;
	lyricGlowStrengthSupplier?: () => number;
	lyricGlowBeatFlagSupplier?: () => boolean;
	lyricTextOptionsSupplier?: () => LyricTextOptions;
	lyricLayoutOptionsSupplier?: () => LyricLayoutOptions;
	skullMouthTransformSupplier?: () => SkullMouthTransform | null;
	skullBeatFlashSupplier?: () => number;
	coverWorldTransformSupplier?: () => StageLyricsWorldTransform | null;
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
	lyricsHasNativeKaraokeSupplier?: () => boolean;
	reduceMotion?: () => boolean;
	rand?: () => number;
}

export type CustomEaseCreator = (id: string, path: string) => string;
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
	requestCameraSnap(frames?: number): void;
	getCurrentIdx(): number;
	getCurrentText(): string;
	getMotionSnapshot(): StageLyricsMotionSnapshot;
	whenIdle(): Promise<void>;
	dispose(): void;
}

export interface StageLyricsMotionSnapshot {
	highBloom: number;
	beatGlow: number;
	beatPulse: number;
	bass: number;
	palette?: LyricPalette;
}

type Vec3Like = { x: number; y: number; z: number };
type QuatLike = { x: number; y: number; z: number; w: number };
export interface SkullMouthTransform {
	visible?: boolean;
	position: Vec3Like;
	quaternion: QuatLike;
}
export interface StageLyricsWorldTransform {
	position?: Vec3Like;
	quaternion?: QuatLike;
	updateMatrixWorld?: (force?: boolean) => void;
	getWorldPosition?: (target: Vec3Like) => Vec3Like;
	getWorldQuaternion?: (target: QuatLike) => QuatLike;
}
export interface LyricLayoutOptions {
	lyricCameraLock?: boolean;
	lyricScale?: number;
	lyricOffsetX?: number;
	lyricOffsetY?: number;
	lyricOffsetZ?: number;
	lyricTiltX?: number;
	lyricTiltY?: number;
	preset?: number;
	skullLyricEdgeGuard?: boolean;
	skullMouthLyrics?: boolean;
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
			age: number;
		}>,
		currentIdx: -1,
		currentText: "",
		highBloom: 0,
		beatGlow: 0,
		beatPulse: 0,
		bass: 0,
		mid: 0,
		glowFollowX: 0,
		glowFollowY: 0,
		glowFollowRoll: 0,
		starRiver: null as THREE.Object3D | null,
		starRiverWidth: 4.2,
		starRiverHeight: 0.58,
		three: null as ThreeModule | null,
		shelfVisibility: 0,
		lines: [] as LyricLine[],
		buildToken: 0,
		activeBuilds: 0,
		textOptionsSignature: "",
		lockFitScale: 1,
		snapCameraLockFrames: 0,
		lastFrame: null as { dt: number; t: number; snapshot: AudioSnapshot } | null,
		pendingBuildPromise: null as Promise<void> | null,
		paletteRuntime: new LyricPaletteRuntime(opts.palette),
		reduceMotionFlag: false,
		disposed: false,
	};

	const threeFactory: ThreeFactory = opts.threeFactory ?? DEFAULT_THREE_FACTORY;
	const goLerp = (cur: number, target: number, ease: number) => cur + (target - cur) * ease;

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

	function getShelfPinnedOpen(): boolean {
		return typeof opts.getShelfPinnedOpen === "function" ? !!opts.getShelfPinnedOpen() : false;
	}

	function getShelfAlwaysVisible(): boolean {
		return typeof opts.getShelfAlwaysVisible === "function" ? !!opts.getShelfAlwaysVisible() : false;
	}

	function getShelfHoverCueValue(): number {
		if (typeof opts.getShelfHoverCueValue !== "function") return 0;
		const value = opts.getShelfHoverCueValue();
		return Number.isFinite(value) ? value : 0;
	}

	function getSkullShelfOpen(): boolean {
		return typeof opts.getSkullShelfOpen === "function" ? !!opts.getSkullShelfOpen() : false;
	}

	function getLyricTextOptions(): LyricTextOptions {
		const raw = opts.lyricTextOptionsSupplier?.() ?? {};
		const lyricFont = normalizeFontKey(raw.lyricFont);
		return {
			lyricFont,
			lyricLetterSpacing: clamp(Number(raw.lyricLetterSpacing) || 0, -0.04, 0.18),
			lyricLineHeight: clamp(Number(raw.lyricLineHeight) || 1, 0.86, 1.35),
			lyricWeight: lyricFont === "stone-song" ? 900 : Math.round(clamp(Number(raw.lyricWeight) || 900, 500, 900) / 50) * 50,
		};
	}

	function textOptionsSignature(opts0: LyricTextOptions): string {
		return `${opts0.lyricFont ?? ""}|${opts0.lyricLetterSpacing ?? ""}|${opts0.lyricLineHeight ?? ""}|${opts0.lyricWeight ?? ""}`;
	}

	function shouldDimWallpaperForShelf(): boolean {
		if (getShelfMode() !== "side") return false;
		if (getShelfPinnedOpen()) return true;
		return getShelfHasOpenContent();
	}

	function shouldAvoidStageLyricsForShelf(): boolean {
		if (getShelfMode() !== "side") return false;
		if (getShelfAlwaysVisible()) return true;
		if (getShelfPinnedOpen()) return true;
		if (getShelfHasOpenContent()) return true;
		return getShelfVisibility() > 0.24 || getShelfHoverCueValue() > 0.28;
	}

	function getLyricLayoutOptions(): Required<LyricLayoutOptions> & {
		lockBaseDistance: number;
		wallpaperLyricLock: boolean;
		wallpaperShelfLyrics: boolean;
		skullLyricEdgeGuard: boolean;
		skullMouthLyrics: boolean;
	} {
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
			wallpaperLyricLock: false,
			wallpaperShelfLyrics: false,
			skullLyricEdgeGuard: !!raw.skullLyricEdgeGuard,
			skullMouthLyrics: !!raw.skullMouthLyrics,
		};
		const wallpaperLyricLock = layout.preset === 5 && layout.lyricCameraLock;
		if (wallpaperLyricLock) {
			const dimForShelf = shouldDimWallpaperForShelf();
			layout.wallpaperLyricLock = true;
			layout.wallpaperShelfLyrics = dimForShelf;
			layout.lyricScale *= dimForShelf ? 0.60 : 0.84;
			layout.lyricOffsetX = clamp(layout.lyricOffsetX + (dimForShelf ? -1.34 : 0), -2, 2);
			layout.lyricOffsetY = clamp(layout.lyricOffsetY + (dimForShelf ? -0.04 : 0.08), -1.2, 1.35);
			layout.lyricOffsetZ = clamp(layout.lyricOffsetZ + (dimForShelf ? 1.02 : 1.15), -1.6, 1.6);
			layout.lockBaseDistance = dimForShelf ? 5.58 : 4.85;
		} else if (layout.skullMouthLyrics) {
			const shelfAvoid = shouldAvoidStageLyricsForShelf();
			const skullShelfDetailOpen = getShelfHasOpenContent() && getSkullShelfOpen();
			layout.lyricScale *= skullShelfDetailOpen ? 0.52 : (shelfAvoid ? 0.58 : 0.66);
			if (shelfAvoid && !skullShelfDetailOpen) {
				layout.lyricOffsetX = clamp(layout.lyricOffsetX - 0.36, -2, 2);
				layout.lyricOffsetY = clamp(layout.lyricOffsetY + 0.02, -1.2, 1.35);
				layout.lyricOffsetZ = clamp(layout.lyricOffsetZ + 0.18, -1.6, 1.6);
			}
		} else if (
			layout.lyricCameraLock &&
			shouldAvoidStageLyricsForShelf() &&
			!getSkullShelfOpen()
		) {
			layout.lyricScale *= 0.72;
			layout.lyricOffsetX = clamp(layout.lyricOffsetX - 1.36, -2, 2);
			layout.lyricOffsetY = clamp(layout.lyricOffsetY + 0.06, -1.2, 1.35);
			layout.lyricOffsetZ = clamp(layout.lyricOffsetZ + 0.72, -1.6, 1.6);
		} else if (!layout.lyricCameraLock && getShelfMode() === "side" && getShelfHasOpenContent()) {
			const normalShelfDetailOpen = layout.preset !== 6;
			layout.lyricScale *= normalShelfDetailOpen ? 0.56 : 0.70;
			layout.lyricOffsetX = clamp(layout.lyricOffsetX - (normalShelfDetailOpen ? 1.78 : 1.58), -2, 2);
			layout.lyricOffsetY = clamp(layout.lyricOffsetY + (normalShelfDetailOpen ? 0.18 : 0.08), -1.2, 1.35);
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
		skullSafe = false,
	): number {
		const scale = Math.max(0.1, layoutScale || 1);
		const fov = ((camera.fov || 45) * Math.PI) / 180;
		const dist = Math.max(1.4, distance || 4.85);
		const visibleH = 2 * Math.tan(fov * 0.5) * dist;
		const visibleW = visibleH * (camera.aspect || 1.78);
		const bounds = getStageLyricLockBounds();
		const safeW = Math.max(
			visibleW * (skullSafe ? 0.36 : 0.42),
			visibleW * (skullSafe ? 0.70 : 0.84) - Math.abs(layoutX || 0) * (skullSafe ? 1.36 : 1.22),
		);
		const safeH = Math.max(
			visibleH * (skullSafe ? 0.16 : 0.18),
			visibleH * (skullSafe ? 0.34 : 0.44) - Math.abs(layoutY || 0) * (skullSafe ? 0.98 : 0.82),
		);
		const scaledW = Math.max(0.01, bounds.w * scale);
		const scaledH = Math.max(0.01, bounds.h * scale);
		const viewportFit = Math.min(1, safeW / scaledW, safeH / scaledH);
		const lockScaleCap = Math.min(1, (skullSafe ? 0.94 : 0.80) / scale);
		return clamp(Math.min(viewportFit, lockScaleCap), skullSafe ? 0.36 : 0.42, 1);
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

	function setGroupQuaternion(
		group: {
			quaternion?: { x: number; y: number; z: number; w: number; copy?: (q: { x: number; y: number; z: number; w: number }) => unknown };
			rotation?: { x: number; y: number; z: number };
		},
		q: { x: number; y: number; z: number; w: number },
		tiltX: number,
		tiltY: number,
	): void {
		if (group.quaternion?.copy) {
			group.quaternion.copy(q);
			return;
		}
		if (group.quaternion) {
			group.quaternion.x = q.x;
			group.quaternion.y = q.y;
			group.quaternion.z = q.z;
			group.quaternion.w = q.w;
			return;
		}
		if (group.rotation) {
			group.rotation.x = tiltX * Math.PI / 180;
			group.rotation.y = tiltY * Math.PI / 180;
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
			userData?: Record<string, unknown>;
		};
		setGroupScale(group, layout.lyricScale);
		const camera = layout.lyricCameraLock ? opts.cameraSupplier?.() ?? null : null;
		if (camera) {
			if (group.userData) group.userData.skullMouthLocked = false;
			const lockDistance = layout.lockBaseDistance + layout.lyricOffsetZ;
			const lockFit = lyricCameraLockFit(camera, layout.lyricScale, layout.lyricOffsetX, layout.lyricOffsetY, lockDistance, layout.preset === 6);
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
			const positionEase = layout.wallpaperLyricLock ? (layout.wallpaperShelfLyrics ? 0.42 : 0.34) : 0.24;
			const quaternionEase = layout.wallpaperLyricLock ? (layout.wallpaperShelfLyrics ? 0.44 : 0.36) : 0.22;
			const targetQuat = multiplyQuaternions(q, tiltQuaternionYXZ(layout.lyricTiltX, layout.lyricTiltY));
			if (state.snapCameraLockFrames > 0) {
				setGroupPosition(group, x, y, z);
				if (group.quaternion) {
					group.quaternion.x = targetQuat.x;
					group.quaternion.y = targetQuat.y;
					group.quaternion.z = targetQuat.z;
					group.quaternion.w = targetQuat.w;
				}
				state.snapCameraLockFrames -= 1;
			} else {
				if (group.position?.lerp) group.position.lerp({ x, y, z }, positionEase);
				else setGroupPosition(group, x, y, z);
				if (group.quaternion?.slerp) group.quaternion.slerp(targetQuat, quaternionEase);
				else if (group.quaternion) {
					group.quaternion.x = targetQuat.x;
					group.quaternion.y = targetQuat.y;
					group.quaternion.z = targetQuat.z;
					group.quaternion.w = targetQuat.w;
				}
			}
			return;
		}
		if (layout.skullLyricEdgeGuard || layout.skullMouthLyrics) {
			const lockDistance = layout.skullMouthLyrics
				? Math.max(2.2, 4.4 + layout.lyricOffsetZ)
				: layout.lockBaseDistance + layout.lyricOffsetZ;
			const edgeGuardCamera = opts.cameraSupplier?.() ?? null;
			let lockFit = edgeGuardCamera
				? lyricCameraLockFit(edgeGuardCamera, layout.lyricScale, layout.lyricOffsetX, layout.lyricOffsetY, lockDistance, layout.preset === 6 || layout.skullMouthLyrics)
				: 1;
			if (layout.skullMouthLyrics) lockFit = Math.min(lockFit, 1.12);
			state.lockFitScale += (lockFit - state.lockFitScale) * (lockFit < state.lockFitScale ? 0.18 : 0.10);
			state.lockFitScale = finiteOr(state.lockFitScale, 1);
			setGroupScale(group, layout.lyricScale * state.lockFitScale);
		} else {
			state.lockFitScale = 1;
		}
		const mouth = layout.skullMouthLyrics ? opts.skullMouthTransformSupplier?.() ?? null : null;
		if (mouth && mouth.visible !== false) {
			state.snapCameraLockFrames = 0;
			group.userData = group.userData ?? {};
			const q = mouth.quaternion;
			const right = normalizeVec(applyQuaternionToVec({ x: 1, y: 0, z: 0 }, q));
			const up = normalizeVec(applyQuaternionToVec({ x: 0, y: 1, z: 0 }, q));
			const forward = normalizeVec(applyQuaternionToVec({ x: 0, y: 0, z: 1 }, q));
			const x = mouth.position.x + right.x * layout.lyricOffsetX + up.x * layout.lyricOffsetY + forward.x * (layout.lyricOffsetZ + 0.020);
			const y = mouth.position.y + right.y * layout.lyricOffsetX + up.y * layout.lyricOffsetY + forward.y * (layout.lyricOffsetZ + 0.020);
			const z = mouth.position.z + right.z * layout.lyricOffsetX + up.z * layout.lyricOffsetY + forward.z * (layout.lyricOffsetZ + 0.020);
			const targetQuat = multiplyQuaternions(q, tiltQuaternionYXZ(layout.lyricTiltX, layout.lyricTiltY));
			if (!group.userData.skullMouthLocked) {
				setGroupPosition(group, x, y, z);
				if (group.quaternion) {
					group.quaternion.x = targetQuat.x;
					group.quaternion.y = targetQuat.y;
					group.quaternion.z = targetQuat.z;
					group.quaternion.w = targetQuat.w;
				}
				group.userData.skullMouthLocked = true;
			} else {
				if (group.position?.lerp) group.position.lerp({ x, y, z }, 0.26);
				else setGroupPosition(group, x, y, z);
				if (group.quaternion?.slerp) group.quaternion.slerp(targetQuat, 0.30);
				else if (group.quaternion) {
					group.quaternion.x = targetQuat.x;
					group.quaternion.y = targetQuat.y;
					group.quaternion.z = targetQuat.z;
					group.quaternion.w = targetQuat.w;
				}
			}
			return;
		}
		if (group.userData) group.userData.skullMouthLocked = false;
		state.snapCameraLockFrames = 0;
		const cover = opts.coverWorldTransformSupplier?.() ?? null;
		const basePos = { x: 0, y: 0, z: 0 };
		const baseQuat = { x: 0, y: 0, z: 0, w: 1 };
		if (cover) {
			cover.updateMatrixWorld?.(true);
			if (cover.getWorldPosition) cover.getWorldPosition(basePos);
			else if (cover.position) {
				basePos.x = cover.position.x;
				basePos.y = cover.position.y;
				basePos.z = cover.position.z;
			}
			if (cover.getWorldQuaternion) cover.getWorldQuaternion(baseQuat);
			else if (cover.quaternion) {
				baseQuat.x = cover.quaternion.x;
				baseQuat.y = cover.quaternion.y;
				baseQuat.z = cover.quaternion.z;
				baseQuat.w = cover.quaternion.w;
			}
		}
		const right = normalizeVec(applyQuaternionToVec({ x: 1, y: 0, z: 0 }, baseQuat));
		const up = normalizeVec(applyQuaternionToVec({ x: 0, y: 1, z: 0 }, baseQuat));
		const forward = normalizeVec(applyQuaternionToVec({ x: 0, y: 0, z: 1 }, baseQuat));
		const x = basePos.x + right.x * layout.lyricOffsetX + up.x * layout.lyricOffsetY + forward.x * layout.lyricOffsetZ;
		const y = basePos.y + right.y * layout.lyricOffsetX + up.y * layout.lyricOffsetY + forward.y * layout.lyricOffsetZ;
		const z = basePos.z + right.z * layout.lyricOffsetX + up.z * layout.lyricOffsetY + forward.z * layout.lyricOffsetZ;
		setGroupPosition(group, x, y, z);
		const targetQuat = multiplyQuaternions(baseQuat, tiltQuaternionYXZ(layout.lyricTiltX, layout.lyricTiltY));
		setGroupQuaternion(group, targetQuat, layout.lyricTiltX, layout.lyricTiltY);
	}

	function getShelfProfile(preset?: number) {
		const sv = getShelfVisibility();
		const shelfDetailOpen = getShelfHasOpenContent();
		const skullShelfDetailOpen = shelfDetailOpen && (preset ?? getLyricLayoutOptions().preset) === 6;
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

	function colorValue(THREE: ThreeModule, css: string | undefined, fallback: string, minLum: number) {
		const rgb = lyricThreeColor(css, fallback, minLum);
		try {
			return new THREE.Color(rgb.r, rgb.g, rgb.b);
		} catch {
			return rgb;
		}
	}

	function copyColor(target: unknown, value: unknown): void {
		const t = target as { copy?: (v: unknown) => unknown; r?: number; g?: number; b?: number } | null | undefined;
		const v = value as { r?: number; g?: number; b?: number } | null | undefined;
		if (!t || !v) return;
		if (typeof t.copy === "function") {
			t.copy(value);
			return;
		}
		if (typeof v.r === "number") t.r = v.r;
		if (typeof v.g === "number") t.g = v.g;
		if (typeof v.b === "number") t.b = v.b;
	}

	function lerpColorValue(from: unknown, to: unknown, amount: number): { r: number; g: number; b: number } | null {
		const a = from as { r?: number; g?: number; b?: number } | null | undefined;
		const b = to as { r?: number; g?: number; b?: number } | null | undefined;
		if (!a || !b || typeof a.r !== "number" || typeof a.g !== "number" || typeof a.b !== "number" || typeof b.r !== "number" || typeof b.g !== "number" || typeof b.b !== "number") return null;
		return {
			r: a.r + (b.r - a.r) * amount,
			g: a.g + (b.g - a.g) * amount,
			b: a.b + (b.b - a.b) * amount,
		};
	}

	function setMaterialColor(target: unknown, value: unknown): void {
		const color = (target as { color?: unknown } | null | undefined)?.color;
		copyColor(color, value);
	}

	function setUniformColor(mat: unknown, key: string, value: unknown): void {
		const u = (mat as { uniforms?: Record<string, { value?: unknown }> } | null | undefined)?.uniforms?.[key];
		if (u) copyColor(u.value, value);
	}

	function lyricSunColorValues(): { sun: unknown; hot: unknown } {
		const pal = state.paletteRuntime.get();
		if (!state.three) return {
			sun: lyricThreeColor(pal.glowColor || pal.secondary || pal.primary, "#ffe6a4", 0.44),
			hot: lyricThreeColor(pal.highlight || pal.primary, "#fff4cc", 0.54),
		};
		return {
			sun: colorValue(state.three, pal.glowColor || pal.secondary || pal.primary, "#ffe6a4", 0.44),
			hot: colorValue(state.three, pal.highlight || pal.primary, "#fff4cc", 0.54),
		};
	}

	function applyPaletteToLyric(lyric: LyricGroup | null | undefined): void {
		if (!lyric || !state.three) return;
		const pal = state.paletteRuntime.get();
		const uniforms0 = (lyric.textMat as unknown as { uniforms?: Record<string, { value?: unknown }>; needsUpdate?: boolean }).uniforms;
		if (uniforms0) {
			if (uniforms0.uBaseColor) copyColor(uniforms0.uBaseColor.value, colorValue(state.three, pal.primary, "#d6f8ff", 0.38));
			if (uniforms0.uHiColor) copyColor(uniforms0.uHiColor.value, colorValue(state.three, pal.highlight || pal.primary, "#fff0b8", 0.48));
			if (uniforms0.uGlowColor) copyColor(uniforms0.uGlowColor.value, colorValue(state.three, pal.glowColor || pal.secondary || pal.primary, "#9cffdf", 0.36));
			if (uniforms0.uSolarColor) copyColor(uniforms0.uSolarColor.value, colorValue(state.three, pal.highlight || pal.secondary || pal.primary, "#fff0b8", 0.50));
			if (uniforms0.uSolar && !Number.isFinite(Number(uniforms0.uSolar.value))) uniforms0.uSolar.value = 0;
			if (uniforms0.uOpacity && !Number.isFinite(Number(uniforms0.uOpacity.value))) uniforms0.uOpacity.value = 0;
			(lyric.textMat as unknown as { needsUpdate?: boolean }).needsUpdate = true;
		}
		setMaterialColor(lyric.glowMat, colorValue(state.three, pal.glowColor || pal.secondary || pal.primary, "#9cffdf", 0.36));
		setUniformColor(lyric.sparkMat, "uColor", colorValue(state.three, pal.highlight || pal.secondary || pal.primary, "#fff0b8", 0.46));
		setMaterialColor(lyric.sunMat, colorValue(state.three, pal.highlight || pal.secondary || pal.primary, "#fff0b8", 0.50));
	}

	function ensureLyricStarRiver(): THREE.Object3D | null {
		if (!state.group) return null;
		if (state.starRiver) return state.starRiver;
		const THREE = state.three;
		if (!THREE) return null;
		const count = 420;
		const geo = new THREE.BufferGeometry();
		const seeds = new Float32Array(count);
		const lanes = new Float32Array(count);
		const depths = new Float32Array(count);
		const rand = opts.rand ?? Math.random;
		for (let i = 0; i < count; i++) {
			seeds[i] = rand() * 1000;
			lanes[i] = rand();
			depths[i] = rand();
		}
		geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
		geo.setAttribute("lane", new THREE.BufferAttribute(lanes, 1));
		geo.setAttribute("depthSeed", new THREE.BufferAttribute(depths, 1));
		const pal = state.paletteRuntime.get();
		const mat = new THREE.ShaderMaterial({
			uniforms: {
				uMap: { value: opts.dotTexture ?? makeDotTexture(THREE) },
				uTime: { value: 0 },
				uPixel: { value: opts.pixelScale ?? 1 },
				uBass: { value: 0 },
				uBeat: { value: 0 },
				uWidth: { value: state.starRiverWidth || 4.2 },
				uHeight: { value: state.starRiverHeight || 0.58 },
				uOpacity: { value: 0 },
				uColorA: { value: colorValue(THREE, pal.secondary || pal.primary, "#9cffdf", 0.42) },
				uColorB: { value: colorValue(THREE, pal.highlight || pal.primary, "#fff7d2", 0.44) },
			},
			vertexShader: [
				"precision highp float;",
				"attribute float seed,lane,depthSeed;",
				"uniform float uTime,uPixel,uBass,uBeat,uWidth,uHeight;",
				"varying float vSeed,vLane,vGlow;",
				"float hash(float n){return fract(sin(n)*43758.5453123);}",
				"void main(){",
				"  float laneBand = floor(lane * 5.0);",
				"  float laneLocal = fract(lane * 5.0);",
				"  float speed = 0.030 + hash(seed * 1.71) * 0.055 + laneBand * 0.005;",
				"  float flow = fract(hash(seed * 2.13) + uTime * speed);",
				"  float x = (flow - 0.5) * uWidth * (1.08 + hash(seed * 5.1) * 0.18);",
				"  float curve = sin(flow * 6.2831853 * (0.92 + hash(seed * 4.0) * 0.46) + seed * 0.071 + uTime * 0.34);",
				"  float breath = sin(uTime * (0.42 + hash(seed * 6.9) * 0.42) + seed * 0.093);",
				"  float y = (laneBand - 2.0) * uHeight * 0.135 + curve * uHeight * (0.20 + hash(seed * 9.0) * 0.18) + (laneLocal - 0.5) * uHeight * 0.16 + breath * uHeight * 0.10;",
				"  float z = -0.08 + (depthSeed - 0.5) * 0.44 + sin(uTime * (0.18 + hash(seed) * 0.24) + seed) * 0.08;",
				"  vec3 pos = vec3(x, y, z);",
				"  float edge = smoothstep(0.0, 0.18, flow) * (1.0 - smoothstep(0.82, 1.0, flow));",
				"  vSeed = seed;",
				"  vLane = lane;",
				"  vGlow = edge * (0.62 + 0.38 * sin(uTime * (0.9 + hash(seed * 8.0) * 0.7) + seed));",
				"  vec4 mv = modelViewMatrix * vec4(pos, 1.0);",
				"  float dist = max(0.45, -mv.z);",
				"  float size = (0.030 + hash(seed * 12.0) * 0.040 + vGlow * 0.024 + uBeat * 0.010) * (1.0 + uBass * 0.18);",
				"  gl_PointSize = clamp(size * uPixel * 120.0 / dist, 1.0, 7.2);",
				"  gl_Position = projectionMatrix * mv;",
				"}",
			].join("\n"),
			fragmentShader: [
				"precision highp float;",
				"uniform sampler2D uMap;",
				"uniform vec3 uColorA,uColorB;",
				"uniform float uOpacity,uTime,uBeat;",
				"varying float vSeed,vLane,vGlow;",
				"void main(){",
				"  vec4 tex = texture2D(uMap, gl_PointCoord);",
				"  if(tex.a < 0.02) discard;",
				"  float tw = pow(0.5 + 0.5 * sin(uTime * (0.55 + fract(vSeed) * 0.35) + vSeed), 4.0);",
				"  vec3 col = mix(uColorA, uColorB, smoothstep(0.12, 0.92, vLane) * 0.45 + tw * 0.42 + vGlow * 0.26);",
				"  float alpha = tex.a * uOpacity * (0.20 + vGlow * 0.78 + tw * 0.32 + uBeat * 0.10);",
				"  gl_FragColor = vec4(col * (0.82 + vGlow * 0.72 + tw * 0.32), alpha);",
				"}",
			].join("\n"),
			transparent: true,
			depthWrite: false,
			depthTest: false,
			blending: THREE.AdditiveBlending,
		} as THREE.ShaderMaterialParameters) as THREE.ShaderMaterial;
		const points = new THREE.Points(geo, mat);
		(points as unknown as { renderOrder: number; frustumCulled: boolean }).renderOrder = 45;
		(points as unknown as { renderOrder: number; frustumCulled: boolean }).frustumCulled = false;
		setGroupPosition(points as unknown as { position?: { set?: (x: number, y: number, z: number) => void; x: number; y: number; z: number } }, 0, 0.20, 1.53);
		(state.group as unknown as { add: (c: unknown) => void }).add(points);
		state.starRiver = points;
		return points;
	}

	function updateLyricStarRiver(dt: number, t: number, skullPreset: boolean): void {
		const river = ensureLyricStarRiver() as unknown as {
			visible?: boolean;
			position?: { y: number; z: number };
			rotation?: { z: number };
			material?: { uniforms?: Record<string, { value: unknown }> };
		} | null;
		if (!river?.material?.uniforms) return;
		const u = river.material.uniforms;
		if (skullPreset) {
			river.visible = false;
			if (u.uOpacity) u.uOpacity.value = 0;
			return;
		}
		const data = (state.current?.group as unknown as { userData?: { lyric?: { textWorldW?: number; worldW?: number; textWorldH?: number; worldH?: number } } } | null)?.userData?.lyric ?? null;
		const targetW = data ? clamp((data.textWorldW || data.worldW || 4.2) * 1.12 + 0.80, 2.25, 7.20) : 3.4;
		const targetH = data ? clamp((data.textWorldH || data.worldH || 0.58) * 1.85 + 0.18, 0.52, 1.35) : 0.58;
		state.starRiverWidth += (targetW - state.starRiverWidth) * Math.min(1, dt * 5.2);
		state.starRiverHeight += (targetH - state.starRiverHeight) * Math.min(1, dt * 4.6);
		if (u.uWidth) u.uWidth.value = state.starRiverWidth;
		if (u.uHeight) u.uHeight.value = state.starRiverHeight;
		if (u.uTime) u.uTime.value = t;
		if (u.uBass) u.uBass.value = state.bass;
		if (u.uBeat) u.uBeat.value = state.beatGlow;
		const lyricGlowStrength = opts.lyricGlowStrengthSupplier ? Math.min(0.85, Math.max(0, opts.lyricGlowStrengthSupplier())) : 0;
		const targetOpacity = state.current && opts.lyricGlowParticlesSupplier?.()
			? clamp(0.22 + lyricGlowStrength * 0.58 + state.highBloom * 0.16 + state.beatGlow * 0.12, 0.16, 0.86)
			: 0;
		const opacity = Number(u.uOpacity?.value ?? 0);
		if (u.uOpacity) u.uOpacity.value = opacity + (targetOpacity - opacity) * (targetOpacity > opacity ? 0.10 : 0.055);
		const pal = state.paletteRuntime.get();
		if (state.three) {
			copyColor(u.uColorA?.value, colorValue(state.three, pal.secondary || pal.primary, "#9cffdf", 0.42));
			copyColor(u.uColorB?.value, colorValue(state.three, pal.highlight || pal.primary, "#fff7d2", 0.46));
		}
		river.visible = Number(u.uOpacity?.value ?? 0) > 0.01 || !!state.current;
		if (river.position) {
			river.position.y += ((0.18 + Math.sin(t * 0.44) * 0.035 + Math.sin(t * 0.91 + 1.7) * 0.018) - river.position.y) * 0.08;
			river.position.z += ((1.54 + Math.cos(t * 0.31) * 0.060) - river.position.z) * 0.08;
		}
		if (river.rotation) river.rotation.z = Math.sin(t * 0.22) * 0.012;
	}

	function uniforms<TLyric extends LyricGroup>(lyric: TLyric, key: string): SizeOfMaterial | null {
		const u = (lyric.textMat as unknown as UniformsOf<unknown>).uniforms;
		if (!u) return null;
		const slot = u[key];
		return slot ?? null;
	}

	function disposeCurrent(): void {
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

	function disposeStarRiver(): void {
		const river = state.starRiver as unknown as {
			parent?: { remove?: (c: unknown) => void };
			geometry?: { dispose?: () => void };
			material?: { dispose?: () => void; uniforms?: Record<string, { value?: { dispose?: () => void } }> };
		} | null;
		if (!river) return;
		try {
			river.parent?.remove?.(river);
		} catch {
			void 0;
		}
		try {
			river.geometry?.dispose?.();
		} catch {
			void 0;
		}
		try {
			river.material?.dispose?.();
		} catch {
			void 0;
		}
		state.starRiver = null;
	}

	function clearStageLyrics(): void {
		disposeCurrent();
		state.currentIdx = -1;
		state.currentText = "";
		while (state.outgoing.length) {
			const entry = state.outgoing.pop()!;
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

	function setScalar(target: unknown, scale: number): void {
		const s = target as { setScalar?: (v: number) => void; set?: (x: number, y: number, z: number) => void; x?: number; y?: number; z?: number } | null | undefined;
		if (!s) return;
		if (typeof s.setScalar === "function") {
			s.setScalar(scale);
			return;
		}
		if (typeof s.set === "function") {
			s.set(scale, scale, scale);
			return;
		}
		s.x = scale;
		s.y = scale;
		s.z = scale;
	}

	function setVector3(target: unknown, x: number, y: number, z: number): void {
		const p = target as { set?: (x: number, y: number, z: number) => void; x?: number; y?: number; z?: number } | null | undefined;
		if (!p) return;
		if (typeof p.set === "function") {
			p.set(x, y, z);
			return;
		}
		p.x = x;
		p.y = y;
		p.z = z;
	}

	function getUniformValue(mat: unknown, key: string, fallback: number): number {
		const u = (mat as { uniforms?: Record<string, { value?: unknown }> } | null | undefined)?.uniforms?.[key];
		const v = Number(u?.value);
		return Number.isFinite(v) ? v : fallback;
	}

	function setUniformValue(mat: unknown, key: string, value: number): void {
		const u = (mat as { uniforms?: Record<string, { value?: unknown }> } | null | undefined)?.uniforms?.[key];
		if (u) u.value = value;
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
			state.outgoing.push({ lyric: outgoingLyric, age: 0 });
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
				const lyricsHasNativeKaraoke = opts.lyricsHasNativeKaraokeSupplier
					? !!opts.lyricsHasNativeKaraokeSupplier()
					: !!opts.lyricsHasNativeKaraoke;
				const lyric = await buildLyricGroup(text, palette, {
					threeFactory,
					dotTexture: opts.dotTexture,
					pixelScale: opts.pixelScale,
					maxAnisotropy: opts.maxAnisotropy,
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
				if (state.lastFrame) {
					updateStageLyrics3D(state.lastFrame.dt, state.lastFrame.t, state.lastFrame.snapshot);
				}
				if (state.disposed || token !== state.buildToken || state.current !== lyric) {
					disposeLyricGroupSafe(lyric);
					return;
				}
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
				state.outgoing.push({ lyric: outgoingLyric, age: 0 });
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
		const a = (() => {
			const raw = Math.min(1, Number(userData.age || 0) / 0.52);
			return raw * raw * (3 - 2 * raw);
		})();
		const uOpacity = uniforms(mesh, "uOpacity");
		const uSolar = uniforms(mesh, "uSolar");
		const readabilityMat = mesh.readabilityMat as { opacity: number };
		const glowMat = mesh.glowMat as { opacity: number; color?: unknown };
		const sunMat = mesh.sunMat as { opacity: number; color?: unknown };
		const data = userData.lyric as {
			glow?: { position?: unknown; rotation?: { z: number } };
			sun?: { position?: unknown; rotation?: { z: number }; scale?: unknown };
			sparks?: { visible?: boolean; position?: unknown; rotation?: { x: number; z: number }; geometry?: { attributes?: { position?: { array: Float32Array; needsUpdate: boolean } } } };
			basePositions?: Float32Array;
			sparkMat?: unknown;
		} | undefined;
		const lyricGlowStrength = opts.lyricGlowStrengthSupplier ? Math.min(0.85, Math.max(0, opts.lyricGlowStrengthSupplier())) : 0;
		const lyricGlowParticles = opts.lyricGlowParticlesSupplier ? !!opts.lyricGlowParticlesSupplier() : false;
		const glowBeatFlag = opts.lyricGlowBeatFlagSupplier ? !!opts.lyricGlowBeatFlagSupplier() : false;
		const layout = getLyricLayoutOptions();
		const skullMouthLyrics = !!layout.skullMouthLyrics;
		const glowDrive = Math.min(1.7, Math.max(0, lyricGlowStrength / 0.5));
		const glowX = state.glowFollowX;
		const glowY = state.glowFollowY;
		const glowRoll = state.glowFollowRoll;
		if (data?.glow) {
			setVector3(data.glow.position, glowX * 0.14, glowY * 0.12, -0.006);
			if (data.glow.rotation) data.glow.rotation.z = glowRoll * 0.30;
		}
		if (data?.sun) {
			setVector3(data.sun.position, glowX * 0.42, 0.02 + glowY * 0.34, -0.035);
			if (data.sun.rotation) data.sun.rotation.z = glowRoll * 0.36;
		}
		if (data?.sparks) {
			setVector3(data.sparks.position, glowX * 0.24, glowY * 0.22, 0.010);
			if (data.sparks.rotation) data.sparks.rotation.z = glowRoll * 0.22;
		}
		const currentOpacity = uOpacity ? uOpacity.value : 0;
		const opacityTarget = shelf.profile.opacity;
		const opacityEase =
			shelf.shelfDetailOpen && currentOpacity > opacityTarget ? shelf.profile.easeDown : 0.16;
		const newOpacity = clamp(goLerp(currentOpacity, opacityTarget, opacityEase), 0, 1);
		if (uOpacity) (uOpacity as SizeOfMaterial).value = newOpacity;
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
			const solar = state.highBloom * shelf.profile.bloom;
			const glowTarget = lyricGlowStrength > 0 ? Math.min(shelf.profile.glowCap, (0.075 + solar * 0.34 + state.beatGlow * 0.16 * shelf.profile.bloom) * Math.min(3.0, glowDrive)) : 0;
			glowMat.opacity += (glowTarget - glowMat.opacity) * (glowTarget > glowMat.opacity ? 0.095 : (shelf.shelfDetailOpen ? 0.20 : 0.055));
			if (state.three) {
				const { hot } = lyricSunColorValues();
				const base = colorValue(state.three, state.paletteRuntime.get().glowColor || state.paletteRuntime.get().secondary, "#9cffdf", 0.36);
				setMaterialColor(glowMat, lerpColorValue(base, hot, Math.max(0, Math.min(1, solar * 1.10))) ?? base);
			}
		}
		const solar = state.highBloom * shelf.profile.bloom;
		if (data?.sparkMat) {
			const sparkTarget = lyricGlowStrength > 0 && lyricGlowParticles && !shelf.shelfDetailOpen ? Math.min(0.42, (0.10 + solar * 0.14 + state.beatGlow * 0.10) * Math.min(1.6, glowDrive)) : 0;
			const sparkOpacity = getUniformValue(data.sparkMat, "uOpacity", 0);
			setUniformValue(data.sparkMat, "uOpacity", sparkOpacity + (sparkTarget - sparkOpacity) * (sparkTarget > sparkOpacity ? 0.13 : (shelf.shelfDetailOpen ? 0.22 : 0.075)));
			const sparkSizeTarget = lyricGlowParticles && !shelf.shelfDetailOpen ? (0.050 + solar * 0.016 + state.beatGlow * 0.026 + state.bass * 0.008) : 0.035;
			const sparkSize = getUniformValue(data.sparkMat, "uSize", 0.052);
			setUniformValue(data.sparkMat, "uSize", sparkSize + (sparkSizeTarget - sparkSize) * 0.12);
			const { sun, hot } = lyricSunColorValues();
			const sparkColor = lerpColorValue(hot, sun, 0.22 + solar * 0.18);
			if (sparkColor) setUniformColor(data.sparkMat, "uColor", sparkColor);
		}
		if (sunMat) {
			const sunTarget = lyricGlowStrength > 0 && !shelf.shelfDetailOpen ? Math.min(0.88, (Math.pow(Math.min(1.35, state.highBloom), 1.08) * 0.28 + state.beatGlow * 0.20) * Math.min(2.4, glowDrive)) : 0;
			sunMat.opacity += (sunTarget - sunMat.opacity) * (shelf.shelfDetailOpen ? 0.18 : 0.055);
			const { sun, hot } = lyricSunColorValues();
			setMaterialColor(sunMat, lerpColorValue(sun, hot, solar * 0.55) ?? sun);
		}
		const seed = Number(userData.floatSeed || 0);
		if (data?.sun) {
			const sunPulse = solar;
			const beatScale = glowBeatFlag ? state.beatGlow * 0.24 : 0;
			const sx = 0.82 + sunPulse * 0.36 + beatScale + Math.sin(t * 1.6) * sunPulse * 0.018;
			const sy = 0.60 + sunPulse * 0.34 + beatScale * 0.72 + Math.cos(t * 1.25) * sunPulse * 0.020;
			const s = data.sun.scale as { set?: (x: number, y: number, z: number) => void; x?: number; y?: number; z?: number } | undefined;
			if (s?.set) s.set(sx, sy, 1);
			else if (s) {
				s.x = sx;
				s.y = sy;
				s.z = 1;
			}
			if (data.sun.rotation) data.sun.rotation.z += Math.sin(t * 0.32 + seed) * 0.010 * sunPulse;
		}
		const beatPulse = fallbackNumber(snapshot.beatPulse, 0);
		const bass = fallbackNumber(snapshot.bass, 0);
		const mid = fallbackNumber(snapshot.mid, 0);
		const breathe = Math.sin(t * 0.92 + seed) * 0.050 + Math.sin(t * 0.41 + seed * 0.7) * 0.028;
		const group = mesh.group as unknown as { position: Vec3Like; scale: unknown; rotation?: { z: number } };
		if (skullMouthLyrics) {
			const mouthMeshY = -0.070 + Math.sin(t * 0.50 + seed) * 0.018 + Math.sin(t * 1.12 + seed) * 0.006;
			const mouthMeshZ = 0.018 + Math.cos(t * 0.46 + seed) * 0.007;
			const mouthMeshScale = 1.08 + a * 0.040 + breathe * 0.12 + bass * 0.024 + beatPulse * 0.014;
			if (!userData.skullMouthMeshLocked) {
				setGroupPosition(group, 0, mouthMeshY, mouthMeshZ);
				userData.skullMouthMeshLocked = true;
			} else {
				group.position.x += (0 - group.position.x) * 0.18;
				group.position.y += (mouthMeshY - group.position.y) * 0.16;
				group.position.z += (mouthMeshZ - group.position.z) * 0.18;
			}
			setScalar(group.scale, mouthMeshScale);
			if (group.rotation) group.rotation.z = Math.sin(t * 0.30 + seed) * 0.010;
		} else {
			userData.skullMouthMeshLocked = false;
			setScalar(group.scale, 0.96 + a * 0.055 + breathe + bass * 0.038 + beatPulse * 0.014);
			group.position.y += ((0.18 + Math.sin(t * 0.55 + seed) * 0.055 + Math.sin(t * 1.35 + seed) * 0.014) - group.position.y) * 0.075;
			group.position.z += ((1.48 + Math.cos(t * 0.48 + seed) * 0.080) - group.position.z) * 0.080;
			if (group.rotation) group.rotation.z = Math.sin(t * 0.34 + seed) * 0.018;
		}
		const sparkOpacity = data?.sparkMat ? getUniformValue(data.sparkMat, "uOpacity", 0) : 0;
		if (data?.sparks) data.sparks.visible = lyricGlowParticles || sparkOpacity > 0.015;
		const attr = data?.sparks?.geometry?.attributes?.position;
		const base = data?.basePositions;
		if (attr?.array && base) {
			const arr = attr.array;
			if (data?.sparks?.rotation) {
				data.sparks.rotation.z += ((lyricGlowParticles ? 0.0009 : 0.00025) + state.beatGlow * 0.0007) * (dt * 60);
				data.sparks.rotation.x = Math.sin(t * 0.12 + seed) * 0.012;
			}
			for (let si = 0; si < arr.length / 3; si++) {
				const s = si * 12.989 + seed;
				const particleBeat = lyricGlowParticles ? state.beatGlow : 0;
				const dustBreath = lyricGlowParticles ? (0.62 + 0.38 * Math.sin(t * (0.32 + (si % 7) * 0.025) + s)) : 0.18;
				const drift = lyricGlowParticles ? 1 : 0.30;
				arr[si * 3] = base[si * 3] + Math.sin(t * (0.18 + (si % 5) * 0.025) + s) * (0.045 + bass * 0.030 + particleBeat * 0.052) * drift + Math.cos(t * 0.11 + s) * 0.018 * dustBreath;
				arr[si * 3 + 1] = base[si * 3 + 1] + Math.cos(t * (0.16 + (si % 6) * 0.024) + s) * (0.042 + mid * 0.026 + particleBeat * 0.046) * drift + Math.sin(t * 0.13 + s) * 0.016 * dustBreath;
				arr[si * 3 + 2] = base[si * 3 + 2] + Math.sin(t * (0.24 + (si % 4) * 0.035) + s) * (0.036 + particleBeat * 0.028) * drift;
			}
			attr.needsUpdate = true;
		}
	}

	function tickOutgoingMeshes(dt: number, shelf: ReturnType<typeof getShelfProfile>, _snapshot: AudioSnapshot, _t: number): void {
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
			const data = userData.lyric as {
				glow?: { position?: unknown; rotation?: { z: number } };
				sun?: { position?: unknown; rotation?: { z: number } };
				sparks?: { position?: unknown; rotation?: { z: number } };
				sparkMat?: unknown;
			} | undefined;
			const lyricGlowStrength = opts.lyricGlowStrengthSupplier ? Math.min(0.85, Math.max(0, opts.lyricGlowStrengthSupplier())) : 0;
			const lyricGlowParticles = opts.lyricGlowParticlesSupplier ? !!opts.lyricGlowParticlesSupplier() : false;
			const followMix = 0.64;
			const glowX = state.glowFollowX * followMix;
			const glowY = state.glowFollowY * followMix;
			const glowRoll = state.glowFollowRoll * followMix;
			if (data?.glow) {
				setVector3(data.glow.position, glowX * 0.14, glowY * 0.12, -0.006);
				if (data.glow.rotation) data.glow.rotation.z = glowRoll * 0.30;
			}
			if (data?.sun) {
				setVector3(data.sun.position, glowX * 0.42, 0.02 + glowY * 0.34, -0.035);
				if (data.sun.rotation) data.sun.rotation.z = glowRoll * 0.36;
			}
			if (data?.sparks) {
				setVector3(data.sparks.position, glowX * 0.24, glowY * 0.22, 0.010);
				if (data.sparks.rotation) data.sparks.rotation.z = glowRoll * 0.22;
			}
			const opacity = (1 - aSmooth) * 0.72 * shelf.profile.outgoing;
			if (uOpacity) (uOpacity as SizeOfMaterial).value = opacity;
			if (readabilityMat) readabilityMat.opacity = opacity * (shelf.shelfDetailOpen ? shelf.profile.readability : 0.58);
			const uSolar = uniforms(lyric, "uSolar");
			if (uSolar) (uSolar as SizeOfMaterial).value *= shelf.shelfDetailOpen ? 0.72 : 0.86;
			if (glowMat) glowMat.opacity = lyricGlowStrength > 0 ? (shelf.shelfDetailOpen ? Math.min(shelf.profile.glowCap * 0.40, opacity * 0.05 * lyricGlowStrength) : opacity * 0.08 * lyricGlowStrength) : 0;
			if (data?.sparkMat) {
				const outgoingSpark = lyricGlowStrength > 0 && lyricGlowParticles && !shelf.shelfDetailOpen ? Math.max(opacity * 0.24 * lyricGlowStrength, (1 - aSmooth) * 0.18 * lyricGlowStrength) : 0;
				setUniformValue(data.sparkMat, "uOpacity", outgoingSpark);
				setUniformValue(data.sparkMat, "uSize", 0.046 + (1 - aSmooth) * 0.020);
			}
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
		const lyricGlowStrength = opts.lyricGlowStrengthSupplier ? Math.min(0.85, Math.max(0, opts.lyricGlowStrengthSupplier())) : 0;
		const glowBeatFlag = opts.lyricGlowBeatFlagSupplier ? opts.lyricGlowBeatFlagSupplier() : false;
		const glowDrive = Math.min(1.7, Math.max(0, lyricGlowStrength / 0.5));
		const glowBreath = lyricGlowStrength > 0 ? 0.5 + 0.5 * Math.sin(t * 1.05) : 0;
		const lyricSunEnergy = opts.lyricSunEnergyHolder
			? opts.lyricSunEnergyHolder.get()
			: fallbackNumber(snapshot.lyricSunEnergy, 0);
		const beatPulseValue = fallbackNumber(snapshot.beatPulse, 0);
		state.beatPulse = clamp(beatPulseValue, 0, 1.4);
		state.bass = clamp(fallbackNumber(snapshot.bass, 0), 0, 1.2);
		state.mid = clamp(fallbackNumber(snapshot.mid, 0), 0, 1.2);
		const musicBloom = Math.max(lyricSunEnergy, beatPulseValue * 0.10);
		const kicks = opts.getBeatCamKick ? opts.getBeatCamKick() : null;
		const beatGlowRaw = glowBeatFlag && lyricGlowStrength > 0
			? Math.max(beatPulseValue * 1.22, (kicks?.punch ?? 0) * 0.86 + (kicks?.radiusKick ?? 0) * 1.85)
			: 0;
		state.beatGlow += (beatGlowRaw - state.beatGlow) * (beatGlowRaw > state.beatGlow ? 0.32 : 0.10);
		state.beatGlow = finiteOr(state.beatGlow, 0);
		const layout = getLyricLayoutOptions();
		const shelf = getShelfProfile(layout.preset);
		(state.group as unknown as { renderOrder: number }).renderOrder = shelf.shelfDetailOpen ? 24 : 38;
		const skullLyricPreset = layout.preset === 6;
		let solarBloom = lyricGlowStrength > 0
			? (0.18 + glowBreath * 0.16 + musicBloom * 0.90 + state.beatGlow * 1.18 + Math.sin(t * 0.37 + 1.2) * 0.035) * glowDrive
			: 0;
		if (skullLyricPreset && lyricGlowStrength > 0) {
			const skullBeatFlash = opts.skullBeatFlashSupplier ? opts.skullBeatFlashSupplier() : 0;
			solarBloom = (
				0.035 +
				glowBreath * 0.030 +
				musicBloom * 0.11 +
				Math.pow(Math.max(0, state.beatGlow), 1.26) * 1.45 +
				Math.pow(Math.max(0, skullBeatFlash || 0), 1.08) * 1.18
			) * glowDrive;
		}
		const solarBloomClamped = Math.max(0, Math.min(1.45, solarBloom));
		state.highBloom += (solarBloomClamped - state.highBloom) * (solarBloomClamped > state.highBloom ? (skullLyricPreset ? 0.22 : 0.075) : (skullLyricPreset ? 0.070 : 0.050));
		state.highBloom = finiteOr(state.highBloom, 0);
		updateLyricStarRiver(dt, t, skullLyricPreset);
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
			state.three = THREE;
			const scene = parent ?? opts.scene ?? null;
			if (state.group) {
				if (scene) (scene as unknown as { add: (c: unknown) => void }).add(state.group);
				ensureLyricStarRiver();
				return state.group;
			}
			const group = new THREE.Group() as THREE.Group;
			(group as unknown as { renderOrder: number }).renderOrder = 38;
			(group as unknown as { userData: Record<string, unknown> }).userData = { isStageLyricsGroup: true };
			state.group = group;
			if (scene) (scene as unknown as { add: (c: unknown) => void }).add(group);
			ensureLyricStarRiver();
			state.reduceMotionFlag = opts.reduceMotion ? !!opts.reduceMotion() : false;
			return group;
		},
		unmount() {
			clearStageLyrics();
			disposeStarRiver();
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
			state.lastFrame = { dt, t, snapshot: ctx.snapshot };
			const nowSeconds = opts.currentTimeSupplier ? opts.currentTimeSupplier() : 0;
			tickLyricsParticles(nowSeconds);
			updateStageLyrics3D(dt, t, ctx.snapshot);
		},
		setPalette(palette: Partial<LyricPalette>) {
			state.paletteRuntime.set(palette);
			applyPaletteToLyric(state.current);
			for (const entry of state.outgoing) applyPaletteToLyric(entry.lyric);
		},
		setShelfVisibility(v: number) {
			state.shelfVisibility = Number.isFinite(v) ? v : 0;
		},
		requestCameraSnap(frames = 10) {
			state.snapCameraLockFrames = Math.max(0, Math.floor(Number(frames) || 0));
		},
		getCurrentIdx() {
			return state.currentIdx;
		},
		getCurrentText() {
			return state.currentText;
		},
		getMotionSnapshot() {
			const palette = state.paletteRuntime.get();
			return {
				highBloom: clamp(state.highBloom, 0, 1.45),
				beatGlow: clamp(state.beatGlow, 0, 1.7),
				beatPulse: clamp(state.beatPulse, 0, 1.4),
				bass: clamp(state.bass, 0, 1.2),
				palette: { ...palette },
			};
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
			disposeStarRiver();
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

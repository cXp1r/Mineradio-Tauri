import type * as THREE from "three";
import type {
	VisualResourceHandle,
	VisualResourceRetention,
	VisualResourceScope,
} from "../../runtime/resource-scope";
import { LYRIC_MASK_H, LYRIC_MASK_W } from "../lyric-mask";
import {
	disposeLyricGroup,
	getLyricGroupResourceAllocation,
	type LyricGroup,
	type LyricGroupResourceAllocation,
	type LyricGroupResourceReservation,
} from "../lyric-builder";
import type { StageLyricRasterRow } from "../textures/structured-raster";
import { estimateLyricTextureBytes } from "../textures/texture-lease";

export interface StageLyricResourceBundle extends LyricGroupResourceAllocation {
	readonly textureBytes: number;
	readonly geometryBytes: number;
	readonly released: boolean;
	readonly retention?: VisualResourceRetention;
	setRetention?(retention: VisualResourceRetention): boolean;
	onRelease?(listener: () => void): () => void;
	release(): void;
}

export interface RegisterStageLyricResourceBundleOptions {
	readonly lyric: LyricGroup;
	readonly resourceScope: VisualResourceScope;
	readonly owner: string;
	readonly retention: VisualResourceRetention;
}

export interface StageLyricResourceEstimate {
	readonly textureBytes: number;
	readonly geometryBytes: number;
}

export interface EstimateStageLyricResourceBundleOptions {
	readonly structuredRows?: readonly Pick<StageLyricRasterRow, "offset">[];
	readonly structuredWidth?: number;
	readonly ownsDotTexture?: boolean;
}

export interface ReserveStageLyricResourceBundleOptions {
	readonly resourceScope: VisualResourceScope;
	readonly owner: string;
	readonly retention: VisualResourceRetention;
	readonly estimate: StageLyricResourceEstimate;
}

function assertEstimatedBytes(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${label} must be finite and non-negative.`);
	}
}

function isBudgetAdmissionError(error: unknown): boolean {
	return error instanceof Error && error.name === "VisualResourceBudgetAdmissionError";
}

function setHandleRetentionOrRelease(
	handles: readonly VisualResourceHandle[],
	nextRetention: VisualResourceRetention,
	release: () => void,
): boolean {
	try {
		for (const handle of handles) {
			if (
				handle.disposed
				|| typeof handle.setRetention !== "function"
				|| !handle.setRetention(nextRetention)
			) {
				release();
				return false;
			}
		}
		return true;
	} catch (error) {
		try {
			release();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Stage lyric retention transition and cleanup failed.",
			);
		}
		throw error;
	}
}

const stageLyricResourceBundles = new WeakMap<object, StageLyricResourceBundle>();

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * 在 Canvas/Three 创建前给整组歌词资源一次性估值。
 * 该 module 集中维护 mask、辅助纹理和固定几何体的预算语义，调用方无需了解实现细节。
 */
export function estimateStageLyricResourceBundle(
	options: EstimateStageLyricResourceBundleOptions = {},
): StageLyricResourceEstimate {
	const structuredRows = options.structuredRows ?? [];
	const structured = structuredRows.length > 0;
	const width = structured
		? Math.round(clamp(Number(options.structuredWidth) || 1024, 768, 3072))
		: LYRIC_MASK_W;
	const offsets = structuredRows.map((row) => row.offset);
	const offsetSpan = offsets.length > 0
		? Math.max(0, Math.max(...offsets) - Math.min(...offsets))
		: 0;
	const height = structured
		? Math.round(clamp(320 + offsetSpan * 64, LYRIC_MASK_H, width * 0.625))
		: LYRIC_MASK_H;
	const maskBytes = estimateLyricTextureBytes(width, height);
	const auxiliaryScale = structured ? 0.4 : 1;
	const auxiliaryWidth = Math.max(1, Math.round(width * auxiliaryScale));
	const auxiliaryHeight = Math.max(1, Math.round(height * auxiliaryScale));
	const auxiliaryBytes = estimateLyricTextureBytes(auxiliaryWidth, auxiliaryHeight);
	const dotBytes = options.ownsDotTexture
		? estimateLyricTextureBytes(64, 64)
		: 0;
	// 4 个 1x1 PlaneGeometry 加 132 个 spark 的 position/seed buffer。
	const planeGeometryBytes = 4 * ((4 * 3 + 4 * 3 + 4 * 2) * 4 + 6 * 2);
	const sparkGeometryBytes = 132 * (3 + 1) * Float32Array.BYTES_PER_ELEMENT;
	return {
		textureBytes: maskBytes + auxiliaryBytes * 2 + dotBytes,
		geometryBytes: planeGeometryBytes + sparkGeometryBytes,
	};
}

export function reserveStageLyricResourceBundle(
	options: ReserveStageLyricResourceBundleOptions,
): LyricGroupResourceReservation | null {
	assertEstimatedBytes(options.estimate.textureBytes, "Stage lyric texture estimate");
	assertEstimatedBytes(options.estimate.geometryBytes, "Stage lyric geometry estimate");
	const handles: VisualResourceHandle[] = [];
	let state: "active" | "committed" | "released" = "active";
	let retention = options.retention;
	let directDisposer: (() => void) | null = null;
	let releasing = false;
	const releaseListeners = new Set<() => void>();

	const allocation: StageLyricResourceBundle = {
		textureBytes: options.estimate.textureBytes,
		geometryBytes: options.estimate.geometryBytes,
		get released() {
			return state === "released";
		},
		get retention() {
			return retention;
		},
		setRetention(nextRetention) {
			if (state === "released") return false;
			if (retention === nextRetention) return true;
			if (!setHandleRetentionOrRelease(
				handles,
				nextRetention,
				() => allocation.release(),
			)) return false;
			retention = nextRetention;
			return true;
		},
		onRelease(listener) {
			if (state === "released") {
				listener();
				return () => {};
			}
			releaseListeners.add(listener);
			return () => releaseListeners.delete(listener);
		},
		release() {
			if (state === "released" || releasing) return;
			state = "released";
			releasing = true;
			const errors: unknown[] = [];
			try {
				for (const listener of releaseListeners) {
					try {
						listener();
					} catch (error) {
						errors.push(error);
					}
				}
				releaseListeners.clear();
				for (let index = handles.length - 1; index >= 0; index -= 1) {
					const report = handles[index]!.dispose();
					errors.push(...report.errors.map((error) => error.cause));
				}
				try {
					directDisposer?.();
				} catch (error) {
					errors.push(error);
				}
			} finally {
				directDisposer = null;
				releasing = false;
			}
			if (errors.length > 0) {
				throw new AggregateError(errors, "Stage lyric resource allocation release failed.");
			}
		},
	};
	stageLyricResourceBundles.set(allocation, allocation);
	const register = (
		kind: "texture" | "geometry" | "material" | "mesh",
		estimatedBytes?: number,
	) => {
		handles.push(options.resourceScope.register({
			owner: options.owner,
			kind,
			retention: options.retention,
			...(estimatedBytes === undefined ? {} : { estimatedBytes }),
			dispose: () => allocation.release(),
		}));
	};

	try {
		if (options.estimate.textureBytes > 0) register("texture", options.estimate.textureBytes);
		if (options.estimate.geometryBytes > 0) register("geometry", options.estimate.geometryBytes);
		for (let index = 0; index < 5; index += 1) register("material");
		for (let index = 0; index < 5; index += 1) register("mesh");
	} catch (error) {
		try {
			allocation.release();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Stage lyric resource reservation and rollback failed.",
			);
		}
		if (isBudgetAdmissionError(error)) return null;
		throw error;
	}

	return {
		get active() {
			return state === "active" && handles.every((handle) => !handle.disposed);
		},
		get committed() {
			return state === "committed";
		},
		allocation,
		commit(dispose) {
			if (state !== "active" || handles.some((handle) => handle.disposed)) return false;
			directDisposer = dispose;
			state = "committed";
			return true;
		},
		cancel() {
			if (state !== "active") return;
			allocation.release();
		},
	};
}

function geometryBytes(geometry: THREE.BufferGeometry | undefined): number {
	if (!geometry) return 0;
	const source = geometry as unknown as {
		attributes?: Record<string, { array?: { byteLength?: number } }>;
		index?: { array?: { byteLength?: number } } | null;
	};
	let bytes = Number(source.index?.array?.byteLength) || 0;
	for (const attribute of Object.values(source.attributes ?? {})) {
		bytes += Number(attribute.array?.byteLength) || 0;
	}
	return bytes;
}

function uniqueObjects<T extends object>(values: readonly (T | null | undefined)[]): T[] {
	return [...new Set(values.filter((value): value is T => !!value))];
}

export function registerStageLyricResourceBundle(
	options: RegisterStageLyricResourceBundleOptions,
): StageLyricResourceBundle {
	const { lyric } = options;
	const existingAllocation = getLyricGroupResourceAllocation(lyric);
	if (existingAllocation) {
		return stageLyricResourceBundles.get(existingAllocation as unknown as object) ?? existingAllocation;
	}
	const ownedTextureBytes = lyric.textureLeases
		.filter((lease) => lease.ownership === "owned")
		.reduce((total, lease) => total + lease.estimatedBytes, 0);
	const geometries = uniqueObjects<THREE.BufferGeometry>([
		lyric.textMesh.geometry,
		lyric.readability.geometry,
		lyric.glow.geometry,
		lyric.sparks.geometry,
		lyric.sun.geometry,
	]);
	const materials = uniqueObjects<THREE.Material>([
		lyric.textMat,
		lyric.readabilityMat,
		lyric.glowMat,
		lyric.sparkMat,
		lyric.sunMat,
	]);
	const meshes = uniqueObjects<THREE.Object3D>([
		lyric.textMesh,
		lyric.readability,
		lyric.glow,
		lyric.sparks,
		lyric.sun,
	]);
	const totalGeometryBytes = geometries.reduce(
		(total, geometry) => total + geometryBytes(geometry),
		0,
	);
	const handles: VisualResourceHandle[] = [];
	let released = false;
	let releasing = false;
	let retention = options.retention;
	const releaseListeners = new Set<() => void>();

	const bundle: StageLyricResourceBundle = {
		textureBytes: ownedTextureBytes,
		geometryBytes: totalGeometryBytes,
		get released() {
			return released;
		},
		get retention() {
			return retention;
		},
		setRetention(nextRetention) {
			if (released) return false;
			if (retention === nextRetention) return true;
			if (!setHandleRetentionOrRelease(
				handles,
				nextRetention,
				() => bundle.release(),
			)) return false;
			retention = nextRetention;
			return true;
		},
		onRelease(listener) {
			if (released) {
				listener();
				return () => {};
			}
			releaseListeners.add(listener);
			return () => releaseListeners.delete(listener);
		},
		release() {
			if (released || releasing) return;
			released = true;
			releasing = true;
			const errors: unknown[] = [];
			try {
				for (const listener of releaseListeners) {
					try {
						listener();
					} catch (error) {
						errors.push(error);
					}
				}
				releaseListeners.clear();
				for (let index = handles.length - 1; index >= 0; index -= 1) {
					const report = handles[index]!.dispose();
					errors.push(...report.errors.map((error) => error.cause));
				}
				try {
					disposeLyricGroup(lyric);
				} catch (error) {
					errors.push(error);
				}
			} finally {
				releasing = false;
			}
			if (errors.length > 0) {
				throw new AggregateError(errors, "Stage lyric resource bundle release failed.");
			}
		},
	};
	stageLyricResourceBundles.set(bundle, bundle);

	const register = (
		kind: "texture" | "geometry" | "material" | "mesh",
		estimatedBytes?: number,
	) => {
		handles.push(options.resourceScope.register({
			owner: options.owner,
			kind,
			retention: options.retention,
			...(estimatedBytes === undefined ? {} : { estimatedBytes }),
			dispose: () => bundle.release(),
		}));
	};

	try {
		if (ownedTextureBytes > 0) register("texture", ownedTextureBytes);
		if (totalGeometryBytes > 0) register("geometry", totalGeometryBytes);
		for (const _material of materials) register("material");
		for (const _mesh of meshes) register("mesh");
		return bundle;
	} catch (error) {
		bundle.release();
		throw error;
	}
}

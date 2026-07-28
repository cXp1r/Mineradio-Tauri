import type * as THREE from "three";
import type {
	VisualResourceRetention,
	VisualResourceScope,
} from "../../runtime/resource-scope";

export type TextureOwnership = "owned" | "borrowed";

export interface LyricTextureLease<TTexture extends THREE.Texture = THREE.Texture> {
	readonly texture: TTexture;
	readonly ownership: TextureOwnership;
	readonly estimatedBytes: number;
	readonly canvas?: HTMLCanvasElement;
	readonly released: boolean;
	release(): void;
}

export interface CreateLyricTextureLeaseOptions<TTexture extends THREE.Texture> {
	readonly texture: TTexture;
	readonly ownership: TextureOwnership;
	readonly estimatedBytes: number;
	readonly canvas?: HTMLCanvasElement;
	readonly releaseAllocation?: () => void;
}

export interface AllocateOwnedLyricTextureLeaseOptions<TTexture extends THREE.Texture> {
	readonly owner: string;
	readonly estimatedBytes: number;
	readonly retention: VisualResourceRetention;
	readonly resourceScope: VisualResourceScope;
	create(): { readonly texture: TTexture; readonly canvas?: HTMLCanvasElement };
}

function assertEstimatedBytes(value: number): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError("Lyric texture estimatedBytes must be finite and non-negative.");
	}
}

function inferCanvas(texture: THREE.Texture): HTMLCanvasElement | undefined {
	const image = (texture as unknown as { image?: unknown }).image;
	if (
		image &&
		typeof (image as { getContext?: unknown }).getContext === "function" &&
		typeof (image as { width?: unknown }).width === "number" &&
		typeof (image as { height?: unknown }).height === "number"
	) {
		return image as HTMLCanvasElement;
	}
	return undefined;
}

export function recycleLyricCanvas(canvas: HTMLCanvasElement | undefined): void {
	if (!canvas) return;
	canvas.width = 1;
	canvas.height = 1;
}

export function estimateLyricTextureBytes(
	width: number,
	height: number,
	multiplier = 8.8,
): number {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
		throw new RangeError("Lyric texture dimensions must be finite and non-negative.");
	}
	if (!Number.isFinite(multiplier) || multiplier < 0) {
		throw new RangeError("Lyric texture byte multiplier must be finite and non-negative.");
	}
	return Math.ceil(width * height * multiplier);
}

export function createLyricTextureLease<TTexture extends THREE.Texture>(
	options: CreateLyricTextureLeaseOptions<TTexture>,
): LyricTextureLease<TTexture> {
	assertEstimatedBytes(options.estimatedBytes);
	const canvas = options.canvas ?? inferCanvas(options.texture);
	let released = false;
	return {
		texture: options.texture,
		ownership: options.ownership,
		estimatedBytes: options.estimatedBytes,
		canvas,
		get released() {
			return released;
		},
		release() {
			if (released) return;
			released = true;
			if (options.ownership === "owned") {
				try {
					options.texture.dispose();
				} catch {
					// 单个纹理释放失败不能阻断 Canvas 和预算回收。
				}
				recycleLyricCanvas(canvas);
			}
			try {
				options.releaseAllocation?.();
			} catch {
				// 预算释放器由 ledger 提供，异常也不应破坏幂等语义。
			}
		},
	};
}

export function allocateOwnedLyricTextureLease<TTexture extends THREE.Texture>(
	options: AllocateOwnedLyricTextureLeaseOptions<TTexture>,
): LyricTextureLease<TTexture> | null {
	assertEstimatedBytes(options.estimatedBytes);
	let directLease: LyricTextureLease<TTexture> | null = null;
	const handle = options.resourceScope.register({
		owner: options.owner,
		kind: "texture",
		retention: options.retention,
		estimatedBytes: options.estimatedBytes,
		dispose: () => directLease?.release(),
	});
	let created: { readonly texture: TTexture; readonly canvas?: HTMLCanvasElement };
	try {
		created = options.create();
	} catch (error) {
		handle.dispose();
		throw error;
	}
	directLease = createLyricTextureLease({
		...created,
		ownership: "owned",
		estimatedBytes: options.estimatedBytes,
	});
	if (handle.disposed) {
		directLease.release();
		return null;
	}
	const ownedLease = directLease;
	return {
		texture: ownedLease.texture,
		ownership: "owned",
		estimatedBytes: ownedLease.estimatedBytes,
		canvas: ownedLease.canvas,
		get released() {
			return handle.disposed;
		},
		release() {
			handle.dispose();
		},
	};
}

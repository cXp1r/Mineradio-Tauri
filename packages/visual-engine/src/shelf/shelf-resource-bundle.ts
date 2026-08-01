import type * as THREE from "three";
import type {
	VisualResourceHandle,
	VisualResourceKind,
	VisualResourceScope,
} from "../runtime/resource-scope";

export interface ShelfRenderableResource {
	readonly texture: THREE.Texture;
	readonly geometry: THREE.BufferGeometry;
	readonly material: THREE.Material;
	readonly mesh: THREE.Object3D;
	retire(): void;
	dispose(): void;
}

export interface ShelfResourceBundle {
	readonly released: boolean;
	release(): void;
}

export interface RegisterShelfResourceBundleOptions {
	readonly owner: string;
	readonly resource: ShelfRenderableResource;
	readonly resourceScope?: VisualResourceScope;
	onRelease(): void;
}

interface ShelfResourceReleaseStep {
	readonly kind: Extract<VisualResourceKind, "texture" | "geometry" | "material" | "mesh">;
	readonly estimatedBytes?: number;
	readonly dispose: () => void;
	handle: VisualResourceHandle | null;
	disposed: boolean;
}

function estimateGpuTextureBytes(texture: THREE.Texture): number | undefined {
	const image = texture.image as
		| { width?: number; height?: number }
		| undefined;
	const width = Number(image?.width);
	const height = Number(image?.height);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return undefined;
	}
	return Math.ceil(width * height * 4);
}

function estimateGeometryBytes(geometry: THREE.BufferGeometry): number | undefined {
	const source = geometry as THREE.BufferGeometry & {
		attributes?: Record<string, { array?: { byteLength?: number } }>;
	};
	let bytes = Number(source.index?.array?.byteLength) || 0;
	for (const attribute of Object.values(source.attributes ?? {})) {
		bytes += Number(attribute.array?.byteLength) || 0;
	}
	return bytes > 0 ? bytes : undefined;
}

export function registerShelfResourceBundle(
	options: RegisterShelfResourceBundleOptions,
): ShelfResourceBundle {
	let released = false;
	let releasing = false;
	const steps: ShelfResourceReleaseStep[] = [
		{
			kind: "texture",
			estimatedBytes: estimateGpuTextureBytes(options.resource.texture),
			dispose: () => options.resource.texture.dispose(),
			handle: null,
			disposed: false,
		},
		{
			kind: "geometry",
			estimatedBytes: estimateGeometryBytes(options.resource.geometry),
			dispose: () => options.resource.geometry.dispose(),
			handle: null,
			disposed: false,
		},
		{
			kind: "material",
			dispose: () => options.resource.material.dispose(),
			handle: null,
			disposed: false,
		},
		{
			kind: "mesh",
			dispose: () => {
				try {
					options.onRelease();
				} finally {
					options.resource.retire();
				}
			},
			handle: null,
			disposed: false,
		},
	];

	const updateReleased = () => {
		released = steps.every((step) => step.disposed);
	};
	const disposeStep = (step: ShelfResourceReleaseStep) => {
		if (step.disposed) return;
		step.disposed = true;
		try {
			step.dispose();
		} finally {
			updateReleased();
		}
	};

	const bundle: ShelfResourceBundle = {
		get released() {
			return released;
		},
		release() {
			if (released || releasing) return;
			releasing = true;
			const errors: unknown[] = [];
			try {
				for (let index = steps.length - 1; index >= 0; index -= 1) {
					const step = steps[index]!;
					if (step.handle) {
						const report = step.handle.dispose();
						errors.push(...report.errors.map((error) => error.cause));
						if (step.disposed) continue;
					}
					try {
						disposeStep(step);
					} catch (error) {
						errors.push(error);
					}
				}
			} finally {
				releasing = false;
			}
			if (errors.length > 0) {
				throw new AggregateError(errors, "Shelf resource bundle release failed.");
			}
		},
	};

	try {
		for (const step of steps) {
			if (!options.resourceScope) continue;
			step.handle = options.resourceScope.register({
				owner: options.owner,
				kind: step.kind,
				retention: "rebuildable",
				...(step.estimatedBytes === undefined ? {} : { estimatedBytes: step.estimatedBytes }),
				dispose: () => disposeStep(step),
			});
		}
		return bundle;
	} catch (error) {
		try {
			bundle.release();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Shelf resource registration and rollback failed.",
			);
		}
		throw error;
	}
}

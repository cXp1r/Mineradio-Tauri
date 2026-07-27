import type { VisualResourceUsage } from "./visual-engine-contract";

export interface ThreeResourceObjectLike {
	readonly children?: readonly ThreeResourceObjectLike[];
	readonly geometry?: unknown;
	readonly material?: unknown;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function numericDimension(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function imageByteEstimate(value: unknown): number {
	if (Array.isArray(value)) {
		return value.reduce((total, image) => total + imageByteEstimate(image), 0);
	}
	if (!isRecord(value)) return 0;
	const width =
		numericDimension(value.width) || numericDimension(value.naturalWidth);
	const height =
		numericDimension(value.height) || numericDimension(value.naturalHeight);
	return width * height * 4;
}

export function scanThreeResourceUsage(
	root: ThreeResourceObjectLike,
): VisualResourceUsage {
	const seenObjects = new WeakSet<object>();
	const seenGeometries = new WeakSet<object>();
	const seenMaterials = new WeakSet<object>();
	const seenTextures = new WeakSet<object>();
	const seenArrays = new WeakSet<object>();
	let textureBytes = 0;
	let geometryBytes = 0;
	let meshCount = 0;

	const scanTexture = (value: unknown) => {
		if (!isRecord(value) || value.isTexture !== true || seenTextures.has(value)) {
			return;
		}
		seenTextures.add(value);
		const source = isRecord(value.source) ? value.source : undefined;
		textureBytes += imageByteEstimate(source?.data ?? value.image);
	};

	const scanTextureValue = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const item of value) scanTexture(item);
			return;
		}
		scanTexture(value);
	};

	const scanMaterial = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const material of value) scanMaterial(material);
			return;
		}
		if (!isRecord(value) || seenMaterials.has(value)) return;
		seenMaterials.add(value);
		for (const property of Object.values(value)) scanTextureValue(property);
		if (!isRecord(value.uniforms)) return;
		for (const uniform of Object.values(value.uniforms)) {
			if (isRecord(uniform)) scanTextureValue(uniform.value);
		}
	};

	const scanArray = (value: unknown) => {
		if (!isRecord(value) || seenArrays.has(value)) return;
		const byteLength = value.byteLength;
		if (
			typeof byteLength !== "number" ||
			!Number.isFinite(byteLength) ||
			byteLength < 0
		) {
			return;
		}
		seenArrays.add(value);
		geometryBytes += byteLength;
	};

	const scanAttribute = (value: unknown) => {
		if (!isRecord(value)) return;
		scanArray(value.array);
		if (isRecord(value.data)) scanArray(value.data.array);
	};

	const scanGeometry = (value: unknown) => {
		if (!isRecord(value) || seenGeometries.has(value)) return;
		seenGeometries.add(value);
		if (isRecord(value.attributes)) {
			for (const attribute of Object.values(value.attributes)) {
				scanAttribute(attribute);
			}
		}
		scanAttribute(value.index);
	};

	const scanObject = (value: unknown) => {
		if (!isRecord(value) || seenObjects.has(value)) return;
		seenObjects.add(value);
		if (value.geometry !== undefined || value.material !== undefined) {
			meshCount += 1;
		}
		scanGeometry(value.geometry);
		scanMaterial(value.material);
		if (!Array.isArray(value.children)) return;
		for (const child of value.children) scanObject(child);
	};

	scanObject(root);
	return {
		textureBytes,
		geometryBytes,
		meshCount,
		queuedTaskCost: 0,
		cacheBytes: 0,
	};
}

import { expect, test } from "bun:test";
import {
	scanThreeResourceUsage,
	type ThreeResourceObjectLike,
} from "../index";

test("shared Three resource identities are counted once without disposal", () => {
	const disposeCounts = {
		geometry: 0,
		material: 0,
		texture: 0,
		object: 0,
	};
	const positions = new Float32Array(6);
	const indices = new Uint16Array(3);
	const texture = {
		isTexture: true,
		image: { width: 4, height: 2 },
		dispose: () => {
			disposeCounts.texture += 1;
		},
	};
	const geometry = {
		attributes: { position: { array: positions } },
		index: { array: indices },
		dispose: () => {
			disposeCounts.geometry += 1;
		},
	};
	const material = {
		map: texture,
		roughnessMap: texture,
		dispose: () => {
			disposeCounts.material += 1;
		},
	};
	const firstMesh = {
		geometry,
		material,
		children: [],
		dispose: () => {
			disposeCounts.object += 1;
		},
	};
	const secondMesh = {
		geometry,
		material,
		children: [],
		dispose: () => {
			disposeCounts.object += 1;
		},
	};
	const scene = {
		children: [firstMesh, secondMesh, firstMesh],
		dispose: () => {
			disposeCounts.object += 1;
		},
	};

	expect(scanThreeResourceUsage(scene)).toEqual({
		textureBytes: 4 * 2 * 4,
		geometryBytes: positions.byteLength + indices.byteLength,
		meshCount: 2,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});
	expect(disposeCounts).toEqual({
		geometry: 0,
		material: 0,
		texture: 0,
		object: 0,
	});
});

test("common interleaved geometry, material arrays, and shader uniforms are scanned without recursive object walks", () => {
	let disposeCalls = 0;
	const sharedInterleaved = new Float32Array(8);
	const interleavedOnly = new Int16Array(5);
	const indices = new Uint32Array(3);
	const uniqueUvs = new Uint16Array(4);
	const geometryA = {
		attributes: {
			position: { data: { array: sharedInterleaved } },
			normal: { data: { array: sharedInterleaved } },
			uv: { data: { array: interleavedOnly } },
		},
		index: { array: indices },
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const geometryB = {
		attributes: {
			color: { array: sharedInterleaved },
			uv: { array: uniqueUvs },
		},
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const directTexture = {
		isTexture: true,
		source: { data: { width: 2, height: 3 } },
		image: { width: 100, height: 100 },
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const naturalTexture = {
		isTexture: true,
		source: { data: { naturalWidth: 5, naturalHeight: 1 } },
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const arrayTexture = {
		isTexture: true,
		image: { naturalWidth: 1, naturalHeight: 2 },
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const ignoredTexture = {
		isTexture: true,
		image: { width: 10, height: 10 },
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const shaderMaterial: Record<string, unknown> = {
		map: directTexture,
		uniforms: {
			diffuse: { value: naturalTexture },
			layers: { value: [directTexture, arrayTexture] },
			nested: { value: { texture: ignoredTexture } },
		},
		userData: { texture: ignoredTexture },
		dispose: () => {
			disposeCalls += 1;
		},
	};
	shaderMaterial.self = shaderMaterial;
	const secondaryMaterial = {
		normalMap: naturalTexture,
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const points = {
		geometry: geometryA,
		material: [shaderMaterial, secondaryMaterial],
		children: [] as ThreeResourceObjectLike[],
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const line = {
		geometry: geometryB,
		material: shaderMaterial,
		children: [] as ThreeResourceObjectLike[],
		dispose: () => {
			disposeCalls += 1;
		},
	};
	const scene: ThreeResourceObjectLike = { children: [points, line] };
	points.children.push(scene);

	expect(scanThreeResourceUsage(scene)).toEqual({
		textureBytes: 2 * 3 * 4 + 5 * 1 * 4 + 1 * 2 * 4,
		geometryBytes:
			sharedInterleaved.byteLength +
			interleavedOnly.byteLength +
			indices.byteLength +
			uniqueUvs.byteLength,
		meshCount: 2,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});
	expect(disposeCalls).toBe(0);
});

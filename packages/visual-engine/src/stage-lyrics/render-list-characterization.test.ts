import { expect, test } from "bun:test";
import * as THREE from "three";
import { WebGLRenderList } from "three/src/renderers/webgl/WebGLRenderLists.js";

interface RenderableEntry {
	readonly name: string;
	readonly groupOrder: number;
	readonly renderOrder: number;
}

function collectThreeRenderEntries(root: THREE.Object3D): RenderableEntry[] {
	const list = new WebGLRenderList({} as never);
	const visit = (object: THREE.Object3D, inheritedGroupOrder: number): void => {
		if (!object.visible) return;
		const groupOrder = object instanceof THREE.Group
			? object.renderOrder
			: inheritedGroupOrder;
		if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
			list.push(
				object,
				(object as THREE.Mesh).geometry,
				(object as THREE.Mesh).material as THREE.Material,
				groupOrder,
				0,
				null,
			);
		}
		for (const child of object.children) visit(child, groupOrder);
	};
	visit(root, 0);
	list.sort(undefined as never, undefined as never);
	return [...list.opaque, ...list.transparent].map((entry) => ({
		name: entry.object.name,
		groupOrder: entry.groupOrder,
		renderOrder: entry.renderOrder,
	}));
}

function makeLayerScene(renderBase: 24 | 38): THREE.Scene {
	const scene = new THREE.Scene();
	const material = new THREE.MeshBasicMaterial();
	const geometry = new THREE.PlaneGeometry(1, 1);
	const passiveShelf = new THREE.Group();
	passiveShelf.renderOrder = 30;
	const shelfCard = new THREE.Mesh(geometry, material);
	shelfCard.name = "passive-shelf";
	passiveShelf.add(shelfCard);

	const stage = new THREE.Group();
	stage.renderOrder = renderBase;
	const lyricRow = new THREE.Group();
	lyricRow.renderOrder = renderBase;
	const text = new THREE.Mesh(geometry, material);
	text.name = "stage-text";
	text.renderOrder = 43;
	lyricRow.add(text);
	stage.add(lyricRow);

	scene.add(passiveShelf, stage);
	return scene;
}

test("Three.js render-list traversal places normal Stage rows above passive Shelf", () => {
	const entries = collectThreeRenderEntries(makeLayerScene(38));
	expect(entries.map((entry) => entry.name)).toEqual(["passive-shelf", "stage-text"]);
	expect(entries.find((entry) => entry.name === "stage-text")?.groupOrder).toBe(38);
});

test("Three.js render-list traversal places detail-open Stage rows below passive Shelf", () => {
	const entries = collectThreeRenderEntries(makeLayerScene(24));
	expect(entries.map((entry) => entry.name)).toEqual(["stage-text", "passive-shelf"]);
	expect(entries.find((entry) => entry.name === "stage-text")?.groupOrder).toBe(24);
});

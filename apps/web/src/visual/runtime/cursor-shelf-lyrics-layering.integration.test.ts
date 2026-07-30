import { expect, test } from "bun:test";
import "../../../../../packages/visual-engine/src/runtime/happy-dom-preload";
import {
	createRuntimeUniforms,
	createShelfManager,
	type FrameContext,
} from "@mineradio/visual-engine";
import * as THREE from "three";
import { WebGLRenderList } from "three/src/renderers/webgl/WebGLRenderLists.js";
import {
	createCursorActivityRuntime,
	type CursorActivityDocument,
	type CursorActivityWindow,
} from "./cursor-activity-runtime";
import { connectCursorActivityToShelf } from "./create-legacy-visual-composition";

function createLayeringHarness() {
	const classes = new Set<string>();
	const windowListeners = new Map<string, Set<EventListener>>();
	const documentListeners = new Map<string, Set<EventListener>>();
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	let hidden = false;
	const windowTarget = {
		addEventListener(type: string, listener: EventListener) {
			let listeners = windowListeners.get(type);
			if (!listeners) windowListeners.set(type, listeners = new Set());
			listeners.add(listener);
		},
		removeEventListener(type: string, listener: EventListener) {
			windowListeners.get(type)?.delete(listener);
		},
		setTimeout(callback: () => void) {
			const handle = nextTimer++;
			timers.set(handle, callback);
			return handle;
		},
		clearTimeout(handle: number) {
			timers.delete(handle);
		},
	} as CursorActivityWindow;
	const documentTarget = {
		get hidden() { return hidden; },
		body: {
			classList: {
				add: (value: string) => { classes.add(value); },
				remove: (value: string) => { classes.delete(value); },
			},
		},
		addEventListener(type: string, listener: EventListener) {
			let listeners = documentListeners.get(type);
			if (!listeners) documentListeners.set(type, listeners = new Set());
			listeners.add(listener);
		},
		removeEventListener(type: string, listener: EventListener) {
			documentListeners.get(type)?.delete(listener);
		},
		createElement() {
			return {
				width: 0,
				height: 0,
				getContext() {
					return {
						clearRect() {}, fillRect() {}, roundRect() {}, beginPath() {},
						fill() {}, stroke() {}, moveTo() {}, lineTo() {}, save() {},
						restore() {}, clip() {}, fillText() {},
						createLinearGradient: () => ({ addColorStop() {} }),
						measureText: (text: string) => ({ width: text.length * 8 }),
					};
				},
			};
		},
	} as unknown as Document & CursorActivityDocument;
	return {
		classes,
		documentTarget,
		windowTarget,
		fireIdleTimer() {
			const pending = [...timers.values()];
			timers.clear();
			for (const callback of pending) callback();
		},
		emitActivity(type: string) {
			for (const listener of [...(windowListeners.get(type) ?? [])]) {
				listener(new Event(type));
			}
		},
		setHidden(nextHidden: boolean) {
			hidden = nextHidden;
			for (const listener of [...(documentListeners.get("visibilitychange") ?? [])]) {
				listener(new Event("visibilitychange"));
			}
		},
		resourceCounts() {
			return {
				timers: timers.size,
				windowListeners: [...windowListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0),
				documentListeners: [...documentListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0),
			};
		},
	};
}

function collectRenderNames(scene: THREE.Scene): string[] {
	const list = new WebGLRenderList({} as never);
	const visit = (object: THREE.Object3D, inheritedGroupOrder: number): void => {
		if (!object.visible) return;
		const groupOrder = object instanceof THREE.Group ? object.renderOrder : inheritedGroupOrder;
		if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
			const material = (object as THREE.Mesh).material;
			if (!Array.isArray(material)) {
				list.push(object, (object as THREE.Mesh).geometry, material, groupOrder, 0, null);
			}
		}
		for (const child of object.children) visit(child, groupOrder);
	};
	visit(scene, 0);
	list.sort(undefined as never, undefined as never);
	return [...list.opaque, ...list.transparent].map((entry) => entry.object.name).filter(Boolean);
}

function createStageRows(scene: THREE.Scene): { stage: THREE.Group; rows: THREE.Group[] } {
	const stage = new THREE.Group();
	stage.renderOrder = 38;
	const rows = ["stage-current", "stage-outgoing"].map((name) => {
		const row = new THREE.Group();
		row.renderOrder = 38;
		const text = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 1),
			new THREE.MeshBasicMaterial({ transparent: true }),
		);
		text.name = name;
		text.renderOrder = 43;
		row.add(text);
		stage.add(row);
		return row;
	});
	scene.add(stage);
	return { stage, rows };
}

test("idle cursor, passive Shelf, nested lyrics and detail layer converge in one runtime scenario", () => {
	const harness = createLayeringHarness();
	const scene = new THREE.Scene();
	const shelfGroup = new THREE.Group();
	scene.add(shelfGroup);
	const shelf = createShelfManager({
		scene,
		group: shelfGroup,
		three: THREE,
		document: harness.documentTarget,
	});
	shelf.setData([{ title: "Selected", playlistId: "playlist" }], { asyncBuild: false });
	shelf.setMode("side");
	shelf.setShelfPresence("always");
	shelf.setShelfVisibility(1);
	shelf.setSelectedIdx(0);
	const cursor = createCursorActivityRuntime({
		window: harness.windowTarget,
		document: harness.documentTarget,
	});
	const disconnect = connectCursorActivityToShelf({ cursorActivity: cursor, shelfManager: shelf });
	const { stage, rows } = createStageRows(scene);
	const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
	camera.position.z = 10;
	camera.updateMatrixWorld(true);
	const uniforms = createRuntimeUniforms();
	const frame = (now: number): FrameContext => {
		uniforms.uTime.value = now / 1000;
		return {
			dt: 1 / 60,
			now,
			snapshot: {} as never,
			uniforms,
			scene,
			camera,
			pointerParallax: { x: 0, y: 0 },
			pointerTarget: { x: 0, y: 0 },
			viewport: { width: 800, height: 600 },
		} as unknown as FrameContext;
	};

	shelf.update(frame(16));
	const selected = shelfGroup.children.find((child) => child.userData.shelfCardIndex === 0);
	if (selected) selected.name = "shelf-selected";
	const visibleLift = selected?.position.y ?? 0;
	expect(shelfGroup.renderOrder).toBe(50);
	const visibleOrder = collectRenderNames(scene);
	expect(visibleOrder.indexOf("stage-current")).toBeLessThan(
		visibleOrder.indexOf("shelf-selected"),
	);

	harness.fireIdleTimer();
	shelf.update(frame(32));
	expect(cursor.getSnapshot().hidden).toBe(true);
	expect(shelf.getSelectedIdx()).toBe(0);
	expect(selected?.position.y ?? 0).toBeLessThan(visibleLift);
	expect(shelfGroup.renderOrder).toBe(30);
	expect(rows.map((row) => row.renderOrder)).toEqual([38, 38]);
	const hiddenOrder = collectRenderNames(scene);
	expect(hiddenOrder.indexOf("shelf-selected")).toBeLessThan(
		hiddenOrder.indexOf("stage-current"),
	);

	shelf.openDetail(0);
	stage.renderOrder = 24;
	for (const row of rows) row.renderOrder = 24;
	shelf.getContentList()?.setRows([{ id: "row", name: "Detail row" }]);
	shelf.update(frame(48));
	const detailGroup = shelfGroup.children.find((child) => child.userData.shelfContentDetailGroup === true);
	expect(detailGroup?.renderOrder ?? 0).toBeGreaterThan(shelfGroup.renderOrder);
	expect(rows.map((row) => row.renderOrder)).toEqual([24, 24]);
	const detailMesh = detailGroup?.children.find((child) => child.userData.shelfContentDetail === true);
	if (detailMesh) detailMesh.name = "shelf-detail";
	const detailOrder = collectRenderNames(scene);
	expect(detailOrder.indexOf("stage-current")).toBeLessThan(
		detailOrder.indexOf("shelf-detail"),
	);

	shelf.clearSelected();
	harness.emitActivity("pointermove");
	shelf.closeDetail({ immediate: true });
	shelf.setShelfPinnedOpen(false);
	shelf.update(frame(64));
	expect(cursor.getSnapshot().hidden).toBe(false);
	expect(shelf.getSelectedIdx()).toBe(-1);
	expect(shelfGroup.renderOrder).toBe(30);

	disconnect();
	cursor.dispose();
	shelf.dispose();
	harness.setHidden(true);
	expect(harness.classes.has("cursor-hidden")).toBe(false);
	expect(harness.resourceCounts()).toEqual({ timers: 0, windowListeners: 0, documentListeners: 0 });
});

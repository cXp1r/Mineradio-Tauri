import { expect, test } from "bun:test";
import "../../../../../packages/visual-engine/src/runtime/happy-dom-preload";
import {
	createBudgetTaskQueue,
	createRuntimeUniforms,
	createShelfManager,
	createStageLyricsLifecycle,
	createVisualResourceLedger,
	createVisualResourceScope,
	createVisualSubsystemDiagnosticsRegistry,
	type FrameContext,
} from "@mineradio/visual-engine";
import { __inspectVisualResourceScopeForTests } from "../../../../../packages/visual-engine/src/runtime/resource-scope";
import * as THREE from "three";
import { WebGLRenderList } from "three/src/renderers/webgl/WebGLRenderLists.js";
import {
	createCursorActivityRuntime,
	type CursorActivityDocument,
	type CursorActivityWindow,
} from "./cursor-activity-runtime";
import {
	connectCursorActivityToShelf,
	createStageLyricsShelfSuppliers,
} from "./create-legacy-visual-composition";

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

function attachedStageRows(group: THREE.Group | null): THREE.Group[] {
	return (group?.children ?? []).filter((child): child is THREE.Group =>
		child instanceof THREE.Group && !!child.userData.lyric);
}

function nameStageTextMeshes(rows: readonly THREE.Group[], prefix: string): string[] {
	return rows.map((row, index) => {
		const name = `${prefix}-${index}`;
		const lyric = row.userData.lyric as { textMesh?: THREE.Object3D } | undefined;
		if (!lyric?.textMesh) throw new Error("生产 Stage lyric row 缺少 text mesh。");
		lyric.textMesh.name = name;
		return name;
	});
}

test("idle cursor, passive Shelf, production Stage lyrics and detail layer converge in one runtime scenario", async () => {
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
	const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
	camera.position.z = 10;
	camera.updateMatrixWorld(true);
	const uniforms = createRuntimeUniforms();
	let lyricTimeSeconds = 0.5;
	const resourceScope = createVisualResourceScope("d1-layering-integration");
	const resourceLedger = createVisualResourceLedger({
		budget: {
			textureBytes: 64 * 1024 * 1024,
			geometryBytes: 16 * 1024 * 1024,
			meshCount: 512,
			queuedTaskCost: 128,
			cacheBytes: 64 * 1024 * 1024,
		},
	});
	const taskQueue = createBudgetTaskQueue({
		ledger: resourceLedger,
		resourceScope,
	});
	const diagnostics = createVisualSubsystemDiagnosticsRegistry();
	const uploadedTextures: THREE.Texture[] = [];
	const stageLyrics = createStageLyricsLifecycle({
		threeFactory: async () => THREE,
		currentTimeSupplier: () => lyricTimeSeconds,
		isPlayingSupplier: () => true,
		audioDurationSupplier: () => 999,
		particleLyricsFlagSupplier: () => true,
		rand: () => 0.35,
		taskQueue,
		resourceScope,
		diagnostics,
		clarityQualitySupplier: () => "balanced",
		stageLyricsSettingsSupplier: () => ({ textureClarity: 2 }),
		textureUploadExecutor: (texture) => {
			uploadedTextures.push(texture);
		},
		...createStageLyricsShelfSuppliers({ shelfManager: shelf }),
	});
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
	const settleStageLyrics = async (startAtMs: number): Promise<void> => {
		for (let attempt = 0; attempt < 120; attempt += 1) {
			taskQueue.runSlice(64);
			stageLyrics.update(frame(startAtMs + attempt));
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const queue = taskQueue.getSnapshot();
			const stage = diagnostics.snapshot()["stage-lyrics"] as {
				activeBuilds?: number;
				pendingBuilds?: number;
				pendingUploads?: number;
			} | undefined;
			if (
				queue.queued === 0
				&& queue.running === 0
				&& stage?.activeBuilds === 0
				&& stage.pendingBuilds === 0
				&& stage.pendingUploads === 0
			) {
				await stageLyrics.whenIdle();
				return;
			}
		}
		throw new Error("生产 Stage lyrics 未在有界帧数内收敛。");
	};

	await stageLyrics.mount(scene);
	stageLyrics.setLyricLines([
		{ t: 0, text: "First row" },
		{ t: 1, text: "Second row" },
		{ t: 2, text: "Third row" },
	]);
	stageLyrics.update(frame(1));
	await settleStageLyrics(2);
	expect(stageLyrics.getCurrentText()).toBe("First row");
	expect(diagnostics.snapshot()["stage-lyrics"]?.residentRows).toBe(3);
	expect(uploadedTextures.length).toBeGreaterThan(0);
	expect(__inspectVisualResourceScopeForTests(resourceScope).activeResourceEntryCount).toBeGreaterThan(0);

	// 激活已预热的第二行时不得重新进入 raster queue；下一帧完成真实 upload/takeover。
	const completedBeforeSecond = taskQueue.getSnapshot().completed;
	lyricTimeSeconds = 1.1;
	stageLyrics.update(frame(14));
	stageLyrics.update(frame(15));
	expect(taskQueue.getSnapshot().completed).toBe(completedBeforeSecond);
	expect(stageLyrics.getCurrentText()).toBe("Second row");
	let rows = attachedStageRows(stageLyrics.group);
	expect(rows.length).toBe(2);
	expect(rows.map((row) => row.renderOrder)).toEqual([38, 38]);

	shelf.update(frame(16));
	const selected = shelfGroup.children.find((child) => child.userData.shelfCardIndex === 0);
	if (selected) selected.name = "shelf-selected";
	const visibleLift = selected?.position.y ?? 0;
	expect(shelfGroup.renderOrder).toBe(50);
	const normalStageNames = nameStageTextMeshes(rows, "stage-normal");
	const visibleOrder = collectRenderNames(scene);
	for (const name of normalStageNames) {
		expect(visibleOrder.indexOf(name)).toBeLessThan(visibleOrder.indexOf("shelf-selected"));
	}

	harness.fireIdleTimer();
	shelf.update(frame(32));
	stageLyrics.update(frame(32));
	expect(cursor.getSnapshot().hidden).toBe(true);
	expect(shelf.getSelectedIdx()).toBe(0);
	expect(selected?.position.y ?? 0).toBeLessThan(visibleLift);
	expect(shelfGroup.renderOrder).toBe(30);
	expect(rows.map((row) => row.renderOrder)).toEqual([38, 38]);
	const hiddenOrder = collectRenderNames(scene);
	for (const name of normalStageNames) {
		expect(hiddenOrder.indexOf("shelf-selected")).toBeLessThan(hiddenOrder.indexOf(name));
	}

	shelf.openDetail(0);
	shelf.getContentList()?.setRows([{ id: "row", name: "Detail row" }]);
	shelf.update(frame(48));
	stageLyrics.update(frame(48));
	const detailGroup = shelfGroup.children.find((child) => child.userData.shelfContentDetailGroup === true);
	expect(detailGroup?.renderOrder ?? 0).toBeGreaterThan(shelfGroup.renderOrder);
	rows = attachedStageRows(stageLyrics.group);
	expect(rows.map((row) => row.renderOrder)).toEqual([24, 24]);
	const detailMesh = detailGroup?.children.find((child) => child.userData.shelfContentDetail === true);
	if (detailMesh) detailMesh.name = "shelf-detail";
	const detailStageNames = nameStageTextMeshes(rows, "stage-detail");
	const detailOrder = collectRenderNames(scene);
	for (const name of detailStageNames) {
		expect(detailOrder.indexOf(name)).toBeLessThan(detailOrder.indexOf("shelf-detail"));
	}

	// 第三行在 attach 前已接收 detail-open 的 24 base，激活仍不新增 raster task。
	const completedBeforeThird = taskQueue.getSnapshot().completed;
	lyricTimeSeconds = 2.1;
	stageLyrics.update(frame(49));
	stageLyrics.update(frame(50));
	expect(taskQueue.getSnapshot().completed).toBe(completedBeforeThird);
	expect(stageLyrics.getCurrentText()).toBe("Third row");
	rows = attachedStageRows(stageLyrics.group);
	expect(rows.length).toBeGreaterThanOrEqual(1);
	expect(rows.every((row) => row.renderOrder === 24)).toBe(true);

	shelf.clearSelected();
	harness.emitActivity("pointermove");
	shelf.closeDetail({ immediate: true });
	shelf.setShelfPinnedOpen(false);
	shelf.update(frame(64));
	stageLyrics.update(frame(64));
	expect(cursor.getSnapshot().hidden).toBe(false);
	expect(shelf.getSelectedIdx()).toBe(-1);
	expect(shelfGroup.renderOrder).toBe(30);
	expect(attachedStageRows(stageLyrics.group).every((row) => row.renderOrder === 38)).toBe(true);

	stageLyrics.dispose();
	taskQueue.dispose();
	disconnect();
	cursor.dispose();
	shelf.dispose();
	harness.setHidden(true);
	expect(stageLyrics.group).toBeNull();
	expect(shelf.getRenderedCardCount()).toBe(0);
	expect(shelf.getResourceDiagnostics().detailPanels).toBe(0);
	expect(scene.children.length).toBe(0);
	const scopeDiagnostics = __inspectVisualResourceScopeForTests(resourceScope);
	expect(scopeDiagnostics.activeResourceEntryCount).toBe(0);
	expect(scopeDiagnostics.retainedDisposerCount).toBe(0);
	const queueSnapshot = taskQueue.getSnapshot();
	expect({ queued: queueSnapshot.queued, running: queueSnapshot.running }).toEqual({ queued: 0, running: 0 });
	const ledgerSnapshot = resourceLedger.getSnapshot();
	expect(ledgerSnapshot.current).toEqual({
		textureBytes: 0,
		geometryBytes: 0,
		meshCount: 0,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});
	expect(ledgerSnapshot.releases).toBe(ledgerSnapshot.allocations);
	expect(diagnostics.snapshot()["stage-lyrics"]).toBe(undefined);
	expect(harness.classes.has("cursor-hidden")).toBe(false);
	expect(harness.resourceCounts()).toEqual({ timers: 0, windowListeners: 0, documentListeners: 0 });
	const disposal = resourceScope.dispose();
	expect(disposal.errors).toEqual([]);
	expect(resourceScope.closed).toBe(true);
});

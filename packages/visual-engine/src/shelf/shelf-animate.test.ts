import { expect, test } from "bun:test";
import "../runtime/happy-dom-preload";
import type { FrameContext } from "../runtime/frame-context";
import type { RuntimeUniforms } from "../runtime/uniforms";
import { createRuntimeUniforms } from "../runtime/uniforms";
import { SHELF_MAX_RENDER } from "./card-position";
import { CONTENT_MAX_RENDER } from "./shelf-content-list";
import { getDefaultShelfLayoutProfile } from "./shelf-layout-profile";
import {
	createShelfManager,
	type ShelfItem,
	type ShelfManager,
} from "./shelf-animate";

function makeCtx(uniforms: RuntimeUniforms, now = 0, dt = 0): FrameContext {
	return {
		dt,
		now,
		snapshot: {} as never,
		uniforms,
		scene: {} as never,
		camera: {} as never,
		pointerParallax: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
	};
}

function makeRaycastShelfDeps(): {
	children: Array<{ visible: boolean; userData: Record<string, unknown> }>;
	documentLike: Document;
	three: typeof import("three");
} {
	const children: Array<{ visible: boolean; userData: Record<string, unknown> }> = [];
	class FakeGroup {
		visible = true;
		add(obj: { visible: boolean; userData: Record<string, unknown> }) {
			children.push(obj);
		}
		remove(obj: { visible: boolean; userData: Record<string, unknown> }) {
			const idx = children.indexOf(obj);
			if (idx >= 0) children.splice(idx, 1);
		}
	}
	class FakeMesh {
		position = { set() {} };
		rotation = { set() {} };
		scale = { setScalar() {} };
		visible = true;
		renderOrder = 0;
		userData: Record<string, unknown> = {};
		constructor(
			public geometry: unknown,
			public material: unknown,
		) {}
	}
	const documentLike = {
		createElement() {
			return {
				width: 0,
				height: 0,
				getContext() {
					return {
						clearRect() {},
						fillRect() {},
						roundRect() {},
						beginPath() {},
						fill() {},
						stroke() {},
						moveTo() {},
						lineTo() {},
						save() {},
						restore() {},
						clip() {},
						createLinearGradient() {
							return { addColorStop() {} };
						},
						measureText(text: string) {
							return { width: text.length * 8 };
						},
						fillText() {},
					};
				},
			};
		},
	} as unknown as Document;
	const three = {
		Group: FakeGroup,
		Mesh: FakeMesh,
		PlaneGeometry: class {
			dispose() {}
		},
		CanvasTexture: class {
			needsUpdate = false;
			minFilter: unknown = null;
			magFilter: unknown = null;
			generateMipmaps = true;
			dispose() {}
		},
		MeshBasicMaterial: class {
			opacity = 1;
			color = { setScalar() {} };
			constructor(init: Record<string, unknown>) {
				Object.assign(this, init);
			}
			dispose() {}
		},
		LinearFilter: "LinearFilter",
		DoubleSide: "DoubleSide",
	} as unknown as typeof import("three");
	return { children, documentLike, three };
}

function makeCanvasDocument(): Document {
	return {
		createElement() {
			return {
				width: 0,
				height: 0,
				getContext() {
					return {
						clearRect() {},
						fillRect() {},
						roundRect() {},
						beginPath() {},
						fill() {},
						stroke() {},
						moveTo() {},
						lineTo() {},
						save() {},
						restore() {},
						clip() {},
						createLinearGradient() {
							return { addColorStop() {} };
						},
						measureText(text: string) {
							return { width: text.length * 8 };
						},
						fillText() {},
					};
				},
			};
		},
	} as unknown as Document;
}

test("ShelfManager.setData stores items length in state.lastSig", () => {
	const m = createShelfManager({});
	m.setData([
		{ type: "playlist", title: "A", playlistId: "p1" },
		{ type: "playlist", title: "B", playlistId: "p2" },
	]);
	expect(m.getData().length).toBe(2);
	expect(m.getState().lastSig).toContain("2");
});

test("ShelfManager.setSelectedIdx persists into state", () => {
	const m = createShelfManager({});
	m.setSelectedIdx(3);
	expect(m.getSelectedIdx()).toBe(3);
	expect(m.getState().selectedIdx).toBe(3);
});

test("ShelfManager.clearSelected resets selectedIdx to baseline empty selection", () => {
	const m = createShelfManager({});
	m.setSelectedIdx(3);
	m.clearSelected();
	expect(m.getSelectedIdx()).toBe(-1);
	expect(m.getState().selectedIdx).toBe(-1);
});

test("ShelfManager.scrollBy clamps centerTarget to shelf data and exposes rounded center", () => {
	const m = createShelfManager({});
	m.setData(Array.from({ length: 4 }, (_, i) => ({ type: "queue", title: `Q${i}` })));
	m.scrollBy(2);
	expect(m.getState().centerTarget).toBe(2);
	expect(m.getCenterIdx()).toBe(0);

	m.getState().centerSmooth = 1.6;
	expect(m.getCenterIdx()).toBe(2);

	m.scrollBy(99);
	expect(m.getState().centerTarget).toBe(3);
	m.scrollBy(-99);
	expect(m.getState().centerTarget).toBe(0);
});

test("ShelfManager.setShelfPane tracks pane memory and switches shelfPane", () => {
	const m = createShelfManager({});
	m.getState().centerTarget = 2;
	m.setShelfPane("fav");
	expect(m.getShelfPane()).toBe("fav");
	expect(m.getState().paneMemory.mine).toBe(2);
});

test("ShelfManager.setShelfPane restores remembered target, overshoots by pane direction, and timestamps switch", () => {
	const m = createShelfManager({});
	m.setData(Array.from({ length: 8 }, (_, i) => ({ type: "queue", title: `Q${i}` })));
	m.getState().centerTarget = 2.4;
	m.getState().paneMemory.fav = 5;

	m.setShelfPane("fav", 12.5);

	expect(m.getShelfPane()).toBe("fav");
	expect(m.getState().paneMemory.mine).toBe(2);
	expect(m.getState().centerTarget).toBe(5);
	expect(m.getState().centerIdx).toBe(5);
	expect(m.getState().centerSmooth).toBeCloseTo(6.85, 5);
	expect(m.getState().paneSwitchDir).toBe(1);
	expect(m.getState().paneSwitchAt).toBe(12.5);
	expect(m.getState().shelfOpenAnimAt).toBe(12.5);

	m.getState().paneMemory.mine = 1;
	m.setShelfPane("mine", 13.25);
	expect(m.getState().centerTarget).toBe(1);
	expect(m.getState().centerIdx).toBe(1);
	expect(m.getState().centerSmooth).toBeCloseTo(0, 5);
	expect(m.getState().paneSwitchDir).toBe(-1);
	expect(m.getState().paneSwitchAt).toBe(13.25);
	expect(m.getState().shelfOpenAnimAt).toBe(13.25);
});

test("ShelfManager.setMode switches state.mode", () => {
	const m = createShelfManager({});
	m.setMode("stage");
	expect(m.getMode()).toBe("stage");
	expect(m.getState().mode).toBe("stage");
});

test("ShelfManager.schedulePaneSwitch records paneSwitchDir sign only", () => {
	const m = createShelfManager({});
	m.schedulePaneSwitch(-5);
	expect(m.getState().paneSwitchDir).toBe(-1);
	m.schedulePaneSwitch(7);
	expect(m.getState().paneSwitchDir).toBe(1);
});

test("ShelfManager.setShelfVisibility stays in state for downstream consumers", () => {
	const m = createShelfManager({});
	m.setShelfVisibility(0.42);
	expect(m.getShelfVisibility()).toBeCloseTo(0.42, 4);
	expect(m.getSnapshot().shelfVisibility).toBeCloseTo(0.42, 4);
});

test("ShelfManager.setShelfPinnedOpen toggles pinned state and only refreshes entrance timing on closed to open", () => {
	const m = createShelfManager({ now: () => 99000 });

	m.setShelfPinnedOpen(true, 12.5);
	expect(m.getShelfPinnedOpen()).toBe(true);
	expect(m.getState().pinnedOpen).toBe(true);
	expect(m.getSnapshot().pinnedOpen).toBe(true);
	expect(m.getState().shelfOpenAnimAt).toBe(12.5);

	m.setShelfPinnedOpen(true, 20);
	expect(m.getState().shelfOpenAnimAt).toBe(12.5);

	m.setShelfPinnedOpen(false);
	expect(m.getShelfPinnedOpen()).toBe(false);
	expect(m.getState().pinnedOpen).toBe(false);

	m.setShelfPinnedOpen(true);
	expect(m.getState().shelfOpenAnimAt).toBe(99);
});

test("ShelfManager.update fades stage shelf with data up by baseline 0.22 on first visible frame", () => {
	const m = createShelfManager({});
	m.setMode("stage");
	m.setData([{ type: "queue", title: "Stage item" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getShelfVisibility()).toBeCloseTo(0.22, 5);
});

test("ShelfManager.update fades side shelf with always presence and data up by baseline 0.22", () => {
	const m = createShelfManager({});
	m.setMode("side");
	m.setShelfPresence("always");
	m.setData([{ type: "queue", title: "Side item" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getShelfVisibility()).toBeCloseTo(0.22, 5);
});

test("ShelfManager.update keeps side shelf hidden for auto presence without detail content", () => {
	const m = createShelfManager({});
	m.setMode("side");
	m.setShelfPresence("auto");
	m.setData([{ type: "queue", title: "Auto item" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getShelfVisibility()).toBe(0);
});

test("ShelfManager hover cue waits baseline 260ms before raising side auto visibility", () => {
	let now = 1000;
	const m = createShelfManager({ now: () => now });
	m.setMode("side");
	m.setShelfPresence("auto");
	m.setData([{ type: "queue", title: "Auto cue item" }]);

	m.updateShelfHoverCueFromPointer({ clientX: 1100, clientY: 300 });
	m.update(makeCtx(createRuntimeUniforms(), 1016, 1 / 60));
	expect(m.getState().shelfHoverCue.zoneActive).toBe(true);
	expect(m.getState().shelfHoverCue.target).toBe(0);
	expect(m.getShelfVisibility()).toBe(0);

	now = 1261;
	m.update(makeCtx(createRuntimeUniforms(), 1277, 1 / 60));
	expect(m.getState().shelfHoverCue.target).toBe(1);
	expect(m.getState().shelfHoverCue.value).toBeCloseTo(0.12, 5);
	expect(m.getShelfVisibility()).toBeCloseTo(0.16 * 0.22, 5);
});

test("ShelfManager hover cue preview-visible predicate follows baseline guide zone target value and visibility thresholds", () => {
	const m = createShelfManager({});
	const cue = m.getState().shelfHoverCue;

	expect(m.getShelfHoverCuePreviewVisible()).toBe(false);
	cue.zoneActive = true;
	expect(m.getShelfHoverCuePreviewVisible()).toBe(true);
	cue.zoneActive = false;
	cue.target = 1;
	expect(m.getShelfHoverCuePreviewVisible()).toBe(true);
	cue.target = 0;
	cue.value = 0.101;
	expect(m.getShelfHoverCuePreviewVisible()).toBe(true);
	cue.value = 0;
	m.setShelfVisibility(0.121);
	expect(m.getShelfHoverCuePreviewVisible()).toBe(true);
	m.setShelfVisibility(0);
	cue.guide = true;
	expect(m.getShelfHoverCuePreviewVisible()).toBe(true);
});

test("ShelfManager hover cue clears after invalid pointer and baseline idle timeout", () => {
	let now = 2000;
	const m = createShelfManager({ now: () => now });
	m.setMode("side");
	m.setShelfPresence("auto");
	m.setData([{ type: "queue", title: "Auto cue item" }]);

	m.updateShelfHoverCueFromPointer({ clientX: 1100, clientY: 300 });
	now = 2261;
	m.update(makeCtx(createRuntimeUniforms(), 2261));
	expect(m.getState().shelfHoverCue.value).toBeCloseTo(0.12, 5);

	m.updateShelfHoverCueFromPointer(null);
	expect(m.getState().shelfHoverCue.zoneActive).toBe(false);
	expect(m.getState().shelfHoverCue.target).toBe(0);

	now = 2950;
	m.getState().shelfHoverCue.value = 0.005;
	m.update(makeCtx(createRuntimeUniforms(), 2950));
	expect(m.getState().shelfHoverCue.value).toBe(0);
});

test("ShelfManager clears hover cue eligibility when side auto state becomes invalid without pointer movement", () => {
	let now = 3000;
	const m = createShelfManager({ now: () => now });
	m.setMode("side");
	m.setShelfPresence("auto");
	m.setData([{ type: "queue", title: "Auto cue item" }]);

	m.updateShelfHoverCueFromPointer({ clientX: 1100, clientY: 300 });
	now = 3261;
	m.openDetail(0);
	m.update(makeCtx(createRuntimeUniforms(), 3261, 1 / 60));

	expect(m.getState().shelfHoverCue.zoneActive).toBe(false);
	expect(m.getState().shelfHoverCue.target).toBe(0);
	expect(m.getState().shelfHoverCue.value).toBe(0);
});

test("ShelfManager.update fades side auto shelf with data and pinned state up by baseline 0.22", () => {
	const m = createShelfManager({});
	m.setMode("side");
	m.setShelfPresence("auto");
	m.setData([{ type: "queue", title: "Pinned auto item" }]);
	m.setShelfPinnedOpen(true, 10);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getShelfVisibility()).toBeCloseTo(0.22, 5);
});

test("ShelfManager.update treats open detail as side content and fades auto presence up", () => {
	const m = createShelfManager({});
	m.setMode("side");
	m.setShelfPresence("auto");
	m.openDetail(0);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getShelfVisibility()).toBeCloseTo(0.22, 5);
});

test("ShelfManager.update fades hidden shelf down by baseline 0.18 and clamps near zero", () => {
	const m = createShelfManager({});
	m.setMode("off");
	m.setShelfVisibility(1);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getShelfVisibility()).toBeCloseTo(0.82, 5);

	m.setShelfVisibility(0.009);
	m.update(makeCtx(createRuntimeUniforms(), 32));
	expect(m.getShelfVisibility()).toBe(0);
});

test("ShelfManager.update fades side shelf with no data and no detail content toward hidden", () => {
	const m = createShelfManager({});
	m.setMode("side");
	m.setShelfPresence("always");
	m.setShelfVisibility(1);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getShelfVisibility()).toBeCloseTo(0.82, 5);
});

test("ShelfManager.update fades shelf out while app is unrevealed without changing mode", () => {
	const m = createShelfManager({});
	m.setMode("stage");
	m.setData([{ type: "queue", title: "Splash fade item" }]);
	m.setShelfVisibility(1);
	m.setAppRevealed(false);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getMode()).toBe("stage");
	expect(m.getShelfVisibility()).toBeCloseTo(0.82, 5);
});

test("ShelfManager.update gates group.visible with current target visibility and detail/data presence", () => {
	const group = { visible: true } as unknown as import("three").Group;
	const m = createShelfManager({ group });
	m.setMode("side");
	m.setShelfPresence("auto");
	m.setData([{ type: "queue", title: "Hidden auto" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(group.visible).toBe(false);

	m.openDetail(0);
	m.update(makeCtx(createRuntimeUniforms(), 32));
	expect(group.visible).toBe(true);

	m.setMode("off");
	m.update(makeCtx(createRuntimeUniforms(), 48));
	expect(group.visible).toBe(true);

	m.setShelfVisibility(0.009);
	m.update(makeCtx(createRuntimeUniforms(), 64));
	expect(group.visible).toBe(false);
});

test("ShelfManager.openDetail + closeDetail mutate openCardIdx", () => {
	const m = createShelfManager({});
	m.openDetail(1);
	expect(m.getState().openCardIdx).toBe(1);
	expect(m.getSnapshot().openCardIdx).toBe(1);
	m.closeDetail();
	expect(m.getState().openCardIdx).toBe(-1);
});

test("ShelfManager.openDetail does not restart existing shelf card reveal timing", () => {
	const m = createShelfManager({ now: () => 42000 });
	m.getState().shelfOpenAnimAt = 12.5;

	m.openDetail(0, { playlistId: "p1", title: "Detail" });

	expect(m.getState().shelfOpenAnimAt).toBe(12.5);
});

test("ShelfManager.openDetail pins side shelf for baseline detail lifecycle without restarting reveal timing", () => {
	const m = createShelfManager({ now: () => 42000 });
	m.setMode("side");
	m.setShelfPresence("auto");
	m.getState().shelfOpenAnimAt = 12.5;

	m.openDetail(0, { playlistId: "p1", title: "Detail" });

	expect(m.getShelfPinnedOpen()).toBe(true);
	expect(m.getSnapshot().pinnedOpen).toBe(true);
	expect(m.getState().shelfOpenAnimAt).toBe(12.5);
	expect(m.hasOpenContent()).toBe(true);
	m.closeDetail();
	expect(m.hasOpenContent()).toBe(false);
	expect(m.getShelfPinnedOpen()).toBe(true);
});

test("ShelfManager exposes a content-list skeleton for open detail state", () => {
	const m = createShelfManager({ now: () => 42000 });
	expect(m.hasOpenContent()).toBe(false);
	expect(m.getContentList()).toBeNull();

	m.openDetail(1, { playlistId: "p1", title: "Playlist 1" });

	expect(m.hasOpenContent()).toBe(true);
	const list = m.getContentList();
	expect(list?.isOpen()).toBe(true);
	expect(list?.getSnapshot().playlistId).toBe("p1");
	expect(list?.getSnapshot().playlistTitle).toBe("Playlist 1");
	expect(list?.getSnapshot().openAnimAt).toBe(0);

	m.closeDetail();
	expect(m.hasOpenContent()).toBe(false);
	expect(m.getContentList()).toBeNull();
});

test("ShelfManager notifies host with playlist detail metadata and the content-list request token", () => {
	const calls: unknown[] = [];
	const m = createShelfManager({
		onOpenDetailContent: (payload) => calls.push(payload),
	});
	const item: ShelfItem = {
		type: "playlist",
		title: "Daily Mix",
		playlistId: "daily",
		provider: "netease",
		cover: "cover.jpg",
	};
	m.setData([item]);

	m.openDetail(0);

	const snapshot = m.getContentList()?.getSnapshot();
	expect(calls).toEqual([{
		playlistId: "daily",
		title: "Daily Mix",
		provider: "netease",
		contentKind: "playlist",
		requestToken: snapshot?.requestToken,
		sourceCard: { item },
		item,
	}]);
});

test("ShelfManager closes content-list skeleton when shelf data shrink invalidates open detail", () => {
	const m = createShelfManager({});
	m.setData([{ type: "playlist", title: "A", playlistId: "p1" }]);
	m.openDetail(0);
	expect(m.hasOpenContent()).toBe(true);

	m.setData([]);

	expect(m.getState().openCardIdx).toBe(-1);
	expect(m.hasOpenContent()).toBe(false);
	expect(m.getContentList()).toBeNull();
});

test("ShelfManager closes content-list skeleton when same-index shelf data changes identity", () => {
	const m = createShelfManager({});
	m.setData([{ type: "playlist", title: "Playlist A", playlistId: "p-a" }]);
	m.openDetail(0);
	expect(m.getContentList()?.getSnapshot().playlistId).toBe("p-a");

	m.setData([{ type: "playlist", title: "Playlist B", playlistId: "p-b" }]);

	expect(m.getState().openCardIdx).toBe(-1);
	expect(m.hasOpenContent()).toBe(false);
	expect(m.getContentList()).toBeNull();
});

test("ShelfManager derives content-list podcast kind from explicit podcast detail id", () => {
	const m = createShelfManager({});
	m.openDetail(0, { playlistId: "podcast:daily", title: "Daily" });

	expect(m.getContentList()?.getSnapshot().contentKind).toBe("podcast");
});

test("ShelfManager prefixes podcastKey fallback with baseline podcast id scheme", () => {
	const m = createShelfManager({});
	m.setData([{ type: "playlist", title: "Podcast shelf", podcastKey: "daily" }]);

	m.openDetail(0);

	expect(m.getContentList()?.getSnapshot().playlistId).toBe("podcast:daily");
	expect(m.getContentList()?.getSnapshot().contentKind).toBe("podcast");
});

test("ShelfManager.update advances the owned content-list skeleton like baseline contentList.update(dt)", () => {
	const m = createShelfManager({});
	const u = createRuntimeUniforms();
	m.openDetail(0, { playlistId: "p1", title: "Playlist 1" });
	m.getContentList()?.setRows([
		{ id: "a", name: "A" },
		{ id: "b", name: "B" },
	]);
	m.getContentList()?.scrollBy(1);

	m.update(makeCtx(u, 16));

	expect(m.getContentList()?.getSnapshot().centerSmooth).toBeCloseTo(0.18, 6);
});

test("ShelfManager.update advances centerSmooth toward target with baseline lerp 0.16", () => {
	const m = createShelfManager({});
	const u = createRuntimeUniforms();
	m.getState().centerTarget = 1;
	const expected = 0 + (1 - 0) * 0.16;
	m.update(makeCtx(u, 16));
	expect(m.getState().centerSmooth).toBeCloseTo(expected, 5);
});

test("ShelfManager.update computes a real breathPulse snapshot value", () => {
	const m = createShelfManager({});
	m.setShelfVisibility(1);
	m.setData([{ type: "queue", title: "Pulse item" }]);
	const u = createRuntimeUniforms();
	u.uTime.value = 0;
	m.update(makeCtx(u, 0));
	expect(m.getSnapshot().breathPulse).toBeCloseTo(0.5, 5);
});

test("3D shelf update does not crash when group is null", () => {
	const m = createShelfManager({});
	const u = createRuntimeUniforms();
	expect(() => m.update(makeCtx(u, 16))).not.toThrow();
	expect(m.getState().centerSmooth).toBeGreaterThanOrEqual(0);
});

test("ShelfManager.dispose removes the group from the scene if present", () => {
	const removed: unknown[] = [];
	const scene = {
		add() {},
		remove(obj: unknown) {
			removed.push(obj);
		},
	} as unknown as import("three").Scene;
	const group = { visible: true } as unknown as import("three").Group;
	const m = createShelfManager({ scene, group });
	m.dispose();
	expect(removed.length).toBe(1);
});

test("ShelfManager builds only SHELF_MAX_RENDER card meshes around center for long data", () => {
	const children: unknown[] = [];
	const scene = {
		add() {},
		remove() {},
	} as unknown as import("three").Scene;
	class FakeGroup {
		visible = true;
		children = children;
		add(obj: unknown) {
			children.push(obj);
		}
		remove(obj: unknown) {
			const idx = children.indexOf(obj);
			if (idx >= 0) children.splice(idx, 1);
		}
	}
	class FakeMesh {
		position = { set() {} };
		rotation = { set() {} };
		scale = { setScalar() {} };
		visible = true;
		renderOrder = 0;
		userData: Record<string, unknown> = {};
		constructor(
			public geometry: unknown,
			public material: unknown,
		) {}
	}
	const documentLike = {
		createElement(tag: string) {
			expect(tag).toBe("canvas");
			return {
				width: 0,
				height: 0,
				getContext() {
					return {
						clearRect() {},
						fillRect() {},
						roundRect() {},
						beginPath() {},
						fill() {},
						stroke() {},
						moveTo() {},
						lineTo() {},
						save() {},
						restore() {},
						clip() {},
						createLinearGradient() {
							return { addColorStop() {} };
						},
						measureText(text: string) {
							return { width: text.length * 8 };
						},
						fillText() {},
					};
				},
			};
		},
	};
	const three = {
		Group: FakeGroup,
		Mesh: FakeMesh,
		PlaneGeometry: class {
			constructor(
				public width: number,
				public height: number,
			) {}
		},
		CanvasTexture: class {
			needsUpdate = false;
			minFilter: unknown = null;
			magFilter: unknown = null;
			generateMipmaps = true;
			constructor(public canvas: unknown) {}
		},
		MeshBasicMaterial: class {
			opacity = 1;
			color = { setScalar() {} };
			constructor(init: Record<string, unknown>) {
				Object.assign(this, init);
			}
		},
		LinearFilter: "LinearFilter",
		DoubleSide: "DoubleSide",
	} as unknown as typeof import("three");
	const m = createShelfManager({ scene, three, document: documentLike as unknown as Document });
	m.setShelfVisibility(1);
	m.getState().centerTarget = 12;
	m.getState().centerSmooth = 12;
	m.setData(Array.from({ length: 25 }, (_, i) => ({ type: "playlist", title: `P${i}`, playlistId: `${i}` })));
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(children.length).toBe(SHELF_MAX_RENDER);
});

test("ShelfManager redraws existing card sprites when selected state changes inside the same render window", () => {
	const children: unknown[] = [];
	const fillTextCalls: string[] = [];
	const scene = {
		add() {},
		remove() {},
	} as unknown as import("three").Scene;
	class FakeGroup {
		visible = true;
		children = children;
		add(obj: unknown) {
			children.push(obj);
		}
		remove(obj: unknown) {
			const idx = children.indexOf(obj);
			if (idx >= 0) children.splice(idx, 1);
		}
	}
	class FakeMesh {
		position = { set() {} };
		rotation = { set() {} };
		scale = { setScalar() {} };
		visible = true;
		renderOrder = 0;
		userData: Record<string, unknown> = {};
		constructor(
			public geometry: unknown,
			public material: unknown,
		) {}
	}
	const documentLike = {
		createElement() {
			return {
				width: 0,
				height: 0,
				getContext() {
					return {
						clearRect() {},
						fillRect() {},
						roundRect() {},
						beginPath() {},
						fill() {},
						stroke() {},
						moveTo() {},
						lineTo() {},
						save() {},
						restore() {},
						clip() {},
						createLinearGradient() {
							return { addColorStop() {} };
						},
						measureText(text: string) {
							return { width: text.length * 8 };
						},
						fillText(text: string) {
							fillTextCalls.push(text);
						},
					};
				},
			};
		},
	};
	const three = {
		Group: FakeGroup,
		Mesh: FakeMesh,
		PlaneGeometry: class {
			dispose() {}
		},
		CanvasTexture: class {
			needsUpdate = false;
			minFilter: unknown = null;
			magFilter: unknown = null;
			generateMipmaps = true;
			dispose() {}
		},
		MeshBasicMaterial: class {
			opacity = 1;
			color = { setScalar() {} };
			constructor(init: Record<string, unknown>) {
				Object.assign(this, init);
			}
			dispose() {}
		},
		LinearFilter: "LinearFilter",
		DoubleSide: "DoubleSide",
	} as unknown as typeof import("three");
	const m = createShelfManager({ scene, three, document: documentLike as unknown as Document });
	m.setShelfVisibility(1);
	m.setData([{ type: "playlist", title: "P0", playlistId: "0" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	const afterFirstUpdate = fillTextCalls.length;
	m.setSelectedIdx(0);
	m.update(makeCtx(createRuntimeUniforms(), 32));
	expect(children.length).toBe(1);
	expect(fillTextCalls.length).toBeGreaterThan(afterFirstUpdate);
});

test("ShelfManager clamps center and open detail indices when data shrinks", () => {
	const children: unknown[] = [];
	const scene = {
		add() {},
		remove() {},
	} as unknown as import("three").Scene;
	class FakeGroup {
		visible = true;
		add(obj: unknown) {
			children.push(obj);
		}
		remove(obj: unknown) {
			const idx = children.indexOf(obj);
			if (idx >= 0) children.splice(idx, 1);
		}
	}
	class FakeMesh {
		position = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) {
			this.x = x;
			this.y = y;
			this.z = z;
		} };
		rotation = { set() {} };
		scale = { setScalar() {} };
		visible = true;
		renderOrder = 0;
		userData: Record<string, unknown> = {};
		constructor(
			public geometry: unknown,
			public material: unknown,
		) {}
	}
	const documentLike = {
		createElement() {
			return {
				width: 0,
				height: 0,
				getContext() {
					return {
						clearRect() {},
						fillRect() {},
						roundRect() {},
						beginPath() {},
						fill() {},
						stroke() {},
						moveTo() {},
						lineTo() {},
						save() {},
						restore() {},
						clip() {},
						createLinearGradient() {
							return { addColorStop() {} };
						},
						measureText(text: string) {
							return { width: text.length * 8 };
						},
						fillText() {},
					};
				},
			};
		},
	};
	const three = {
		Group: FakeGroup,
		Mesh: FakeMesh,
		PlaneGeometry: class {
			dispose() {}
		},
		CanvasTexture: class {
			needsUpdate = false;
			minFilter: unknown = null;
			magFilter: unknown = null;
			generateMipmaps = true;
			dispose() {}
		},
		MeshBasicMaterial: class {
			opacity = 1;
			color = { setScalar() {} };
			constructor(init: Record<string, unknown>) {
				Object.assign(this, init);
			}
			dispose() {}
		},
		LinearFilter: "LinearFilter",
		DoubleSide: "DoubleSide",
	} as unknown as typeof import("three");
	const m = createShelfManager({ scene, three, document: documentLike as unknown as Document });
	m.setShelfVisibility(1);
	m.getState().centerTarget = 12;
	m.getState().centerSmooth = 12;
	m.openDetail(12);
	m.setData([{ type: "playlist", title: "Only", playlistId: "only" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	expect(m.getState().centerTarget).toBe(0);
	expect(m.getState().centerSmooth).toBe(0);
	expect(m.getState().openCardIdx).toBe(-1);
	expect(children.length).toBe(1);
	expect((children[0] as { visible: boolean }).visible).toBe(true);
});

test("ShelfManager.raycastCards intersects visible rendered card meshes and returns hit metadata", () => {
	const { children, documentLike, three } = makeRaycastShelfDeps();
	const m = createShelfManager({
		scene: { add() {}, remove() {} } as unknown as import("three").Scene,
		three,
		document: documentLike,
	});
	const items: ShelfItem[] = [
		{ type: "playlist", title: "Hidden", playlistId: "hidden" },
		{ type: "playlist", title: "Hit", playlistId: "hit" },
	];
	m.setShelfVisibility(1);
	m.setData(items);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	children[0].visible = false;

	let intersected: unknown[] = [];
	const point = { x: 1, y: 2, z: 3 };
	const uv = { x: 0.25, y: 0.75 };
	const raycaster = {
		intersectObjects(objects: unknown[], recursive: boolean) {
			intersected = objects;
			expect(recursive).toBe(false);
			return [{ object: children[1], point, uv }];
		},
	} as unknown as import("three").Raycaster;

	const hit = m.raycastCards(raycaster);

	expect(intersected).toEqual([children[1]]);
	expect(hit).toEqual({
		index: 1,
		item: items[1],
		mesh: children[1],
		point,
		uv,
	});
});

test("ShelfManager.raycastCards returns null when there is no render group", () => {
	const m = createShelfManager({});
	const raycaster = {
		intersectObjects() {
			throw new Error("should not raycast without a group");
		},
	} as unknown as import("three").Raycaster;

	expect(m.raycastCards(raycaster)).toBeNull();
});

test("ShelfManager.raycastCards returns null when no visible cards hit", () => {
	const { children, documentLike, three } = makeRaycastShelfDeps();
	const m = createShelfManager({
		scene: { add() {}, remove() {} } as unknown as import("three").Scene,
		three,
		document: documentLike,
	});
	m.setShelfVisibility(1);
	m.setData([{ type: "playlist", title: "Miss", playlistId: "miss" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));

	const raycaster = {
		intersectObjects(objects: unknown[]) {
			expect(objects).toEqual([children[0]]);
			return [];
		},
	} as unknown as import("three").Raycaster;

	expect(m.raycastCards(raycaster)).toBeNull();
});

test("ShelfManager.pickCardAtScreen uses baseline default 72px screen padding and returns clamped uv", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument() });
	m.setShelfVisibility(1);
	m.setData([{ type: "playlist", title: "Screen Pick", playlistId: "screen" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	const mesh = group.children[0] as import("three").Mesh;
	mesh.position.set(0, 0, 0);
	mesh.rotation.set(0, 0, 0);
	mesh.scale.setScalar(1);
	mesh.visible = true;
	mesh.renderOrder = 10;
	group.visible = true;

	const viewportWidth = 800;
	const viewportHeight = 600;
	const params = (mesh.geometry as import("three").PlaneGeometry).parameters as { width: number; height: number };
	const maxX = ((params.width / 2 / 4) + 1) * viewportWidth / 2;
	const hit = m.pickCardAtScreen(maxX + 60, viewportHeight / 2, viewportWidth, viewportHeight, camera);

	expect(hit?.index).toBe(0);
	expect(hit?.screenPick).toBe(true);
	expect(hit?.uv?.x).toBe(1);
	expect(hit?.uv?.y).toBeCloseTo(0.5, 5);
});

test("ShelfManager.pickCardAtScreen respects explicit 18px side-mode padding", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument() });
	m.setShelfVisibility(1);
	m.setData([{ type: "playlist", title: "Side Pad", playlistId: "side" }]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	const mesh = group.children[0] as import("three").Mesh;
	mesh.position.set(0, 0, 0);
	mesh.rotation.set(0, 0, 0);
	mesh.scale.setScalar(1);
	mesh.visible = true;
	group.visible = true;

	const viewportWidth = 800;
	const viewportHeight = 600;
	const params = (mesh.geometry as import("three").PlaneGeometry).parameters as { width: number; height: number };
	const maxX = ((params.width / 2 / 4) + 1) * viewportWidth / 2;

	expect(m.pickCardAtScreen(maxX + 18, viewportHeight / 2, viewportWidth, viewportHeight, camera, 18)?.index).toBe(0);
	expect(m.pickCardAtScreen(maxX + 19, viewportHeight / 2, viewportWidth, viewportHeight, camera, 18)).toBeNull();
});

test("ShelfManager.pickCardAtScreen returns highest renderOrder card when padded screen rects overlap", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument() });
	m.setShelfVisibility(1);
	m.setData([
		{ type: "playlist", title: "Low", playlistId: "low" },
		{ type: "playlist", title: "High", playlistId: "high" },
	]);
	m.update(makeCtx(createRuntimeUniforms(), 16));
	const [low, high] = group.children as import("three").Mesh[];
	for (const mesh of [low, high]) {
		mesh.position.set(0, 0, 0);
		mesh.rotation.set(0, 0, 0);
		mesh.scale.setScalar(1);
		mesh.visible = true;
	}
	low.renderOrder = 5;
	high.renderOrder = 55;
	group.visible = true;

	const hit = m.pickCardAtScreen(400, 300, 800, 600, camera, 0);

	expect(hit?.index).toBe(1);
	expect(hit?.item.playlistId).toBe("high");
	expect(hit?.screenPick).toBe(true);
});

test("ShelfManager renders open detail panel and capped row meshes, then syncs screen targets", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const uniforms = createRuntimeUniforms();
	uniforms.uTime.value = 1;
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument() });

	m.setShelfVisibility(1);
	m.openDetail(0, { playlistId: "p1", title: "Detail" });
	m.getContentList()?.setRows(Array.from({ length: 20 }, (_, index) => ({
		id: `song-${index}`,
		name: `Song ${index}`,
		artist: `Artist ${index}`,
	})));

	m.update({
		...makeCtx(uniforms, 16),
		camera: camera as unknown as FrameContext["camera"],
		viewport: { width: 800, height: 600 },
	} as FrameContext & { viewport: { width: number; height: number } });

	const detailMeshes = findDetailMeshes(group);
	const panelMeshes = detailMeshes.filter((child) =>
		(child as import("three").Object3D).userData?.shelfContentKind === "panel"
	);
	const rowMeshes = detailMeshes.filter((child) =>
		(child as import("three").Object3D).userData?.shelfContentKind === "row"
	);

	expect(panelMeshes.length).toBe(1);
	expect(rowMeshes.length).toBe(CONTENT_MAX_RENDER);
	expect(m.getContentList()?.hasScreenTargetAt({ x: 400, y: 300 })).toBe(true);
});

test("ShelfManager nests detail meshes under a transformed baseline detail group and projects screen targets from world space", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-5, 5, 4, -4, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const uniforms = createRuntimeUniforms();
	uniforms.uTime.value = 1;
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument() });

	m.setShelfVisibility(1);
	m.openDetail(0, { playlistId: "p1", title: "Detail" });
	m.getContentList()?.setRows([{ id: "song-0", name: "Song 0", artist: "Artist 0" }]);
	m.update({
		...makeCtx(uniforms, 16),
		camera: camera as unknown as FrameContext["camera"],
		pointerParallax: { x: 0, y: 0 },
		viewport: { width: 1000, height: 800 },
	} as FrameContext & { viewport: { width: number; height: number } });

	const detailGroup = group.children.find((child) =>
		(child as import("three").Object3D).userData?.shelfContentDetailGroup === true
	) as import("three").Group | undefined;
	expect(detailGroup).toBeDefined();
	const detail = getDefaultShelfLayoutProfile().detail;
	expect(detailGroup?.position.x).toBeCloseTo(detail.x, 5);
	expect(detailGroup?.position.y).toBeCloseTo(detail.y, 5);
	expect(detailGroup?.position.z).toBeCloseTo(detail.z, 5);
	expect(detailGroup?.rotation.x).toBeCloseTo(detail.rx, 5);
	expect(detailGroup?.rotation.y).toBeCloseTo(detail.ry, 5);
	expect(detailGroup?.scale.x).toBeCloseTo(detail.scale, 5);
	expect(detailGroup?.scale.y).toBeCloseTo(detail.scale, 5);

	const panelMeshes = detailGroup?.children.filter((child) =>
		(child as import("three").Object3D).userData?.shelfContentKind === "panel"
	) ?? [];
	const rowMeshes = detailGroup?.children.filter((child) =>
		(child as import("three").Object3D).userData?.shelfContentKind === "row"
	) as import("three").Mesh[] | undefined ?? [];
	expect(panelMeshes.length).toBe(1);
	expect(rowMeshes.length).toBe(1);
	expect(group.children.some((child) =>
		(child as import("three").Object3D).userData?.shelfContentKind === "row"
	)).toBe(false);

	const rowCenter = new three.Vector3(0, 0, 0);
	rowMeshes[0].updateMatrixWorld(true);
	rowCenter.applyMatrix4(rowMeshes[0].matrixWorld).project(camera);
	const point = {
		x: (rowCenter.x + 1) * 1000 / 2,
		y: (1 - rowCenter.y) * 800 / 2,
	};
	expect(m.getContentList()?.hasScreenTargetAt(point)).toBe(true);
});

test("ShelfManager detail group intro settles against visual uTime instead of wall-clock time", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-5, 5, 4, -4, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const uniforms = createRuntimeUniforms();
	uniforms.uTime.value = 10;
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument(), now: () => 42000 });
	const detail = getDefaultShelfLayoutProfile().detail;

	m.setShelfVisibility(1);
	m.update({
		...makeCtx(uniforms, 16),
		camera: camera as unknown as FrameContext["camera"],
		viewport: { width: 1000, height: 800 },
	} as FrameContext & { viewport: { width: number; height: number } });
	m.openDetail(0, { playlistId: "p1", title: "Detail" });
	m.getContentList()?.setRows([{ id: "song-0", name: "Song 0", artist: "Artist 0" }]);

	m.update({
		...makeCtx(uniforms, 32),
		camera: camera as unknown as FrameContext["camera"],
		pointerParallax: { x: 0, y: 0 },
		viewport: { width: 1000, height: 800 },
	} as FrameContext & { viewport: { width: number; height: number } });
	const introGroup = findDetailGroup(group);
	expect(introGroup?.position.x).toBeGreaterThan(detail.x + 0.12);
	expect(introGroup?.scale.x).toBeLessThan(detail.scale);

	uniforms.uTime.value = 10.6;
	m.update({
		...makeCtx(uniforms, 48),
		camera: camera as unknown as FrameContext["camera"],
		pointerParallax: { x: 0, y: 0 },
		viewport: { width: 1000, height: 800 },
	} as FrameContext & { viewport: { width: number; height: number } });
	const settledGroup = findDetailGroup(group);
	expect(settledGroup?.position.x).toBeCloseTo(detail.x, 5);
	expect(settledGroup?.position.y).toBeCloseTo(detail.y, 5);
	expect(settledGroup?.position.z).toBeCloseTo(detail.z, 5);
	expect(settledGroup?.scale.x).toBeCloseTo(detail.scale, 5);
});

test("ShelfManager refreshes detail group world matrix before syncing screen targets", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-5, 5, 4, -4, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const uniforms = createRuntimeUniforms();
	uniforms.uTime.value = 10;
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument() });

	m.setShelfVisibility(1);
	m.update({
		...makeCtx(uniforms, 16),
		camera: camera as unknown as FrameContext["camera"],
		viewport: { width: 1000, height: 800 },
	} as FrameContext & { viewport: { width: number; height: number } });
	m.openDetail(0, { playlistId: "p1", title: "Detail" });
	m.getContentList()?.setRows([{ id: "song-0", name: "Song 0", artist: "Artist 0" }]);
	m.update({
		...makeCtx(uniforms, 32),
		camera: camera as unknown as FrameContext["camera"],
		pointerParallax: { x: 0, y: 0 },
		viewport: { width: 1000, height: 800 },
	} as FrameContext & { viewport: { width: number; height: number } });
	const detailGroup = findDetailGroup(group);
	expect(detailGroup).toBeDefined();
	const updateMatrixWorldCalls: boolean[] = [];
	const originalUpdateMatrixWorld = detailGroup!.updateMatrixWorld.bind(detailGroup);
	detailGroup!.updateMatrixWorld = (force?: boolean) => {
		updateMatrixWorldCalls.push(!!force);
		originalUpdateMatrixWorld(force);
	};

	uniforms.uTime.value = 10.6;
	m.update({
		...makeCtx(uniforms, 48),
		camera: camera as unknown as FrameContext["camera"],
		pointerParallax: { x: 0, y: 0 },
		viewport: { width: 1000, height: 800 },
	} as FrameContext & { viewport: { width: number; height: number } });

	expect(updateMatrixWorldCalls).toContain(true);
});

test("ShelfManager closeDetail disposes detail meshes and clears content-list screen targets", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const uniforms = createRuntimeUniforms();
	uniforms.uTime.value = 1;
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument() });
	m.setShelfVisibility(1);
	m.openDetail(0, { playlistId: "p1", title: "Detail" });
	m.getContentList()?.setRows([
		{ id: "a", name: "Song A", artist: "Artist A" },
		{ id: "b", name: "Song B", artist: "Artist B" },
	]);
	m.update({
		...makeCtx(uniforms, 16),
		camera: camera as unknown as FrameContext["camera"],
		viewport: { width: 800, height: 600 },
	} as FrameContext & { viewport: { width: number; height: number } });
	const list = m.getContentList();
	expect(list?.hasScreenTargetAt({ x: 400, y: 300 })).toBe(true);

	let disposeEvents = 0;
	const detailMeshes = findDetailMeshes(group) as import("three").Mesh[];
	for (const mesh of detailMeshes) {
		mesh.geometry.addEventListener("dispose", () => disposeEvents++);
		const material = mesh.material as import("three").MeshBasicMaterial;
		material.addEventListener("dispose", () => disposeEvents++);
		material.map?.addEventListener("dispose", () => disposeEvents++);
	}

	m.closeDetail();

	expect(findDetailMeshes(group).length).toBe(0);
	expect(list?.hasScreenTargetAt({ x: 400, y: 300 })).toBe(false);
	expect(disposeEvents).toBe(detailMeshes.length * 3);
});

test("ShelfManager rebuilds detail row meshes when content render window changes and keeps max cap", async () => {
	const three = await import("three");
	const scene = new three.Scene();
	const group = new three.Group();
	scene.add(group);
	const camera = new three.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();
	const uniforms = createRuntimeUniforms();
	uniforms.uTime.value = 1;
	const m = createShelfManager({ scene, group, three, document: makeCanvasDocument() });
	m.setShelfVisibility(1);
	m.openDetail(0, { playlistId: "p1", title: "Detail" });
	const rows = Array.from({ length: 25 }, (_, index) => ({
		id: `song-${index}`,
		name: `Song ${index}`,
		artist: `Artist ${index}`,
	}));
	m.getContentList()?.setRows(rows);

	const updateDetail = () => m.update({
		...makeCtx(uniforms, 16),
		camera: camera as unknown as FrameContext["camera"],
		viewport: { width: 800, height: 600 },
	} as FrameContext & { viewport: { width: number; height: number } });

	updateDetail();
	const firstIndexes = detailRowIndexes(group);
	expect(firstIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

	m.getContentList()?.scrollBy(12);
	updateDetail();

	const nextIndexes = detailRowIndexes(group);
	expect(nextIndexes).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
	expect(nextIndexes.length).toBe(CONTENT_MAX_RENDER);
	for (let frame = 0; frame < 72; frame++) {
		uniforms.uTime.value += 1 / 60;
		updateDetail();
	}
	expect(m.getContentList()?.pickRowAtScreen({ x: 400, y: 300 })?.row.id).toBe("song-12");
});

function detailRowIndexes(group: import("three").Group): number[] {
	return findDetailMeshes(group)
		.filter((child) => (child as import("three").Object3D).userData?.shelfContentKind === "row")
		.map((child) => Number((child as import("three").Object3D).userData.shelfContentRowIndex))
		.sort((a, b) => a - b);
}

function findDetailMeshes(group: import("three").Group): import("three").Object3D[] {
	const found: import("three").Object3D[] = [];
	group.traverse((child) => {
		if (child.userData?.shelfContentDetail === true) found.push(child);
	});
	return found;
}

function findDetailGroup(group: import("three").Group): import("three").Group | undefined {
	return group.children.find((child) =>
		child.userData?.shelfContentDetailGroup === true
	) as import("three").Group | undefined;
}

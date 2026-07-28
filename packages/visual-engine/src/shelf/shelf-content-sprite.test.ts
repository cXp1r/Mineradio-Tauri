import { expect, test } from "bun:test";
import type { ShelfContentRow } from "./shelf-content-list";
import {
	SHELF_CONTENT_PANEL_CANVAS_HEIGHT,
	SHELF_CONTENT_PANEL_CANVAS_WIDTH,
	SHELF_CONTENT_ROW_CANVAS_HEIGHT,
	SHELF_CONTENT_ROW_CANVAS_WIDTH,
	createShelfContentPanelSprite,
	createShelfContentRowSprite,
} from "./shelf-content-sprite";

type DrawCall =
	| { kind: "fillText"; text: string; x: number; y: number; fillStyle: unknown; font: string }
	| { kind: "fillRect"; x: number; y: number; w: number; h: number; fillStyle: unknown }
	| { kind: "roundRect"; x: number; y: number; w: number; h: number; r: number }
	| { kind: "createLinearGradient"; x0: number; y0: number; x1: number; y1: number }
	| { kind: "arc"; x: number; y: number; radius: number; startAngle: number; endAngle: number }
	| { kind: "stroke"; strokeStyle: unknown; lineWidth: number }
	| { kind: "fill"; fillStyle: unknown };

function makeCanvasLike() {
	const calls: DrawCall[] = [];
	const ctx = {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		font: "",
		textAlign: "start",
		textBaseline: "alphabetic",
		clearRect() {},
		fillRect(x: number, y: number, w: number, h: number) {
			calls.push({ kind: "fillRect", x, y, w, h, fillStyle: this.fillStyle });
		},
		roundRect(x: number, y: number, w: number, h: number, r: number) {
			calls.push({ kind: "roundRect", x, y, w, h, r });
		},
		beginPath() {},
		closePath() {},
		fill() {
			calls.push({ kind: "fill", fillStyle: this.fillStyle });
		},
		stroke() {
			calls.push({ kind: "stroke", strokeStyle: this.strokeStyle, lineWidth: this.lineWidth });
		},
		moveTo() {},
		lineTo() {},
		arc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
			calls.push({ kind: "arc", x, y, radius, startAngle, endAngle });
		},
		save() {},
		restore() {},
		clip() {},
		createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
			calls.push({ kind: "createLinearGradient", x0, y0, x1, y1 });
			return { addColorStop() {} };
		},
		measureText(text: string) {
			return { width: text.length * 8 };
		},
		fillText(text: string, x: number, y: number) {
			calls.push({ kind: "fillText", text, x, y, fillStyle: this.fillStyle, font: this.font });
		},
	};
	return {
		calls,
		canvas: {
			width: 0,
			height: 0,
			getContext(type: string) {
				expect(type).toBe("2d");
				return ctx;
			},
		},
	};
}

function makeThreeLike() {
	class FakePlaneGeometry {
		disposed = false;
		constructor(
			public width: number,
			public height: number,
			public widthSegments: number,
			public heightSegments: number,
		) {}
		dispose() {
			this.disposed = true;
		}
	}
	class FakeCanvasTexture {
		needsUpdate = false;
		minFilter: unknown = null;
		magFilter: unknown = null;
		generateMipmaps = true;
		disposed = false;
		constructor(public canvas: unknown) {}
		dispose() {
			this.disposed = true;
		}
	}
	class FakeMaterial {
		disposed = false;
		opacity = 1;
		transparent = false;
		depthWrite = true;
		depthTest = true;
		side: unknown = null;
		map: unknown = null;
		color = { setScalar() {} };
		constructor(init: Record<string, unknown>) {
			Object.assign(this, init);
		}
		dispose() {
			this.disposed = true;
		}
	}
	class FakeMesh {
		renderOrder = 0;
		userData: Record<string, unknown> = {};
		position = { set() {} };
		rotation = { set() {} };
		scale = { setScalar() {} };
		visible = true;
		constructor(
			public geometry: FakePlaneGeometry,
			public material: FakeMaterial,
		) {}
	}
	return {
		PlaneGeometry: FakePlaneGeometry,
		CanvasTexture: FakeCanvasTexture,
		MeshBasicMaterial: FakeMaterial,
		Mesh: FakeMesh,
		LinearFilter: "LinearFilter",
		DoubleSide: "DoubleSide",
	} as unknown as typeof import("three");
}

function textCalls(calls: DrawCall[]): string[] {
	return calls
		.filter((call): call is Extract<DrawCall, { kind: "fillText" }> => call.kind === "fillText")
		.map((call) => call.text);
}

function fillTextCall(calls: DrawCall[], text: string) {
	return calls.find((call): call is Extract<DrawCall, { kind: "fillText" }> => call.kind === "fillText" && call.text === text);
}

test("ShelfContentRowSprite draws rich track metadata with cover cue, duration, quality and playable state", () => {
	const made = makeCanvasLike();
	const row: ShelfContentRow = {
		name: "Main Name",
		title: "Displayed Title",
		artist: "Fallback Artist",
		artists: ["Singer A", "Singer B"],
		album: "Album X",
		provider: "QQ音乐",
		coverUrl: "https://example.test/cover.jpg",
		durationMs: 185000,
		qualityHints: ["SQ", "Hi-Res"],
		playableState: "vip",
	};

	createShelfContentRowSprite({
		three: makeThreeLike(),
		createCanvas: () => made.canvas as unknown as HTMLCanvasElement,
	}, row, 4, true);

	expect(made.canvas.width).toBe(SHELF_CONTENT_ROW_CANVAS_WIDTH);
	expect(made.canvas.height).toBe(SHELF_CONTENT_ROW_CANVAS_HEIGHT);
	expect(textCalls(made.calls)).toContain("Displayed Title");
	expect(textCalls(made.calls)).toContain("Singer A / Singer B · Album X · QQ音乐");
	expect(textCalls(made.calls)).toContain("03:05");
	expect(textCalls(made.calls)).toContain("SQ / Hi-Res");
	expect(textCalls(made.calls)).toContain("VIP");
	expect(made.calls.some((call) => call.kind === "roundRect" && call.x <= 70 && call.w >= 34 && call.h >= 34)).toBe(true);
	expect(made.calls.some((call) => call.kind === "createLinearGradient")).toBe(true);
});

test("ShelfContentRowSprite normalizes shared playable state labels", () => {
	const made = makeCanvasLike();
	createShelfContentRowSprite({
		three: makeThreeLike(),
		createCanvas: () => made.canvas as unknown as HTMLCanvasElement,
	}, {
		name: "会员歌曲",
		artist: "Singer",
		provider: "netease",
		playableState: "vip_required",
	}, 0, true);

	expect(textCalls(made.calls)).toContain("VIP");
	expect(textCalls(made.calls)).not.toContain("VIP_REQUIRED");
});

test("ShelfContentRowSprite draws dedicated loading, error and empty placeholder rows", () => {
	const three = makeThreeLike();
	const loading = makeCanvasLike();
	createShelfContentRowSprite({
		three,
		createCanvas: () => loading.canvas as unknown as HTMLCanvasElement,
	}, { name: "加载中…", kind: "loading", durationMs: 999000, qualityHints: ["SQ"] }, 0, true);

	const error = makeCanvasLike();
	createShelfContentRowSprite({
		three,
		createCanvas: () => error.canvas as unknown as HTMLCanvasElement,
	}, { name: "请求失败", artist: "should-not-render", kind: "error", durationMs: 999000, qualityHints: ["HQ"] }, 0, false);

	const empty = makeCanvasLike();
	createShelfContentRowSprite({
		three,
		createCanvas: () => empty.canvas as unknown as HTMLCanvasElement,
	}, { name: "", kind: "empty", durationMs: 999000, qualityHints: ["HQ"] }, 0, false);

	expect(textCalls(loading.calls)).toContain("正在载入歌单");
	expect(textCalls(loading.calls)).toContain("请稍候");
	expect(textCalls(error.calls)).toContain("请求失败");
	expect(textCalls(empty.calls)).toContain("歌单暂无可播放歌曲");
	for (const calls of [loading.calls, error.calls, empty.calls]) {
		expect(textCalls(calls)).not.toContain("16:39");
		expect(textCalls(calls)).not.toContain("SQ");
		expect(textCalls(calls)).not.toContain("HQ");
		expect(textCalls(calls).some((text) => /^0[1-9]$/.test(text))).toBe(false);
		expect(calls.some((call) => call.kind === "arc")).toBe(true);
	}
	expect(fillTextCall(loading.calls, "正在载入歌单")?.fillStyle).not.toBe(fillTextCall(error.calls, "请求失败")?.fillStyle);
});

test("ShelfContentPanelSprite keeps legacy title update and supports richer header metadata", () => {
	const made = makeCanvasLike();
	const panel = createShelfContentPanelSprite({
		three: makeThreeLike(),
		createCanvas: () => made.canvas as unknown as HTMLCanvasElement,
	}, "旧标题");

	expect(made.canvas.width).toBe(SHELF_CONTENT_PANEL_CANVAS_WIDTH);
	expect(made.canvas.height).toBe(SHELF_CONTENT_PANEL_CANVAS_HEIGHT);
	expect(textCalls(made.calls)).toContain("旧标题");

	made.calls.length = 0;
	panel.update({
		title: "夜航歌单",
		trackCount: 42,
		provider: "网易云音乐",
		coverUrl: "https://example.test/playlist.jpg",
		loading: true,
	});

	expect(textCalls(made.calls)).toContain("夜航歌单");
	expect(textCalls(made.calls)).toContain("42 首 · 网易云音乐");
	expect(textCalls(made.calls)).toContain("正在载入歌单");
	expect(made.calls.some((call) => call.kind === "roundRect" && call.x <= 82 && call.w >= 96 && call.h >= 96)).toBe(true);
	expect(made.calls.some((call) => call.kind === "createLinearGradient")).toBe(true);
});

test("ShelfContentRowSprite fully rebinds index, render order and generation when reused", () => {
	const made = makeCanvasLike();
	const sprite = createShelfContentRowSprite({
		three: makeThreeLike(),
		createCanvas: () => made.canvas as unknown as HTMLCanvasElement,
	}, { id: "old", name: "Old" }, 1, false);
	const firstGeneration = Number(sprite.mesh.userData.shelfBindingGeneration);

	sprite.update({ id: "new", name: "New" }, 7, true);

	expect(sprite.index).toBe(7);
	expect(sprite.row.id).toBe("new");
	expect(sprite.mesh.userData.shelfContentRowIndex).toBe(7);
	expect(sprite.mesh.renderOrder).toBe(247);
	expect(Number(sprite.mesh.userData.shelfBindingGeneration)).toBeGreaterThan(firstGeneration);
});

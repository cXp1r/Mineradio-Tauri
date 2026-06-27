import { expect, test } from "bun:test";
import {
	SHELF_CARD_CANVAS_HEIGHT,
	SHELF_CARD_CANVAS_WIDTH,
	SHELF_CARD_GEOMETRY_HEIGHT,
	SHELF_CARD_GEOMETRY_WIDTH,
	createShelfCardMesh,
	makeShelfCardAction,
} from "./shelf-card-sprite";

function makeCanvasLike() {
	const calls: string[] = [];
	return {
		calls,
		canvas: {
			width: 0,
			height: 0,
			getContext(type: string) {
				expect(type).toBe("2d");
				return {
					clearRect() {
						calls.push("clearRect");
					},
					fillRect() {
						calls.push("fillRect");
					},
					roundRect() {
						calls.push("roundRect");
					},
					beginPath() {
						calls.push("beginPath");
					},
					fill() {
						calls.push("fill");
					},
					stroke() {
						calls.push("stroke");
					},
					moveTo() {
						calls.push("moveTo");
					},
					lineTo() {
						calls.push("lineTo");
					},
					save() {},
					restore() {},
					clip() {},
					createLinearGradient() {
						calls.push("createLinearGradient");
						return { addColorStop() {} };
					},
					measureText(text: string) {
						return { width: text.length * 8 };
					},
					fillText() {
						calls.push("fillText");
					},
				};
			},
		},
	};
}

test("createShelfCardMesh uses baseline canvas, geometry, texture and material settings", () => {
	const made = makeCanvasLike();
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
	const three = {
		PlaneGeometry: FakePlaneGeometry,
		CanvasTexture: FakeCanvasTexture,
		MeshBasicMaterial: FakeMaterial,
		Mesh: FakeMesh,
		LinearFilter: "LinearFilter",
		DoubleSide: "DoubleSide",
	} as unknown as typeof import("three");

	const card = createShelfCardMesh({
		item: { type: "playlist", title: "Playlist", sub: "12 tracks", playlistId: "p1" },
		index: 3,
		three,
		createCanvas: () => made.canvas as unknown as HTMLCanvasElement,
	});
	const geometry = card.geometry as unknown as FakePlaneGeometry;
	const texture = card.texture as unknown as FakeCanvasTexture;
	const material = card.material as unknown as FakeMaterial;

	expect(made.canvas.width).toBe(SHELF_CARD_CANVAS_WIDTH);
	expect(made.canvas.height).toBe(SHELF_CARD_CANVAS_HEIGHT);
	expect(geometry.width).toBe(SHELF_CARD_GEOMETRY_WIDTH);
	expect(geometry.height).toBe(SHELF_CARD_GEOMETRY_HEIGHT);
	expect(geometry.widthSegments).toBe(1);
	expect(geometry.heightSegments).toBe(1);
	expect(texture.minFilter).toBe("LinearFilter");
	expect(texture.magFilter).toBe("LinearFilter");
	expect(texture.generateMipmaps).toBe(false);
	expect(material.transparent).toBe(true);
	expect(material.opacity).toBe(0.96);
	expect(material.depthWrite).toBe(false);
	expect(material.depthTest).toBe(false);
	expect(material.side).toBe("DoubleSide");
	expect(card.mesh.userData.action).toEqual({
		kind: "loadPlaylist",
		playlistId: "p1",
		title: "Playlist",
		provider: undefined,
	});
	expect(made.calls).toContain("roundRect");

	card.dispose();
	expect(geometry.disposed).toBe(true);
	expect(texture.disposed).toBe(true);
	expect(material.disposed).toBe(true);
});

test("makeShelfCardAction maps baseline podcast collection and queue card actions", () => {
	expect(makeShelfCardAction({ title: "Unknown" })).toEqual({
		kind: "empty",
	});
	expect(makeShelfCardAction({ type: "podcastCollection", podcastKey: "dj" })).toEqual({
		kind: "loadPlaylist",
		playlistId: "podcast:dj",
		title: undefined,
	});
	expect(makeShelfCardAction({ type: "queue", queueIndex: 4 })).toEqual({
		kind: "playQueue",
		index: 4,
	});
});

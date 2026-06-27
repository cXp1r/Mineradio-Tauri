import { expect, test } from "bun:test";
import { createShelfPointerRaycastFocus, createShelfPointerRaycastHitGetter } from "./shelf-raycast-focus";

test("createShelfPointerRaycastFocus maps pointer coordinates to NDC and raycasts side shelf cards", async () => {
	const vectorValues: number[][] = [];
	const raycasterCalls: unknown[] = [];
	class FakeVector2 {
		x = 0;
		y = 0;
		set(x: number, y: number) {
			this.x = x;
			this.y = y;
			vectorValues.push([x, y]);
		}
	}
	class FakeRaycaster {
		setFromCamera(vector: FakeVector2, camera: unknown) {
			raycasterCalls.push([vector.x, vector.y, camera]);
		}
	}
	const camera = { name: "camera" };
	const raycasted: unknown[] = [];
	const getSideShelfFocusHit = await createShelfPointerRaycastFocus({
		camera: camera as never,
		three: {
			Raycaster: FakeRaycaster,
			Vector2: FakeVector2,
		} as never,
		shelfManager: {
			getMode: () => "side",
			raycastCards: (raycaster) => {
				raycasted.push(raycaster);
				return { index: 0 } as never;
			},
			pickCardAtScreen: () => {
				throw new Error("fallback should not run after a raycast hit");
			},
		},
	});

	expect(getSideShelfFocusHit({
		clientX: 600,
		clientY: 225,
		viewportWidth: 1200,
		viewportHeight: 900,
	})).toBe(true);

	expect(vectorValues).toEqual([[0, 0.5]]);
	expect(raycasterCalls).toEqual([[0, 0.5, camera]]);
	expect(raycasted.length).toBe(1);
});

test("createShelfPointerRaycastHitGetter returns the card hit so hover and click can reuse raycast results", async () => {
	const vectorValues: number[][] = [];
	class FakeVector2 {
		x = 0;
		y = 0;
		set(x: number, y: number) {
			this.x = x;
			this.y = y;
			vectorValues.push([x, y]);
		}
	}
	class FakeRaycaster {
		setFromCamera() {}
	}
	const hit = { index: 3 };
	const getHit = await createShelfPointerRaycastHitGetter({
		camera: {} as never,
		three: {
			Raycaster: FakeRaycaster,
			Vector2: FakeVector2,
		} as never,
		shelfManager: {
			raycastCards: () => hit as never,
			pickCardAtScreen: () => {
				throw new Error("fallback should not run after a raycast hit");
			},
		},
	});

	expect(getHit({
		clientX: 1200,
		clientY: 900,
		viewportWidth: 1200,
		viewportHeight: 900,
	})).toBe(hit);
	expect(vectorValues).toEqual([[1, -1]]);
});

test("createShelfPointerRaycastHitGetter falls back to screen-space card pick with baseline default padding", async () => {
	class FakeVector2 {
		set() {}
	}
	class FakeRaycaster {
		setFromCamera() {}
	}
	const fallbackHit = { index: 4, screenPick: true };
	const camera = { name: "camera" };
	const pickCalls: unknown[] = [];
	const getHit = await createShelfPointerRaycastHitGetter({
		camera: camera as never,
		three: {
			Raycaster: FakeRaycaster,
			Vector2: FakeVector2,
		} as never,
		shelfManager: {
			raycastCards: () => null,
			pickCardAtScreen: (clientX, clientY, viewportWidth, viewportHeight, pickCamera, pad) => {
				pickCalls.push([clientX, clientY, viewportWidth, viewportHeight, pickCamera, pad]);
				return fallbackHit as never;
			},
		},
	});

	expect(getHit({
		clientX: 12,
		clientY: 34,
		viewportWidth: 1200,
		viewportHeight: 900,
	})).toBe(fallbackHit);
	expect(pickCalls).toEqual([[12, 34, 1200, 900, camera, undefined]]);
});

test("createShelfPointerRaycastHitGetter keeps raycast hit ahead of screen-space fallback", async () => {
	class FakeVector2 {
		set() {}
	}
	class FakeRaycaster {
		setFromCamera() {}
	}
	const raycastHit = { index: 2 };
	const getHit = await createShelfPointerRaycastHitGetter({
		camera: {} as never,
		three: {
			Raycaster: FakeRaycaster,
			Vector2: FakeVector2,
		} as never,
		shelfManager: {
			raycastCards: () => raycastHit as never,
			pickCardAtScreen: () => {
				throw new Error("fallback should not run after a raycast hit");
			},
		},
	});

	expect(getHit({
		clientX: 12,
		clientY: 34,
		viewportWidth: 1200,
		viewportHeight: 900,
		screenPad: 18,
	})).toBe(raycastHit);
});

test("createShelfPointerRaycastHitGetter passes explicit screen padding to fallback picker", async () => {
	class FakeVector2 {
		set() {}
	}
	class FakeRaycaster {
		setFromCamera() {}
	}
	const pickPads: Array<number | undefined> = [];
	const getHit = await createShelfPointerRaycastHitGetter({
		camera: {} as never,
		three: {
			Raycaster: FakeRaycaster,
			Vector2: FakeVector2,
		} as never,
		shelfManager: {
			raycastCards: () => null,
			pickCardAtScreen: (_clientX, _clientY, _viewportWidth, _viewportHeight, _camera, pad) => {
				pickPads.push(pad);
				return null;
			},
		},
	});

	getHit({
		clientX: 12,
		clientY: 34,
		viewportWidth: 1200,
		viewportHeight: 900,
		screenPad: 18,
	});

	expect(pickPads).toEqual([18]);
});

test("createShelfPointerRaycastFocus stays false outside side mode or without viewport size", async () => {
	const getSideShelfFocusHit = await createShelfPointerRaycastFocus({
		camera: {} as never,
		three: {
			Raycaster: class {
				setFromCamera() {
					throw new Error("should not raycast");
				}
			},
			Vector2: class {
				set() {}
			},
		} as never,
		shelfManager: {
			getMode: () => "stage",
			raycastCards: () => {
				throw new Error("should not raycast");
			},
			pickCardAtScreen: () => {
				throw new Error("should not pick screen fallback");
			},
		},
	});

	expect(getSideShelfFocusHit({
		clientX: 100,
		clientY: 100,
		viewportWidth: 1200,
		viewportHeight: 900,
	})).toBe(false);
	expect(getSideShelfFocusHit({
		clientX: 100,
		clientY: 100,
		viewportWidth: 0,
		viewportHeight: 900,
	})).toBe(false);
});

test("createShelfPointerRaycastFocus passes focus-specific screen padding to fallback picker", async () => {
	class FakeVector2 {
		set() {}
	}
	class FakeRaycaster {
		setFromCamera() {}
	}
	const pickPads: Array<number | undefined> = [];
	const getSideShelfFocusHit = await createShelfPointerRaycastFocus({
		camera: {} as never,
		three: {
			Raycaster: FakeRaycaster,
			Vector2: FakeVector2,
		} as never,
		getScreenPad: () => 24,
		shelfManager: {
			getMode: () => "side",
			raycastCards: () => null,
			pickCardAtScreen: (_clientX, _clientY, _viewportWidth, _viewportHeight, _camera, pad) => {
				pickPads.push(pad);
				return { index: 1 } as never;
			},
		},
	});

	expect(getSideShelfFocusHit({
		clientX: 100,
		clientY: 120,
		viewportWidth: 1200,
		viewportHeight: 900,
	})).toBe(true);
	expect(pickPads).toEqual([24]);
});

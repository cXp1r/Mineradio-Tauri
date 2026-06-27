import type * as THREE from "three";
import type { ShelfManager, ShelfRaycastCardHit } from "./shelf-animate";

export interface ShelfPointerRaycastInfo {
	clientX: number;
	clientY: number;
	viewportWidth: number;
	viewportHeight: number;
	screenPad?: number;
}

export type ShelfPointerRaycastFocusGetter = (pointer: ShelfPointerRaycastInfo) => boolean;
export type ShelfPointerRaycastHitGetter = (pointer: ShelfPointerRaycastInfo) => ShelfRaycastCardHit | null;

export interface ShelfPointerRaycastFocusOptions {
	camera: THREE.Camera;
	shelfManager: Pick<ShelfManager, "getMode" | "raycastCards" | "pickCardAtScreen">;
	three?: Pick<typeof import("three"), "Raycaster" | "Vector2">;
	getScreenPad?: (pointer: ShelfPointerRaycastInfo) => number | undefined;
}

export interface ShelfPointerRaycastHitOptions {
	camera: THREE.Camera;
	shelfManager: Pick<ShelfManager, "raycastCards" | "pickCardAtScreen">;
	three?: Pick<typeof import("three"), "Raycaster" | "Vector2">;
}

export async function createShelfPointerRaycastHitGetter(
	opts: ShelfPointerRaycastHitOptions,
): Promise<ShelfPointerRaycastHitGetter> {
	const three = opts.three ?? await import("three");
	const raycaster = new three.Raycaster();
	const pointerNdc = new three.Vector2();
	return (pointer) => {
		if (pointer.viewportWidth <= 0 || pointer.viewportHeight <= 0) return null;
		pointerNdc.set(
			(pointer.clientX / pointer.viewportWidth) * 2 - 1,
			-(pointer.clientY / pointer.viewportHeight) * 2 + 1,
		);
		raycaster.setFromCamera(pointerNdc, opts.camera);
		return opts.shelfManager.raycastCards(raycaster) ||
			opts.shelfManager.pickCardAtScreen(
				pointer.clientX,
				pointer.clientY,
				pointer.viewportWidth,
				pointer.viewportHeight,
				opts.camera,
				pointer.screenPad,
			);
	};
}

export async function createShelfPointerRaycastFocus(
	opts: ShelfPointerRaycastFocusOptions,
): Promise<ShelfPointerRaycastFocusGetter> {
	const getHit = await createShelfPointerRaycastHitGetter(opts);
	return (pointer) => {
		if (opts.shelfManager.getMode() !== "side") return false;
		return getHit({
			...pointer,
			screenPad: opts.getScreenPad?.(pointer),
		}) !== null;
	};
}

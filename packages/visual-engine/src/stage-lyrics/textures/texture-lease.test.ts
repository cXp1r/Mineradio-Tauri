import { expect, test } from "bun:test";
import { createVisualResourceScope } from "../../runtime/resource-scope";
import {
	allocateOwnedLyricTextureLease,
	createLyricTextureLease,
} from "./texture-lease";

test("owned texture lease disposes texture and recycles its canvas exactly once", () => {
	let disposeCount = 0;
	const canvas = { width: 64, height: 32 } as HTMLCanvasElement;
	const lease = createLyricTextureLease({
		texture: { dispose: () => { disposeCount += 1; } } as never,
		ownership: "owned",
		estimatedBytes: 512,
		canvas,
	});
	lease.release();
	lease.release();
	expect(disposeCount).toBe(1);
	expect([canvas.width, canvas.height]).toEqual([1, 1]);
	expect(lease.released).toBe(true);
});

test("borrowed texture lease never disposes or recycles the shared texture", () => {
	let disposeCount = 0;
	const canvas = { width: 64, height: 32 } as HTMLCanvasElement;
	const lease = createLyricTextureLease({
		texture: { dispose: () => { disposeCount += 1; } } as never,
		ownership: "borrowed",
		estimatedBytes: 512,
		canvas,
	});
	lease.release();
	expect(disposeCount).toBe(0);
	expect([canvas.width, canvas.height]).toEqual([64, 32]);
});

test("owned allocation registers its reservation before creating a texture and releases through scope", () => {
	const scope = createVisualResourceScope("stage-test");
	let sawReservation = false;
	let disposed = 0;
	const originalRegister = scope.register.bind(scope);
	let registered = false;
	const resourceScope = {
		...scope,
		register(registration: Parameters<typeof scope.register>[0]) {
			registered = true;
			return originalRegister(registration);
		},
	};
	const lease = allocateOwnedLyricTextureLease({
		owner: "row:1",
		estimatedBytes: 512,
		retention: "ephemeral",
		resourceScope,
		create: () => {
			sawReservation = registered;
			return { texture: { dispose: () => { disposed += 1; } } as never };
		},
	});
	expect(lease).not.toBeNull();
	expect(sawReservation).toBe(true);
	scope.dispose();
	expect(disposed).toBe(1);
	expect(lease?.released).toBe(true);
});

test("owned allocation releases a texture when creation reentrantly closes its scope", () => {
	const scope = createVisualResourceScope("stage-reentrant-close");
	let disposed = 0;
	const lease = allocateOwnedLyricTextureLease({
		owner: "row:closed",
		estimatedBytes: 16,
		retention: "ephemeral",
		resourceScope: scope,
		create: () => {
			scope.dispose();
			return { texture: { dispose: () => { disposed += 1; } } as never };
		},
	});
	expect(lease).toBeNull();
	expect(disposed).toBe(1);
});

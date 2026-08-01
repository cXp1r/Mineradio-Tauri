import { expect, test } from "bun:test";
import { createReusableObjectPool } from "./object-pool";

test("reusable object pool reuses released objects without exceeding capacity", () => {
	let nextId = 0;
	const pool = createReusableObjectPool({
		capacity: 2,
		create: () => ({ id: ++nextId }),
		dispose: () => {},
	});

	const first = pool.acquire();
	const second = pool.acquire();
	expect(pool.acquire()).toBeNull();
	pool.release(first!);
	expect(pool.acquire()).toBe(first);
	expect(second?.id).toBe(2);
	expect(pool.getSnapshot()).toEqual({ capacity: 2, created: 2, active: 2, idle: 0, disposed: false });
});

test("reusable object pool reports cumulative creations and disposes every owned object exactly once", () => {
	let nextId = 0;
	const disposedIds: number[] = [];
	const pool = createReusableObjectPool({
		capacity: 2,
		create: () => ({ id: ++nextId }),
		dispose: (value) => disposedIds.push(value.id),
	});

	const first = pool.acquire();
	const second = pool.acquire();
	pool.release(first!);
	pool.dispose();
	pool.dispose();

	expect(disposedIds.sort()).toEqual([1, 2]);
	expect(pool.getSnapshot()).toEqual({ capacity: 2, created: 2, active: 0, idle: 0, disposed: true });
	expect(() => pool.acquire()).toThrow("Reusable object pool is disposed.");
	expect(second?.id).toBe(2);
});

test("reusable object pool discards externally released resources and can rebuild capacity", () => {
	let nextId = 0;
	const pool = createReusableObjectPool({
		capacity: 2,
		create: () => ({ id: ++nextId }),
		dispose: () => {},
	});
	const first = pool.acquire()!;
	const second = pool.acquire()!;
	pool.release(first);

	pool.discard(first);
	const replacement = pool.acquire();

	expect(replacement?.id).toBe(3);
	expect(pool.getSnapshot()).toEqual({ capacity: 2, created: 3, active: 2, idle: 0, disposed: false });
	expect(second.id).toBe(2);
});

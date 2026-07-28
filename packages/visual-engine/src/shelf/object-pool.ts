export interface ReusableObjectPoolSnapshot {
	readonly capacity: number;
	readonly created: number;
	readonly active: number;
	readonly idle: number;
	readonly disposed: boolean;
}

export interface ReusableObjectPool<T extends object> {
	acquire(): T | null;
	release(value: T): void;
	discard(value: T): void;
	dispose(): void;
	getSnapshot(): ReusableObjectPoolSnapshot;
}

export interface ReusableObjectPoolOptions<T extends object> {
	readonly capacity: number;
	create(): T;
	dispose(value: T): void;
}

export function createReusableObjectPool<T extends object>(
	options: ReusableObjectPoolOptions<T>,
): ReusableObjectPool<T> {
	if (!Number.isInteger(options.capacity) || options.capacity <= 0) {
		throw new RangeError("Reusable object pool capacity must be a positive integer.");
	}
	const owned = new Set<T>();
	const active = new Set<T>();
	const idle: T[] = [];
	let created = 0;
	let disposed = false;

	return {
		acquire() {
			if (disposed) throw new Error("Reusable object pool is disposed.");
			const value = idle.pop() ?? (owned.size < options.capacity ? options.create() : null);
			if (!value) return null;
			if (!owned.has(value)) created += 1;
			owned.add(value);
			active.add(value);
			return value;
		},
		release(value) {
			if (disposed || !owned.has(value) || !active.delete(value)) return;
			idle.push(value);
		},
		discard(value) {
			if (disposed || !owned.delete(value)) return;
			active.delete(value);
			for (let index = idle.length - 1; index >= 0; index -= 1) {
				if (idle[index] === value) idle.splice(index, 1);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const value of owned) options.dispose(value);
			owned.clear();
			active.clear();
			idle.length = 0;
		},
		getSnapshot() {
			return {
				capacity: options.capacity,
				created,
				active: active.size,
				idle: idle.length,
				disposed,
			};
		},
	};
}

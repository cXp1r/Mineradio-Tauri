declare module "bun:test" {
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function beforeEach(fn: () => void): void;
	export function afterEach(fn: () => void): void;
	export function expect(actual: unknown): {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toBeNull(): void;
		toBeGreaterThan(expected: number): void;
		toBeGreaterThanOrEqual(expected: number): void;
		toBeLessThan(expected: number): void;
		toBeLessThanOrEqual(expected: number): void;
		toContain(expected: unknown): void;
		readonly not: {
			toBe(expected: unknown): void;
			toEqual(expected: unknown): void;
			toBeNull(): void;
			toContain(expected: unknown): void;
		};
	};
}
declare module "bun:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void): void;
  export function afterEach(fn: () => void): void;
  export interface ExpectBase {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: unknown): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeInstanceOf(expected: unknown): void;
  }
  export interface ExpectWithNot extends ExpectBase {
    readonly not: Pick<ExpectBase, "toBe" | "toEqual" | "toBeNull" | "toContain">;
  }
  export function expect(actual: unknown): ExpectWithNot;
}
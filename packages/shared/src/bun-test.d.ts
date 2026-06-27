declare module "bun:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): {
    toEqual(expected: unknown): void;
    toBe(expected: unknown): void;
    toThrow(expected?: unknown): void;
  };
}

import { expect, test } from "bun:test";
import { createCancellationScope } from "../index";

test("a newer owner key ticket aborts and invalidates its predecessor", () => {
	const scope = createCancellationScope("root");
	const first = scope.issue("cover", "album-1");
	const next = scope.issue("cover", "album-1");

	expect(first.signal.aborted).toBe(true);
	expect(first.isCurrent()).toBe(false);
	expect(next.signal.aborted).toBe(false);
	expect(next.isCurrent()).toBe(true);
	expect(next.generation).toBe(first.generation + 1);
});

test("disposing a parent invalidates child tickets and rejects new issues", () => {
	const parent = createCancellationScope("parent");
	const child = parent.createChild("child");
	const ticket = child.issue("lyrics", "line-1");

	parent.dispose();

	expect(ticket.signal.aborted).toBe(true);
	expect(ticket.isCurrent()).toBe(false);
	expect(child.isOpen()).toBe(false);
	expect(() => parent.issue("late", "work")).toThrow();
});

test("a stale uncancellable promise cannot commit after a replacement ticket", async () => {
	const scope = createCancellationScope("root");
	let resolveFirst: ((value: string) => void) | undefined;
	const uncancellable = new Promise<string>((resolve) => {
		resolveFirst = resolve;
	});
	const first = scope.issue("palette", "cover");
	const commits: string[] = [];
	void uncancellable.then((value) => {
		if (first.isCurrent() && !first.signal.aborted) commits.push(value);
	});
	scope.issue("palette", "cover");
	resolveFirst?.("old-result");
	await Promise.resolve();

	expect(commits).toEqual([]);
});

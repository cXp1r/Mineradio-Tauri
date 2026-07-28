import { expect, test } from "bun:test";
import {
	createVisualResourceScope,
	VisualResourceScopeClosedError,
} from "../index";
import {
	__inspectVisualResourceHandleForTests as inspectHandle,
	__inspectVisualResourceScopeForTests as inspectScope,
} from "./resource-scope";

test("resources and child scopes dispose once in exact reverse creation order", () => {
	const calls: string[] = [];
	const root = createVisualResourceScope("root");
	const first = root.register({
		owner: "first",
		kind: "mesh",
		retention: "persistent",
		dispose: () => calls.push("first"),
	});
	const child = root.createChild("child");
	child.register({
		owner: "child-first",
		kind: "geometry",
		retention: "rebuildable",
		dispose: () => calls.push("child-first"),
	});
	child.register({
		owner: "child-last",
		kind: "material",
		retention: "rebuildable",
		dispose: () => calls.push("child-last"),
	});
	root.register({
		owner: "last",
		kind: "listener",
		retention: "ephemeral",
		dispose: () => calls.push("last"),
	});

	root.dispose();
	root.dispose();
	first.dispose();

	expect(calls).toEqual(["last", "child-last", "child-first", "first"]);
});

test("manually disposed handles and children are not repeated by their parent", () => {
	const calls: string[] = [];
	const root = createVisualResourceScope("root");
	const handle = root.register({
		owner: "resource",
		kind: "texture",
		retention: "persistent",
		dispose: () => calls.push("resource"),
	});
	const child = root.createChild("child");
	child.register({
		owner: "child-resource",
		kind: "timer",
		retention: "ephemeral",
		dispose: () => calls.push("child-resource"),
	});

	handle.dispose();
	child.dispose();
	root.dispose();

	expect(calls).toEqual(["resource", "child-resource"]);
	expect(handle.disposed).toBe(true);
	expect(child.closed).toBe(true);
});

test("a reentrant disposer observes the shared handle as already disposed", () => {
	const scope = createVisualResourceScope("reentrant");
	let calls = 0;
	let nestedDisposed = -1;
	const handle = scope.register({
		owner: "reentrant-resource",
		kind: "subscription",
		retention: "persistent",
		dispose() {
			calls += 1;
			nestedDisposed = handle.dispose().disposed;
		},
	});

	expect(handle.dispose().disposed).toBe(1);
	expect(nestedDisposed).toBe(0);
	expect(scope.dispose().disposed).toBe(0);
	expect(calls).toBe(1);
});

test("method-style disposers retain the registration as their this value", () => {
	const scope = createVisualResourceScope("method-disposer");
	let observedThis: unknown;
	const registration = {
		owner: "method-resource",
		kind: "listener" as const,
		retention: "persistent" as const,
		dispose() {
			observedThis = this;
		},
	};
	const handle = scope.register(registration);

	const report = handle.dispose();

	expect(observedThis).toBe(registration);
	expect(report.errors).toEqual([]);
	expect(report.disposed).toBe(1);
});

test("closed scopes reject resource registration and child creation", () => {
	const scope = createVisualResourceScope("closed-scope");
	scope.dispose();

	for (const operation of [
		() =>
			scope.register({
				owner: "late",
				kind: "cache",
				retention: "ephemeral",
				dispose() {},
			}),
		() => scope.createChild("late-child"),
	]) {
		try {
			operation();
			throw new Error("expected operation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(VisualResourceScopeClosedError);
			expect((error as VisualResourceScopeClosedError).scopeName).toBe(
				"closed-scope",
			);
		}
	}
});

test("a failing disposer is reported without stopping earlier resources", () => {
	const calls: string[] = [];
	const failure = new Error("material dispose failed");
	const scope = createVisualResourceScope("scene");
	scope.register({
		owner: "first",
		kind: "geometry",
		retention: "persistent",
		dispose: () => calls.push("first"),
	});
	scope.register({
		owner: "broken",
		kind: "material",
		retention: "persistent",
		dispose() {
			calls.push("broken");
			throw failure;
		},
	});
	scope.register({
		owner: "last",
		kind: "texture",
		retention: "persistent",
		dispose: () => calls.push("last"),
	});

	const report = scope.dispose();

	expect(calls).toEqual(["last", "broken", "first"]);
	expect(report.disposed).toBe(3);
	expect(report.errors).toEqual([
		{
			scope: "scene",
			scopePath: "scene",
			owner: "broken",
			kind: "material",
			retention: "persistent",
			cause: failure,
		},
	]);
});

test("parent reports preserve child scope paths and disposer context", () => {
	const failure = new Error("child failed");
	const root = createVisualResourceScope("root");
	const child = root.createChild("child");
	child.register({
		owner: "child-cache",
		kind: "cache",
		retention: "ephemeral",
		dispose() {
			throw failure;
		},
	});

	expect(root.dispose().errors).toEqual([
		{
			scope: "child",
			scopePath: "root/child",
			owner: "child-cache",
			kind: "cache",
			retention: "ephemeral",
			cause: failure,
		},
	]);
});

test("releaseRetention recursively releases only matching entries without closing scopes", () => {
	const calls: string[] = [];
	const root = createVisualResourceScope("root");
	root.register({
		owner: "root-persistent",
		kind: "mesh",
		retention: "persistent",
		dispose: () => calls.push("root-persistent"),
	});
	root.register({
		owner: "root-rebuildable",
		kind: "geometry",
		retention: "rebuildable",
		dispose: () => calls.push("root-rebuildable"),
	});
	const child = root.createChild("child");
	child.register({
		owner: "child-ephemeral",
		kind: "timer",
		retention: "ephemeral",
		dispose: () => calls.push("child-ephemeral"),
	});
	child.register({
		owner: "child-persistent",
		kind: "listener",
		retention: "persistent",
		dispose: () => calls.push("child-persistent"),
	});
	child.register({
		owner: "child-rebuildable",
		kind: "material",
		retention: "rebuildable",
		dispose: () => calls.push("child-rebuildable"),
	});
	root.register({
		owner: "root-ephemeral",
		kind: "subscription",
		retention: "ephemeral",
		dispose: () => calls.push("root-ephemeral"),
	});

	const release = root.releaseRetention(["rebuildable", "ephemeral"]);

	expect(release.disposed).toBe(4);
	expect(release.errors).toEqual([]);
	expect(calls).toEqual([
		"root-ephemeral",
		"child-rebuildable",
		"child-ephemeral",
		"root-rebuildable",
	]);
	expect(root.closed).toBe(false);
	expect(child.closed).toBe(false);
	expect(root.isOpen()).toBe(true);
	expect(child.isOpen()).toBe(true);

	root.register({
		owner: "rebuilt",
		kind: "cache",
		retention: "rebuildable",
		dispose: () => calls.push("rebuilt"),
	});
	expect(root.releaseRetention("rebuildable").disposed).toBe(1);

	const finalReport = root.dispose();
	expect(finalReport.disposed).toBe(2);
	expect(root.isOpen()).toBe(false);
	expect(child.isOpen()).toBe(false);
	expect(calls).toEqual([
		"root-ephemeral",
		"child-rebuildable",
		"child-ephemeral",
		"root-rebuildable",
		"rebuilt",
		"child-persistent",
		"root-persistent",
	]);
});

test("releaseRetention removes disposed entries and clears captured disposer references across rebuilds", () => {
	const scope = createVisualResourceScope("rebuild-loop");
	const handles: ReturnType<typeof scope.register>[] = [];
	const disposedCaptures: object[] = [];

	for (let cycle = 0; cycle < 4; cycle += 1) {
		const captured = { cycle };
		const handle = scope.register({
			owner: `rebuild-${cycle}`,
			kind: "geometry",
			retention: "rebuildable",
			dispose() {
				disposedCaptures.push(captured);
			},
		});
		handles.push(handle);

		expect(scope.releaseRetention("rebuildable")).toEqual({
			disposed: 1,
			errors: [],
		});
		expect(inspectScope(scope)).toEqual({
			entryCount: 0,
			resourceEntryCount: 0,
			childEntryCount: 0,
			activeResourceEntryCount: 0,
			retainedDisposerCount: 0,
		});
		expect(inspectHandle(handle)).toEqual({
			disposed: true,
			retainsDisposer: false,
		});
	}

	expect(disposedCaptures).toHaveLength(4);
	expect(handles.every((handle) => handle.disposed)).toBe(true);
});

test("full dispose releases parent and child entries and clears every disposer reference", () => {
	const root = createVisualResourceScope("root-cleanup");
	const rootHandle = root.register({
		owner: "root-resource",
		kind: "mesh",
		retention: "persistent",
		dispose() {},
	});
	const child = root.createChild("child-cleanup");
	const childHandle = child.register({
		owner: "child-resource",
		kind: "texture",
		retention: "persistent",
		dispose() {},
	});

	expect(root.dispose()).toEqual({ disposed: 2, errors: [] });
	expect(inspectScope(root)).toEqual({
		entryCount: 0,
		resourceEntryCount: 0,
		childEntryCount: 0,
		activeResourceEntryCount: 0,
		retainedDisposerCount: 0,
	});
	expect(inspectScope(child)).toEqual({
		entryCount: 0,
		resourceEntryCount: 0,
		childEntryCount: 0,
		activeResourceEntryCount: 0,
		retainedDisposerCount: 0,
	});
	expect(inspectHandle(rootHandle)).toEqual({
		disposed: true,
		retainsDisposer: false,
	});
	expect(inspectHandle(childHandle)).toEqual({
		disposed: true,
		retainsDisposer: false,
	});
});

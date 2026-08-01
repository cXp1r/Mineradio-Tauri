import { expect, test } from "bun:test";
import {
	__inspectVisualResourceScopeForTests,
	createVisualResourceScope,
} from "../runtime/resource-scope";
import { registerShelfResourceBundle } from "./shelf-resource-bundle";

function makeResource(calls: string[]) {
	return {
		texture: {
			image: { width: 16, height: 8 },
			dispose() {
				calls.push("texture");
			},
		},
		geometry: {
			attributes: {},
			dispose() {
				calls.push("geometry");
			},
		},
		material: {
			dispose() {
				calls.push("material");
				throw new Error("material failed");
			},
		},
		mesh: {},
		retire() {
			calls.push("retire");
		},
	} as never;
}

test("Shelf resource scope isolates one disposer failure and still releases every resource exactly once", () => {
	const calls: string[] = [];
	const scope = createVisualResourceScope("shelf");
	const bundle = registerShelfResourceBundle({
		owner: "card",
		resource: makeResource(calls),
		resourceScope: scope,
		onRelease() {
			calls.push("mesh");
		},
	});

	const report = scope.releaseRetention("rebuildable");
	expect(report.disposed).toBe(4);
	expect(report.errors.length).toBe(1);
	expect(calls).toEqual(["mesh", "retire", "material", "geometry", "texture"]);
	expect(bundle.released).toBe(true);
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);

	scope.releaseRetention("rebuildable");
	expect(calls).toEqual(["mesh", "retire", "material", "geometry", "texture"]);
});

test("Shelf resource bundle reports manual release failures after completing all release steps", () => {
	const calls: string[] = [];
	const scope = createVisualResourceScope("shelf");
	const bundle = registerShelfResourceBundle({
		owner: "row",
		resource: makeResource(calls),
		resourceScope: scope,
		onRelease() {
			calls.push("mesh");
		},
	});

	expect(() => bundle.release()).toThrow("Shelf resource bundle release failed");
	expect(calls).toEqual(["mesh", "retire", "material", "geometry", "texture"]);
	expect(bundle.released).toBe(true);
	expect(__inspectVisualResourceScopeForTests(scope).activeResourceEntryCount).toBe(0);
});

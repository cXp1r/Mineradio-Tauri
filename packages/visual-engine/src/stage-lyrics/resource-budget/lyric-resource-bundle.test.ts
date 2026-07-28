import { expect, test } from "bun:test";
import "../../runtime/happy-dom-preload";
import type {
	VisualResourceDisposalReport,
	VisualResourceHandle,
	VisualResourceRegistration,
	VisualResourceScope,
} from "../../runtime/resource-scope";
import { createVisualResourceScope } from "../../runtime/resource-scope";
import { buildLyricGroup } from "../lyric-builder";
import { DEFAULT_LYRIC_PALETTE } from "../palette";
import {
	registerStageLyricResourceBundle,
	reserveStageLyricResourceBundle,
	type StageLyricResourceBundle,
} from "./lyric-resource-bundle";

function emptyReport(): VisualResourceDisposalReport {
	return { disposed: 0, errors: [] };
}

test("a denied Stage lyric reservation rolls back prior registrations in reverse order", () => {
	const registered: string[] = [];
	const released: string[] = [];
	let registrationCount = 0;
	const scope: VisualResourceScope = {
		name: "stage-row",
		closed: false,
		isOpen: () => true,
		register(registration: VisualResourceRegistration): VisualResourceHandle {
			registrationCount += 1;
			if (registrationCount === 4) {
				const denial = new Error("resource admission denied");
				denial.name = "VisualResourceBudgetAdmissionError";
				throw denial;
			}
			const key = `${registration.kind}:${registrationCount}`;
			registered.push(key);
			let disposed = false;
			return {
				owner: registration.owner,
				kind: registration.kind,
				retention: registration.retention,
				estimatedBytes: registration.estimatedBytes,
				get disposed() { return disposed; },
				dispose() {
					if (disposed) return emptyReport();
					disposed = true;
					released.push(key);
					registration.dispose();
					return { disposed: 1, errors: [] };
				},
			};
		},
		createChild() {
			throw new Error("reservation must reuse the supplied child scope");
		},
		releaseRetention: () => emptyReport(),
		dispose: () => emptyReport(),
	};

	const reservation = reserveStageLyricResourceBundle({
		resourceScope: scope,
		owner: "stage:row",
		retention: "rebuildable",
		estimate: {
			textureBytes: 4096,
			geometryBytes: 1024,
		},
	});

	expect(reservation).toBeNull();
	expect(registered).toEqual(["texture:1", "geometry:2", "material:3"]);
	expect(released).toEqual(["material:3", "geometry:2", "texture:1"]);
});

test("a committed Stage lyric reservation converts to one allocation release", () => {
	const scope = createVisualResourceScope("stage-row");
	const reservation = reserveStageLyricResourceBundle({
		resourceScope: scope,
		owner: "stage:current",
		retention: "persistent",
		estimate: {
			textureBytes: 8192,
			geometryBytes: 2048,
		},
	});
	if (!reservation) throw new Error("expected resource reservation");
	let directDisposals = 0;

	expect(reservation.active).toBe(true);
	expect(reservation.commit(() => { directDisposals += 1; })).toBe(true);
	expect(reservation.commit(() => { directDisposals += 100; })).toBe(false);
	expect(reservation.committed).toBe(true);
	expect(reservation.allocation.released).toBe(false);

	scope.dispose();
	reservation.cancel();
	reservation.allocation.release();
	reservation.allocation.release();

	expect(directDisposals).toBe(1);
	expect(reservation.active).toBe(false);
	expect(reservation.allocation.released).toBe(true);
});

test("a rejected Stage lyric retention promotion releases the whole allocation", () => {
	const handles: VisualResourceHandle[] = [];
	const handleDisposals: number[] = [];
	let registrationCount = 0;
	let directDisposals = 0;
	const scope: VisualResourceScope = {
		name: "stage-row",
		closed: false,
		isOpen: () => true,
		register(registration: VisualResourceRegistration): VisualResourceHandle {
			registrationCount += 1;
			const registrationIndex = registrationCount;
			let retention = registration.retention;
			let disposed = false;
			handleDisposals.push(0);
			const handle: VisualResourceHandle = {
				owner: registration.owner,
				kind: registration.kind,
				get retention() { return retention; },
				estimatedBytes: registration.estimatedBytes,
				get disposed() { return disposed; },
				setRetention(nextRetention) {
					if (disposed || (registrationIndex === 3 && nextRetention === "persistent")) {
						return false;
					}
					retention = nextRetention;
					return true;
				},
				dispose() {
					if (disposed) return emptyReport();
					disposed = true;
					handleDisposals[registrationIndex - 1]! += 1;
					registration.dispose();
					return { disposed: 1, errors: [] };
				},
			};
			handles.push(handle);
			return handle;
		},
		createChild() {
			throw new Error("reservation must reuse the supplied child scope");
		},
		releaseRetention: () => emptyReport(),
		dispose() {
			for (let index = handles.length - 1; index >= 0; index -= 1) {
				handles[index]!.dispose();
			}
			return emptyReport();
		},
	};
	const reservation = reserveStageLyricResourceBundle({
		resourceScope: scope,
		owner: "stage:adjacent",
		retention: "rebuildable",
		estimate: {
			textureBytes: 4096,
			geometryBytes: 1024,
		},
	});
	if (!reservation) throw new Error("expected resource reservation");
	const allocation = reservation.allocation as StageLyricResourceBundle;
	expect(reservation.commit(() => { directDisposals += 1; })).toBe(true);

	expect(allocation.setRetention?.("persistent")).toBe(false);

	expect(allocation.released).toBe(true);
	expect(handles.every((handle) => handle.disposed)).toBe(true);
	expect(handleDisposals).toEqual(handles.map(() => 1));
	expect(directDisposals).toBe(1);

	scope.dispose();
	allocation.release();
	expect(handleDisposals).toEqual(handles.map(() => 1));
	expect(directDisposals).toBe(1);
});

test("a release observer error cannot interrupt fail-closed retention cleanup", async () => {
	const lyric = await buildLyricGroup("observer cleanup", DEFAULT_LYRIC_PALETTE);
	const handles: VisualResourceHandle[] = [];
	const handleDisposals: number[] = [];
	let registrationCount = 0;
	let materialDisposals = 0;
	const originalMaterialDispose = lyric.textMat.dispose.bind(lyric.textMat);
	lyric.textMat.dispose = () => {
		materialDisposals += 1;
		originalMaterialDispose();
	};
	const scope: VisualResourceScope = {
		name: "stage-row",
		closed: false,
		isOpen: () => true,
		register(registration: VisualResourceRegistration): VisualResourceHandle {
			registrationCount += 1;
			const registrationIndex = registrationCount;
			let retention = registration.retention;
			let disposed = false;
			handleDisposals.push(0);
			const handle: VisualResourceHandle = {
				owner: registration.owner,
				kind: registration.kind,
				get retention() { return retention; },
				estimatedBytes: registration.estimatedBytes,
				get disposed() { return disposed; },
				setRetention(nextRetention) {
					if (disposed || (registrationIndex === 3 && nextRetention === "persistent")) {
						return false;
					}
					retention = nextRetention;
					return true;
				},
				dispose() {
					if (disposed) return emptyReport();
					disposed = true;
					handleDisposals[registrationIndex - 1]! += 1;
					registration.dispose();
					return { disposed: 1, errors: [] };
				},
			};
			handles.push(handle);
			return handle;
		},
		createChild() {
			throw new Error("bundle must reuse the supplied child scope");
		},
		releaseRetention: () => emptyReport(),
		dispose() {
			for (let index = handles.length - 1; index >= 0; index -= 1) {
				handles[index]!.dispose();
			}
			return emptyReport();
		},
	};
	const bundle = registerStageLyricResourceBundle({
		lyric,
		resourceScope: scope,
		owner: "stage:adjacent",
		retention: "rebuildable",
	});
	bundle.onRelease?.(() => {
		throw new Error("observer failed");
	});

	expect(() => bundle.setRetention?.("persistent")).toThrow(AggregateError);

	expect(bundle.released).toBe(true);
	expect(handles.every((handle) => handle.disposed)).toBe(true);
	expect(handleDisposals).toEqual(handles.map(() => 1));
	expect(materialDisposals).toBe(1);

	scope.dispose();
	bundle.release();
	expect(handleDisposals).toEqual(handles.map(() => 1));
	expect(materialDisposals).toBe(1);
});

test("post-build registration reuses the committed allocation without another admission", async () => {
	const rawScope = createVisualResourceScope("stage-row");
	let registrations = 0;
	const scope: VisualResourceScope = {
		get name() { return rawScope.name; },
		get closed() { return rawScope.closed; },
		isOpen: () => rawScope.isOpen(),
		register(registration) {
			registrations += 1;
			return rawScope.register(registration);
		},
		createChild: (name) => rawScope.createChild(name),
		releaseRetention: (retention) => rawScope.releaseRetention(retention),
		dispose: () => rawScope.dispose(),
	};
	const reservation = reserveStageLyricResourceBundle({
		resourceScope: scope,
		owner: "stage:current",
		retention: "persistent",
		estimate: {
			textureBytes: 16 * 1024 * 1024,
			geometryBytes: 1024 * 1024,
		},
	});
	if (!reservation) throw new Error("expected resource reservation");
	const lyric = await buildLyricGroup("allocation reuse", DEFAULT_LYRIC_PALETTE, {
		reserveResources: () => reservation,
	});
	const registrationsAfterBuild = registrations;

	const bundle = registerStageLyricResourceBundle({
		lyric,
		resourceScope: scope,
		owner: "stage:current",
		retention: "persistent",
	});

	expect(bundle).toBe(reservation.allocation);
	expect(registrations).toBe(registrationsAfterBuild);
	bundle.release();
	expect(bundle.released).toBe(true);
});

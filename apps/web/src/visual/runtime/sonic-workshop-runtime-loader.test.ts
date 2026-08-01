import { expect, test } from "bun:test";
import { SONIC_WORKSHOP_DEFAULTS } from "../../../../../packages/visual-engine/src/sonic-workshop/sonic-workshop-settings";
import { createSonicWorkshopRuntimeLoader } from "./sonic-workshop-runtime-loader";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

test("Workshop loader keeps the disabled path cold and drops a stale dynamic import", async () => {
	const loaded = deferred<{ createSonicWorkshopRuntime(): never }>();
	let loads = 0;
	let factories = 0;
	let contexts = 0;
	let registrations = 0;
	const controller = createSonicWorkshopRuntimeLoader({
		load: () => {
			loads += 1;
			return loaded.promise;
		},
		createContext: () => {
			contexts += 1;
			return {} as never;
		},
		registerStep: () => {
			registrations += 1;
			return () => undefined;
		},
	});

	controller.sync(false, SONIC_WORKSHOP_DEFAULTS);
	expect(loads).toBe(0);
	expect(contexts).toBe(0);
	expect(registrations).toBe(0);

	controller.sync(true, { ...SONIC_WORKSHOP_DEFAULTS, active: true });
	expect(loads).toBe(1);
	controller.sync(false, SONIC_WORKSHOP_DEFAULTS);
	loaded.resolve({
		createSonicWorkshopRuntime() {
			factories += 1;
			throw new Error("stale factory must not run");
		},
	});
	await Promise.resolve();
	await Promise.resolve();

	expect(factories).toBe(0);
	expect(contexts).toBe(0);
	expect(registrations).toBe(0);
	expect(controller.getState()).toEqual({
		requested: false,
		loading: false,
		active: false,
		failed: false,
	});
	controller.dispose();
});

test("Workshop loader owns the active runtime and unregisters its render lane on exit", async () => {
	const calls: string[] = [];
	const runtime = {
		activate: () => calls.push("activate"),
		configure: () => calls.push("configure"),
		update: () => calls.push("update"),
		deactivate: () => calls.push("deactivate"),
		dispose: () => calls.push("dispose"),
		getDiagnostics: () => ({}),
	};
	const steps: Array<() => void> = [];
	const controller = createSonicWorkshopRuntimeLoader({
		load: async () => ({ createSonicWorkshopRuntime: () => runtime }),
		createContext: () => ({} as never),
		registerStep: (run) => {
			calls.push("register");
			steps.push(() => run({} as never));
			return () => {
				calls.push("unregister");
				steps.length = 0;
			};
		},
	});

	controller.sync(true, { ...SONIC_WORKSHOP_DEFAULTS, active: true });
	await Promise.resolve();
	await Promise.resolve();
	expect(calls).toEqual(["register", "activate"]);
	steps.at(-1)?.();
	expect(calls.at(-1)).toBe("update");
	controller.sync(true, { ...SONIC_WORKSHOP_DEFAULTS, active: true });
	expect(calls.filter((call) => call === "configure").length).toBe(0);

	controller.sync(true, {
		...SONIC_WORKSHOP_DEFAULTS,
		active: true,
		audioIntensity: 1.4,
	});
	expect(calls.at(-1)).toBe("configure");
	expect(calls.filter((call) => call === "configure").length).toBe(1);

	controller.sync(false, SONIC_WORKSHOP_DEFAULTS);
	expect(calls.slice(-2)).toEqual(["unregister", "dispose"]);
	expect(controller.getState().active).toBe(false);

	controller.sync(true, { ...SONIC_WORKSHOP_DEFAULTS, active: true });
	await Promise.resolve();
	await Promise.resolve();
	expect(calls.slice(-2)).toEqual(["register", "activate"]);
	expect(controller.getState().active).toBe(true);
	controller.sync(false, SONIC_WORKSHOP_DEFAULTS);
	expect(calls.slice(-2)).toEqual(["unregister", "dispose"]);
	controller.dispose();
});

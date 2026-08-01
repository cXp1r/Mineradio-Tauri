import { expect, test } from "bun:test";
import type { UpdateSnapshot } from "../../ports/update-runtime-port";
import {
	createDisabledUpdateRuntimePort,
	createTauriUpdateRuntimePort,
	type TauriUpdateRuntimeDependencies,
} from "./tauri-update-runtime";

function snapshot(revision: number, phase: UpdateSnapshot["phase"] = "idle"): UpdateSnapshot {
	return {
		revision,
		phase,
		currentVersion: "0.1.0",
		candidate: null,
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
	};
}

test("standalone Web bootstrap receives a stable disabled runtime", async () => {
	const port = await createTauriUpdateRuntimePort();

	expect(port.getSnapshot()).toEqual({
		revision: 0,
		phase: "disabled",
		currentVersion: "0.0.0-dev",
		candidate: null,
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
	});
	expect(await port.dispatch({ kind: "check-now" })).toBe("runtime-unavailable");
	port.dispose();
});

test("bootstrap failure fallback is a disposable read-only disabled port", async () => {
	const port = createDisabledUpdateRuntimePort("1.0.0");
	let notifications = 0;
	const unsubscribe = port.subscribe(() => {
		notifications += 1;
	});

	expect(port.getSnapshot().phase).toBe("disabled");
	expect(port.getSnapshot().currentVersion).toBe("1.0.0");
	expect(await port.dispatch({ kind: "check-now" })).toBe("runtime-unavailable");
	unsubscribe();
	port.dispose();
	expect(notifications).toBe(0);
});

test("initial snapshot failure releases the listener installed before the read", async () => {
	let unlistenCalls = 0;
	let message = "";
	try {
		await createTauriUpdateRuntimePort({
			listenSnapshot: async () => () => {
				unlistenCalls += 1;
			},
			readSnapshot: async () => {
				throw new Error("snapshot unavailable");
			},
			dispatch: async () => "accepted",
		});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}

	expect(message).toBe("snapshot unavailable");
	expect(unlistenCalls).toBe(1);
});

test("Tauri update adapter listens before snapshot and keeps the highest initialization revision", async () => {
	const calls: string[] = [];
	let emit: ((value: UpdateSnapshot) => void) | undefined;
	let resolveSnapshot: ((value: UpdateSnapshot) => void) | undefined;
	const dependencies: TauriUpdateRuntimeDependencies = {
		listenSnapshot: async (listener) => {
			calls.push("listen");
			emit = listener;
			return () => {};
		},
		readSnapshot: () => {
			calls.push("snapshot");
			return new Promise((resolve) => {
				resolveSnapshot = resolve;
			});
		},
		dispatch: async () => "accepted",
	};

	const pending = createTauriUpdateRuntimePort(dependencies);
	await Promise.resolve();
	await Promise.resolve();
	expect(calls).toEqual(["listen", "snapshot"]);
	emit?.(snapshot(2, "available"));
	resolveSnapshot?.(snapshot(1, "checking"));

	const port = await pending;
	expect(port.getSnapshot()).toEqual(snapshot(2, "available"));
	expect(calls).toEqual(["listen", "snapshot"]);
	port.dispose();
});

test("a revision gap stops local publication and resynchronizes a full snapshot", async () => {
	let emit: ((value: UpdateSnapshot) => void) | undefined;
	let reads = 0;
	const dependencies: TauriUpdateRuntimeDependencies = {
		listenSnapshot: async (listener) => {
			emit = listener;
			return () => {};
		},
		readSnapshot: async () => {
			reads += 1;
			return reads === 1 ? snapshot(1, "checking") : snapshot(4, "available");
		},
		dispatch: async () => "accepted",
	};
	const port = await createTauriUpdateRuntimePort(dependencies);
	let notifications = 0;
	port.subscribe(() => {
		notifications += 1;
	});

	emit?.(snapshot(3, "current"));
	expect(notifications).toBe(0);
	await Promise.resolve();
	await Promise.resolve();

	expect(reads).toBe(2);
	expect(port.getSnapshot()).toEqual(snapshot(4, "available"));
	expect(notifications).toBe(1);
	port.dispose();
});

test("a failed revision resync retries through one delayed timer without a native event", async () => {
	let emit: ((value: UpdateSnapshot) => void) | undefined;
	let reads = 0;
	const retries: Array<() => void> = [];
	const port = await createTauriUpdateRuntimePort({
		listenSnapshot: async (listener) => {
			emit = listener;
			return () => {};
		},
		readSnapshot: async () => {
			reads += 1;
			if (reads === 1) return snapshot(1, "idle");
			if (reads === 2) throw new Error("temporary snapshot failure");
			return snapshot(5, "available");
		},
		dispatch: async () => "accepted",
		scheduleResyncRetry(callback) {
			retries.push(callback);
			return () => {};
		},
	});

	emit?.(snapshot(3, "current"));
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(reads).toBe(2);
	expect(port.getSnapshot()).toEqual(snapshot(1, "idle"));
	expect(retries.length).toBe(1);

	retries.shift()?.();
	await Promise.resolve();
	await Promise.resolve();
	expect(reads).toBe(3);
	expect(port.getSnapshot()).toEqual(snapshot(5, "available"));
	port.dispose();
});

test("a malformed revision resync is also treated as a failed read", async () => {
	let emit: ((value: UpdateSnapshot) => void) | undefined;
	let reads = 0;
	const retries: Array<() => void> = [];
	const port = await createTauriUpdateRuntimePort({
		listenSnapshot: async (listener) => {
			emit = listener;
			return () => {};
		},
		readSnapshot: async () => {
			reads += 1;
			if (reads === 1) return snapshot(1, "idle");
			if (reads === 2) {
				return {
					...snapshot(3, "available"),
					candidate: { id: "x", version: "1.0.0", notes: null, publishedAt: null },
				} as unknown as UpdateSnapshot;
			}
			return snapshot(5, "available");
		},
		dispatch: async () => "accepted",
		scheduleResyncRetry(callback) {
			retries.push(callback);
			return () => {};
		},
	});

	emit?.(snapshot(3, "current"));
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(reads).toBe(2);
	expect(retries.length).toBe(1);

	retries.shift()?.();
	await Promise.resolve();
	await Promise.resolve();
	expect(reads).toBe(3);
	expect(port.getSnapshot()).toEqual(snapshot(5, "available"));
	port.dispose();
});

test("the Web projection is immutable and detached from native payload mutation", async () => {
	const native = {
		...snapshot(1, "available"),
		candidate: {
			id: "candidate-0.2.0",
			version: "0.2.0",
			notes: ["修复播放链路"],
			publishedAt: null,
		},
	};
	const port = await createTauriUpdateRuntimePort({
		listenSnapshot: async () => () => {},
		readSnapshot: async () => native,
		dispatch: async () => "accepted",
	});
	const projected = port.getSnapshot();

	expect(Object.isFrozen(projected)).toBe(true);
	expect(Object.isFrozen(projected.candidate)).toBe(true);
	expect(Object.isFrozen(projected.candidate?.notes)).toBe(true);
	native.candidate.notes.push("远端对象后续被修改");
	expect(projected.candidate?.notes).toEqual(["修复播放链路"]);
	port.dispose();
});

test("dispatch carries the projected revision and contains transport failure", async () => {
	let received: unknown;
	const port = await createTauriUpdateRuntimePort({
		listenSnapshot: async () => () => {},
		readSnapshot: async () => snapshot(7, "available"),
		dispatch: async (request) => {
			received = request;
			throw new Error("native transport unavailable");
		},
	});

	expect(await port.dispatch({ kind: "check-now" })).toBe("runtime-unavailable");
	expect(received).toEqual({
		expectedRevision: 7,
		intent: { kind: "check-now" },
	});
	port.dispose();
});

test("subscriber churn reuses one native listener and dispose stops every publication", async () => {
	let listenCalls = 0;
	let unlistenCalls = 0;
	let emit: ((value: UpdateSnapshot) => void) | undefined;
	const port = await createTauriUpdateRuntimePort({
		listenSnapshot: async (listener) => {
			listenCalls += 1;
			emit = listener;
			return () => {
				unlistenCalls += 1;
			};
		},
		readSnapshot: async () => snapshot(0),
		dispatch: async () => "accepted",
	});
	let notifications = 0;
	const unsubscribeFirst = port.subscribe(() => {
		notifications += 1;
	});
	unsubscribeFirst();
	const unsubscribeSecond = port.subscribe(() => {
		notifications += 1;
	});
	emit?.(snapshot(1, "checking"));
	unsubscribeSecond();
	port.dispose();
	port.dispose();
	emit?.(snapshot(2, "available"));

	expect(listenCalls).toBe(1);
	expect(unlistenCalls).toBe(1);
	expect(notifications).toBe(1);
	expect(port.getSnapshot()).toEqual(snapshot(1, "checking"));
});

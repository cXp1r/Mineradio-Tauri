import type {
	UpdateIntent,
	UpdateReceipt,
	UpdateRuntimePort,
	UpdateSnapshot,
} from "../../ports/update-runtime-port";
import {
	invokeTauriCommand,
	listenTauriEvent,
	type Unlisten,
} from "../../tauri/runtime";

const UPDATE_SNAPSHOT_EVENT = "update-runtime-snapshot";
const UPDATE_SNAPSHOT_COMMAND = "get_update_runtime_snapshot";
const UPDATE_DISPATCH_COMMAND = "dispatch_update_runtime_intent";

export interface TauriUpdateDispatchRequest {
	readonly expectedRevision: number;
	readonly intent: UpdateIntent;
}

export interface TauriUpdateRuntimeDependencies {
	listenSnapshot(listener: (snapshot: UpdateSnapshot) => void): Promise<Unlisten>;
	readSnapshot(): Promise<UpdateSnapshot>;
	dispatch(request: TauriUpdateDispatchRequest): Promise<UpdateReceipt>;
}

export interface DisposableUpdateRuntimePort extends UpdateRuntimePort {
	dispose(): void;
}

const defaultDependencies: TauriUpdateRuntimeDependencies = {
	listenSnapshot: (listener) => listenTauriEvent(UPDATE_SNAPSHOT_EVENT, listener),
	async readSnapshot() {
		const snapshot = await invokeTauriCommand<UpdateSnapshot>(UPDATE_SNAPSHOT_COMMAND);
		if (!snapshot) throw new Error("UPDATE_RUNTIME_SNAPSHOT_UNAVAILABLE");
		return snapshot;
	},
	async dispatch(request) {
		const receipt = await invokeTauriCommand<UpdateReceipt>(UPDATE_DISPATCH_COMMAND, { request });
		return receipt ?? "runtime-unavailable";
	},
};

function highestRevision(
	left: UpdateSnapshot | null,
	right: UpdateSnapshot | null,
): UpdateSnapshot | null {
	if (!left) return right;
	if (!right) return left;
	return right.revision > left.revision ? right : left;
}

function projectSnapshot(snapshot: UpdateSnapshot): UpdateSnapshot {
	const candidate = snapshot.candidate
		? Object.freeze({
			...snapshot.candidate,
			notes: Object.freeze([...snapshot.candidate.notes]),
		})
		: null;
	const operation = snapshot.operation ? Object.freeze({ ...snapshot.operation }) : null;
	const fault = snapshot.fault ? Object.freeze({ ...snapshot.fault }) : null;
	return Object.freeze({ ...snapshot, candidate, operation, fault });
}

export async function createTauriUpdateRuntimePort(
	dependencies: TauriUpdateRuntimeDependencies = defaultDependencies,
): Promise<DisposableUpdateRuntimePort> {
	let disposed = false;
	let initializing = true;
	let buffered: UpdateSnapshot | null = null;
	let current: UpdateSnapshot | null = null;
	let resyncBuffered: UpdateSnapshot | null = null;
	let resync: Promise<void> | null = null;
	const subscribers = new Set<() => void>();
	const publish = (snapshot: UpdateSnapshot) => {
		if (disposed || (current && snapshot.revision <= current.revision)) return;
		current = snapshot;
		for (const subscriber of subscribers) subscriber();
	};
	const startResync = (snapshot: UpdateSnapshot) => {
		resyncBuffered = highestRevision(resyncBuffered, snapshot);
		if (resync) return;
		resync = dependencies.readSnapshot()
			.then((fresh) => {
				if (disposed) return;
				const next = highestRevision(projectSnapshot(fresh), resyncBuffered);
				resyncBuffered = null;
				if (next) publish(next);
			})
			.catch(() => undefined)
			.finally(() => {
				resync = null;
				const pending = resyncBuffered;
				resyncBuffered = null;
				if (!disposed && pending && (!current || pending.revision > current.revision)) {
					if (current && pending.revision === current.revision + 1) publish(pending);
					else startResync(pending);
				}
			});
	};

	const unlisten = await dependencies.listenSnapshot((nativeSnapshot) => {
		if (disposed) return;
		const snapshot = projectSnapshot(nativeSnapshot);
		if (initializing) {
			buffered = highestRevision(buffered, snapshot);
			return;
		}
		if (!current || snapshot.revision <= current.revision) return;
		if (resync) {
			resyncBuffered = highestRevision(resyncBuffered, snapshot);
			return;
		}
		if (snapshot.revision === current.revision + 1) publish(snapshot);
		else startResync(snapshot);
	});
	const commandSnapshot = projectSnapshot(await dependencies.readSnapshot());
	current = highestRevision(commandSnapshot, buffered);
	initializing = false;

	return {
		getSnapshot() {
			if (!current) throw new Error("UPDATE_RUNTIME_SNAPSHOT_UNAVAILABLE");
			return current;
		},
		subscribe(listener) {
			subscribers.add(listener);
			return () => subscribers.delete(listener);
		},
		async dispatch(intent) {
			if (disposed || !current) return Promise.resolve("runtime-unavailable");
			try {
				return await dependencies.dispatch({
					expectedRevision: current.revision,
					intent,
				});
			} catch {
				return "runtime-unavailable";
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			subscribers.clear();
			unlisten();
		},
	};
}

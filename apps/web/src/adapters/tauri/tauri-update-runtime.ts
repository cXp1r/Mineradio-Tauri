import type {
	UpdateIntent,
	UpdateReceipt,
	UpdateRuntimePort,
	UpdateSnapshot,
} from "../../ports/update-runtime-port";
import {
	invokeTauriCommand,
	isTauriRuntime,
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
	scheduleResyncRetry?(callback: () => void, delayMs: number): Unlisten;
}

export interface DisposableUpdateRuntimePort extends UpdateRuntimePort {
	dispose(): void;
}

function disabledSnapshot(currentVersion: string): UpdateSnapshot {
	return Object.freeze({
		revision: 0,
		phase: "disabled",
		currentVersion,
		candidate: null,
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
	});
}

const STANDALONE_DISABLED_SNAPSHOT = disabledSnapshot("0.0.0-dev");
const INITIAL_RESYNC_RETRY_MS = 250;
const MAX_RESYNC_RETRY_MS = 30_000;

const defaultDependencies: TauriUpdateRuntimeDependencies = {
	listenSnapshot: (listener) => listenTauriEvent(UPDATE_SNAPSHOT_EVENT, listener),
	async readSnapshot() {
		// 浏览器开发构建没有 native authority；保持稳定 disabled，而不是阻断整个 Web bootstrap。
		if (!isTauriRuntime()) return STANDALONE_DISABLED_SNAPSHOT;
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

/** updater bootstrap 失败时仅禁用更新；播放器和其他应用生命周期继续启动。 */
export function createDisabledUpdateRuntimePort(
	currentVersion = "0.0.0-unavailable",
): DisposableUpdateRuntimePort {
	const snapshot = disabledSnapshot(currentVersion);
	return Object.freeze({
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		dispatch: async () => "runtime-unavailable" as const,
		dispose: () => {},
	});
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
	let cancelResyncRetry: Unlisten | null = null;
	let resyncRetryDelayMs = INITIAL_RESYNC_RETRY_MS;
	const subscribers = new Set<() => void>();
	const scheduleResyncRetry = dependencies.scheduleResyncRetry
		?? ((callback: () => void, delayMs: number) => {
			const timer = globalThis.setTimeout(callback, delayMs);
			return () => globalThis.clearTimeout(timer);
		});
	const clearResyncRetry = () => {
		cancelResyncRetry?.();
		cancelResyncRetry = null;
	};
	const publish = (snapshot: UpdateSnapshot) => {
		if (disposed || (current && snapshot.revision <= current.revision)) return;
		current = snapshot;
		for (const subscriber of subscribers) subscriber();
	};
	const scheduleBufferedResync = () => {
		if (disposed || !resyncBuffered || cancelResyncRetry) return;
		const delayMs = resyncRetryDelayMs;
		resyncRetryDelayMs = Math.min(resyncRetryDelayMs * 2, MAX_RESYNC_RETRY_MS);
		cancelResyncRetry = scheduleResyncRetry(() => {
			cancelResyncRetry = null;
			const pending = resyncBuffered;
			if (pending && !disposed) startResync(pending);
		}, delayMs);
	};
	const startResync = (snapshot: UpdateSnapshot) => {
		clearResyncRetry();
		resyncBuffered = highestRevision(resyncBuffered, snapshot);
		if (resync) return;
		let succeeded = false;
		resync = dependencies.readSnapshot()
			.then((fresh) => {
				if (disposed) return;
				const projected = projectSnapshot(fresh);
				const next = highestRevision(projected, resyncBuffered);
				resyncBuffered = null;
				if (next) publish(next);
				succeeded = true;
				resyncRetryDelayMs = INITIAL_RESYNC_RETRY_MS;
			})
			.catch(() => undefined)
			.finally(() => {
				resync = null;
				// 失败时保留最高缺口证据，通过唯一指数退避 timer 恢复；禁止
				// microtask/IPC 自旋，也不依赖后续 native event 才能重新收敛。
				if (!succeeded) {
					scheduleBufferedResync();
					return;
				}
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
		if (resyncBuffered) {
			startResync(snapshot);
			return;
		}
		if (snapshot.revision === current.revision + 1) publish(snapshot);
		else startResync(snapshot);
	});
	let commandSnapshot: UpdateSnapshot;
	try {
		commandSnapshot = projectSnapshot(await dependencies.readSnapshot());
	} catch (error) {
		disposed = true;
		unlisten();
		throw error;
	}
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
			clearResyncRetry();
			subscribers.clear();
			unlisten();
		},
	};
}

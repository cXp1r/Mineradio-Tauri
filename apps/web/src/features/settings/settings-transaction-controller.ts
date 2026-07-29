export type SettingPath = string;

export interface SettingsValueChange {
	before: unknown;
	after: unknown;
}

export interface SettingsMutation {
	label: string;
	changes: Record<SettingPath, SettingsValueChange>;
	resolveChanges?(): Record<SettingPath, SettingsValueChange>;
	mergeKey?: string;
	commit(): Promise<void> | void;
}

export interface SettingsHistoryEntry {
	id: string;
	label: string;
	changedPaths: SettingPath[];
	before: Record<SettingPath, unknown>;
	after: Record<SettingPath, unknown>;
	mergeKey?: string;
	committedAt: number;
}

export interface SettingsTransactionSnapshot {
	entries: readonly SettingsHistoryEntry[];
	busy: boolean;
	error: string | null;
}

export type SettingsRestore = (
	values: Record<SettingPath, unknown>,
) => Promise<void> | void;

export interface SettingsTransactionControllerOptions {
	now?: () => number;
	mergeWindowMs?: number;
	maxEntries?: number;
}

function settingsValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object") {
		return false;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
			return false;
		}
		return left.every((value, index) => settingsValuesEqual(value, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every(
		(key) =>
			Object.hasOwn(rightRecord, key) &&
			settingsValuesEqual(leftRecord[key], rightRecord[key]),
	);
}

export class SettingsTransactionController {
	private entries: SettingsHistoryEntry[] = [];
	private busy = false;
	private error: string | null = null;
	private sequence = 0;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;
	private readonly mergeWindowMs: number;
	private readonly maxEntries: number;
	private snapshot: SettingsTransactionSnapshot = {
		entries: [],
		busy: false,
		error: null,
	};

	constructor(options: SettingsTransactionControllerOptions = {}) {
		this.now = options.now ?? Date.now;
		this.mergeWindowMs = options.mergeWindowMs ?? 650;
		this.maxEntries = options.maxEntries ?? 40;
	}

	getSnapshot(): SettingsTransactionSnapshot {
		return this.snapshot;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	apply(mutation: SettingsMutation): Promise<boolean> {
		return this.enqueue(async () => {
			const changes = mutation.resolveChanges?.() ?? mutation.changes;
			const changedPaths = Object.keys(changes).filter((path) => {
				const change = changes[path];
				return !!change && !settingsValuesEqual(change.before, change.after);
			});
			if (!changedPaths.length) return false;
			await mutation.commit();
			const before: Record<SettingPath, unknown> = {};
			const after: Record<SettingPath, unknown> = {};
			for (const path of changedPaths) {
				const change = changes[path];
				if (!change) continue;
				before[path] = change.before;
				after[path] = change.after;
			}
			const committedAt = this.now();
			const previous = this.entries.at(-1);
			if (
				mutation.mergeKey &&
				previous?.mergeKey === mutation.mergeKey &&
				committedAt - previous.committedAt <= this.mergeWindowMs
			) {
				const mergedPaths = [...previous.changedPaths];
				const mergedBefore = { ...previous.before };
				const mergedAfter = { ...previous.after };
				for (const path of changedPaths) {
					if (!mergedPaths.includes(path)) mergedPaths.push(path);
					if (!Object.hasOwn(mergedBefore, path)) mergedBefore[path] = before[path];
					mergedAfter[path] = after[path];
				}
				this.entries = [
					...this.entries.slice(0, -1),
					{
						...previous,
						label: mutation.label,
						changedPaths: mergedPaths,
						before: mergedBefore,
						after: mergedAfter,
						committedAt,
					},
				];
			} else {
				this.entries = [
					...this.entries,
					{
						id: `settings-${++this.sequence}`,
						label: mutation.label,
						changedPaths,
						before,
						after,
						mergeKey: mutation.mergeKey,
						committedAt,
					},
				].slice(-this.maxEntries);
			}
			this.emit();
			return true;
		});
	}

	undo(restore: SettingsRestore): Promise<boolean> {
		return this.enqueue(async () => {
			const entry = this.entries.at(-1);
			if (!entry) return false;
			await restore(entry.before);
			this.entries = this.entries.slice(0, -1);
			this.emit();
			return true;
		});
	}

	rollbackTo(entryId: string, restore: SettingsRestore): Promise<boolean> {
		return this.enqueue(async () => {
			const targetIndex = this.entries.findIndex((entry) => entry.id === entryId);
			if (targetIndex < 0) return false;
			const values: Record<SettingPath, unknown> = {};
			for (const entry of this.entries.slice(targetIndex)) {
				for (const path of entry.changedPaths) {
					if (!Object.hasOwn(values, path)) values[path] = entry.before[path];
				}
			}
			await restore(values);
			this.entries = this.entries.slice(0, targetIndex);
			this.emit();
			return true;
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const run = async () => {
			this.busy = true;
			this.error = null;
			this.emit();
			try {
				return await operation();
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
				this.emit();
				throw error;
			} finally {
				this.busy = false;
				this.emit();
			}
		};
		if (!this.busy) {
			const immediate = run();
			this.tail = immediate.then(
				() => undefined,
				() => undefined,
			);
			return immediate;
		}
		const queued = this.tail.then(run, run);
		this.tail = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	private emit(): void {
		this.snapshot = {
			entries: this.entries,
			busy: this.busy,
			error: this.error,
		};
		for (const listener of this.listeners) listener();
	}
}

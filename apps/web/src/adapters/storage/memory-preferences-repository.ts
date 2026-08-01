import {
	cloneJsonValue,
	defaultPreferenceValue,
	parsePreferenceValue,
	type PreferenceKey,
	type PreferencesRepository,
	type PreferencesTransaction,
} from "../../ports/preferences-repository";

export interface StoredPreference {
	schemaVersion: number;
	value: unknown;
}

interface QuarantinedPreference extends StoredPreference {
	reason: string;
}

export class MemoryPreferencesRepository implements PreferencesRepository {
	private values: Map<string, StoredPreference>;
	private quarantined = new Map<string, QuarantinedPreference>();
	private tail: Promise<void> = Promise.resolve();

	constructor(initial: Readonly<Record<string, StoredPreference>> = {}) {
		this.values = new Map(
			Object.entries(initial).map(([name, stored]) => [name, cloneJsonValue(stored)]),
		);
	}

	get<T>(key: PreferenceKey<T>): Promise<T> {
		return this.enqueue(() => this.readFrom(this.values, key));
	}

	set<T>(key: PreferenceKey<T>, value: T): Promise<void> {
		return this.enqueue(() => {
			this.writeTo(this.values, key, value);
		});
	}

	remove<T>(key: PreferenceKey<T>): Promise<void> {
		return this.enqueue(() => {
			this.values.delete(key.name);
		});
	}

	transaction<T>(work: (tx: PreferencesTransaction) => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			const working = new Map(
				[...this.values].map(([name, stored]) => [name, cloneJsonValue(stored)]),
			);
			const tx: PreferencesTransaction = {
				get: async <V>(key: PreferenceKey<V>) => this.readFrom(working, key),
				set: async <V>(key: PreferenceKey<V>, value: V) => {
					this.writeTo(working, key, value);
				},
				remove: async <V>(key: PreferenceKey<V>) => {
					working.delete(key.name);
				},
			};
			const result = await work(tx);
			this.values = working;
			return result;
		});
	}

	/** 仅供测试和诊断读取；业务代码不能依赖隔离区内容。 */
	quarantinedSnapshot(): Readonly<Record<string, QuarantinedPreference>> {
		return Object.fromEntries(
			[...this.quarantined].map(([name, value]) => [name, cloneJsonValue(value)]),
		);
	}

	private readFrom<T>(store: Map<string, StoredPreference>, key: PreferenceKey<T>): T {
		const stored = store.get(key.name);
		if (!stored) return defaultPreferenceValue(key);
		if (stored.schemaVersion !== key.schemaVersion) {
			this.quarantine(store, key.name, stored, "schema-version");
			return defaultPreferenceValue(key);
		}
		try {
			return parsePreferenceValue(key, stored.value);
		} catch {
			this.quarantine(store, key.name, stored, "schema-invalid");
			return defaultPreferenceValue(key);
		}
	}

	private writeTo<T>(
		store: Map<string, StoredPreference>,
		key: PreferenceKey<T>,
		value: T,
	): void {
		const parsed = parsePreferenceValue(key, value);
		store.set(key.name, {
			schemaVersion: key.schemaVersion,
			value: cloneJsonValue(parsed),
		});
	}

	private quarantine(
		store: Map<string, StoredPreference>,
		name: string,
		stored: StoredPreference,
		reason: string,
	): void {
		this.quarantined.set(name, { ...cloneJsonValue(stored), reason });
		store.delete(name);
	}

	private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
		const result = this.tail.then(work, work);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

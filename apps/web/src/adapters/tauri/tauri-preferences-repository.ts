import {
	cloneJsonValue,
	defaultPreferenceValue,
	parsePreferenceValue,
	type PreferenceKey,
	type PreferencesRepository,
	type PreferencesTransaction,
} from "../../ports/preferences-repository";
import {
	DEFAULT_LEGACY_PREFERENCE_MAPPINGS,
	mappingByPreferenceName,
	type LegacyPreferenceMapping,
	type LegacyPreferenceStorage,
} from "../../preferences/legacy-preferences";
import { canonicalPreferenceDigest } from "../../preferences/preference-digest";
import {
	commitPreferencesTransaction,
	getPreferencesSnapshot,
	migrateLegacyPreferences,
	type LegacyPreferenceMigrationEntry,
	type LegacyPreferencesMigrationRequest,
	type PreferenceMutation,
	type PreferenceTransactionRequest,
	type PreferencesSnapshot,
} from "./tauri-preferences";
import { getLegacyBrowserPreferenceStorage } from "../storage/legacy-browser-storage";

export const MAX_PREFERENCES_STARTUP_IPC_CALLS = 2;

export interface TauriPreferencesTransport {
	getSnapshot(): Promise<PreferencesSnapshot>;
	commitTransaction(
		request: PreferenceTransactionRequest,
	): Promise<PreferencesSnapshot>;
	migrateLegacy(
		request: LegacyPreferencesMigrationRequest,
	): Promise<PreferencesSnapshot>;
}

const defaultTransport: TauriPreferencesTransport = {
	getSnapshot: getPreferencesSnapshot,
	commitTransaction: commitPreferencesTransaction,
	migrateLegacy: migrateLegacyPreferences,
};

export interface TauriPreferenceDiagnostic {
	code: string;
	message: string;
	key?: string;
}

interface StagedMutation {
	wire: PreferenceMutation;
	key: PreferenceKey<unknown>;
	value?: unknown;
}

export class TauriPreferencesRepository implements PreferencesRepository {
	private snapshot: PreferencesSnapshot = {
		schemaVersion: 1,
		values: {},
		migrations: {},
	};
	private hydrated = false;
	private tail: Promise<void> = Promise.resolve();
	private diagnostics: TauriPreferenceDiagnostic[] = [];
	private readonly mappingByName: ReadonlyMap<
		string,
		LegacyPreferenceMapping<unknown>
	>;

	constructor(
		private readonly transport: TauriPreferencesTransport = defaultTransport,
		private readonly storage: LegacyPreferenceStorage | null =
			getLegacyBrowserPreferenceStorage(),
		private readonly legacyMappings: readonly LegacyPreferenceMapping<unknown>[] =
			DEFAULT_LEGACY_PREFERENCE_MAPPINGS,
	) {
		this.mappingByName = mappingByPreferenceName(legacyMappings);
	}

	async hydrate(): Promise<void> {
		await this.enqueue(async () => {
			if (this.hydrated) return;
			let startupCalls = 0;
			this.snapshot = await this.transport.getSnapshot();
			startupCalls += 1;
			const entries = await this.collectLegacyMigrationEntries();
			if (entries.length > 0) {
				this.snapshot = await this.transport.migrateLegacy({ entries });
				startupCalls += 1;
			}
			if (startupCalls > MAX_PREFERENCES_STARTUP_IPC_CALLS) {
				throw new Error("PREFERENCES_STARTUP_IPC_LIMIT_EXCEEDED");
			}
			this.hydrated = true;
		});
	}

	isHydrated(): boolean {
		return this.hydrated;
	}

	get<T>(key: PreferenceKey<T>): Promise<T> {
		return this.enqueue(async () => {
			this.requireHydrated();
			const stored = this.snapshot.values[key.name];
			if (!stored) return defaultPreferenceValue(key);
			try {
				if (stored.schemaVersion !== key.schemaVersion) {
					throw new Error("schema-version");
				}
				return parsePreferenceValue(key, stored.value);
			} catch (error) {
				try {
					this.snapshot = await this.transport.commitTransaction({
						operations: [
							{
								kind: "quarantine",
								key: key.name,
								reason:
									error instanceof Error
										? error.message
										: "schema-invalid",
							},
						],
					});
				} catch (quarantineError) {
					delete this.snapshot.values[key.name];
					this.diagnostics.push({
						code: "PREFERENCE_QUARANTINE_FAILED",
						message:
							quarantineError instanceof Error
								? quarantineError.message
								: String(quarantineError),
						key: key.name,
					});
				}
				return defaultPreferenceValue(key);
			}
		});
	}

	set<T>(key: PreferenceKey<T>, value: T): Promise<void> {
		return this.transaction(async (tx) => tx.set(key, value));
	}

	remove<T>(key: PreferenceKey<T>): Promise<void> {
		return this.transaction(async (tx) => tx.remove(key));
	}

	transaction<T>(work: (tx: PreferencesTransaction) => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			this.requireHydrated();
			const working = cloneJsonValue(this.snapshot);
			const staged: StagedMutation[] = [];
			const tx: PreferencesTransaction = {
				get: async <V>(key: PreferenceKey<V>) => {
					const stored = working.values[key.name];
					if (!stored) return defaultPreferenceValue(key);
					try {
						if (stored.schemaVersion !== key.schemaVersion) {
							throw new Error("schema-version");
						}
						return parsePreferenceValue(key, stored.value);
					} catch (error) {
						delete working.values[key.name];
						staged.push({
							wire: {
								kind: "quarantine",
								key: key.name,
								reason:
									error instanceof Error
										? error.message
										: "schema-invalid",
							},
							key,
						});
						return defaultPreferenceValue(key);
					}
				},
				set: async <V>(key: PreferenceKey<V>, value: V) => {
					const parsed = parsePreferenceValue(key, value);
					working.values[key.name] = {
						schemaVersion: key.schemaVersion,
						value: parsed,
					};
					staged.push({
						wire: {
							kind: "set",
							key: key.name,
							schemaVersion: key.schemaVersion,
							value: parsed,
						},
						key,
						value: parsed,
					});
				},
				remove: async <V>(key: PreferenceKey<V>) => {
					delete working.values[key.name];
					staged.push({ wire: { kind: "remove", key: key.name }, key });
				},
			};
			const result = await work(tx);
			if (staged.length === 0) return result;
			const committed = await this.transport.commitTransaction({
				operations: staged.map((mutation) => mutation.wire),
			});
			this.snapshot = committed;
			this.mirrorLegacy(staged);
			return result;
		});
	}

	diagnosticsSnapshot(): readonly TauriPreferenceDiagnostic[] {
		return cloneJsonValue(this.diagnostics);
	}

	private async collectLegacyMigrationEntries(): Promise<
		LegacyPreferenceMigrationEntry[]
	> {
		if (!this.storage) return [];
		const entries: LegacyPreferenceMigrationEntry[] = [];
		for (const mapping of this.legacyMappings) {
			if (this.snapshot.migrations[mapping.legacyKey]?.state === "committed") {
				continue;
			}
			const raw = this.storage.getItem(mapping.legacyKey);
			if (raw === null) continue;
			const decoded = mapping.decode(raw);
			if (decoded === undefined) {
				this.diagnostics.push({
					code: "PREFERENCE_LEGACY_VALUE_INVALID",
					message: `无法迁移旧偏好 ${mapping.legacyKey}`,
					key: mapping.legacyKey,
				});
				continue;
			}
			try {
				const value = parsePreferenceValue(mapping.preferenceKey, decoded);
				entries.push({
					legacyKey: mapping.legacyKey,
					preferenceKey: mapping.preferenceKey.name,
					schemaVersion: mapping.preferenceKey.schemaVersion,
					digest: await canonicalPreferenceDigest(value),
					value,
				});
			} catch (error) {
				this.diagnostics.push({
					code: "PREFERENCE_LEGACY_VALUE_INVALID",
					message: error instanceof Error ? error.message : String(error),
					key: mapping.legacyKey,
				});
			}
		}
		return entries;
	}

	private mirrorLegacy(staged: readonly StagedMutation[]): void {
		if (!this.storage) return;
		for (const mutation of staged) {
			if (mutation.wire.kind === "quarantine") continue;
			const mapping = this.mappingByName.get(mutation.key.name);
			if (!mapping) continue;
			const value =
				mutation.wire.kind === "set"
					? mutation.value
					: defaultPreferenceValue(mutation.key);
			try {
				this.storage.setItem(mapping.legacyKey, mapping.encode(value));
			} catch (error) {
				this.diagnostics.push({
					code: "PREFERENCE_LEGACY_MIRROR_FAILED",
					message: error instanceof Error ? error.message : String(error),
					key: mapping.legacyKey,
				});
			}
		}
	}

	private requireHydrated(): void {
		if (!this.hydrated) throw new Error("PREFERENCES_NOT_HYDRATED");
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

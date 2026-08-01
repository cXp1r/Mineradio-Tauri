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
import type { StoredPreference } from "./memory-preferences-repository";
import { getLegacyBrowserPreferenceStorage } from "./legacy-browser-storage";

export const BROWSER_PREFERENCES_STORAGE_KEY = "mineradio-preferences-v1";
const BROWSER_PREFERENCES_QUARANTINE_KEY =
	"mineradio-preferences-v1-quarantine";

interface BrowserMigrationJournal {
	digest: string;
	preferenceKey: string;
	state: "committed";
}

interface BrowserPreferencesEnvelope {
	schemaVersion: 1;
	values: Record<string, StoredPreference>;
	quarantine: Record<string, StoredPreference & { reason: string }>;
	migrations: Record<string, BrowserMigrationJournal>;
}

export interface PreferenceDiagnostic {
	code: string;
	message: string;
	key?: string;
}

interface BrowserMutation {
	kind: "set" | "remove" | "quarantine";
	key: PreferenceKey<unknown>;
	value?: unknown;
}

function emptyEnvelope(): BrowserPreferencesEnvelope {
	return {
		schemaVersion: 1,
		values: {},
		quarantine: {},
		migrations: {},
	};
}

export class BrowserPreferencesRepository implements PreferencesRepository {
	private envelope = emptyEnvelope();
	private hydrated = false;
	private tail: Promise<void> = Promise.resolve();
	private diagnostics: PreferenceDiagnostic[] = [];
	private readonly mappingByName: ReadonlyMap<
		string,
		LegacyPreferenceMapping<unknown>
	>;

	constructor(
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
			this.envelope = this.readEnvelope();
			let changed = false;
			for (const mapping of this.legacyMappings) {
				if (this.envelope.migrations[mapping.legacyKey]?.state === "committed") {
					continue;
				}
				const raw = this.storage?.getItem(mapping.legacyKey);
				if (raw === null || raw === undefined) continue;
				const decoded = mapping.decode(raw);
				if (decoded === undefined) continue;
				try {
					const value = parsePreferenceValue(mapping.preferenceKey, decoded);
					this.envelope.values[mapping.preferenceKey.name] = {
						schemaVersion: mapping.preferenceKey.schemaVersion,
						value,
					};
					this.envelope.migrations[mapping.legacyKey] = {
						digest: await canonicalPreferenceDigest(value),
						preferenceKey: mapping.preferenceKey.name,
						state: "committed",
					};
					changed = true;
				} catch {
					this.diagnostics.push({
						code: "PREFERENCE_LEGACY_VALUE_INVALID",
						message: `无法迁移旧偏好 ${mapping.legacyKey}`,
						key: mapping.legacyKey,
					});
				}
			}
			if (changed) this.persistEnvelope(this.envelope);
			this.hydrated = true;
		});
	}

	isHydrated(): boolean {
		return this.hydrated;
	}

	get<T>(key: PreferenceKey<T>): Promise<T> {
		return this.enqueue(() => {
			this.requireHydrated();
			return this.readFrom(this.envelope, key);
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
			const working = cloneJsonValue(this.envelope);
			const mutations: BrowserMutation[] = [];
			const tx: PreferencesTransaction = {
				get: async <V>(key: PreferenceKey<V>) => this.readFrom(working, key),
				set: async <V>(key: PreferenceKey<V>, value: V) => {
					const parsed = parsePreferenceValue(key, value);
					working.values[key.name] = {
						schemaVersion: key.schemaVersion,
						value: parsed,
					};
					mutations.push({ kind: "set", key, value: parsed });
				},
				remove: async <V>(key: PreferenceKey<V>) => {
					delete working.values[key.name];
					mutations.push({ kind: "remove", key });
				},
			};
			const result = await work(tx);
			this.persistEnvelope(working);
			this.envelope = working;
			this.mirrorLegacy(mutations);
			return result;
		});
	}

	diagnosticsSnapshot(): readonly PreferenceDiagnostic[] {
		return cloneJsonValue(this.diagnostics);
	}

	private readEnvelope(): BrowserPreferencesEnvelope {
		const raw = this.storage?.getItem(BROWSER_PREFERENCES_STORAGE_KEY);
		if (!raw) return emptyEnvelope();
		try {
			const parsed = JSON.parse(raw) as Partial<BrowserPreferencesEnvelope>;
			if (
				parsed.schemaVersion !== 1 ||
				!parsed.values ||
				typeof parsed.values !== "object"
			) {
				throw new Error("invalid envelope");
			}
			return {
				schemaVersion: 1,
				values: parsed.values,
				quarantine: parsed.quarantine ?? {},
				migrations: parsed.migrations ?? {},
			};
		} catch (error) {
			try {
				this.storage?.setItem(BROWSER_PREFERENCES_QUARANTINE_KEY, raw);
			} catch {
				// 原始损坏内容已保留在原 key，隔离副本失败也不覆盖它。
			}
			this.diagnostics.push({
				code: "PREFERENCES_ENVELOPE_INVALID",
				message: error instanceof Error ? error.message : String(error),
			});
			return emptyEnvelope();
		}
	}

	private readFrom<T>(
		envelope: BrowserPreferencesEnvelope,
		key: PreferenceKey<T>,
	): T {
		const stored = envelope.values[key.name];
		if (!stored) return defaultPreferenceValue(key);
		try {
			if (stored.schemaVersion !== key.schemaVersion) throw new Error("schema-version");
			return parsePreferenceValue(key, stored.value);
		} catch (error) {
			envelope.quarantine[key.name] = {
				...cloneJsonValue(stored),
				reason: error instanceof Error ? error.message : "schema-invalid",
			};
			delete envelope.values[key.name];
			if (envelope === this.envelope) {
				try {
					this.persistEnvelope(envelope);
				} catch {
					// 读取仍返回安全默认值；诊断已保留，不能让损坏值阻止启动。
				}
			}
			return defaultPreferenceValue(key);
		}
	}

	private persistEnvelope(envelope: BrowserPreferencesEnvelope): void {
		this.storage?.setItem(
			BROWSER_PREFERENCES_STORAGE_KEY,
			JSON.stringify(envelope),
		);
	}

	private mirrorLegacy(mutations: readonly BrowserMutation[]): void {
		for (const mutation of mutations) {
			if (mutation.kind === "quarantine") continue;
			const mapping = this.mappingByName.get(mutation.key.name);
			if (!mapping || !this.storage) continue;
			const value =
				mutation.kind === "set"
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

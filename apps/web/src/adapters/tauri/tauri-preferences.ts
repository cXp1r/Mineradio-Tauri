import { invokeTauriCommand, isTauriRuntime } from "../../tauri/runtime";

export interface StoredPreferenceValue {
	schemaVersion: number;
	value: unknown;
}

export interface PreferenceMigrationJournal {
	legacyKey: string;
	preferenceKey: string;
	schemaVersion: number;
	digest: string;
	state: "copied" | "verified" | "committed";
	diagnostic: string | null;
}

export interface PreferencesSnapshot {
	schemaVersion: number;
	values: Record<string, StoredPreferenceValue>;
	migrations: Record<string, PreferenceMigrationJournal>;
}

export type PreferenceMutation =
	| {
			kind: "set";
			key: string;
			schemaVersion: number;
			value: unknown;
	  }
	| { kind: "remove"; key: string }
	| { kind: "quarantine"; key: string; reason: string };

export interface PreferenceTransactionRequest {
	operations: PreferenceMutation[];
}

export interface LegacyPreferenceMigrationEntry {
	legacyKey: string;
	preferenceKey: string;
	schemaVersion: number;
	digest: string;
	value: unknown;
}

export interface LegacyPreferencesMigrationRequest {
	entries: LegacyPreferenceMigrationEntry[];
}

function requireTauriRuntime(): void {
	if (!isTauriRuntime()) throw new Error("PREFERENCES_TAURI_RUNTIME_REQUIRED");
}

export async function getPreferencesSnapshot(): Promise<PreferencesSnapshot> {
	requireTauriRuntime();
	const snapshot = await invokeTauriCommand<PreferencesSnapshot>(
		"get_preferences_snapshot",
	);
	if (!snapshot) throw new Error("PREFERENCES_SNAPSHOT_EMPTY");
	return snapshot;
}

export async function commitPreferencesTransaction(
	request: PreferenceTransactionRequest,
): Promise<PreferencesSnapshot> {
	requireTauriRuntime();
	const snapshot = await invokeTauriCommand<PreferencesSnapshot>(
		"commit_preferences_transaction",
		{ request },
	);
	if (!snapshot) throw new Error("PREFERENCES_COMMIT_EMPTY");
	return snapshot;
}

export async function migrateLegacyPreferences(
	request: LegacyPreferencesMigrationRequest,
): Promise<PreferencesSnapshot> {
	requireTauriRuntime();
	const snapshot = await invokeTauriCommand<PreferencesSnapshot>(
		"migrate_legacy_preferences",
		{ request },
	);
	if (!snapshot) throw new Error("PREFERENCES_MIGRATION_EMPTY");
	return snapshot;
}

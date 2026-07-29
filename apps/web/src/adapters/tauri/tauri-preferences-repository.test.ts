import { expect, test } from "bun:test";
import {
	DIY_MODE_PREFERENCE,
	PLAYBACK_QUALITY_PREFERENCE,
} from "../../preferences/keys";
import {
	TauriPreferencesRepository,
	type TauriPreferencesTransport,
} from "./tauri-preferences-repository";
import type {
	LegacyPreferencesMigrationRequest,
	PreferenceTransactionRequest,
	PreferencesSnapshot,
} from "./tauri-preferences";

class MemoryLegacyStorage {
	readonly values = new Map<string, string>();
	readonly failures = new Set<string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		if (this.failures.has(key)) throw new Error(`blocked:${key}`);
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

function emptySnapshot(): PreferencesSnapshot {
	return { schemaVersion: 1, values: {}, migrations: {} };
}

class FakeTransport implements TauriPreferencesTransport {
	snapshot = emptySnapshot();
	readonly calls: string[] = [];
	failCommit = false;

	async getSnapshot(): Promise<PreferencesSnapshot> {
		this.calls.push("snapshot");
		return structuredClone(this.snapshot);
	}

	async commitTransaction(
		request: PreferenceTransactionRequest,
	): Promise<PreferencesSnapshot> {
		this.calls.push("commit");
		if (this.failCommit) throw new Error("commit failed");
		for (const operation of request.operations) {
			if (operation.kind === "set") {
				this.snapshot.values[operation.key] = {
					schemaVersion: operation.schemaVersion,
					value: operation.value,
				};
			} else {
				delete this.snapshot.values[operation.key];
			}
		}
		return structuredClone(this.snapshot);
	}

	async migrateLegacy(
		request: LegacyPreferencesMigrationRequest,
	): Promise<PreferencesSnapshot> {
		this.calls.push("migrate");
		for (const entry of request.entries) {
			this.snapshot.values[entry.preferenceKey] = {
				schemaVersion: entry.schemaVersion,
				value: entry.value,
			};
			this.snapshot.migrations[entry.legacyKey] = {
				legacyKey: entry.legacyKey,
				preferenceKey: entry.preferenceKey,
				schemaVersion: entry.schemaVersion,
				digest: entry.digest,
				state: "committed",
				diagnostic: null,
			};
		}
		return structuredClone(this.snapshot);
	}
}

async function captureError(work: () => Promise<unknown>): Promise<string> {
	try {
		await work();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

test("Tauri repository hydrates snapshot and legacy journal in at most two startup calls", async () => {
	const transport = new FakeTransport();
	const legacy = new MemoryLegacyStorage();
	legacy.values.set("mineradio-playback-quality-v1", "flac");
	const repository = new TauriPreferencesRepository(transport, legacy);

	expect(
		await captureError(() => repository.set(PLAYBACK_QUALITY_PREFERENCE, "m4a")),
	).toContain("PREFERENCES_NOT_HYDRATED");
	expect(transport.calls).toEqual([]);

	await repository.hydrate();

	expect(transport.calls).toEqual(["snapshot", "migrate"]);
	expect(await repository.get(PLAYBACK_QUALITY_PREFERENCE)).toBe("flac");
});

test("Tauri repository leaves memory and legacy mirror untouched when commit fails", async () => {
	const transport = new FakeTransport();
	transport.snapshot.values["playback.quality"] = {
		schemaVersion: 1,
		value: "hires",
	};
	const legacy = new MemoryLegacyStorage();
	const repository = new TauriPreferencesRepository(transport, legacy);
	await repository.hydrate();
	transport.failCommit = true;

	expect(
		await captureError(() => repository.set(PLAYBACK_QUALITY_PREFERENCE, "flac")),
	).toContain("commit failed");
	expect(await repository.get(PLAYBACK_QUALITY_PREFERENCE)).toBe("hires");
	expect(legacy.values.has("mineradio-playback-quality-v1")).toBe(false);
});

test("Tauri repository reports mirror failure without rolling back committed SQLite value", async () => {
	const transport = new FakeTransport();
	const legacy = new MemoryLegacyStorage();
	legacy.failures.add("mineradio-playback-quality-v1");
	const repository = new TauriPreferencesRepository(transport, legacy);
	await repository.hydrate();

	await repository.set(PLAYBACK_QUALITY_PREFERENCE, "flac");

	expect(await repository.get(PLAYBACK_QUALITY_PREFERENCE)).toBe("flac");
	expect(repository.diagnosticsSnapshot()[0]?.code).toBe(
		"PREFERENCE_LEGACY_MIRROR_FAILED",
	);
});

test("Tauri repository quarantines a stored value that fails the typed schema", async () => {
	const transport = new FakeTransport();
	transport.snapshot.values["shell.diyMode"] = {
		schemaVersion: 1,
		value: "broken",
	};
	const repository = new TauriPreferencesRepository(transport, null);
	await repository.hydrate();

	expect(await repository.get(DIY_MODE_PREFERENCE)).toBe(false);
	expect(transport.calls).toEqual(["snapshot", "commit"]);
	expect(transport.snapshot.values["shell.diyMode"]).toBe(undefined);
});

test("Tauri repository returns the safe default when quarantine persistence fails", async () => {
	const transport = new FakeTransport();
	transport.snapshot.values["shell.diyMode"] = {
		schemaVersion: 1,
		value: "broken",
	};
	const repository = new TauriPreferencesRepository(transport, null);
	await repository.hydrate();
	transport.failCommit = true;

	expect(await repository.get(DIY_MODE_PREFERENCE)).toBe(false);
	expect(repository.diagnosticsSnapshot()[0]?.code).toBe(
		"PREFERENCE_QUARANTINE_FAILED",
	);
});

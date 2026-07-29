import { expect, test } from "bun:test";
import {
	createJsonPreferenceKey,
	type PreferencesRepository,
} from "../../ports/preferences-repository";
import { MemoryPreferencesRepository } from "./memory-preferences-repository";
import {
	BROWSER_PREFERENCES_STORAGE_KEY,
	BrowserPreferencesRepository,
} from "./browser-preferences-repository";
import { PLAYBACK_QUALITY_PREFERENCE } from "../../preferences/keys";
import {
	TauriPreferencesRepository,
	type TauriPreferencesTransport,
} from "../tauri/tauri-preferences-repository";
import type {
	LegacyPreferencesMigrationRequest,
	PreferenceTransactionRequest,
	PreferencesSnapshot,
} from "../tauri/tauri-preferences";

const COUNT_PREFERENCE = createJsonPreferenceKey({
	name: "test.count",
	schemaVersion: 1,
	defaultValue: 7,
	parse(value): number | undefined {
		return typeof value === "number" && Number.isInteger(value) ? value : undefined;
	},
});

function repositoryFactories(): Array<{
	name: string;
	create(): Promise<PreferencesRepository>;
}> {
	return [
		{
			name: "memory",
			create: async () => new MemoryPreferencesRepository(),
		},
		{
			name: "browser",
			create: async () => {
				const repository = new BrowserPreferencesRepository(new MemoryStorage());
				await repository.hydrate();
				return repository;
			},
		},
		{
			name: "tauri",
			create: async () => {
				const repository = new TauriPreferencesRepository(
					new ConformanceTauriTransport(),
					null,
				);
				await repository.hydrate();
				return repository;
			},
		},
	];
}

class ConformanceTauriTransport implements TauriPreferencesTransport {
	private snapshot: PreferencesSnapshot = {
		schemaVersion: 1,
		values: {},
		migrations: {},
	};

	async getSnapshot(): Promise<PreferencesSnapshot> {
		return structuredClone(this.snapshot);
	}

	async commitTransaction(
		request: PreferenceTransactionRequest,
	): Promise<PreferencesSnapshot> {
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
		_request: LegacyPreferencesMigrationRequest,
	): Promise<PreferencesSnapshot> {
		return structuredClone(this.snapshot);
	}
}

class MemoryStorage {
	readonly values = new Map<string, string>();
	readonly failures = new Set<string>();
	writeCount = 0;

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.writeCount += 1;
		if (this.failures.has(key)) throw new Error(`blocked:${key}`);
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		if (this.failures.has(key)) throw new Error(`blocked:${key}`);
		this.values.delete(key);
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

for (const factory of repositoryFactories()) {
	test(`${factory.name} typed key returns its default and validates persisted values`, async () => {
			const repository = await factory.create();

			expect(await repository.get(COUNT_PREFERENCE)).toBe(7);
			await repository.set(COUNT_PREFERENCE, 11);
			expect(await repository.get(COUNT_PREFERENCE)).toBe(11);
			expect(
				await captureError(() => repository.set(COUNT_PREFERENCE, 1.5)),
			).toContain("PREFERENCE_SCHEMA_INVALID");
		});

	test(`${factory.name} transaction commits all mutations atomically`, async () => {
			const repository = await factory.create();

			expect(
				await captureError(() => repository.transaction(async (tx) => {
					await tx.set(COUNT_PREFERENCE, 19);
					throw new Error("abort");
				})),
			).toContain("abort");
			expect(await repository.get(COUNT_PREFERENCE)).toBe(7);

			await repository.transaction(async (tx) => {
				await tx.set(COUNT_PREFERENCE, 23);
			});
			expect(await repository.get(COUNT_PREFERENCE)).toBe(23);
		});
}

test("browser repository blocks default writeback before hydration", async () => {
	const storage = new MemoryStorage();
	const repository = new BrowserPreferencesRepository(storage);

	expect(
		await captureError(() => repository.set(PLAYBACK_QUALITY_PREFERENCE, "flac")),
	).toContain("PREFERENCES_NOT_HYDRATED");
	expect(storage.writeCount).toBe(0);
});

test("browser repository keeps committed value when legacy mirror fails", async () => {
	const storage = new MemoryStorage();
	storage.failures.add("mineradio-playback-quality-v1");
	const repository = new BrowserPreferencesRepository(storage);
	await repository.hydrate();

	await repository.set(PLAYBACK_QUALITY_PREFERENCE, "flac");

	expect(await repository.get(PLAYBACK_QUALITY_PREFERENCE)).toBe("flac");
	expect(storage.values.get(BROWSER_PREFERENCES_STORAGE_KEY)).toContain("flac");
	expect(repository.diagnosticsSnapshot()[0]?.code).toBe(
		"PREFERENCE_LEGACY_MIRROR_FAILED",
	);
});

test("browser migration keeps legacy data and committed canonical value becomes authoritative", async () => {
	const storage = new MemoryStorage();
	storage.values.set("mineradio-playback-quality-v1", "flac");
	const first = new BrowserPreferencesRepository(storage);
	await first.hydrate();
	expect(await first.get(PLAYBACK_QUALITY_PREFERENCE)).toBe("flac");
	expect(storage.values.get("mineradio-playback-quality-v1")).toBe("flac");

	storage.values.set("mineradio-playback-quality-v1", "m4a");
	const afterLegacyChanged = new BrowserPreferencesRepository(storage);
	await afterLegacyChanged.hydrate();
	expect(await afterLegacyChanged.get(PLAYBACK_QUALITY_PREFERENCE)).toBe("flac");
});

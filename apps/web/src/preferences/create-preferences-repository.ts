import { isTauriRuntime } from "../tauri/runtime";
import { BrowserPreferencesRepository } from "../adapters/storage/browser-preferences-repository";
import {
	TauriPreferencesRepository,
	type TauriPreferencesTransport,
} from "../adapters/tauri/tauri-preferences-repository";
import type { PreferencesRepository } from "../ports/preferences-repository";
import {
	DEFAULT_LEGACY_PREFERENCE_MAPPINGS,
	stagePlaybackAudioLegacyAggregate,
	type LegacyPreferenceMapping,
	type LegacyPreferenceStorage,
} from "./legacy-preferences";
import { getLegacyBrowserPreferenceStorage } from "../adapters/storage/legacy-browser-storage";

export interface CreatePreferencesRepositoryOptions {
	storage?: LegacyPreferenceStorage | null;
	additionalLegacyMappings?: readonly LegacyPreferenceMapping<unknown>[];
	tauriTransport?: TauriPreferencesTransport;
	forceRuntime?: "browser" | "tauri";
}

function mergeMappings(
	additional: readonly LegacyPreferenceMapping<unknown>[],
): readonly LegacyPreferenceMapping<unknown>[] {
	const byLegacyKey = new Map(
		DEFAULT_LEGACY_PREFERENCE_MAPPINGS.map((mapping) => [
			mapping.legacyKey,
			mapping,
		]),
	);
	for (const mapping of additional) byLegacyKey.set(mapping.legacyKey, mapping);
	return [...byLegacyKey.values()];
}

/**
 * Composition root 使用的唯一工厂。返回前已完成 snapshot + legacy hydration，
 * 因而调用方不会拿到可把默认值提前写回的 repository。
 */
export async function createPreferencesRepository(
	options: CreatePreferencesRepositoryOptions = {},
): Promise<PreferencesRepository> {
	const storage =
		options.storage === undefined
			? getLegacyBrowserPreferenceStorage()
			: options.storage;
	stagePlaybackAudioLegacyAggregate(storage);
	const mappings = mergeMappings(options.additionalLegacyMappings ?? []);
	const useTauri =
		options.forceRuntime === "tauri" ||
		(options.forceRuntime !== "browser" && isTauriRuntime());
	if (useTauri) {
		const repository = new TauriPreferencesRepository(
			options.tauriTransport,
			storage,
			mappings,
		);
		await repository.hydrate();
		return repository;
	}
	const repository = new BrowserPreferencesRepository(storage, mappings);
	await repository.hydrate();
	return repository;
}

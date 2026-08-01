import type {
	JsonValue,
	PreferenceKey,
	PreferencesRepository,
} from "../../ports/preferences-repository";
import { HOME_LISTEN_LEDGER_PREFERENCE } from "../../preferences/keys";
import {
	defineLegacyPreferenceMapping,
	type LegacyPreferenceMapping,
} from "../../preferences/legacy-preferences";
import {
	migrateHomeListenLedger,
	type HomeListenLedgerV2,
} from "./home-listen-ledger";
import type { HomeListenRepository } from "./home-listen-repository";

const HOME_LISTEN_LEGACY_KEY = "mineradio-listen-stats-v1";

function preferenceValue(ledger: HomeListenLedgerV2): { [key: string]: JsonValue } {
	const parsed = HOME_LISTEN_LEDGER_PREFERENCE.parse(ledger);
	if (!parsed) throw new Error("HOME_LISTEN_LEDGER_SCHEMA_INVALID");
	return parsed;
}

/**
 * Home domain 自己拥有 v1→v2 语义，Preferences factory 只负责执行迁移 journal。
 */
export function createHomeListenLegacyPreferenceMapping(): LegacyPreferenceMapping<unknown> {
	return defineLegacyPreferenceMapping<unknown>({
		legacyKey: HOME_LISTEN_LEGACY_KEY,
		preferenceKey: HOME_LISTEN_LEDGER_PREFERENCE as PreferenceKey<unknown>,
		decode(raw) {
			try {
				return preferenceValue(migrateHomeListenLedger(JSON.parse(raw)));
			} catch {
				return undefined;
			}
		},
		encode(value) {
			const ledger = migrateHomeListenLedger(value);
			return JSON.stringify({
				history: ledger.songs,
				updatedAt: ledger.updatedAt,
			});
		},
	});
}

/**
 * Hydration 后创建同步读取、异步提交的 Home Adapter。
 * save 只有在 canonical preference 提交成功后才更新本地快照。
 */
export async function createPreferencesHomeListenRepository(
	preferences: PreferencesRepository,
): Promise<HomeListenRepository> {
	let current = migrateHomeListenLedger(
		await preferences.get(HOME_LISTEN_LEDGER_PREFERENCE),
	);
	return {
		read: () => current,
		async save(value) {
			const next = migrateHomeListenLedger(value);
			await preferences.set(
				HOME_LISTEN_LEDGER_PREFERENCE,
				preferenceValue(next),
			);
			current = next;
		},
	};
}

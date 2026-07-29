import {
	migrateHomeListenLedger,
	type HomeListenLedgerV2,
} from "./home-listen-ledger";
import type { HomeListenRepository } from "./home-listen-repository";

const HOME_LISTEN_LEDGER_KEY = "mineradio-listen-stats-v2";
const HOME_LISTEN_LEGACY_KEY = "mineradio-listen-stats-v1";

/**
 * M8 过渡期浏览器 Adapter。正式 Tauri 路径由 PreferencesRepository 注入，
 * 这里仅负责旧 localStorage 的 dual-read / dual-write 回滚窗口。
 */
export class LegacyBrowserHomeListenAdapter implements HomeListenRepository {
	constructor(
		private readonly configuredStorage?: Pick<
			Storage,
			"getItem" | "setItem"
		> | null,
	) {}

	read(): unknown {
		const storage = this.resolveStorage();
		if (!storage) return null;
		try {
			const current = storage.getItem(HOME_LISTEN_LEDGER_KEY);
			if (current) return JSON.parse(current);
			const legacy = storage.getItem(HOME_LISTEN_LEGACY_KEY);
			return legacy ? JSON.parse(legacy) : null;
		} catch {
			return null;
		}
	}

	save(value: HomeListenLedgerV2): void {
		const storage = this.resolveStorage();
		if (!storage) return;
		const ledger = migrateHomeListenLedger(value);
		try {
			storage.setItem(HOME_LISTEN_LEDGER_KEY, JSON.stringify(ledger));
		} catch {
			return;
		}
		try {
			// 回滚窗口内保留可无损映射的 v1 lifetime 镜像，不删除旧 key。
			storage.setItem(
				HOME_LISTEN_LEGACY_KEY,
				JSON.stringify({ history: ledger.songs, updatedAt: ledger.updatedAt }),
			);
		} catch {
			// 新存储已经提交，legacy mirror 失败不能回滚新值。
		}
	}

	private resolveStorage(): Pick<Storage, "getItem" | "setItem"> | null {
		if (this.configuredStorage !== undefined) return this.configuredStorage;
		return typeof localStorage === "undefined" ? null : localStorage;
	}
}

export const defaultHomeListenRepository: HomeListenRepository =
	new LegacyBrowserHomeListenAdapter();

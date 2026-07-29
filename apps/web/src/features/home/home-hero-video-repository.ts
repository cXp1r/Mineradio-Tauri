import type {
	HomeHeroVideoRecord,
	HomeHeroVideoRepository,
} from "./home-hero-video";

// 复用 Electron 2.0.2 的数据库与记录形状，升级后无需复制 300MB Blob。
const HOME_HERO_VIDEO_DB = "mineradio-home-dashboard-video-v1";
const HOME_HERO_VIDEO_STORE = "media";
const HOME_HERO_VIDEO_ID = "home-hero-video";

interface StoredHomeHeroVideoRecord extends HomeHeroVideoRecord {
	id: typeof HOME_HERO_VIDEO_ID;
}

function transactionFailure(
	transaction: IDBTransaction,
	fallback: string,
): Error {
	return transaction.error ?? new Error(fallback);
}

export class IndexedDbHomeHeroVideoRepository
	implements HomeHeroVideoRepository
{
	private databasePromise: Promise<IDBDatabase> | null = null;

	constructor(
		private readonly indexedDb: IDBFactory | null =
			typeof indexedDB === "undefined" ? null : indexedDB,
	) {}

	async read(): Promise<HomeHeroVideoRecord | null> {
		const database = await this.open();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction(
				HOME_HERO_VIDEO_STORE,
				"readonly",
			);
			const request = transaction
				.objectStore(HOME_HERO_VIDEO_STORE)
				.get(HOME_HERO_VIDEO_ID);
			request.onsuccess = () => {
				const value = request.result as StoredHomeHeroVideoRecord | undefined;
				resolve(value ? { blob: value.blob, meta: value.meta } : null);
			};
			request.onerror = () =>
				reject(request.error ?? new Error("主页 MP4 读取失败"));
		});
	}

	async write(record: HomeHeroVideoRecord): Promise<void> {
		const database = await this.open();
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(
				HOME_HERO_VIDEO_STORE,
				"readwrite",
			);
			transaction.objectStore(HOME_HERO_VIDEO_STORE).put({
				id: HOME_HERO_VIDEO_ID,
				blob: record.blob,
				meta: record.meta,
			} satisfies StoredHomeHeroVideoRecord);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () =>
				reject(transactionFailure(transaction, "主页 MP4 保存失败"));
			transaction.onabort = () =>
				reject(transactionFailure(transaction, "主页 MP4 保存已取消"));
		});
	}

	async remove(): Promise<void> {
		const database = await this.open();
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(
				HOME_HERO_VIDEO_STORE,
				"readwrite",
			);
			transaction
				.objectStore(HOME_HERO_VIDEO_STORE)
				.delete(HOME_HERO_VIDEO_ID);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () =>
				reject(transactionFailure(transaction, "主页 MP4 删除失败"));
			transaction.onabort = () =>
				reject(transactionFailure(transaction, "主页 MP4 删除已取消"));
		});
	}

	private open(): Promise<IDBDatabase> {
		if (this.databasePromise) return this.databasePromise;
		if (!this.indexedDb) {
			return Promise.reject(new Error("当前环境不支持 IndexedDB"));
		}
		this.databasePromise = new Promise((resolve, reject) => {
			const request = this.indexedDb!.open(HOME_HERO_VIDEO_DB, 1);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(HOME_HERO_VIDEO_STORE)) {
					database.createObjectStore(HOME_HERO_VIDEO_STORE, {
						keyPath: "id",
					});
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => {
				this.databasePromise = null;
				reject(request.error ?? new Error("主页 MP4 存储初始化失败"));
			};
		});
		return this.databasePromise;
	}
}

export function createMemoryHomeHeroVideoRepository(
	initial: HomeHeroVideoRecord | null = null,
): HomeHeroVideoRepository {
	let current = initial;
	return {
		async read() {
			return current;
		},
		async write(record) {
			current = record;
		},
		async remove() {
			current = null;
		},
	};
}

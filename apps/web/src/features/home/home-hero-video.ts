export const HOME_HERO_VIDEO_MAX_BYTES = 300 * 1024 * 1024;

export interface HomeHeroVideoMeta {
	version: 1;
	name: string;
	type: "video/mp4";
	size: number;
	savedAt: number;
}

export interface HomeHeroVideoRecord {
	blob: Blob;
	meta: HomeHeroVideoMeta;
}

export interface HomeHeroVideoRepository {
	read(): Promise<HomeHeroVideoRecord | null>;
	write(record: HomeHeroVideoRecord): Promise<void>;
	remove(): Promise<void>;
}

export interface HomeHeroObjectUrlFactory {
	create(blob: Blob): string;
	revoke(url: string): void;
}

export type HomeHeroVideoStatus =
	| "idle"
	| "loading"
	| "saving"
	| "ready"
	| "error";

export interface HomeHeroVideoSnapshot {
	active: boolean;
	status: HomeHeroVideoStatus;
	url: string | null;
	meta: HomeHeroVideoMeta | null;
	error: string | null;
}

export class HomeHeroVideoValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HomeHeroVideoValidationError";
	}
}

export function validateHomeHeroVideo(
	file: Pick<File, "name" | "type" | "size">,
): string | null {
	const name = String(file.name || "");
	const type = String(file.type || "").toLowerCase();
	if (!/\.mp4$/i.test(name) || (type !== "" && type !== "video/mp4")) {
		return "这里只能选择 .mp4 文件";
	}
	if (Number(file.size) > HOME_HERO_VIDEO_MAX_BYTES) {
		return "MP4 不能超过 300 MB";
	}
	return null;
}

function defaultObjectUrlFactory(): HomeHeroObjectUrlFactory {
	return {
		create: (blob) => URL.createObjectURL(blob),
		revoke: (url) => URL.revokeObjectURL(url),
	};
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export class HomeHeroVideoController {
	private snapshot: HomeHeroVideoSnapshot = {
		active: false,
		status: "idle",
		url: null,
		meta: null,
		error: null,
	};
	private readonly listeners = new Set<() => void>();
	private readonly ownedUrls = new Set<string>();
	private generation = 0;
	private disposed = false;
	private mutations: Promise<void> = Promise.resolve();

	constructor(
		private readonly repository: HomeHeroVideoRepository,
		private readonly objectUrls: HomeHeroObjectUrlFactory = defaultObjectUrlFactory(),
	) {}

	getSnapshot = (): HomeHeroVideoSnapshot => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	async activate(): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.generation;
		this.update({ active: true, status: "loading", error: null });
		try {
			const record = await this.repository.read();
			if (!this.isCurrent(generation) || !this.snapshot.active) return;
			if (!record) {
				this.releaseOwnedUrl();
				this.update({ status: "idle", meta: null, error: null });
				return;
			}
			this.attach(record);
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			this.releaseOwnedUrl();
			this.update({
				status: "error",
				error: errorMessage(error, "主页 MP4 读取失败，请重新选择"),
			});
		}
	}

	deactivate(): void {
		if (this.disposed) return;
		this.generation += 1;
		this.releaseOwnedUrl();
		this.update({ active: false, status: "idle", error: null });
	}

	async replace(file: File, now = Date.now()): Promise<void> {
		if (this.disposed) return;
		const validationError = validateHomeHeroVideo(file);
		if (validationError) throw new HomeHeroVideoValidationError(validationError);
		const generation = ++this.generation;
		const record: HomeHeroVideoRecord = {
			blob: file,
			meta: {
				version: 1,
				name: String(file.name || "home.mp4"),
				type: "video/mp4",
				size: Number(file.size) || 0,
				savedAt: now,
			},
		};
		this.update({ status: "saving", error: null });
		try {
			await this.enqueueMutation(() => this.repository.write(record));
			if (!this.isCurrent(generation)) return;
			if (this.snapshot.active) this.attach(record);
			else this.update({ status: "idle", meta: record.meta, error: null });
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			this.update({
				status: "error",
				error: errorMessage(error, "主页 MP4 保存失败"),
			});
			throw error;
		}
	}

	async clear(): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.generation;
		this.releaseOwnedUrl();
		this.update({ status: "saving", meta: null, error: null });
		try {
			await this.enqueueMutation(() => this.repository.remove());
			if (!this.isCurrent(generation)) return;
			this.update({ status: "idle", meta: null, error: null });
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			this.update({
				status: "error",
				error: errorMessage(error, "主页 MP4 删除失败"),
			});
			throw error;
		}
	}

	reportPlaybackError(
		message = "这个 MP4 无法解码，请换成 H.264 编码的 MP4",
	): void {
		if (this.disposed) return;
		this.generation += 1;
		this.releaseOwnedUrl();
		this.update({ status: "error", error: message });
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation += 1;
		this.releaseOwnedUrl();
		this.snapshot = {
			active: false,
			status: "idle",
			url: null,
			meta: null,
			error: null,
		};
		this.listeners.clear();
	}

	private isCurrent(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	private enqueueMutation(work: () => Promise<void>): Promise<void> {
		const task = this.mutations.then(work, work);
		this.mutations = task.catch(() => undefined);
		return task;
	}

	private attach(record: HomeHeroVideoRecord): void {
		this.releaseOwnedUrl();
		try {
			const url = this.objectUrls.create(record.blob);
			this.ownedUrls.add(url);
			this.update({
				status: "ready",
				url,
				meta: record.meta,
				error: null,
			});
		} catch (error) {
			this.update({
				status: "error",
				url: null,
				meta: record.meta,
				error: errorMessage(error, "主页 MP4 无法加载"),
			});
		}
	}

	private releaseOwnedUrl(): void {
		const current = this.snapshot.url;
		if (!current || !this.ownedUrls.delete(current)) {
			if (current) this.update({ url: null });
			return;
		}
		try {
			this.objectUrls.revoke(current);
		} finally {
			this.update({ url: null });
		}
	}

	private update(patch: Partial<HomeHeroVideoSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		for (const listener of this.listeners) listener();
	}
}

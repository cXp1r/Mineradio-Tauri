import { expect, test } from "bun:test";
import {
	HOME_HERO_VIDEO_MAX_BYTES,
	HomeHeroVideoController,
	validateHomeHeroVideo,
	type HomeHeroVideoRecord,
	type HomeHeroVideoRepository,
} from "./home-hero-video";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function file(name: string, type = "video/mp4"): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function record(name: string): HomeHeroVideoRecord {
	const blob = file(name);
	return {
		blob,
		meta: {
			version: 1,
			name,
			type: "video/mp4",
			size: blob.size,
			savedAt: 1,
		},
	};
}

test("Hero video accepts only MP4 files up to 300 MB", () => {
	expect(validateHomeHeroVideo(file("hero.mp4"))).toBeNull();
	expect(validateHomeHeroVideo(file("hero.webm", "video/webm"))).toBe(
		"这里只能选择 .mp4 文件",
	);
	expect(
		validateHomeHeroVideo({
			name: "hero.mp4",
			type: "video/mp4",
			size: HOME_HERO_VIDEO_MAX_BYTES + 1,
		} as File),
	).toBe("MP4 不能超过 300 MB");
});

test("a stale IndexedDB load cannot replace the latest selected Hero video", async () => {
	const pendingRead = deferred<HomeHeroVideoRecord | null>();
	let stored: HomeHeroVideoRecord | null = null;
	let storedName = "";
	const repository: HomeHeroVideoRepository = {
		read: () => pendingRead.promise,
		write: async (value) => {
			stored = value;
			storedName = value.meta.name;
		},
		remove: async () => {
			stored = null;
		},
	};
	const created: string[] = [];
	const revoked: string[] = [];
	const controller = new HomeHeroVideoController(repository, {
		create: (blob) => {
			const url = `blob:owned-${created.length + 1}-${blob.size}`;
			created.push(url);
			return url;
		},
		revoke: (url) => revoked.push(url),
	});

	const activation = controller.activate();
	await controller.replace(file("latest.mp4"), 2);
	pendingRead.resolve(record("stale.mp4"));
	await activation;

	expect(storedName).toBe("latest.mp4");
	expect(stored === null).toBe(false);
	expect(controller.getSnapshot().meta?.name).toBe("latest.mp4");
	expect(controller.getSnapshot().url).toBe(created[0]);
	expect(created.length).toBe(1);
	expect(revoked).toEqual([]);
});

test("deactivate and dispose revoke each controller-owned Object URL exactly once", async () => {
	const repository: HomeHeroVideoRepository = {
		read: async () => null,
		write: async () => undefined,
		remove: async () => undefined,
	};
	const revoked: string[] = [];
	const controller = new HomeHeroVideoController(repository, {
		create: () => "blob:owned",
		revoke: (url) => revoked.push(url),
	});

	await controller.activate();
	await controller.replace(file("hero.mp4"), 3);
	controller.deactivate();
	controller.deactivate();
	controller.dispose();

	expect(revoked).toEqual(["blob:owned"]);
	expect(controller.getSnapshot().url).toBeNull();
});

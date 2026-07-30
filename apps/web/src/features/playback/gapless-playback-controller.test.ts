import { expect, test } from "bun:test";
import {
	GaplessPlaybackController,
	type GaplessPlaybackContext,
	type GaplessPreparedHandle,
} from "./gapless-playback-controller";

interface TestTrack {
	provider: string;
	id: string;
	album: string;
	coverUrl: string;
}

interface TestHandle extends GaplessPreparedHandle {
	readonly id: string;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function tracks(): TestTrack[] {
	return [
		{
			provider: "netease",
			id: "first",
			album: "叶惠美",
			coverUrl: "https://img.example/album.jpg",
		},
		{
			provider: "netease",
			id: "second",
			album: "叶惠美",
			coverUrl: "https://img.example/album.jpg",
		},
	];
}

function playbackContext(
	overrides: Partial<GaplessPlaybackContext<TestTrack>> = {},
): GaplessPlaybackContext<TestTrack> {
	return {
		enabled: true,
		crossfade: true,
		queue: tracks(),
		currentIndex: 0,
		mode: "queue",
		sessionId: 7,
		intentId: 11,
		...overrides,
	};
}

test("8.5 秒预加载窗口内同一上下文只准备一代候选", async () => {
	let current = playbackContext();
	const resolved: string[] = [];
	const prepared: string[] = [];
	const handle: TestHandle = { id: "deck-b", abort() {} };
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => current,
		resolve: async (candidate) => {
			resolved.push(candidate.id);
			return {
				audioUrl: "http://127.0.0.1/audio/second",
				rawUrl: "https://media.example/second.flac",
			};
		},
		prepareNext: (url) => {
			prepared.push(url);
			return handle;
		},
		playPrepared: async () => {},
		commitPreparedHandoff: () => true,
		onCommitted: () => {},
	});

	expect(await controller.onTimeUpdate(8.51)).toBe(false);
	await Promise.all([
		controller.onTimeUpdate(8.5),
		controller.onTimeUpdate(8.4),
	]);
	expect(resolved).toEqual(["second"]);
	expect(prepared).toEqual(["http://127.0.0.1/audio/second"]);
	expect(controller.diagnostics().phase).toBe("prepared");
	expect(controller.diagnostics().generation).toBe(1);
	expect(controller.diagnostics().resolveCount).toBe(1);
	expect(controller.diagnostics().preparedCount).toBe(1);

	current = playbackContext();
	expect(await controller.onTimeUpdate(4)).toBe(false);
	expect(resolved).toEqual(["second"]);
});

test("手动意图失效会 abort 正在 resolve 的预加载并拒绝迟到结果", async () => {
	const pending = deferred<{
		audioUrl: string;
		rawUrl: string;
	}>();
	const observed: { signal: AbortSignal | null } = { signal: null };
	let prepareCount = 0;
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext(),
		resolve: (_candidate, resolveContext) => {
			observed.signal = resolveContext.signal;
			return pending.promise;
		},
		prepareNext: () => {
			prepareCount += 1;
			return { id: "deck-b", abort() {} };
		},
		playPrepared: async () => {},
		commitPreparedHandoff: () => true,
		onCommitted: () => {},
	});

	const timeUpdate = controller.onTimeUpdate(8.5);
	await Promise.resolve();
	controller.invalidate("manual-intent");
	expect(observed.signal?.aborted).toBe(true);
	pending.resolve({
		audioUrl: "http://127.0.0.1/audio/second",
		rawUrl: "https://media.example/second.flac",
	});
	await timeUpdate;
	expect(prepareCount).toBe(0);
	expect(controller.diagnostics().phase).toBe("idle");
	expect(controller.diagnostics().generation).toBe(2);
});

test("队列变化可立即撤销已准备 deck", async () => {
	let current = playbackContext();
	let resolveCount = 0;
	let abortCount = 0;
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => current,
		resolve: async () => {
			resolveCount += 1;
			return {
				audioUrl: "http://127.0.0.1/audio/second",
				rawUrl: "https://media.example/second.flac",
			};
		},
		prepareNext: () => ({
			id: "deck-b",
			abort: () => {
				abortCount += 1;
			},
		}),
		playPrepared: async () => {},
		commitPreparedHandoff: () => true,
		onCommitted: () => {},
	});

	await controller.onTimeUpdate(8.5);
	current = playbackContext({
		queue: [
			tracks()[0],
			{ ...tracks()[1], id: "replacement" },
		],
	});
	expect(controller.reconcileContext()).toBe(false);
	expect(abortCount).toBe(1);
	expect(controller.diagnostics().phase).toBe("idle");
	expect(resolveCount).toBe(1);
});

test("1.05 秒窗口只静音 preroll，720ms 边界才开始可听 crossfade", async () => {
	const events: string[] = [];
	let commitCount = 0;
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext(),
		resolve: async () => ({
			audioUrl: "http://127.0.0.1/audio/second",
			rawUrl: "https://media.example/second.flac",
		}),
		prepareNext: () => ({ id: "deck-b", abort() {} }),
		prerollPrepared: async (_handle, options) => {
			expect(options.isCurrent()).toBe(true);
			events.push("preroll");
		},
		playPrepared: async (_handle, options) => {
			events.push(`crossfade:${options.crossfadeMs}`);
		},
		commitPreparedHandoff: () => {
			commitCount += 1;
			return true;
		},
		onCommitted: () => {},
	});

	await controller.onTimeUpdate(8.5);
	expect(await controller.onTimeUpdate(1.05)).toBe(false);
	expect(events).toEqual(["preroll"]);
	expect(commitCount).toBe(0);

	expect(await controller.onTimeUpdate(0.72)).toBe(true);
	expect(events).toEqual(["preroll", "crossfade:720"]);
	expect(commitCount).toBe(1);
});

test("关闭 crossfade 后只预载和静音 preroll，直到 ended 才零混合提交", async () => {
	const durations: number[] = [];
	let prerollCount = 0;
	let commitCount = 0;
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext({ crossfade: false }),
		resolve: async () => ({
			audioUrl: "http://127.0.0.1/audio/second",
			rawUrl: "https://media.example/second.flac",
		}),
		prepareNext: () => ({ id: "deck-b", abort() {} }),
		prerollPrepared: async () => {
			prerollCount += 1;
		},
		playPrepared: async (_handle, options) => {
			durations.push(options.crossfadeMs);
		},
		commitPreparedHandoff: () => {
			commitCount += 1;
			return true;
		},
		onCommitted: () => {},
	});

	await controller.onTimeUpdate(8.5);
	expect(await controller.onTimeUpdate(1.05)).toBe(false);
	expect(await controller.onTimeUpdate(0.72)).toBe(false);
	expect(prerollCount).toBe(1);
	expect(durations).toEqual([]);
	expect(commitCount).toBe(0);

	expect(await controller.onEnded()).toBe(true);
	expect(durations).toEqual([0]);
	expect(commitCount).toBe(1);
});

test("preroll handoff 成功后 exactly-once 提交并暴露 adopted deck", async () => {
	const handle: TestHandle = { id: "deck-b", abort() {} };
	const playDurations: number[] = [];
	const committedCandidates: string[] = [];
	const notifications: string[] = [];
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext(),
		resolve: async () => ({
			audioUrl: "http://127.0.0.1/audio/second",
			rawUrl: "https://media.example/second.flac",
		}),
		prepareNext: () => handle,
		playPrepared: async (_handle, options) => {
			playDurations.push(options.crossfadeMs);
		},
		commitPreparedHandoff: (request) => {
			committedCandidates.push(request.candidate.id);
			expect(request.expectedIntentId).toBe(11);
			expect(request.expectedOutgoingTrackKey).toBe("netease:first");
			return true;
		},
		onCommitted: (adopted) => {
			notifications.push(adopted.candidate.id);
		},
	});

	await controller.onTimeUpdate(8.5);
	expect(await controller.onTimeUpdate(0.72)).toBe(true);
	expect(playDurations).toEqual([720]);
	expect(committedCandidates).toEqual(["second"]);
	expect(notifications).toEqual(["second"]);

	const adopted = controller.takeAdopted();
	expect(adopted?.handle).toBe(handle);
	expect(adopted?.source.rawUrl).toBe("https://media.example/second.flac");
	expect(controller.takeAdopted()).toBeNull();
});

test("handoff 进行中遇到 ended 时共用同一结果且只提交一次", async () => {
	const playing = deferred<void>();
	let playCount = 0;
	let commitCount = 0;
	let notificationCount = 0;
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext(),
		resolve: async () => ({
			audioUrl: "http://127.0.0.1/audio/second",
			rawUrl: "https://media.example/second.flac",
		}),
		prepareNext: () => ({ id: "deck-b", abort() {} }),
		playPrepared: () => {
			playCount += 1;
			return playing.promise;
		},
		commitPreparedHandoff: () => {
			commitCount += 1;
			return true;
		},
		onCommitted: () => {
			notificationCount += 1;
		},
	});

	await controller.onTimeUpdate(8.5);
	const handoff = controller.onTimeUpdate(0.72);
	await Promise.resolve();
	const ended = controller.onEnded();
	playing.resolve();
	expect(await handoff).toBe(true);
	expect(await ended).toBe(true);
	expect(await controller.onEnded()).toBe(true);
	expect(playCount).toBe(1);
	expect(commitCount).toBe(1);
	expect(notificationCount).toBe(1);
});

test("dispose 幂等 abort pending deck 并永久关闭 controller", async () => {
	let abortCount = 0;
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext(),
		resolve: async () => ({
			audioUrl: "http://127.0.0.1/audio/second",
			rawUrl: "https://media.example/second.flac",
		}),
		prepareNext: () => ({
			id: "deck-b",
			abort: () => {
				abortCount += 1;
			},
		}),
		playPrepared: async () => {},
		commitPreparedHandoff: () => true,
		onCommitted: () => {},
	});

	await controller.onTimeUpdate(8.5);
	controller.dispose();
	controller.dispose();
	expect(abortCount).toBe(1);
	expect(controller.diagnostics().phase).toBe("disposed");
	expect(controller.diagnostics().disposed).toBe(true);
	expect(await controller.onTimeUpdate(1)).toBe(false);
	expect(await controller.onEnded()).toBe(false);
});

test("playPrepared 失败会 abort incoming 并向普通 ended fallback 返回 false", async () => {
	let abortCount = 0;
	let commitCount = 0;
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext(),
		resolve: async () => ({
			audioUrl: "http://127.0.0.1/audio/second",
			rawUrl: "https://media.example/second.flac",
		}),
		prepareNext: () => ({
			id: "deck-b",
			abort: () => {
				abortCount += 1;
			},
		}),
		playPrepared: async (_handle, options) => {
			expect(options.isCurrent()).toBe(true);
			throw new Error("incoming deck refused to play");
		},
		commitPreparedHandoff: () => {
			commitCount += 1;
			return true;
		},
		onCommitted: () => {},
	});

	await controller.onTimeUpdate(8.5);
	expect(await controller.onTimeUpdate(0.72)).toBe(false);
	expect(await controller.onEnded()).toBe(false);
	expect(abortCount).toBe(1);
	expect(commitCount).toBe(0);
	expect(controller.diagnostics().phase).toBe("failed");
});

test("store 拒绝 compare-and-commit 时撤销已播放的 prepared owner", async () => {
	let abortCount = 0;
	const handle: TestHandle = {
		id: "deck-b",
		abort: () => { abortCount += 1; },
	};
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext(),
		resolve: async () => ({
			audioUrl: "http://127.0.0.1/audio/second",
			rawUrl: "https://media.example/second.flac",
		}),
		prepareNext: () => handle,
		playPrepared: async () => undefined,
		commitPreparedHandoff: () => false,
		onCommitted: () => undefined,
	});

	await controller.onTimeUpdate(8.5);
	expect(await controller.onTimeUpdate(0.72)).toBe(false);

	expect(abortCount).toBe(1);
	expect(controller.takeAdopted()).toBeNull();
	expect(controller.diagnostics().phase).toBe("failed");
});

test("ended 抢先时以零 crossfade 采用已准备 deck", async () => {
	const durations: number[] = [];
	const triggers: string[] = [];
	const controller = new GaplessPlaybackController<TestTrack, TestHandle>({
		getContext: () => playbackContext(),
		resolve: async () => ({
			audioUrl: "http://127.0.0.1/audio/second",
			rawUrl: "https://media.example/second.flac",
		}),
		prepareNext: () => ({ id: "deck-b", abort() {} }),
		playPrepared: async (_handle, options) => {
			durations.push(options.crossfadeMs);
		},
		commitPreparedHandoff: (request) => {
			triggers.push(request.trigger);
			return true;
		},
		onCommitted: () => {},
	});

	await controller.onTimeUpdate(8.5);
	expect(await controller.onEnded()).toBe(true);
	expect(durations).toEqual([0]);
	expect(triggers).toEqual(["ended"]);
});

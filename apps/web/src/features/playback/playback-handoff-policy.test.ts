import { expect, test } from "bun:test";
import {
	ALBUM_GAPLESS_ADOPT_SLEW_MS,
	ALBUM_GAPLESS_CROSSFADE_DEFAULT_MS,
	ALBUM_GAPLESS_CROSSFADE_MIN_MS,
	ALBUM_GAPLESS_INCOMING_ATTACK_MS,
	ALBUM_GAPLESS_PRELOAD_WINDOW_SECONDS,
	ALBUM_GAPLESS_PREROLL_SECONDS,
	authorizeAlbumGaplessPreload,
	canCommitAlbumGaplessPreload,
	claimAlbumGaplessAdvance,
	claimAlbumGaplessPreloadCommit,
	createAlbumGaplessHandoffState,
	disposeAlbumGaplessHandoff,
	getAlbumGaplessTimingDecision,
	invalidateAlbumGaplessHandoff,
	resolveAlbumGaplessCandidate,
	sampleAlbumGaplessCrossfade,
	type AlbumGaplessContext,
} from "./playback-handoff-policy";

function context(
	overrides: Partial<AlbumGaplessContext> = {},
): AlbumGaplessContext {
	return {
		enabled: true,
		playMode: "sequence",
		currentIndex: 0,
		playbackSessionId: 7,
		intentId: 11,
		queue: [
			{
				provider: "netease",
				id: "first",
				album: "  叶惠美  ",
				coverUrl: "https://img.example/album.jpg",
			},
			{
				provider: "NETEASE",
				id: "second",
				album: "叶惠美",
				coverUrl: "https://img.example/album.jpg",
			},
		],
		...overrides,
	};
}

test("仅为已启用的相邻同专辑队列项建立 gapless 候选", () => {
	const candidate = resolveAlbumGaplessCandidate(context());

	expect(candidate).toEqual({
		albumKey: "netease\u0000叶惠美\u0000https://img.example/album.jpg",
		currentTrackKey: "netease:first",
		candidateTrackKey: "netease:second",
		candidateIndex: 1,
	});
	expect(resolveAlbumGaplessCandidate(context({ enabled: false }))).toBeNull();
	expect(resolveAlbumGaplessCandidate(context({ playMode: "single" }))).toBeNull();
	expect(resolveAlbumGaplessCandidate(context({ playMode: "shuffle" }))).toBeNull();
});

test("loop 模式只允许显式的队尾到队首同专辑 handoff", () => {
	const base = context();
	const loopCandidate = resolveAlbumGaplessCandidate(context({
		playMode: "loop",
		currentIndex: 1,
	}));

	expect(loopCandidate?.candidateTrackKey).toBe("netease:first");
	expect(loopCandidate?.candidateIndex).toBe(0);
	expect(resolveAlbumGaplessCandidate(context({
		playMode: "queue",
		currentIndex: 1,
		queue: base.queue,
	}))).toBeNull();
});

test("专辑身份字段不足或不一致时保守拒绝 gapless", () => {
	const base = context();
	const current = base.queue[0];
	const next = base.queue[1];
	for (const incomplete of [
		{ ...next, provider: "" },
		{ ...next, id: "" },
		{ ...next, album: "" },
		{ ...next, coverUrl: "" },
	]) {
		expect(
			resolveAlbumGaplessCandidate(
				context({ queue: [current, incomplete] }),
			),
		).toBeNull();
	}
	expect(
		resolveAlbumGaplessCandidate(
			context({
				queue: [
					current,
					{ ...next, coverUrl: "https://img.example/other.jpg" },
				],
			}),
		),
	).toBeNull();
});

test("预加载授权绑定 generation、session、intent 与候选曲目且只能提交一次", () => {
	const initial = createAlbumGaplessHandoffState();
	const authorized = authorizeAlbumGaplessPreload(initial, context());

	expect(authorized).not.toBeNull();
	if (!authorized) throw new Error("应创建预加载授权");
	expect(authorized.authority.generation).toBe(1);
	expect(authorized.authority.playbackSessionId).toBe(7);
	expect(authorized.authority.intentId).toBe(11);
	expect(authorized.authority.candidateTrackKey).toBe("netease:second");

	const first = claimAlbumGaplessPreloadCommit(
		authorized.state,
		authorized.authority,
		context(),
	);
	expect(first.accepted).toBe(true);
	const duplicate = claimAlbumGaplessPreloadCommit(
		first.state,
		authorized.authority,
		context(),
	);
	expect(duplicate.accepted).toBe(false);
});

test("旧 generation、队列变化、手动意图、关闭与 dispose 都撤销提交权", () => {
	const first = authorizeAlbumGaplessPreload(
		createAlbumGaplessHandoffState(),
		context(),
	);
	if (!first) throw new Error("应创建第一代授权");
	const second = authorizeAlbumGaplessPreload(first.state, context());
	if (!second) throw new Error("应创建第二代授权");

	expect(canCommitAlbumGaplessPreload(second.state, first.authority, context())).toBe(false);
	expect(
		canCommitAlbumGaplessPreload(
			second.state,
			second.authority,
			context({
				queue: [context().queue[1], context().queue[0]],
			}),
		),
	).toBe(false);
	expect(
		canCommitAlbumGaplessPreload(
			second.state,
			second.authority,
			context({ intentId: 12 }),
		),
	).toBe(false);
	expect(
		canCommitAlbumGaplessPreload(
			second.state,
			second.authority,
			context({ playbackSessionId: 8 }),
		),
	).toBe(false);
	expect(
		canCommitAlbumGaplessPreload(
			second.state,
			second.authority,
			context({ enabled: false }),
		),
	).toBe(false);

	const invalidated = invalidateAlbumGaplessHandoff(second.state);
	expect(
		canCommitAlbumGaplessPreload(invalidated, second.authority, context()),
	).toBe(false);
	const disposed = disposeAlbumGaplessHandoff(second.state);
	expect(
		canCommitAlbumGaplessPreload(disposed, second.authority, context()),
	).toBe(false);
	expect(
		authorizeAlbumGaplessPreload(disposed, context()),
	).toBeNull();
});

test("handoff 与 ended 共享 exactly-once advance gate", () => {
	const pending = authorizeAlbumGaplessPreload(
		createAlbumGaplessHandoffState(),
		context(),
	);
	if (!pending) throw new Error("应创建预加载授权");

	const earlyHandoff = claimAlbumGaplessAdvance(
		pending.state,
		pending.authority,
		context(),
		"handoff",
	);
	expect(earlyHandoff.accepted).toBe(false);
	const endedWins = claimAlbumGaplessAdvance(
		earlyHandoff.state,
		pending.authority,
		context(),
		"ended",
	);
	expect(endedWins.accepted).toBe(true);
	expect(
		claimAlbumGaplessPreloadCommit(
			endedWins.state,
			pending.authority,
			context(),
		).accepted,
	).toBe(false);

	const another = authorizeAlbumGaplessPreload(endedWins.state, context());
	if (!another) throw new Error("应创建下一代预加载授权");
	const committed = claimAlbumGaplessPreloadCommit(
		another.state,
		another.authority,
		context(),
	);
	const handoffWins = claimAlbumGaplessAdvance(
		committed.state,
		another.authority,
		context(),
		"handoff",
	);
	expect(handoffWins.accepted).toBe(true);
	expect(
		claimAlbumGaplessAdvance(
			handoffWins.state,
			another.authority,
			context(),
			"ended",
		).accepted,
	).toBe(false);
});

test("gapless timing decision 保留 2.0.2 的预加载、preroll 与混合时序", () => {
	expect(ALBUM_GAPLESS_PRELOAD_WINDOW_SECONDS).toBe(8.5);
	expect(ALBUM_GAPLESS_PREROLL_SECONDS).toBe(1.05);
	expect(ALBUM_GAPLESS_CROSSFADE_DEFAULT_MS).toBe(720);
	expect(ALBUM_GAPLESS_CROSSFADE_MIN_MS).toBe(360);
	expect(ALBUM_GAPLESS_INCOMING_ATTACK_MS).toBe(56);
	expect(ALBUM_GAPLESS_ADOPT_SLEW_MS).toBe(180);

	expect(getAlbumGaplessTimingDecision(8.51)).toEqual({
		preloadDue: false,
		prerollDue: false,
		crossfadeDurationMs: 720,
	});
	expect(getAlbumGaplessTimingDecision(8.5).preloadDue).toBe(true);
	expect(getAlbumGaplessTimingDecision(1.05).prerollDue).toBe(true);
	expect(getAlbumGaplessTimingDecision(0.5).crossfadeDurationMs).toBe(580);
	expect(getAlbumGaplessTimingDecision(0.1).crossfadeDurationMs).toBe(360);
});

test("crossfade sample 使用 equal-power 曲线并在 56ms 完成 incoming attack", () => {
	const start = sampleAlbumGaplessCrossfade({ elapsedMs: 0 });
	expect(start.outgoingGain).toBe(1);
	expect(start.incomingGain).toBe(0);

	const attack = sampleAlbumGaplessCrossfade({ elapsedMs: 56 });
	expect(Math.abs(attack.incomingGain - 0.9)).toBeLessThan(1e-8);
	expect(
		Math.abs(attack.outgoingGain - Math.sqrt(1 - 0.9 ** 2)),
	).toBeLessThan(1e-8);

	const end = sampleAlbumGaplessCrossfade({ elapsedMs: 720 });
	expect(Math.abs(end.outgoingGain)).toBeLessThan(1e-8);
	expect(end.incomingGain).toBe(1);
});

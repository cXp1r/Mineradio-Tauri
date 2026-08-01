import type { DiscoverHomeResponse, Track } from "@mineradio/shared";
import type { HomeListenSummary } from "./home-listen-ledger";

export type HomeContinueKind = "current" | "recent" | "daily" | "empty";

export interface HomeContinueModel {
	kind: HomeContinueKind;
	title: string;
	subtitle: string;
	track: Track | null;
	queue: Track[];
	index: number;
	isPaused: boolean;
}

export interface HomeDashboardInsight {
	todayListenMs: number;
	todayUniqueSongs: number;
	streakDays: number;
	topArtist: HomeListenSummary["topArtist"];
}

export interface HomeDashboardModel {
	dateLabel: string;
	timeLabel: string;
	continue: HomeContinueModel;
	nextUp: Track | null;
	nextUpIndex: number;
	forYou: Track[];
	dailyLoadedCount: number;
	insight: HomeDashboardInsight;
}

export interface HomeDashboardInput {
	discover: DiscoverHomeResponse | null | undefined;
	listenSummary: HomeListenSummary | null | undefined;
	queue?: Track[];
	currentIndex?: number;
	currentTrack?: Track | null;
	isPlaying?: boolean;
	playbackMode?: HomeDashboardPlaybackMode;
	now?: number;
}

export type HomeDashboardPlaybackMode =
	| "single"
	| "loop"
	| "queue"
	| "shuffle";

function artistLine(track: Track): string {
	return track.artists.filter(Boolean).join(" / ") || "未知歌手";
}

function normalizedTrackText(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function trackIdentity(track: Track): string {
	const title = normalizedTrackText(track.title);
	const artists = track.artists
		.map(normalizedTrackText)
		.filter(Boolean)
		.sort()
		.join("|");
	// Provider 的曲目 id 不可跨平台比较；标题与歌手完整时优先使用语义身份。
	if (title && artists) return `semantic:${title}:${artists}`;
	return `${track.provider}:${track.sourceId || track.id}`;
}

function stableHash(value: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function buildForYouTracks(input: HomeDashboardInput, now: Date): Track[] {
	const candidates = [
		input.listenSummary?.recent?.track,
		input.listenSummary?.topSong?.track,
		...(input.discover?.dailySongs ?? []),
	].filter((track): track is Track => !!track?.id && !!track.title);
	const unique = new Map<string, { track: Track; sourceIndex: number }>();
	candidates.forEach((track, sourceIndex) => {
		const key = trackIdentity(track);
		if (!unique.has(key)) unique.set(key, { track, sourceIndex });
	});
	const dateSeed = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
	return [...unique.entries()]
		.map(([key, candidate]) => ({
			...candidate,
			rank: stableHash(`${dateSeed}:${key}`),
		}))
		.sort((a, b) => a.rank - b.rank || a.sourceIndex - b.sourceIndex)
		.slice(0, 3)
		.map(({ track }) => track);
}

function safeQueue(input: HomeDashboardInput): Track[] {
	if (input.queue?.length) return input.queue.filter(Boolean);
	return input.currentTrack ? [input.currentTrack] : [];
}

function resolveCurrentIndex(input: HomeDashboardInput, queue: Track[]): number {
	if (!queue.length) return -1;
	const requested = Math.floor(Number(input.currentIndex));
	if (Number.isFinite(requested) && requested >= 0 && requested < queue.length) {
		return requested;
	}
	if (input.currentTrack) {
		const byIdentity = queue.findIndex(
			(track) =>
				track.provider === input.currentTrack?.provider &&
				track.id === input.currentTrack.id,
		);
		if (byIdentity >= 0) return byIdentity;
	}
	return 0;
}

function selectContinue(
	input: HomeDashboardInput,
	queue: Track[],
	currentIndex: number,
): HomeContinueModel {
	const current = currentIndex >= 0 ? queue[currentIndex] ?? null : null;
	if (current) {
		return {
			kind: "current",
			title: current.title || "继续听",
			subtitle: `${input.isPlaying ? "正在播放" : "已暂停"} · ${artistLine(current)}`,
			track: current,
			queue,
			index: currentIndex,
			isPaused: input.isPlaying !== true,
		};
	}
	const recent = input.listenSummary?.recent?.track ?? null;
	if (recent) {
		return {
			kind: "recent",
			title: recent.title || "最近播放",
			subtitle: `最近播放 · ${artistLine(recent)}`,
			track: recent,
			queue: [recent],
			index: 0,
			isPaused: false,
		};
	}
	const daily = input.discover?.dailySongs ?? [];
	if (daily.length) {
		return {
			kind: "daily",
			title: daily[0]?.title || "今日推荐",
			subtitle: `当前已载入 ${daily.length} 首`,
			track: daily[0] ?? null,
			queue: daily,
			index: 0,
			isPaused: false,
		};
	}
	return {
		kind: "empty",
		title: "继续听",
		subtitle: "播放记录会出现在这里",
		track: null,
		queue: [],
		index: -1,
		isPaused: false,
	};
}

function selectNextUp(
	input: HomeDashboardInput,
	queue: Track[],
	currentIndex: number,
): { track: Track | null; index: number } {
	if (currentIndex < 0 || !queue.length) return { track: null, index: -1 };
	const mode = input.playbackMode ?? "queue";
	if (mode === "single") {
		return { track: queue[currentIndex] ?? null, index: currentIndex };
	}
	if (mode === "loop") {
		const index = (currentIndex + 1) % queue.length;
		return { track: queue[index] ?? null, index };
	}
	if (mode === "shuffle") {
		if (queue.length === 1) {
			return { track: queue[currentIndex] ?? null, index: currentIndex };
		}
		const candidates = queue
			.map((_, index) => index)
			.filter((index) => index !== currentIndex);
		const seed = `${queue.map(trackIdentity).join(";")}:${trackIdentity(queue[currentIndex]!)}`;
		const index = candidates[stableHash(seed) % candidates.length] ?? -1;
		return { track: index >= 0 ? queue[index] ?? null : null, index };
	}
	const index = currentIndex + 1;
	if (index >= queue.length) return { track: null, index: -1 };
	return { track: queue[index] ?? null, index };
}

export function buildHomeDashboardModel(
	input: HomeDashboardInput,
): HomeDashboardModel {
	const now = new Date(input.now ?? Date.now());
	const queue = safeQueue(input);
	const currentIndex = resolveCurrentIndex(input, queue);
	const nextUp = selectNextUp(input, queue, currentIndex);
	return {
		dateLabel: now.toLocaleDateString("zh-CN", {
			year: "numeric",
			month: "long",
			day: "numeric",
			weekday: "long",
		}),
		timeLabel: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
		continue: selectContinue(input, queue, currentIndex),
		nextUp: nextUp.track,
		nextUpIndex: nextUp.index,
		forYou: buildForYouTracks(input, now),
		dailyLoadedCount: input.discover?.dailySongs.length ?? 0,
		insight: {
			todayListenMs: input.listenSummary?.todayListenMs ?? 0,
			todayUniqueSongs: input.listenSummary?.todayUniqueSongs ?? 0,
			streakDays: input.listenSummary?.streakDays ?? 0,
			topArtist: input.listenSummary?.topArtist ?? null,
		},
	};
}

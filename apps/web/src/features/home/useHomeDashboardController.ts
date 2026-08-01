import { useCallback, useMemo, useRef } from "react";
import type { DiscoverHomeResponse, Track } from "@mineradio/shared";
import {
	buildHomeDashboardModel,
	type HomeDashboardModel,
	type HomeDashboardPlaybackMode,
} from "./home-dashboard-policy";
import type { HomeListenSummary } from "./home-listen-ledger";

export interface HomeDashboardPlaybackFacade {
	setQueue(tracks: Track[]): void;
	playAt(index: number): void;
	resume?(): void;
}

export interface HomeDashboardController {
	model: HomeDashboardModel;
	continueListening(): void;
	playNextUp(): void;
	playForYou(index: number): void;
}

export function useHomeDashboardController({
	discover,
	listenSummary,
	queue,
	currentIndex,
	currentTrack,
	isPlaying,
	playbackMode,
	playback,
	enterPlayback,
	showToast,
}: {
	discover: DiscoverHomeResponse | null;
	listenSummary: HomeListenSummary | null;
	queue?: Track[];
	currentIndex?: number;
	currentTrack: Track | null;
	isPlaying?: boolean;
	playbackMode?: HomeDashboardPlaybackMode;
	playback: HomeDashboardPlaybackFacade;
	enterPlayback(): void;
	showToast(message: string): void;
}): HomeDashboardController {
	const model = useMemo(
		() =>
			buildHomeDashboardModel({
				discover,
				listenSummary,
				queue,
				currentIndex,
				currentTrack,
				isPlaying,
				playbackMode,
			}),
		[
			currentIndex,
			currentTrack,
			discover,
			isPlaying,
			listenSummary,
			playbackMode,
			queue,
		],
	);
	const dependenciesRef = useRef({ playback, enterPlayback, showToast, model });
	dependenciesRef.current = { playback, enterPlayback, showToast, model };

	const continueListening = useCallback(() => {
		const current = dependenciesRef.current;
		const choice = current.model.continue;
		if (!choice.track) {
			current.showToast("还没有可继续播放的内容");
			return;
		}
		if (choice.kind === "current") {
			if (choice.isPaused && current.playback.resume) current.playback.resume();
			else if (choice.isPaused) current.playback.playAt(choice.index);
			current.enterPlayback();
			return;
		}
		current.playback.setQueue(choice.queue);
		current.playback.playAt(choice.index);
		current.enterPlayback();
	}, []);

	const playNextUp = useCallback(() => {
		const current = dependenciesRef.current;
		if (!current.model.nextUp || current.model.nextUpIndex < 0) {
			current.showToast("当前队列没有下一首");
			return;
		}
		current.playback.playAt(current.model.nextUpIndex);
		current.enterPlayback();
	}, []);

	const playForYou = useCallback((index: number) => {
		const current = dependenciesRef.current;
		const tracks = current.model.forYou;
		if (!tracks.length) {
			current.showToast("推荐正在生成");
			return;
		}
		const safeIndex = Math.max(0, Math.min(Math.floor(index), tracks.length - 1));
		current.playback.setQueue(tracks);
		current.playback.playAt(safeIndex);
		current.enterPlayback();
	}, []);

	return { model, continueListening, playNextUp, playForYou };
}

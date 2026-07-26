import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "@mineradio/shared";
import type { LikesPort } from "../../ports/music/likes-port";
import {
	isLoginRequiredError,
	isProviderLikeSupported,
	likeUnsupportedMessage,
	providerLikeLabel,
	trackLikeKey,
	trackProviderLikeId,
} from "./likes-policy";

export interface LikesControllerResult {
	likedByTrack: Record<string, boolean>;
	busyByTrack: Record<string, boolean>;
	isLiked(track: Track | null): boolean;
	isBusy(track: Track | null): boolean;
	refresh(track: Track | null): void;
	toggle(track: Track | null): Promise<void>;
}

export function useLikesController({
	likes,
	currentTrack,
	showToast,
	openProviderLogin,
}: {
	likes: LikesPort | null;
	currentTrack: Track | null;
	showToast(message: string): void;
	openProviderLogin(): void;
}): LikesControllerResult {
	const [likedByTrack, setLikedByTrack] = useState<Record<string, boolean>>({});
	const [busyByTrack, setBusyByTrack] = useState<Record<string, boolean>>({});
	const likedRef = useRef(likedByTrack);
	const busyRef = useRef(busyByTrack);
	const refreshSequenceRef = useRef(0);
	const dependenciesRef = useRef({ likes, showToast, openProviderLogin });
	likedRef.current = likedByTrack;
	busyRef.current = busyByTrack;
	dependenciesRef.current = { likes, showToast, openProviderLogin };

	const refresh = useCallback((track: Track | null) => {
		const token = ++refreshSequenceRef.current;
		const currentLikes = dependenciesRef.current.likes;
		if (!currentLikes || !isProviderLikeSupported(track)) return;
		const key = trackLikeKey(track);
		const trackId = trackProviderLikeId(track);
		if (!key) return;
		void Promise.resolve()
			.then(() => currentLikes.checkSongLikes(track.provider, [trackId]))
			.then((ack) => {
				if (token !== refreshSequenceRef.current) return;
				setLikedByTrack((map) => ({
					...map,
					[key]: ack.liked[trackId] === true,
				}));
			})
			.catch(() => {
				// 红心状态只影响按钮高亮，失败不能阻断播放 UI。
			});
	}, []);

	const toggle = useCallback(async (track: Track | null) => {
		const current = dependenciesRef.current;
		if (!isProviderLikeSupported(track)) {
			current.showToast(likeUnsupportedMessage(track));
			return;
		}
		const key = trackLikeKey(track);
		const trackId = trackProviderLikeId(track);
		if (!current.likes || !key || busyRef.current[key]) {
			if (!current.likes) current.showToast("红心操作失败");
			return;
		}

		const previous = likedRef.current[key] === true;
		const nextLiked = !previous;
		busyRef.current = { ...busyRef.current, [key]: true };
		likedRef.current = { ...likedRef.current, [key]: nextLiked };
		setBusyByTrack(busyRef.current);
		setLikedByTrack(likedRef.current);
		try {
			const ack = await current.likes.likeSong(track.provider, trackId, nextLiked);
			likedRef.current = { ...likedRef.current, [key]: ack.liked === true };
			setLikedByTrack(likedRef.current);
			current.showToast(nextLiked ? "已加入红心喜欢" : "已取消红心");
		} catch (error) {
			likedRef.current = { ...likedRef.current, [key]: previous };
			setLikedByTrack(likedRef.current);
			if (isLoginRequiredError(error)) {
				current.showToast(`登录后可同步到${providerLikeLabel(track.provider)}`);
				current.openProviderLogin();
			} else {
				current.showToast("红心操作失败");
			}
		} finally {
			const nextBusy = { ...busyRef.current };
			delete nextBusy[key];
			busyRef.current = nextBusy;
			setBusyByTrack(nextBusy);
		}
	}, []);

	useEffect(() => {
		refresh(currentTrack);
	}, [currentTrack, likes, refresh]);

	const isLiked = useCallback(
		(track: Track | null) => {
			const key = trackLikeKey(track);
			return key ? likedByTrack[key] === true : false;
		},
		[likedByTrack],
	);

	const isBusy = useCallback(
		(track: Track | null) => {
			const key = trackLikeKey(track);
			return key ? busyByTrack[key] === true : false;
		},
		[busyByTrack],
	);

	return { likedByTrack, busyByTrack, isLiked, isBusy, refresh, toggle };
}

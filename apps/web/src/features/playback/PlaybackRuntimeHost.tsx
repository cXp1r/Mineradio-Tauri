import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { AudioFrameSource } from "@mineradio/visual-engine";
import {
	PlayerController,
	type ErrorPayload,
	type MediaEventPayload,
	type OwnerChangePayload,
	type PlaybackReadinessPayload,
	type TimeUpdatePayload,
} from "../../audio/player-controller";

export interface PlaybackRuntimeCallbacks {
	onTimeUpdate(payload: TimeUpdatePayload): void;
	onDurationChange(payload: TimeUpdatePayload): void;
	onPlay(payload: MediaEventPayload): void;
	onPause(payload: MediaEventPayload): void;
	onEnded(payload: MediaEventPayload): void;
	onError(payload: ErrorPayload): void;
	onStalled?(payload: PlaybackReadinessPayload): void;
	onOwnerChange(payload: OwnerChangePayload): void;
	onControllerReady?(controller: PlayerController | null): void;
}

export interface PlaybackRuntimeHostProps extends PlaybackRuntimeCallbacks {
	controllerRef: RefObject<PlayerController | null>;
	audioFrameSourceRef: RefObject<AudioFrameSource | null>;
	playbackRateRef: RefObject<number>;
	volume: number;
	muted: boolean;
	createController?: () => PlayerController;
}

function createDefaultController(): PlayerController {
	return new PlayerController();
}

export function PlaybackRuntimeHost({
	controllerRef,
	audioFrameSourceRef,
	playbackRateRef,
	volume,
	muted,
	createController = createDefaultController,
	onTimeUpdate,
	onDurationChange,
	onPlay,
	onPause,
	onEnded,
	onError,
	onStalled,
	onOwnerChange,
	onControllerReady,
}: PlaybackRuntimeHostProps): ReactElement | null {
	const callbacksRef = useRef({
		onTimeUpdate,
		onDurationChange,
		onPlay,
		onPause,
		onEnded,
		onError,
		onStalled,
		onOwnerChange,
		onControllerReady,
	});
	callbacksRef.current = {
		onTimeUpdate,
		onDurationChange,
		onPlay,
		onPause,
		onEnded,
		onError,
		onStalled,
		onOwnerChange,
		onControllerReady,
	};

	useEffect(() => {
		if (controllerRef.current) return;
		const controller = createController();
		const ownedFrameSource = controller.getAudioFrameSource();
		controllerRef.current = controller;
		audioFrameSourceRef.current = ownedFrameSource;
		playbackRateRef.current = controller.getActiveElement()?.playbackRate || 1;
		controller.setVolume(muted ? 0 : volume);
		callbacksRef.current.onControllerReady?.(controller);
		const handleOwnerChange = (payload: OwnerChangePayload) => {
			callbacksRef.current.onOwnerChange(payload);
			playbackRateRef.current = controller.getActiveElement()?.playbackRate || 1;
		};
		const unsubscribe = [
			controller.on("timeupdate", (payload) => callbacksRef.current.onTimeUpdate(payload)),
			controller.on("durationchange", (payload) => callbacksRef.current.onDurationChange(payload)),
			controller.on("play", (payload) => callbacksRef.current.onPlay(payload)),
			controller.on("pause", (payload) => callbacksRef.current.onPause(payload)),
			controller.on("ended", (payload) => callbacksRef.current.onEnded(payload)),
			controller.on("error", (payload) => callbacksRef.current.onError(payload)),
			controller.on("stalled", (payload) => callbacksRef.current.onStalled?.(payload)),
			controller.on("ownerchange", handleOwnerChange),
		];

		return () => {
			for (const off of unsubscribe) off();
			controller.dispose();
			if (controllerRef.current === controller) {
				controllerRef.current = null;
				playbackRateRef.current = 1;
				callbacksRef.current.onControllerReady?.(null);
			}
			if (audioFrameSourceRef.current === ownedFrameSource) {
				audioFrameSourceRef.current = null;
			}
		};
	}, [
		audioFrameSourceRef,
		controllerRef,
		createController,
		playbackRateRef,
	]);

	useEffect(() => {
		controllerRef.current?.setVolume(muted ? 0 : volume);
	}, [controllerRef, muted, volume]);

	return null;
}

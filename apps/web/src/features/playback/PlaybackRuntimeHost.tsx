import { useEffect, type ReactElement, type RefObject } from "react";
import {
	PlayerController,
	type ErrorPayload,
	type TimeUpdatePayload,
} from "../../audio/player-controller";

export interface PlaybackRuntimeCallbacks {
	onTimeUpdate(payload: TimeUpdatePayload): void;
	onDurationChange(payload: TimeUpdatePayload): void;
	onPlay(): void;
	onPause(): void;
	onEnded(): void;
	onError(payload: ErrorPayload): void;
}

export interface PlaybackRuntimeHostProps extends PlaybackRuntimeCallbacks {
	audioElementRef: RefObject<HTMLAudioElement | null>;
	controllerRef: RefObject<PlayerController | null>;
	volume: number;
	muted: boolean;
	createController?: (audio: HTMLAudioElement) => PlayerController;
	createAudioElement?: () => HTMLAudioElement | null;
}

function createDefaultController(audio: HTMLAudioElement): PlayerController {
	return new PlayerController(audio);
}

function createDefaultAudioElement(): HTMLAudioElement | null {
	if (typeof Audio === "undefined") return null;
	return new Audio();
}

export function PlaybackRuntimeHost({
	audioElementRef,
	controllerRef,
	volume,
	muted,
	createController = createDefaultController,
	createAudioElement = createDefaultAudioElement,
	onTimeUpdate,
	onDurationChange,
	onPlay,
	onPause,
	onEnded,
	onError,
}: PlaybackRuntimeHostProps): ReactElement | null {
	useEffect(() => {
		if (controllerRef.current) return;
		let audio = audioElementRef.current;
		if (!audio) {
			audio = createAudioElement();
			audioElementRef.current = audio;
		}
		if (!audio) return;

		audio.preload = "metadata";
		const controller = createController(audio);
		controllerRef.current = controller;
		controller.setVolume(muted ? 0 : volume);
		const unsubscribe = [
			controller.on("timeupdate", onTimeUpdate),
			controller.on("durationchange", onDurationChange),
			controller.on("play", onPlay),
			controller.on("pause", onPause),
			controller.on("ended", onEnded),
			controller.on("error", onError),
		];

		return () => {
			for (const off of unsubscribe) off();
			if (controllerRef.current === controller) controllerRef.current = null;
			if (audioElementRef.current === audio) audioElementRef.current = null;
		};
	}, [
		audioElementRef,
		controllerRef,
		createAudioElement,
		createController,
		onDurationChange,
		onEnded,
		onError,
		onPause,
		onPlay,
		onTimeUpdate,
	]);

	useEffect(() => {
		controllerRef.current?.setVolume(muted ? 0 : volume);
	}, [controllerRef, muted, volume]);

	return null;
}

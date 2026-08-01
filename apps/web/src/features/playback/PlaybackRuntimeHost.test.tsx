import { expect, test } from "bun:test";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AudioFrameSource } from "@mineradio/visual-engine";
import type {
	ErrorPayload,
	HandlerForEvent,
	MediaEventPayload,
	OwnerChangePayload,
	PlaybackReadinessPayload,
	PlayerController,
	PlayerEventName,
	TimeUpdatePayload,
} from "../../audio/player-controller";
import { PlaybackRuntimeHost } from "./PlaybackRuntimeHost";

class FakePlayerController {
	volume = -1;
	unsubscribeCount = 0;
	disposeCount = 0;
	activeElement: HTMLAudioElement | null = null;
	readonly frameSource: AudioFrameSource = () => null;
	private readonly listeners = new Map<PlayerEventName, Set<(...args: never[]) => void>>();

	setVolume(volume: number): void {
		this.volume = volume;
	}

	getActiveElement(): HTMLAudioElement | null {
		return this.activeElement;
	}

	getAudioFrameSource(): AudioFrameSource {
		return this.frameSource;
	}

	dispose(): void {
		this.disposeCount += 1;
	}

	on<E extends PlayerEventName>(event: E, handler: HandlerForEvent<E>): () => void {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(handler as (...args: never[]) => void);
		return () => {
			listeners?.delete(handler as (...args: never[]) => void);
			this.unsubscribeCount += 1;
		};
	}

	emit(event: "timeupdate" | "durationchange", payload: TimeUpdatePayload): void;
	emit(event: "error", payload: ErrorPayload): void;
	emit(event: "play" | "pause" | "ended", payload: MediaEventPayload): void;
	emit(event: "stalled", payload: PlaybackReadinessPayload): void;
	emit(event: "ownerchange", payload: OwnerChangePayload): void;
	emit(
		event: PlayerEventName,
		payload:
			| MediaEventPayload
			| TimeUpdatePayload
			| ErrorPayload
			| PlaybackReadinessPayload
			| OwnerChangePayload,
	): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload as never);
		}
	}
}

function asPlayerController(controller: FakePlayerController): PlayerController {
	return controller as unknown as PlayerController;
}

test("PlaybackRuntimeHost owns controller events, volume and cleanup", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const controllerRef = createRef<PlayerController>();
	const audioFrameSourceRef = { current: null as AudioFrameSource | null };
	const playbackRateRef = { current: 1 };
	const controller = new FakePlayerController();
	controller.activeElement = { playbackRate: 1.25 } as HTMLAudioElement;
	const receivedEvents: string[] = [];
	const ownerCallbackRates: number[] = [];
	const readyControllers: Array<PlayerController | null> = [];
	const loadContext = { load: "host" };
	const source = {
		loadContext,
		sourceUrl: "https://media.example/host.mp3",
	};
	let createControllerCalls = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const createController = () => {
		createControllerCalls += 1;
		return asPlayerController(controller);
	};
	const onTimeUpdate = (payload: TimeUpdatePayload) => {
		receivedEvents.push(`time:${payload.positionMs}:${payload.durationMs}`);
	};
	const onDurationChange = (payload: TimeUpdatePayload) => {
		receivedEvents.push(`duration:${payload.positionMs}:${payload.durationMs}`);
	};
	const onPlay = (payload: MediaEventPayload) => {
		receivedEvents.push(`play:${payload.loadContext === loadContext}:${payload.sourceUrl}`);
	};
	const onPause = () => { receivedEvents.push("pause"); };
	const onEnded = (payload: MediaEventPayload) => {
		receivedEvents.push(`ended:${payload.loadContext === loadContext}`);
	};
	const onError = (payload: ErrorPayload) => {
		receivedEvents.push(`error:${payload.code}:${payload.message}`);
	};
	const onStalled = (payload: PlaybackReadinessPayload) => {
		receivedEvents.push(`stalled:${payload.probe}`);
	};
	const onOwnerChange = (payload: OwnerChangePayload) => {
		ownerCallbackRates.push(playbackRateRef.current);
		receivedEvents.push(`owner:${payload.reason}`);
	};

	const render = (muted: boolean) => (
		<PlaybackRuntimeHost
			controllerRef={controllerRef}
			audioFrameSourceRef={audioFrameSourceRef}
			playbackRateRef={playbackRateRef}
			volume={0.35}
			muted={muted}
			createController={createController}
			onTimeUpdate={onTimeUpdate}
			onDurationChange={onDurationChange}
			onPlay={onPlay}
			onPause={onPause}
			onEnded={onEnded}
			onError={onError}
			onStalled={onStalled}
			onOwnerChange={onOwnerChange}
			onControllerReady={(ready) => readyControllers.push(ready)}
		/>
	);

	try {
		flushSync(() => root.render(render(false)));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(createControllerCalls).toBe(1);
		expect(controllerRef.current).toBe(asPlayerController(controller));
		expect(audioFrameSourceRef.current).toBe(controller.frameSource);
		expect(playbackRateRef.current).toBe(1.25);
		expect(controller.volume).toBe(0.35);
		expect(readyControllers).toEqual([asPlayerController(controller)]);

		controller.emit("timeupdate", { ...source, positionMs: 1200, durationMs: 9000 });
		controller.emit("durationchange", { ...source, positionMs: 1200, durationMs: 9000 });
		controller.emit("play", source);
		controller.emit("pause", source);
		controller.emit("ended", source);
		controller.emit("error", { ...source, code: 4, message: "network" });
		controller.emit("stalled", { ...source, probe: "late" });
		controller.activeElement = { playbackRate: 1.5 } as HTMLAudioElement;
		controller.emit("ownerchange", {
			...source,
			previous: source,
			current: source,
			reason: "prepared",
		});
		expect(ownerCallbackRates).toEqual([1.25]);
		expect(playbackRateRef.current).toBe(1.5);
		expect(receivedEvents).toEqual([
			"time:1200:9000",
			"duration:1200:9000",
			"play:true:https://media.example/host.mp3",
			"pause",
			"ended:true",
			"error:4:network",
			"stalled:late",
			"owner:prepared",
		]);

		flushSync(() => root.render(render(true)));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(controller.volume).toBe(0);
	} finally {
		flushSync(() => root.unmount());
		host.remove();
	}

	expect(controller.unsubscribeCount).toBe(8);
	expect(controller.disposeCount).toBe(1);
	expect(readyControllers).toEqual([asPlayerController(controller), null]);
	expect(controllerRef.current).toBeNull();
	expect(audioFrameSourceRef.current).toBeNull();
	expect(playbackRateRef.current).toBe(1);
});

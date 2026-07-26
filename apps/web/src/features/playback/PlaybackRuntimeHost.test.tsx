import { expect, test } from "bun:test";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
	ErrorPayload,
	HandlerForEvent,
	MediaEventPayload,
	PlayerController,
	PlayerEventName,
	TimeUpdatePayload,
} from "../../audio/player-controller";
import { PlaybackRuntimeHost } from "./PlaybackRuntimeHost";

class StubAudioElement extends EventTarget {
	preload = "";
}

class FakePlayerController {
	volume = -1;
	unsubscribeCount = 0;
	private readonly listeners = new Map<PlayerEventName, Set<(...args: never[]) => void>>();

	setVolume(volume: number): void {
		this.volume = volume;
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
	emit(
		event: PlayerEventName,
		payload: MediaEventPayload | TimeUpdatePayload | ErrorPayload,
	): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload as never);
		}
	}
}

function asAudioElement(audio: StubAudioElement): HTMLAudioElement {
	return audio as unknown as HTMLAudioElement;
}

function asPlayerController(controller: FakePlayerController): PlayerController {
	return controller as unknown as PlayerController;
}

test("PlaybackRuntimeHost owns controller events, volume and cleanup", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const audio = asAudioElement(new StubAudioElement());
	const audioElementRef = createRef<HTMLAudioElement>();
	const controllerRef = createRef<PlayerController>();
	audioElementRef.current = audio;
	const controller = new FakePlayerController();
	const receivedEvents: string[] = [];
	const loadContext = { load: "host" };
	const source = {
		loadContext,
		sourceUrl: "https://media.example/host.mp3",
	};
	let factoryAudio: HTMLAudioElement | null = null;
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const createController = (nextAudio: HTMLAudioElement) => {
		factoryAudio = nextAudio;
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

	const render = (muted: boolean) => (
		<PlaybackRuntimeHost
			audioElementRef={audioElementRef}
			controllerRef={controllerRef}
			volume={0.35}
			muted={muted}
			createController={createController}
			onTimeUpdate={onTimeUpdate}
			onDurationChange={onDurationChange}
			onPlay={onPlay}
			onPause={onPause}
			onEnded={onEnded}
			onError={onError}
		/>
	);

	try {
		flushSync(() => root.render(render(false)));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(factoryAudio).toBe(audioElementRef.current);
		expect(controllerRef.current).toBe(asPlayerController(controller));
		expect(audio.preload).toBe("metadata");
		expect(controller.volume).toBe(0.35);

		controller.emit("timeupdate", { ...source, positionMs: 1200, durationMs: 9000 });
		controller.emit("durationchange", { ...source, positionMs: 1200, durationMs: 9000 });
		controller.emit("play", source);
		controller.emit("pause", source);
		controller.emit("ended", source);
		controller.emit("error", { ...source, code: 4, message: "network" });
		expect(receivedEvents).toEqual([
			"time:1200:9000",
			"duration:1200:9000",
			"play:true:https://media.example/host.mp3",
			"pause",
			"ended:true",
			"error:4:network",
		]);

		flushSync(() => root.render(render(true)));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(controller.volume).toBe(0);
	} finally {
		flushSync(() => root.unmount());
		host.remove();
	}

	expect(controller.unsubscribeCount).toBe(6);
	expect(controllerRef.current).toBeNull();
	expect(audioElementRef.current).toBeNull();
});

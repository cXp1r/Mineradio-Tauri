export type PlayerEventName =
	| "play"
	| "pause"
	| "timeupdate"
	| "durationchange"
	| "ended"
	| "error";

export type TimeUpdatePayload = {
	positionMs: number;
	durationMs: number | null;
};

export type ErrorPayload = {
	code: number;
	message: string;
};

export type Listener = (payload?: TimeUpdatePayload | ErrorPayload | void) => void;

export type HandlerForEvent<E extends PlayerEventName> =
	E extends "play" | "pause" | "ended"
		? () => void
		: E extends "timeupdate" | "durationchange"
			? (payload: TimeUpdatePayload) => void
			: E extends "error"
				? (payload: ErrorPayload) => void
				: Listener;

function timeMsFromSeconds(seconds: number): number {
	return Math.max(0, Math.floor(seconds * 1000));
}

function durationMsOrNull(duration: number): number | null {
	return Number.isFinite(duration) ? Math.floor(duration * 1000) : null;
}

function createAudioElement(): HTMLAudioElement | null {
	if (typeof window === "undefined") return null;
	const ctor = (window as unknown as { Audio?: typeof Audio }).Audio;
	if (typeof ctor !== "function") return null;
	return new ctor();
}

export class PlayerController {
	private readonly audio: HTMLAudioElement | null;
	private readonly listeners = new Map<PlayerEventName, Set<Listener>>();
	private readonly boundRelays: Record<PlayerEventName, EventListener>;

	constructor(audio?: HTMLAudioElement) {
		if (audio) {
			this.audio = audio;
		} else {
			this.audio = createAudioElement();
		}

		this.boundRelays = {
			play: () => this.emit("play"),
			pause: () => this.emit("pause"),
			timeupdate: () => this.emitTimeUpdate(),
			durationchange: () => this.emitDurationChange(),
			ended: () => this.emit("ended"),
			error: () => this.emitError(),
		};

		if (this.audio) {
			const keys = Object.keys(this.boundRelays) as PlayerEventName[];
			for (const key of keys) {
				this.audio.addEventListener(key, this.boundRelays[key]);
			}
		}
	}

	private requireAudio(): HTMLAudioElement {
		if (!this.audio) {
			throw new Error("PlayerController has no audio element bound");
		}
		return this.audio;
	}

	load(url: string): void {
		const audio = this.requireAudio();
		audio.src = url;
		audio.load();
	}

	async play(): Promise<void> {
		const audio = this.requireAudio();
		await audio.play();
	}

	pause(): void {
		const audio = this.requireAudio();
		audio.pause();
	}

	seek(timeMs: number): void {
		const audio = this.requireAudio();
		audio.currentTime = timeMs / 1000;
	}

	setVolume(volume: number): void {
		const audio = this.requireAudio();
		audio.volume = Math.max(0, Math.min(1, volume));
	}

	on<E extends PlayerEventName>(event: E, handler: HandlerForEvent<E>): () => void {
		const listener = handler as Listener;
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return () => {
			const existing = this.listeners.get(event);
			if (existing) {
				existing.delete(listener);
			}
		};
	}

	private emit(event: PlayerEventName): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const handler of set) {
			handler();
		}
	}

	private emitTimeUpdate(): void {
		const audio = this.requireAudio();
		const payload: TimeUpdatePayload = {
			positionMs: timeMsFromSeconds(audio.currentTime),
			durationMs: durationMsOrNull(audio.duration),
		};
		const set = this.listeners.get("timeupdate");
		if (!set) return;
		for (const handler of set) {
			(handler as (p: TimeUpdatePayload) => void)(payload);
		}
	}

	private emitDurationChange(): void {
		const audio = this.requireAudio();
		const payload: TimeUpdatePayload = {
			positionMs: timeMsFromSeconds(audio.currentTime),
			durationMs: durationMsOrNull(audio.duration),
		};
		const set = this.listeners.get("durationchange");
		if (!set) return;
		for (const handler of set) {
			(handler as (p: TimeUpdatePayload) => void)(payload);
		}
	}

	private emitError(): void {
		const audio = this.requireAudio();
		const mediaError = audio.error;
		const payload: ErrorPayload = {
			code: mediaError ? mediaError.code : 0,
			message: mediaError?.message ?? "playback error",
		};
		const set = this.listeners.get("error");
		if (!set) return;
		for (const handler of set) {
			(handler as (p: ErrorPayload) => void)(payload);
		}
	}
}
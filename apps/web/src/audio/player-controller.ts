export type PlayerEventName =
	| "play"
	| "pause"
	| "timeupdate"
	| "durationchange"
	| "ended"
	| "error";

export type MediaEventPayload = {
	readonly loadContext: object | null;
	readonly sourceUrl: string;
};

export type TimeUpdatePayload = MediaEventPayload & {
	positionMs: number;
	durationMs: number | null;
};

export type ErrorPayload = MediaEventPayload & {
	code: number;
	message: string;
};

export type Listener = (
	payload: MediaEventPayload | TimeUpdatePayload | ErrorPayload,
) => void;

export type HandlerForEvent<E extends PlayerEventName> =
	E extends "play" | "pause" | "ended"
		? (payload: MediaEventPayload) => void
		: E extends "timeupdate" | "durationchange"
			? (payload: TimeUpdatePayload) => void
			: E extends "error"
				? (payload: ErrorPayload) => void
				: Listener;

const MINERADIO_AUDIO_CONTEXT_KEY = "_mineradioAudioCtx";

type MineradioAudioElement = HTMLAudioElement & {
	[MINERADIO_AUDIO_CONTEXT_KEY]?: AudioContext;
};

interface SourceBinding {
	readonly loadContext: object | null;
	readonly sourceUrl: string;
}

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
	const audio = new ctor();
	configureAudioElement(audio);
	return audio;
}

function configureAudioElement(audio: HTMLAudioElement): void {
	audio.crossOrigin = "anonymous";
}

async function resumeMineradioAudioContext(audio: HTMLAudioElement): Promise<void> {
	const ctx = (audio as MineradioAudioElement)[MINERADIO_AUDIO_CONTEXT_KEY];
	if (!ctx || ctx.state !== "suspended") return;
	try {
		await ctx.resume();
	} catch {
	}
}

export class PlayerController {
	private readonly audio: HTMLAudioElement | null;
	private readonly listeners = new Map<PlayerEventName, Set<Listener>>();
	private readonly boundRelays: Record<PlayerEventName, EventListener>;
	private sourceBinding: SourceBinding | null = null;

	constructor(audio?: HTMLAudioElement) {
		if (audio) {
			this.audio = audio;
		} else {
			this.audio = createAudioElement();
		}
		if (this.audio) configureAudioElement(this.audio);

		this.boundRelays = {
			play: () => this.emitMediaEvent("play"),
			pause: () => this.emitMediaEvent("pause"),
			timeupdate: () => this.emitTimeUpdate(),
			durationchange: () => this.emitDurationChange(),
			ended: () => this.emitMediaEvent("ended"),
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

	load(url: string, loadContext?: object): void {
		const audio = this.requireAudio();
		configureAudioElement(audio);
		audio.src = url;
		this.sourceBinding = Object.freeze({
			loadContext: loadContext ?? null,
			sourceUrl: audio.src,
		});
		audio.load();
	}

	async play(): Promise<void> {
		const audio = this.requireAudio();
		const resumeBeforePlay = resumeMineradioAudioContext(audio);
		const playPromise = audio.play();
		await resumeBeforePlay;
		await playPromise;
		await resumeMineradioAudioContext(audio);
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

	private emitMediaEvent(event: "play" | "pause" | "ended"): void {
		const payload = this.mediaEventPayload();
		const set = this.listeners.get(event);
		if (!set) return;
		for (const handler of set) {
			handler(payload);
		}
	}

	private mediaEventPayload(): MediaEventPayload {
		const audio = this.requireAudio();
		const sourceUrl = audio.currentSrc || audio.src;
		const binding = this.sourceBinding;
		return {
			loadContext: binding?.sourceUrl === sourceUrl
				? binding.loadContext
				: null,
			sourceUrl,
		};
	}

	private emitTimeUpdate(): void {
		const audio = this.requireAudio();
		const payload: TimeUpdatePayload = {
			...this.mediaEventPayload(),
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
			...this.mediaEventPayload(),
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
			...this.mediaEventPayload(),
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

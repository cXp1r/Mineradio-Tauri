import type { AudioFrameSource } from "@mineradio/visual-engine";
import {
	PlaybackAudioRuntime,
	type AudioOutputDevice,
	type CommittedPlaybackOwnerLease,
	type OutputRoutingConfig,
	type OutputRoutingSnapshot,
	type PlaybackAudioDiagnostics,
	type PlaybackAudioEventName,
	type PlaybackAudioRuntimeOptions,
	type PlaybackDeckId,
	type PlaybackTransitionPreferences,
	type PlayPreparedOptions,
	type PrerollPreparedOptions,
	type PreparedPlaybackHandle,
} from "./playback-audio-runtime";

export type PlayerEventName = PlaybackAudioEventName;

/**
 * generation/deckId 是 M2 runtime 的附加 owner 证据。旧 feature fake 只提供
 * loadContext/sourceUrl 仍然合法，避免把深 Module 的内部标识扩散到全部 caller。
 */
export type MediaEventPayload = {
	readonly loadContext: object | null;
	readonly sourceUrl: string;
	readonly generation?: number;
	readonly deckId?: PlaybackDeckId;
};

export type TimeUpdatePayload = MediaEventPayload & {
	positionMs: number;
	durationMs: number | null;
};

export type ErrorPayload = MediaEventPayload & {
	code: number;
	message: string;
};

export type OwnerChangePayload = MediaEventPayload & {
	readonly previous: MediaEventPayload | null;
	readonly current: MediaEventPayload;
	readonly reason: "play" | "prepared" | "adopted";
};

export type PlaybackReadinessPayload = MediaEventPayload & {
	readonly probe: "native" | "early" | "late";
};

export type Listener = (
	payload: MediaEventPayload | TimeUpdatePayload | ErrorPayload | OwnerChangePayload | PlaybackReadinessPayload,
) => void;

export type HandlerForEvent<E extends PlayerEventName> =
	E extends "play" | "playing" | "pause" | "ended"
		? (payload: MediaEventPayload) => void
		: E extends "timeupdate" | "durationchange"
			? (payload: TimeUpdatePayload) => void
			: E extends "error"
				? (payload: ErrorPayload) => void
				: E extends "ownerchange"
					? (payload: OwnerChangePayload) => void
					: E extends "waiting" | "stalled" | "canplay"
						? (payload: PlaybackReadinessPayload) => void
						: Listener;

export type {
	AudioOutputDevice,
	CommittedPlaybackOwnerLease,
	OutputRoutingConfig,
	OutputRoutingSnapshot,
	PlaybackAudioDiagnostics,
	PlaybackAudioRuntimeOptions,
	PlaybackTransitionPreferences,
	PlayPreparedOptions,
	PrerollPreparedOptions,
	PreparedPlaybackHandle,
};

/**
 * 兼容旧 caller 的窄 facade。双 deck、owner handoff、Audio Graph、恢复预算与
 * 输出路由全部保留在 PlaybackAudioRuntime implementation 内。
 */
export class PlayerController {
	private readonly runtime: PlaybackAudioRuntime;

	constructor(audio?: HTMLAudioElement, options: PlaybackAudioRuntimeOptions = {}) {
		this.runtime = new PlaybackAudioRuntime(audio, options);
	}

	load(url: string, loadContext?: object): void {
		this.runtime.load(url, loadContext);
	}

	prepareNext(url: string, loadContext?: object): PreparedPlaybackHandle {
		return this.runtime.prepareNext(url, loadContext);
	}

	playPrepared(handle: PreparedPlaybackHandle, options?: PlayPreparedOptions): Promise<void> {
		return this.runtime.playPrepared(handle, options);
	}

	prerollPrepared(handle: PreparedPlaybackHandle, options?: PrerollPreparedOptions): Promise<void> {
		return this.runtime.prerollPrepared(handle, options);
	}

	adoptPrepared(handle: PreparedPlaybackHandle, loadContext: object): boolean {
		return this.runtime.adoptPrepared(handle, loadContext);
	}

	abort(handle: PreparedPlaybackHandle): void {
		this.runtime.abort(handle);
	}

	play(): Promise<void> {
		return this.runtime.play();
	}

	pause(): void {
		this.runtime.pause();
	}

	stageCommittedOwnerLease(): CommittedPlaybackOwnerLease | null {
		return this.runtime.stageCommittedOwnerLease();
	}

	pauseCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean {
		return this.runtime.pauseCommittedOwnerLease(lease);
	}

	rollbackCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): Promise<boolean> {
		return this.runtime.rollbackCommittedOwnerLease(lease);
	}

	releaseCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean {
		return this.runtime.releaseCommittedOwnerLease(lease);
	}

	cancelCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean {
		return this.runtime.cancelCommittedOwnerLease(lease);
	}

	stop(): void {
		this.runtime.stop();
	}

	seek(timeMs: number): void {
		this.runtime.seek(timeMs);
	}

	setVolume(volume: number): void {
		this.runtime.setVolume(volume);
	}

	setTransitionPreferences(preferences: PlaybackTransitionPreferences): void {
		this.runtime.setTransitionPreferences(preferences);
	}

	setOutputRouting(config: OutputRoutingConfig): Promise<OutputRoutingSnapshot> {
		return this.runtime.setOutputRouting(config);
	}

	listOutputDevices(): Promise<readonly AudioOutputDevice[]> {
		return this.runtime.listOutputDevices();
	}

	getActiveElement(): HTMLAudioElement | null {
		return this.runtime.getActiveElement();
	}

	getAudioFrameSource(): AudioFrameSource {
		return this.runtime.getAudioFrameSource();
	}

	diagnostics(): PlaybackAudioDiagnostics {
		return this.runtime.diagnostics();
	}

	on<E extends PlayerEventName>(event: E, handler: HandlerForEvent<E>): () => void {
		return this.runtime.on(event, handler as never);
	}

	dispose(): void {
		this.runtime.dispose();
	}
}

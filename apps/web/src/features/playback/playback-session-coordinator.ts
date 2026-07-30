import type { PlaybackQualityRequest } from "@mineradio/shared";
import {
	createPlaybackState,
	reducePlaybackState,
	type PlaybackMachineEvent,
	type PlaybackMachineState,
	type PlaybackReloadReason as MachinePlaybackReloadReason,
} from "./playback-state-machine";

export const LONG_PAUSE_PLAYBACK_URL_REFRESH_MS = 10 * 60 * 1_000;
export const PLAYBACK_URL_MAX_AGE_MS = 20 * 60 * 1_000;

export type PlaybackLoadReason = MachinePlaybackReloadReason;
export type PlaybackReloadReason = Extract<
	PlaybackLoadReason,
	"media-error" | "long-pause" | "url-age"
>;

export interface PlaybackLoadHandle {
	readonly playbackSessionId: number;
	readonly playbackToken: number;
	readonly lyricToken: number;
	readonly reloadReason?: PlaybackLoadReason;
}

export type PlaybackTrackSession = PlaybackLoadHandle;

export interface LoadedPlaybackSource {
	trackKey: string;
	quality: PlaybackQualityRequest;
	resolvedAtMs: number;
	audioUrl: string;
	rawUrl: string;
	local: boolean;
	trial: boolean;
}

interface PlaybackTransition {
	next: PlaybackMachineState;
	accepted: boolean;
}

function freezeMachineState(state: PlaybackMachineState): PlaybackMachineState {
	return Object.freeze(state);
}

export class PlaybackSessionCoordinator {
	private readonly issuedHandles = new WeakSet<PlaybackLoadHandle>();
	private trackKey = "";
	private playbackToken = 0;
	private lyricToken = 0;
	private loadedSource: Readonly<LoadedPlaybackSource> | null = null;
	private mediaErrorRecoveryTrackKey = "";
	private pausedAtMs: number | null = null;
	private machineState: PlaybackMachineState = freezeMachineState(
		createPlaybackState(),
	);
	private nextPlaybackSessionId = 0;
	private lastExplicitPlaybackIntentId = 0;
	private hasExplicitPlaybackIntent = false;
	private pendingInvalidatedLoad: PlaybackLoadHandle | null = null;
	private qualityReloadLoad: PlaybackLoadHandle | null = null;
	private pendingReloadCompletion: PlaybackLoadHandle | null = null;

	snapshot(): Readonly<PlaybackMachineState> {
		return this.machineState;
	}

	beginTrack(
		trackKey: string,
		playbackIntentId?: number,
		expectedInvalidatedLoad?: PlaybackLoadHandle,
	): PlaybackTrackSession | null {
		if (playbackIntentId !== undefined) {
			if (this.hasExplicitPlaybackIntent) {
				if (playbackIntentId < this.lastExplicitPlaybackIntentId) return null;
				if (playbackIntentId === this.lastExplicitPlaybackIntentId) {
					return this.claimInvalidatedLoadHandle(
						trackKey,
						expectedInvalidatedLoad,
					);
				}
			}
			const session = this.startTrackSession(trackKey);
			if (!session) return null;
			this.hasExplicitPlaybackIntent = true;
			this.lastExplicitPlaybackIntentId = playbackIntentId;
			return session;
		}

		const invalidatedHandle = this.claimInvalidatedLoadHandle(
			trackKey,
			expectedInvalidatedLoad,
		);
		if (invalidatedHandle) return invalidatedHandle;
		if (trackKey === this.trackKey) return null;
		return this.startTrackSession(trackKey);
	}

	clear(): void {
		const nextPlaybackSessionId = this.nextPlaybackSessionId + 1;
		const nextPlaybackToken = this.playbackToken + 1;
		const nextLyricToken = this.lyricToken + 1;
		const transition = this.reduce({
			type: "STOP",
			playbackSessionId: nextPlaybackSessionId,
		});
		if (!transition.accepted) return;

		this.machineState = freezeMachineState(transition.next);
		this.nextPlaybackSessionId = nextPlaybackSessionId;
		this.playbackToken = nextPlaybackToken;
		this.lyricToken = nextLyricToken;
		this.trackKey = "";
		this.loadedSource = null;
		this.pausedAtMs = null;
		this.mediaErrorRecoveryTrackKey = "";
		this.pendingInvalidatedLoad = null;
		this.qualityReloadLoad = null;
		this.pendingReloadCompletion = null;
	}

	beginReload(reason: PlaybackReloadReason): PlaybackLoadHandle | null {
		if (
			reason !== "long-pause" &&
			reason !== "url-age" &&
			reason !== "media-error"
		) {
			return null;
		}
		const playbackToken = this.playbackToken + 1;
		const transition = this.reduce({
			type: "BEGIN_RELOAD",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: playbackToken,
			reason,
		});
		if (!transition.accepted) return null;

		const handle = this.issueHandle({
			playbackSessionId: transition.next.playbackSessionId,
			playbackToken,
			lyricToken: this.lyricToken,
			reloadReason: reason,
		});
		this.machineState = freezeMachineState(transition.next);
		this.playbackToken = playbackToken;
		this.pendingInvalidatedLoad = null;
		this.qualityReloadLoad = null;
		this.pendingReloadCompletion = handle;
		return handle;
	}

	invalidateCurrentTrackLoad(): PlaybackLoadHandle | null {
		const playbackToken = this.playbackToken + 1;
		const lyricToken = this.lyricToken + 1;
		const transition = this.reduce({
			type: "BEGIN_RELOAD",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: playbackToken,
			reason: "quality",
		});
		if (!transition.accepted) return null;

		const handle = this.issueHandle({
			playbackSessionId: transition.next.playbackSessionId,
			playbackToken,
			lyricToken,
			reloadReason: "quality",
		});
		this.machineState = freezeMachineState(transition.next);
		this.playbackToken = playbackToken;
		this.lyricToken = lyricToken;
		this.loadedSource = null;
		this.pausedAtMs = null;
		this.mediaErrorRecoveryTrackKey = "";
		this.pendingInvalidatedLoad = handle;
		this.qualityReloadLoad = handle;
		this.pendingReloadCompletion = handle;
		return handle;
	}

	markLoaded(handle: PlaybackLoadHandle, source: LoadedPlaybackSource): boolean {
		if (!this.isPlaybackCurrent(handle)) return false;
		const transition = this.reduce({
			type: "SOURCE_READY",
			playbackSessionId: handle.playbackSessionId,
			loadRequestId: handle.playbackToken,
		});
		if (!transition.accepted) return false;

		this.machineState = freezeMachineState(transition.next);
		this.loadedSource = Object.freeze({ ...source });
		if (this.pendingInvalidatedLoad === handle) {
			this.pendingInvalidatedLoad = null;
		}
		if (this.qualityReloadLoad === handle) {
			this.machineState = freezeMachineState(
				reducePlaybackState(this.machineState, {
					type: "RESET_RECOVERY_BUDGET",
					playbackSessionId: handle.playbackSessionId,
					loadRequestId: handle.playbackToken,
				}),
			);
			this.qualityReloadLoad = null;
			if (this.pendingReloadCompletion === handle) {
				this.pendingReloadCompletion = null;
			}
		}
		return true;
	}

	markPaused(handle: PlaybackLoadHandle, nowMs: number): boolean {
		if (!this.isPlaybackCurrent(handle)) return false;
		const transition = this.tryDispatch({
			type: "PAUSE",
			playbackSessionId: handle.playbackSessionId,
			loadRequestId: handle.playbackToken,
		});
		if (!transition.accepted) return false;
		this.pausedAtMs = nowMs;
		return true;
	}

	markPlaying(handle: PlaybackLoadHandle): boolean {
		if (!this.isPlaybackCurrent(handle)) return false;
		const transition = this.machineState.phase === "paused"
			? this.tryDispatch({
				type: "RESUME",
				playbackSessionId: handle.playbackSessionId,
				loadRequestId: handle.playbackToken,
			})
			: this.tryDispatch({
				type: "MEDIA_PLAYING",
				playbackSessionId: handle.playbackSessionId,
				loadRequestId: handle.playbackToken,
			});
		if (!transition.accepted) return false;
		this.pausedAtMs = null;
		return true;
	}

	markOwnerPlaying(handle: PlaybackLoadHandle, sourceUrl: string): boolean {
		if (!this.isCurrentLoadedSource(handle, sourceUrl)) return false;
		return this.markPlaying(handle);
	}

	isCurrentLoadedSource(
		handle: PlaybackLoadHandle,
		sourceUrl: string,
	): boolean {
		return !!(
			this.isPlaybackCurrent(handle) &&
			this.loadedSource &&
			sourceUrl.trim() &&
			this.loadedSource.audioUrl === sourceUrl
		);
	}

	markEnded(handle: PlaybackLoadHandle): boolean {
		if (!this.isPlaybackCurrent(handle)) return false;
		const accepted = this.tryDispatch({
			type: "MEDIA_ENDED",
			playbackSessionId: handle.playbackSessionId,
			loadRequestId: handle.playbackToken,
		}).accepted;
		if (accepted) this.clearPendingLoad(handle);
		return accepted;
	}

	markResolveFailed(handle: PlaybackLoadHandle, reason: string): boolean {
		if (!this.isPlaybackCurrent(handle)) return false;
		const accepted = this.tryDispatch({
			type: "RESOLVE_FAILED",
			playbackSessionId: handle.playbackSessionId,
			loadRequestId: handle.playbackToken,
			reason,
		}).accepted;
		if (accepted) this.clearPendingLoad(handle);
		return accepted;
	}

	markRecoveryExhausted(handle: PlaybackLoadHandle, reason: string): boolean {
		if (!this.isPlaybackCurrent(handle)) return false;
		const accepted = this.tryDispatch({
			type: "RECOVERY_EXHAUSTED",
			playbackSessionId: handle.playbackSessionId,
			loadRequestId: handle.playbackToken,
			reason,
		}).accepted;
		if (accepted) this.clearPendingLoad(handle);
		return accepted;
	}

	markMediaFailed(
		handle: PlaybackLoadHandle,
		reason: string,
		recoverable = false,
	): boolean {
		if (!this.isPlaybackCurrent(handle)) return false;
		const accepted = this.tryDispatch({
			type: "MEDIA_FAILED",
			playbackSessionId: handle.playbackSessionId,
			loadRequestId: handle.playbackToken,
			recoverable,
			reason,
		}).accepted;
		if (accepted) this.clearPendingLoad(handle);
		return accepted;
	}

	refreshReason(
		nowMs: number,
	): Exclude<PlaybackReloadReason, "media-error"> | null {
		const loaded = this.loadedSource;
		if (!loaded || loaded.local) return null;
		if (
			this.pausedAtMs !== null &&
			nowMs - this.pausedAtMs >= LONG_PAUSE_PLAYBACK_URL_REFRESH_MS
		) {
			return "long-pause";
		}
		return nowMs - loaded.resolvedAtMs >= PLAYBACK_URL_MAX_AGE_MS
			? "url-age"
			: null;
	}

	claimMediaErrorRecovery(
		handle: PlaybackLoadHandle,
		trackKey: string,
		canResolveSongUrl: boolean,
	): boolean {
		if (!this.isPlaybackCurrent(handle)) return false;
		const loaded = this.loadedSource;
		const canRecover = !!(
			canResolveSongUrl &&
			trackKey &&
			loaded &&
			loaded.trackKey === trackKey &&
			!loaded.local &&
			!loaded.trial &&
			this.mediaErrorRecoveryTrackKey !== trackKey
		);

		if (!canRecover) {
			if (this.machineState.phase === "recovering") {
				this.markRecoveryExhausted(
					handle,
					"media-error-recovery-exhausted",
				);
			} else if (this.machineState.phase === "resolving") {
				this.markResolveFailed(
					handle,
					"media-error-recovery-unavailable",
				);
			} else {
				this.markMediaFailed(
					handle,
					"media-error-recovery-unavailable",
				);
			}
			return false;
		}

		if (
			!this.markMediaFailed(handle, "media-error", true) ||
			this.machineState.phase !== "recovering"
		) {
			return false;
		}
		this.mediaErrorRecoveryTrackKey = trackKey;
		return true;
	}

	completeReload(handle: PlaybackLoadHandle): boolean {
		const pending = this.pendingReloadCompletion;
		if (
			!this.isPlaybackCurrent(handle) ||
			pending !== handle ||
			this.machineState.phase !== "loading"
		) {
			return false;
		}
		this.pendingReloadCompletion = null;
		if (pending.reloadReason !== "media-error") {
			this.machineState = freezeMachineState(
				reducePlaybackState(this.machineState, {
					type: "RESET_RECOVERY_BUDGET",
					playbackSessionId: handle.playbackSessionId,
					loadRequestId: handle.playbackToken,
				}),
			);
			this.mediaErrorRecoveryTrackKey = "";
		}
		return true;
	}

	isPlaybackCurrent(handle: PlaybackLoadHandle): boolean {
		return (
			this.isIssuedHandle(handle) &&
			handle.playbackSessionId === this.machineState.playbackSessionId &&
			handle.playbackToken === this.machineState.loadRequestId &&
			handle.playbackToken === this.playbackToken
		);
	}

	isLyricCurrent(handle: PlaybackLoadHandle): boolean {
		return (
			this.isIssuedHandle(handle) &&
			handle.playbackSessionId === this.machineState.playbackSessionId &&
			handle.lyricToken === this.lyricToken
		);
	}

	private startTrackSession(trackKey: string): PlaybackTrackSession | null {
		const eventType = this.machineState.phase === "idle"
			? "PLAY_TRACK"
			: "SWITCH_TRACK";
		const playbackSessionId = this.nextPlaybackSessionId + 1;
		const playbackToken = this.playbackToken + 1;
		const lyricToken = this.lyricToken + 1;
		const transition = this.reduce({
			type: eventType,
			playbackSessionId,
			loadRequestId: playbackToken,
			trackKey,
		});
		if (!transition.accepted) return null;

		const handle = this.issueHandle({
			playbackSessionId,
			playbackToken,
			lyricToken,
		});
		this.machineState = freezeMachineState(transition.next);
		this.nextPlaybackSessionId = playbackSessionId;
		this.playbackToken = playbackToken;
		this.lyricToken = lyricToken;
		this.trackKey = trackKey;
		this.loadedSource = null;
		this.pausedAtMs = null;
		this.mediaErrorRecoveryTrackKey = "";
		this.pendingInvalidatedLoad = null;
		this.qualityReloadLoad = null;
		this.pendingReloadCompletion = null;
		return handle;
	}

	private claimInvalidatedLoadHandle(
		trackKey: string,
		expectedInvalidatedLoad?: PlaybackLoadHandle,
	): PlaybackTrackSession | null {
		const pending = this.pendingInvalidatedLoad;
		if (
			!pending ||
			pending !== expectedInvalidatedLoad ||
			!this.isIssuedHandle(expectedInvalidatedLoad) ||
			trackKey !== this.trackKey ||
			!this.isPlaybackCurrent(pending)
		) {
			return null;
		}
		this.pendingInvalidatedLoad = null;
		return pending;
	}

	private clearPendingLoad(handle: PlaybackLoadHandle): void {
		if (this.pendingInvalidatedLoad === handle) {
			this.pendingInvalidatedLoad = null;
		}
		if (this.qualityReloadLoad === handle) {
			this.qualityReloadLoad = null;
		}
		if (this.pendingReloadCompletion === handle) {
			this.pendingReloadCompletion = null;
		}
	}

	private issueHandle(handle: PlaybackLoadHandle): PlaybackLoadHandle {
		const issued = Object.freeze(handle);
		this.issuedHandles.add(issued);
		return issued;
	}

	private isIssuedHandle(
		handle: PlaybackLoadHandle | undefined,
	): handle is PlaybackLoadHandle {
		return !!handle && this.issuedHandles.has(handle);
	}

	private reduce(event: PlaybackMachineEvent): PlaybackTransition {
		const next = reducePlaybackState(this.machineState, event);
		return { next, accepted: next !== this.machineState };
	}

	private tryDispatch(event: PlaybackMachineEvent): PlaybackTransition {
		const transition = this.reduce(event);
		if (transition.accepted) {
			this.machineState = freezeMachineState(transition.next);
		}
		return transition;
	}
}

import type { PlaybackQualityRequest } from "@mineradio/shared";
import {
	createPlaybackState,
	reducePlaybackState,
	type PlaybackMachineEvent,
	type PlaybackMachineState,
} from "./playback-state-machine";

export const LONG_PAUSE_PLAYBACK_URL_REFRESH_MS = 10 * 60 * 1_000;
export const PLAYBACK_URL_MAX_AGE_MS = 20 * 60 * 1_000;

export type PlaybackReloadReason = "long-pause" | "url-age" | "media-error";

export interface PlaybackTrackSession {
	playbackSessionId: number;
	playbackToken: number;
	lyricToken: number;
}

export interface LoadedPlaybackSource {
	trackKey: string;
	quality: PlaybackQualityRequest;
	resolvedAtMs: number;
	audioUrl: string;
	rawUrl: string;
	local: boolean;
	trial: boolean;
}

export class PlaybackSessionCoordinator {
	private trackKey = "";
	private playbackToken = 0;
	private lyricToken = 0;
	private loadedSource: LoadedPlaybackSource | null = null;
	private mediaErrorRecoveryTrackKey = "";
	private pausedAtMs: number | null = null;
	private machineState: PlaybackMachineState = createPlaybackState();
	private nextPlaybackSessionId = 0;
	private playbackIntentId = 0;
	private legacyTrackInvalidated = false;

	snapshot(): PlaybackMachineState {
		return this.machineState;
	}

	beginTrack(
		trackKey: string,
		playbackIntentId?: number,
	): PlaybackTrackSession | null {
		if (playbackIntentId !== undefined) {
			if (playbackIntentId <= this.playbackIntentId) return null;
			this.playbackIntentId = playbackIntentId;
		} else {
			if (!this.legacyTrackInvalidated && trackKey === this.trackKey) return null;
			this.playbackIntentId += 1;
		}

		const eventType = this.machineState.phase === "idle"
			? "PLAY_TRACK"
			: "SWITCH_TRACK";
		this.trackKey = trackKey;
		this.loadedSource = null;
		this.pausedAtMs = null;
		this.mediaErrorRecoveryTrackKey = "";
		this.legacyTrackInvalidated = false;
		this.playbackToken += 1;
		this.lyricToken += 1;
		this.nextPlaybackSessionId += 1;
		this.dispatch({
			type: eventType,
			playbackSessionId: this.nextPlaybackSessionId,
			loadRequestId: this.playbackToken,
			trackKey,
		});
		return {
			playbackSessionId: this.nextPlaybackSessionId,
			playbackToken: this.playbackToken,
			lyricToken: this.lyricToken,
		};
	}

	clear(): void {
		this.trackKey = "";
		this.loadedSource = null;
		this.pausedAtMs = null;
		this.mediaErrorRecoveryTrackKey = "";
		this.legacyTrackInvalidated = false;
		this.playbackToken += 1;
		this.lyricToken += 1;
		this.nextPlaybackSessionId += 1;
		this.dispatch({
			type: "STOP",
			playbackSessionId: this.nextPlaybackSessionId,
		});
	}

	beginReload(reason: PlaybackReloadReason = "url-age"): number {
		this.playbackToken += 1;
		this.dispatch({
			type: "BEGIN_RELOAD",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: this.playbackToken,
			reason,
		});
		return this.playbackToken;
	}

	invalidateCurrentTrackLoad(): void {
		this.playbackToken += 1;
		this.legacyTrackInvalidated = true;
		this.dispatch({
			type: "BEGIN_RELOAD",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: this.playbackToken,
			reason: "quality",
		});
	}

	markLoaded(
		source: LoadedPlaybackSource,
		playbackToken = this.playbackToken,
	): void {
		if (!this.isPlaybackCurrent(playbackToken)) return;
		this.loadedSource = source;
		this.dispatch({
			type: "SOURCE_READY",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: playbackToken,
		});
	}

	markPaused(nowMs: number): void {
		this.pausedAtMs = nowMs;
		this.dispatch({
			type: "PAUSE",
			playbackSessionId: this.machineState.playbackSessionId,
		});
	}

	markPlaying(): void {
		this.pausedAtMs = null;
		this.dispatch({
			type: "MEDIA_PLAYING",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: this.playbackToken,
		});
	}

	markEnded(): void {
		this.dispatch({
			type: "MEDIA_ENDED",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: this.playbackToken,
		});
	}

	markResolveFailed(playbackToken: number, reason: string): void {
		this.dispatch({
			type: "RESOLVE_FAILED",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: playbackToken,
			reason,
		});
	}

	markRecoveryExhausted(reason: string): void {
		this.dispatch({
			type: "RECOVERY_EXHAUSTED",
			playbackSessionId: this.machineState.playbackSessionId,
			reason,
		});
	}

	refreshReason(nowMs: number): Exclude<PlaybackReloadReason, "media-error"> | null {
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

	claimMediaErrorRecovery(trackKey: string, canResolveSongUrl: boolean): boolean {
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
				this.markRecoveryExhausted("media-error-recovery-exhausted");
			} else if (this.machineState.phase === "resolving") {
				this.markResolveFailed(
					this.playbackToken,
					"media-error-recovery-unavailable",
				);
			} else {
				this.dispatch({
					type: "MEDIA_FAILED",
					playbackSessionId: this.machineState.playbackSessionId,
					loadRequestId: this.playbackToken,
					recoverable: false,
					reason: "media-error-recovery-unavailable",
				});
			}
			return false;
		}

		this.mediaErrorRecoveryTrackKey = trackKey;
		this.dispatch({
			type: "MEDIA_FAILED",
			playbackSessionId: this.machineState.playbackSessionId,
			loadRequestId: this.playbackToken,
			recoverable: true,
			reason: "media-error",
		});
		return true;
	}

	completeReload(
		reason: PlaybackReloadReason,
		playbackToken = this.playbackToken,
	): void {
		if (!this.isPlaybackCurrent(playbackToken)) return;
		if (reason !== "media-error") {
			this.mediaErrorRecoveryTrackKey = "";
			this.dispatch({
				type: "RESET_RECOVERY_BUDGET",
				playbackSessionId: this.machineState.playbackSessionId,
				loadRequestId: playbackToken,
			});
		}
	}

	isPlaybackCurrent(token: number): boolean {
		return token === this.playbackToken;
	}

	isLyricCurrent(token: number): boolean {
		return token === this.lyricToken;
	}

	private dispatch(event: PlaybackMachineEvent): void {
		this.machineState = reducePlaybackState(this.machineState, event);
	}
}

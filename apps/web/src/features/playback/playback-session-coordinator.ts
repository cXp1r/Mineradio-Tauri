import type { PlaybackQualityRequest } from "@mineradio/shared";

export const LONG_PAUSE_PLAYBACK_URL_REFRESH_MS = 10 * 60 * 1_000;
export const PLAYBACK_URL_MAX_AGE_MS = 20 * 60 * 1_000;

export type PlaybackReloadReason = "long-pause" | "url-age" | "media-error";

export interface PlaybackTrackSession {
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

	beginTrack(trackKey: string): PlaybackTrackSession | null {
		if (trackKey === this.trackKey) return null;
		this.trackKey = trackKey;
		this.mediaErrorRecoveryTrackKey = "";
		this.playbackToken += 1;
		this.lyricToken += 1;
		return {
			playbackToken: this.playbackToken,
			lyricToken: this.lyricToken,
		};
	}

	clear(): void {
		this.trackKey = "";
		this.loadedSource = null;
		this.pausedAtMs = null;
		this.mediaErrorRecoveryTrackKey = "";
		this.playbackToken += 1;
		this.lyricToken += 1;
	}

	beginReload(): number {
		this.playbackToken += 1;
		return this.playbackToken;
	}

	invalidateCurrentTrackLoad(): void {
		this.trackKey = "";
		this.playbackToken += 1;
	}

	markLoaded(source: LoadedPlaybackSource): void {
		this.loadedSource = source;
	}

	markPaused(nowMs: number): void {
		this.pausedAtMs = nowMs;
	}

	markPlaying(): void {
		this.pausedAtMs = null;
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
		if (
			!canResolveSongUrl ||
			!trackKey ||
			!loaded ||
			loaded.trackKey !== trackKey ||
			loaded.local ||
			loaded.trial ||
			this.mediaErrorRecoveryTrackKey === trackKey
		) {
			return false;
		}
		this.mediaErrorRecoveryTrackKey = trackKey;
		return true;
	}

	completeReload(reason: PlaybackReloadReason): void {
		if (reason !== "media-error") this.mediaErrorRecoveryTrackKey = "";
	}

	isPlaybackCurrent(token: number): boolean {
		return token === this.playbackToken;
	}

	isLyricCurrent(token: number): boolean {
		return token === this.lyricToken;
	}
}

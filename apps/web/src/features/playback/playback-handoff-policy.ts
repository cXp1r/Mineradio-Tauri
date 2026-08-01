export {
	ALBUM_GAPLESS_ADOPT_SLEW_MS,
	ALBUM_GAPLESS_CROSSFADE_DEFAULT_MS,
	ALBUM_GAPLESS_CROSSFADE_MIN_MS,
	ALBUM_GAPLESS_INCOMING_ATTACK_MS,
	sampleAlbumGaplessCrossfade,
	type AlbumGaplessCrossfadeInput,
	type AlbumGaplessCrossfadeSample,
} from "../../audio/album-gapless-transition";
import {
	ALBUM_GAPLESS_CROSSFADE_DEFAULT_MS,
	ALBUM_GAPLESS_CROSSFADE_MIN_MS,
} from "../../audio/album-gapless-transition";

export const ALBUM_GAPLESS_PRELOAD_WINDOW_SECONDS = 8.5;
export const ALBUM_GAPLESS_PREROLL_SECONDS = 1.05;

export interface AlbumGaplessTrack {
	readonly provider?: string | null;
	readonly id?: string | null;
	readonly album?: string | null;
	readonly coverUrl?: string | null;
}

export interface AlbumGaplessContext {
	readonly enabled: boolean;
	readonly playMode: string;
	readonly currentIndex: number;
	readonly playbackSessionId: number;
	readonly intentId: number;
	readonly queue: readonly AlbumGaplessTrack[];
}

export interface AlbumGaplessCandidate {
	readonly albumKey: string;
	readonly currentTrackKey: string;
	readonly candidateTrackKey: string;
	readonly candidateIndex: number;
}

export interface PreloadAuthority {
	readonly generation: number;
	readonly playbackSessionId: number;
	readonly intentId: number;
	readonly currentTrackKey: string;
	readonly candidateTrackKey: string;
	readonly candidateIndex: number;
	readonly albumKey: string;
	readonly queueFingerprint: string;
}

export interface AlbumGaplessHandoffState {
	readonly generation: number;
	readonly authority: PreloadAuthority | null;
	readonly committedGeneration: number | null;
	readonly advanceClaimedGeneration: number | null;
	readonly disposed: boolean;
}

export interface AlbumGaplessPreloadAuthorization {
	readonly state: AlbumGaplessHandoffState;
	readonly authority: PreloadAuthority;
}

export interface AlbumGaplessPolicyClaim {
	readonly state: AlbumGaplessHandoffState;
	readonly accepted: boolean;
}

export type AlbumGaplessAdvanceTrigger = "ended" | "handoff";

export interface AlbumGaplessTimingDecision {
	readonly preloadDue: boolean;
	readonly prerollDue: boolean;
	readonly crossfadeDurationMs: number;
}

function normalizeProvider(value: string | null | undefined): string {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function normalizeAlbum(value: string | null | undefined): string {
	return String(value ?? "")
		.normalize("NFKC")
		.trim()
		.toLocaleLowerCase()
		.replace(/\s+/gu, " ");
}

function normalizeCoverUrl(value: string | null | undefined): string {
	return String(value ?? "").trim();
}

function trackKey(track: AlbumGaplessTrack): string {
	const provider = normalizeProvider(track.provider);
	const id = String(track.id ?? "").trim();
	return provider && id ? `${provider}:${id}` : "";
}

function albumKey(track: AlbumGaplessTrack): string {
	const provider = normalizeProvider(track.provider);
	const album = normalizeAlbum(track.album);
	const coverUrl = normalizeCoverUrl(track.coverUrl);
	return provider && album && coverUrl
		? `${provider}\u0000${album}\u0000${coverUrl}`
		: "";
}

export function getAlbumGaplessTimingDecision(
	remainingSeconds: number,
): AlbumGaplessTimingDecision {
	const hasRemaining =
		Number.isFinite(remainingSeconds) && remainingSeconds > 0;
	const crossfadeDurationMs = hasRemaining
		? Math.min(
				ALBUM_GAPLESS_CROSSFADE_DEFAULT_MS,
				Math.max(
					ALBUM_GAPLESS_CROSSFADE_MIN_MS,
					Math.round(remainingSeconds * 1_000 + 80),
				),
			)
		: ALBUM_GAPLESS_CROSSFADE_DEFAULT_MS;
	return {
		preloadDue:
			hasRemaining &&
			remainingSeconds <= ALBUM_GAPLESS_PRELOAD_WINDOW_SECONDS,
		prerollDue:
			hasRemaining && remainingSeconds <= ALBUM_GAPLESS_PREROLL_SECONDS,
		crossfadeDurationMs,
	};
}

function queueFingerprint(queue: readonly AlbumGaplessTrack[]): string {
	return queue
		.map((track) => `${trackKey(track)}\u0000${albumKey(track)}`)
		.join("\u001e");
}

export function resolveAlbumGaplessCandidate(
	context: AlbumGaplessContext,
): AlbumGaplessCandidate | null {
	if (
		!context.enabled ||
		context.playMode === "single" ||
		context.playMode === "shuffle"
	) {
		return null;
	}
	if (!Number.isInteger(context.currentIndex) || context.currentIndex < 0) {
		return null;
	}
	const current = context.queue[context.currentIndex];
	const candidateIndex = context.currentIndex + 1 < context.queue.length
		? context.currentIndex + 1
		: context.playMode === "loop" && context.queue.length > 1
			? 0
			: -1;
	const candidate = candidateIndex >= 0 ? context.queue[candidateIndex] : undefined;
	if (!current || !candidate) return null;

	const currentTrackKey = trackKey(current);
	const candidateTrackKey = trackKey(candidate);
	const currentAlbumKey = albumKey(current);
	const candidateAlbumKey = albumKey(candidate);
	if (
		!currentTrackKey ||
		!candidateTrackKey ||
		!currentAlbumKey ||
		currentAlbumKey !== candidateAlbumKey
	) {
		return null;
	}

	return {
		albumKey: currentAlbumKey,
		currentTrackKey,
		candidateTrackKey,
		candidateIndex,
	};
}

export function createAlbumGaplessHandoffState(): AlbumGaplessHandoffState {
	return {
		generation: 0,
		authority: null,
		committedGeneration: null,
		advanceClaimedGeneration: null,
		disposed: false,
	};
}

export function authorizeAlbumGaplessPreload(
	state: AlbumGaplessHandoffState,
	context: AlbumGaplessContext,
): AlbumGaplessPreloadAuthorization | null {
	if (state.disposed) return null;
	const candidate = resolveAlbumGaplessCandidate(context);
	if (!candidate) return null;
	const generation = state.generation + 1;
	const authority: PreloadAuthority = Object.freeze({
		generation,
		playbackSessionId: context.playbackSessionId,
		intentId: context.intentId,
		currentTrackKey: candidate.currentTrackKey,
		candidateTrackKey: candidate.candidateTrackKey,
		candidateIndex: candidate.candidateIndex,
		albumKey: candidate.albumKey,
		queueFingerprint: queueFingerprint(context.queue),
	});
	return {
		authority,
		state: {
			generation,
			authority,
			committedGeneration: null,
			advanceClaimedGeneration: null,
			disposed: false,
		},
	};
}

function isCurrentAuthority(
	state: AlbumGaplessHandoffState,
	authority: PreloadAuthority,
	context: AlbumGaplessContext,
): boolean {
	if (state.disposed || !context.enabled) return false;
	const candidate = resolveAlbumGaplessCandidate(context);
	const current = state.authority;
	return !!(
		candidate &&
		current &&
		state.generation === authority.generation &&
		current.generation === authority.generation &&
		current.playbackSessionId === authority.playbackSessionId &&
		current.intentId === authority.intentId &&
		current.candidateTrackKey === authority.candidateTrackKey &&
		authority.playbackSessionId === context.playbackSessionId &&
		authority.intentId === context.intentId &&
		authority.currentTrackKey === candidate.currentTrackKey &&
		authority.candidateTrackKey === candidate.candidateTrackKey &&
		authority.candidateIndex === candidate.candidateIndex &&
		authority.albumKey === candidate.albumKey &&
		authority.queueFingerprint === queueFingerprint(context.queue)
	);
}

export function canCommitAlbumGaplessPreload(
	state: AlbumGaplessHandoffState,
	authority: PreloadAuthority,
	context: AlbumGaplessContext,
): boolean {
	return (
		isCurrentAuthority(state, authority, context) &&
		state.committedGeneration !== authority.generation &&
		state.advanceClaimedGeneration !== authority.generation
	);
}

export function claimAlbumGaplessPreloadCommit(
	state: AlbumGaplessHandoffState,
	authority: PreloadAuthority,
	context: AlbumGaplessContext,
): AlbumGaplessPolicyClaim {
	if (!canCommitAlbumGaplessPreload(state, authority, context)) {
		return { state, accepted: false };
	}
	return {
		accepted: true,
		state: {
			...state,
			committedGeneration: authority.generation,
		},
	};
}

export function claimAlbumGaplessAdvance(
	state: AlbumGaplessHandoffState,
	authority: PreloadAuthority,
	context: AlbumGaplessContext,
	trigger: AlbumGaplessAdvanceTrigger,
): AlbumGaplessPolicyClaim {
	if (
		!isCurrentAuthority(state, authority, context) ||
		state.advanceClaimedGeneration === authority.generation ||
		(trigger === "handoff" &&
			state.committedGeneration !== authority.generation)
	) {
		return { state, accepted: false };
	}

	// 原音频 ended 与预加载 handoff 可能同一时刻到达，只允许一个推进队列。
	return {
		accepted: true,
		state: {
			...state,
			advanceClaimedGeneration: authority.generation,
		},
	};
}

export function invalidateAlbumGaplessHandoff(
	state: AlbumGaplessHandoffState,
): AlbumGaplessHandoffState {
	return {
		generation: state.generation + 1,
		authority: null,
		committedGeneration: null,
		advanceClaimedGeneration: null,
		disposed: state.disposed,
	};
}

export function disposeAlbumGaplessHandoff(
	state: AlbumGaplessHandoffState,
): AlbumGaplessHandoffState {
	return {
		generation: state.generation + 1,
		authority: null,
		committedGeneration: null,
		advanceClaimedGeneration: null,
		disposed: true,
	};
}

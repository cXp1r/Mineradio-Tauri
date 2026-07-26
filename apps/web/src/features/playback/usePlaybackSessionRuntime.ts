import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type RefObject,
} from "react";
import {
	ensureLyricFallbackPayload,
	type LyricPayload,
	type PlaybackQualityRequest,
	type ProviderId,
	type SongUrlResult,
	type Track,
	type TrackQualityOption,
} from "@mineradio/shared";
import type {
	ErrorPayload,
	MediaEventPayload,
	PlayerController,
	TimeUpdatePayload,
} from "../../audio/player-controller";
import type { AppServices } from "../../app/app-services";
import { resolveLyricsForTrack } from "../../lyrics/custom-lyrics";
import type { JsonValue } from "../../tauri/runtime";
import {
	PlaybackSessionCoordinator,
	type PlaybackLoadHandle,
	type PlaybackReloadReason,
} from "./playback-session-coordinator";
import { resolvePlayableAudio } from "./resolve-playable-audio";

export interface CurrentBeatMapState {
	key: string;
	map: JsonValue;
}

export interface TrialBannerState {
	text: string;
	provider: ProviderId;
	showLogin: boolean;
}

export interface PlaybackSessionSnapshot {
	currentTrack: Track | null;
	positionMs: number;
	durationMs: number | null;
	isPlaying: boolean;
}

export interface PlaybackSessionRuntimeOptions {
	appServices: AppServices | null;
	coordinator?: PlaybackSessionCoordinator;
	controllerRef: RefObject<PlayerController | null>;
	localAudioUrlsRef: RefObject<Map<string, string>>;
	currentTrack: Track | null;
	playbackIntentId: number;
	positionMs: number;
	getPlaybackSnapshot(): PlaybackSessionSnapshot;
	setPlaying(playing: boolean): void;
	setPositionMs(positionMs: number): void;
	togglePlayFallback(): void;
	setSearchError(message: string): void;
	showToast(message: string): void;
	setHomeForcedOpen(open: boolean): void;
	setHomeSuppressed(suppressed: boolean): void;
	setLyricsPayload(payload: LyricPayload): void;
	setLyricsLoading(loading: boolean): void;
	setLyricsError(message: string): void;
	resetLyrics(): void;
	beatMapKeyForMap(map: JsonValue, source: string): string;
	initialLyricsPayload: LyricPayload | null;
	initialPlaybackQuality: PlaybackQualityRequest;
	persistPlaybackQuality(quality: PlaybackQualityRequest): void;
	now?: () => number;
	onRuntimePause?: () => void;
	onRuntimeTimeUpdate?(payload: TimeUpdatePayload): void;
	onRuntimeDurationChange?(payload: TimeUpdatePayload): void;
	onRuntimeEnded?(): void;
}

export interface PlaybackSessionRuntimeResult {
	playbackQuality: PlaybackQualityRequest;
	trackQualityOptions: TrackQualityOption[];
	trialBanner: TrialBannerState | null;
	currentBeatMapState: CurrentBeatMapState | null;
	originalLyricsPayloadRef: RefObject<LyricPayload | null>;
	clearCurrentBeatMap(): void;
	dismissTrialBanner(): void;
	setPlaybackQuality(quality: PlaybackQualityRequest): void;
	togglePlayback(): void;
	handleRuntimeTimeUpdate(payload: TimeUpdatePayload): void;
	handleRuntimeDurationChange(payload: TimeUpdatePayload): void;
	handleRuntimePlay(payload: MediaEventPayload): void;
	handleRuntimePause(payload: MediaEventPayload): void;
	handleRuntimeEnded(payload: MediaEventPayload): void;
	handleRuntimeError(payload: ErrorPayload): void;
}

function playbackKeyForTrack(track: Track | null | undefined): string {
	return track ? `${track.provider}:${track.id}` : "";
}

function buildTrackLyricFallback(track: Track): LyricPayload {
	return ensureLyricFallbackPayload({
		provider: track.provider,
		trackId: track.id,
		lines: [],
		hasTranslation: false,
		isWordByWord: false,
	}, track);
}

function trialBannerText(result: SongUrlResult): string {
	if (result.message?.trim()) return result.message.trim();
	if (result.loggedIn && result.vipLevel === "svip") {
		return "此歌曲需要单曲、专辑购买或更高权限";
	}
	if (result.loggedIn && result.vipLevel === "vip") {
		return "此歌曲需要 SVIP 或购买 · 当前仅播放试听片段";
	}
	if (result.loggedIn) return "此歌曲需 VIP · 当前仅播放试听片段";
	return "当前未登录 · 仅播放试听片段";
}

function toJsonValue(value: unknown): JsonValue | null {
	if (value == null) return null;
	try {
		return JSON.parse(JSON.stringify(value)) as JsonValue;
	} catch {
		return null;
	}
}

function isPodcastTrack(track: Track | null | undefined): boolean {
	const record = track as unknown as Record<string, unknown> | null | undefined;
	return record?.type === "podcast" || record?.source === "podcast";
}

export function usePlaybackSessionRuntime({
	appServices,
	coordinator: providedCoordinator,
	controllerRef,
	localAudioUrlsRef,
	currentTrack,
	playbackIntentId,
	positionMs,
	getPlaybackSnapshot,
	setPlaying,
	setPositionMs,
	togglePlayFallback,
	setSearchError,
	showToast,
	setHomeForcedOpen,
	setHomeSuppressed,
	setLyricsPayload,
	setLyricsLoading,
	setLyricsError,
	resetLyrics,
	beatMapKeyForMap,
	initialLyricsPayload,
	initialPlaybackQuality,
	persistPlaybackQuality,
	now = Date.now,
	onRuntimePause,
	onRuntimeTimeUpdate,
	onRuntimeDurationChange,
	onRuntimeEnded,
}: PlaybackSessionRuntimeOptions): PlaybackSessionRuntimeResult {
	const [playbackQuality, setPlaybackQualityState] = useState(initialPlaybackQuality);
	const [playbackQualityReloadHandle, setPlaybackQualityReloadHandle] =
		useState<PlaybackLoadHandle | null>(null);
	const [trackQualityOptions, setTrackQualityOptions] = useState<TrackQualityOption[]>([]);
	const [trialBanner, setTrialBanner] = useState<TrialBannerState | null>(null);
	const [currentBeatMapState, setCurrentBeatMapState] =
		useState<CurrentBeatMapState | null>(null);
	const coordinatorRef = useRef<PlaybackSessionCoordinator | null>(null);
	if (!coordinatorRef.current) {
		coordinatorRef.current = providedCoordinator ?? new PlaybackSessionCoordinator();
	}
	const coordinator = coordinatorRef.current;
	const positionRef = useRef(positionMs);
	positionRef.current = positionMs;
	const originalLyricsPayloadRef = useRef<LyricPayload | null>(initialLyricsPayload);
	const reloadCurrentTrackAndPlayRef = useRef<
		(options: { preservePosition: boolean; reason: PlaybackReloadReason }) => Promise<boolean>
	>(async () => false);

	const loadBeatMap = useCallback((
		services: AppServices,
		track: Track,
		rawUrl: string,
		loadHandle: PlaybackLoadHandle,
	) => {
		if (!isPodcastTrack(track)) return;
		void Promise.resolve().then(() => services.music.discover.podcastDjBeatmap(
			rawUrl,
			Math.max(
				0,
				Number(track.durationMs ?? getPlaybackSnapshot().durationMs ?? 0) / 1_000,
			),
			0,
		)).then((beatmap) => {
			if (!coordinator.isPlaybackCurrent(loadHandle)) return;
			const map = toJsonValue(beatmap.map);
			setCurrentBeatMapState(map ? {
				key: beatMapKeyForMap(map, "dj"),
				map,
			} : null);
		}).catch(() => {
			if (coordinator.isPlaybackCurrent(loadHandle)) {
				setCurrentBeatMapState(null);
			}
		});
	}, [beatMapKeyForMap, coordinator, getPlaybackSnapshot]);

	const reloadCurrentTrackAndPlay = useCallback(async ({
		preservePosition,
		reason,
	}: {
		preservePosition: boolean;
		reason: PlaybackReloadReason;
	}): Promise<boolean> => {
		const controller = controllerRef.current;
		const services = appServices;
		const track = getPlaybackSnapshot().currentTrack;
		if (!controller || !services || !track) return false;

		const key = playbackKeyForTrack(track);
		if (!key || localAudioUrlsRef.current.has(key)) return false;

		const reload = coordinator.beginReload(reason);
		if (!reload) return false;
		const resumeAt = preservePosition
			? Math.max(0, getPlaybackSnapshot().positionMs)
			: 0;

		let sourceAccepted = false;
		try {
			const { result, audioUrl } = await resolvePlayableAudio({
				playback: services.music.playback,
				mediaUrl: services.mediaUrl,
				track,
				quality: playbackQuality,
			});
			if (!coordinator.isPlaybackCurrent(reload)) return false;
			setTrialBanner(result.trial ? {
				text: trialBannerText(result),
				provider: track.provider,
				showLogin: !result.loggedIn,
			} : null);
			if (!coordinator.markLoaded(reload, {
				trackKey: key,
				quality: playbackQuality,
				resolvedAtMs: now(),
				audioUrl,
				rawUrl: result.url,
				local: false,
				trial: result.trial === true,
			})) return false;
			sourceAccepted = true;
			controller.load(audioUrl, reload);
			coordinator.completeReload(reload);
			loadBeatMap(services, track, result.url, reload);
			if (resumeAt > 0) {
				setPositionMs(resumeAt);
				controller.seek(resumeAt);
			}
			await controller.play();
			if (!coordinator.isPlaybackCurrent(reload)) return false;
			if (coordinator.markPlaying(reload)) setPlaying(true);
			setHomeForcedOpen(false);
			setHomeSuppressed(true);
			return true;
		} catch (error) {
			if (!coordinator.isPlaybackCurrent(reload)) return false;
			const message = error instanceof Error ? error.message : "playback error";
			const accepted = sourceAccepted
				? coordinator.markMediaFailed(reload, message)
				: coordinator.markResolveFailed(reload, message);
			if (!accepted) return false;
			setTrialBanner(null);
			setPlaying(false);
			setSearchError(message);
			showToast(message);
			return false;
		}
	}, [
		appServices,
		controllerRef,
		coordinator,
		getPlaybackSnapshot,
		loadBeatMap,
		localAudioUrlsRef,
		now,
		playbackQuality,
		setHomeForcedOpen,
		setHomeSuppressed,
		setPlaying,
		setPositionMs,
		setSearchError,
		showToast,
	]);
	reloadCurrentTrackAndPlayRef.current = reloadCurrentTrackAndPlay;
	const currentEventLoad = useCallback((payload: MediaEventPayload) => {
		const loadContext = payload.loadContext;
		if (!loadContext) return null;
		const handle = loadContext as PlaybackLoadHandle;
		return coordinator.isPlaybackCurrent(handle) ? handle : null;
	}, [coordinator]);
	const runtimeLifecycleCallbacksRef = useRef({
		onRuntimeTimeUpdate,
		onRuntimeDurationChange,
		onRuntimeEnded,
	});
	runtimeLifecycleCallbacksRef.current = {
		onRuntimeTimeUpdate,
		onRuntimeDurationChange,
		onRuntimeEnded,
	};

	const handleRuntimeTimeUpdate = useCallback((payload: TimeUpdatePayload) => {
		if (!currentEventLoad(payload)) return;
		runtimeLifecycleCallbacksRef.current.onRuntimeTimeUpdate?.(payload);
	}, [currentEventLoad]);

	const handleRuntimeDurationChange = useCallback((payload: TimeUpdatePayload) => {
		if (!currentEventLoad(payload)) return;
		runtimeLifecycleCallbacksRef.current.onRuntimeDurationChange?.(payload);
	}, [currentEventLoad]);

	const handleRuntimeEnded = useCallback((payload: MediaEventPayload) => {
		const boundLoad = currentEventLoad(payload);
		if (!boundLoad || !coordinator.markEnded(boundLoad)) return;
		runtimeLifecycleCallbacksRef.current.onRuntimeEnded?.();
	}, [coordinator, currentEventLoad]);

	const handleRuntimeErrorImpl = useCallback((payload: ErrorPayload) => {
		const boundLoad = currentEventLoad(payload);
		if (!boundLoad) return;
		const message = payload.message || "音频播放失败";
		const track = getPlaybackSnapshot().currentTrack;
		const key = playbackKeyForTrack(track);
		const previousState = coordinator.snapshot();
		if (
			coordinator.claimMediaErrorRecovery(
				boundLoad,
				key,
				!!appServices?.music.playback,
			)
		) {
			setTrialBanner(null);
			void reloadCurrentTrackAndPlayRef.current({
				preservePosition: true,
				reason: "media-error",
			});
			return;
		}
		if (coordinator.snapshot() === previousState) return;
		setTrialBanner(null);
		setSearchError(message);
		showToast(message);
	}, [
		appServices,
		coordinator,
		currentEventLoad,
		getPlaybackSnapshot,
		setSearchError,
		showToast,
	]);
	const handleRuntimeErrorRef = useRef(handleRuntimeErrorImpl);
	handleRuntimeErrorRef.current = handleRuntimeErrorImpl;
	const handleRuntimeError = useCallback((payload: ErrorPayload) => {
		handleRuntimeErrorRef.current(payload);
	}, []);

	const togglePlayback = useCallback(() => {
		const snapshot = getPlaybackSnapshot();
		if (!snapshot.currentTrack) {
			showToast("先搜索或打开歌单选择一首歌");
			return;
		}
		const controller = controllerRef.current;
		if (!controller) {
			togglePlayFallback();
			return;
		}
		if (snapshot.isPlaying) {
			controller.pause();
			return;
		}
		const reason = coordinator.refreshReason(now());
		if (reason) {
			void reloadCurrentTrackAndPlayRef.current({
				preservePosition: true,
				reason,
			});
			return;
		}
		void controller.play();
	}, [controllerRef, coordinator, getPlaybackSnapshot, now, showToast, togglePlayFallback]);

	const handleRuntimePlay = useCallback((payload: MediaEventPayload) => {
		const boundLoad = currentEventLoad(payload);
		if (!boundLoad) return;
		if (!coordinator.markPlaying(boundLoad)) return;
		setPlaying(true);
	}, [coordinator, currentEventLoad, setPlaying]);

	const handleRuntimePause = useCallback((payload: MediaEventPayload) => {
		const boundLoad = currentEventLoad(payload);
		if (!boundLoad) return;
		if (!coordinator.markPaused(boundLoad, now())) return;
		onRuntimePause?.();
		setPlaying(false);
	}, [coordinator, currentEventLoad, now, onRuntimePause, setPlaying]);

	const setPlaybackQuality = useCallback((quality: PlaybackQualityRequest) => {
		setPlaybackQualityState(quality);
		persistPlaybackQuality(quality);
		const snapshot = getPlaybackSnapshot();
		if (!snapshot.currentTrack) {
			showToast("音质偏好已保存，下次播放生效");
			return;
		}
		const resumeAt = controllerRef.current ? snapshot.positionMs : 0;
		if (resumeAt > 0) controllerRef.current?.pause();
		const qualityReload = coordinator.invalidateCurrentTrackLoad();
		if (qualityReload) {
			setPlaybackQualityReloadHandle(qualityReload);
		}
		setPositionMs(resumeAt);
		showToast("正在切换音质");
	}, [
		controllerRef,
		coordinator,
		getPlaybackSnapshot,
		persistPlaybackQuality,
		setPositionMs,
		showToast,
	]);

	useEffect(() => {
		const track = currentTrack;
		const playback = appServices?.music.playback;
		const key = playbackKeyForTrack(track);
		if (!track || !playback || !key || localAudioUrlsRef.current.has(key)) {
			setTrackQualityOptions([]);
			return;
		}
		let cancelled = false;
		void Promise.resolve().then(() => playback.trackQualities(track)).then((availability) => {
			if (cancelled) return;
			const qualities = availability.qualities;
			setTrackQualityOptions(qualities);
			const selectedAvailable = qualities.some(
				(quality) => quality.requestQuality === playbackQuality,
			);
			const fallbackQuality = availability.defaultQuality ?? qualities[0]?.requestQuality;
			if (!selectedAvailable && fallbackQuality) setPlaybackQuality(fallbackQuality);
		}).catch(() => {
			if (!cancelled) setTrackQualityOptions([]);
		});
		return () => {
			cancelled = true;
		};
	}, [
		appServices,
		currentTrack,
		localAudioUrlsRef,
		playbackQuality,
		setPlaybackQuality,
	]);

	useEffect(() => {
		const controller = controllerRef.current;
		const services = appServices;
		if (!controller) return;
		if (!currentTrack) {
			coordinator.clear();
			setCurrentBeatMapState(null);
			setTrialBanner(null);
			controller.pause();
			resetLyrics();
			return;
		}

		const key = playbackKeyForTrack(currentTrack);
		const localAudioUrl = localAudioUrlsRef.current.get(key);
		if (!localAudioUrl && !services) return;
		const session = coordinator.beginTrack(
			key,
			playbackIntentId,
			playbackQualityReloadHandle ?? undefined,
		);
		if (!session) return;
		setCurrentBeatMapState(null);
		setTrialBanner(null);
		const fallbackLyric = buildTrackLyricFallback(currentTrack);
		originalLyricsPayloadRef.current = fallbackLyric;
		const resolvedFallbackLyric = resolveLyricsForTrack({
			track: currentTrack,
			original: fallbackLyric,
			durationMs: getPlaybackSnapshot().durationMs ?? currentTrack.durationMs,
		});
		setLyricsPayload(resolvedFallbackLyric.payload);

		if (localAudioUrl) {
			void (async () => {
				let sourceAccepted = false;
				try {
					if (!coordinator.markLoaded(session, {
						trackKey: key,
						quality: playbackQuality,
						resolvedAtMs: now(),
						audioUrl: localAudioUrl,
						rawUrl: localAudioUrl,
						local: true,
						trial: false,
					})) return;
					sourceAccepted = true;
					controller.load(localAudioUrl, session);
					if (positionRef.current > 0) controller.seek(positionRef.current);
					await controller.play();
					if (!coordinator.isPlaybackCurrent(session)) return;
					if (coordinator.markPlaying(session)) setPlaying(true);
					setLyricsLoading(false);
					setHomeForcedOpen(false);
					setHomeSuppressed(true);
				} catch (error) {
					if (!coordinator.isPlaybackCurrent(session)) return;
					const message = error instanceof Error ? error.message : "playback error";
					const accepted = sourceAccepted
						? coordinator.markMediaFailed(session, message)
						: coordinator.markResolveFailed(session, message);
					if (!accepted) return;
					setPlaying(false);
					setSearchError(message);
					showToast(message);
				}
			})();
			return;
		}

		if (!services) return;
		void (async () => {
			let sourceAccepted = false;
			try {
				const { result, audioUrl } = await resolvePlayableAudio({
					playback: services.music.playback,
					mediaUrl: services.mediaUrl,
					track: currentTrack,
					quality: playbackQuality,
				});
				if (!coordinator.isPlaybackCurrent(session)) return;
				setTrialBanner(result.trial ? {
					text: trialBannerText(result),
					provider: currentTrack.provider,
					showLogin: !result.loggedIn,
				} : null);
				if (!coordinator.markLoaded(session, {
					trackKey: key,
					quality: playbackQuality,
					resolvedAtMs: now(),
					audioUrl,
					rawUrl: result.url,
					local: false,
					trial: result.trial === true,
			})) return;
			sourceAccepted = true;
			controller.load(audioUrl, session);
				loadBeatMap(services, currentTrack, result.url, session);
				if (positionRef.current > 0) controller.seek(positionRef.current);
			await controller.play();
			if (!coordinator.isPlaybackCurrent(session)) return;
			if (coordinator.markPlaying(session)) setPlaying(true);
				setHomeForcedOpen(false);
				setHomeSuppressed(true);
			} catch (error) {
				if (!coordinator.isPlaybackCurrent(session)) return;
				const message = error instanceof Error ? error.message : "playback error";
				const accepted = sourceAccepted
					? coordinator.markMediaFailed(session, message)
					: coordinator.markResolveFailed(session, message);
				if (!accepted) return;
				setTrialBanner(null);
				setPlaying(false);
				setSearchError(message);
				showToast(message);
			}

			try {
				setLyricsLoading(true);
				const lyric = ensureLyricFallbackPayload(
					await services.music.lyrics.lyric(currentTrack),
					currentTrack,
				);
				if (!coordinator.isLyricCurrent(session)) return;
				originalLyricsPayloadRef.current = lyric;
				const resolvedLyric = resolveLyricsForTrack({
					track: currentTrack,
					original: lyric,
					durationMs: getPlaybackSnapshot().durationMs ?? currentTrack.durationMs,
				});
				setLyricsPayload(resolvedLyric.payload);
			} catch (error) {
				if (!coordinator.isLyricCurrent(session)) return;
				const message = error instanceof Error ? error.message : "lyrics failed";
				const fallback = buildTrackLyricFallback(currentTrack);
				originalLyricsPayloadRef.current = fallback;
				const resolvedLyric = resolveLyricsForTrack({
					track: currentTrack,
					original: fallback,
					durationMs: getPlaybackSnapshot().durationMs ?? currentTrack.durationMs,
				});
				setLyricsPayload(resolvedLyric.payload);
				setLyricsError(message);
			}
		})();
	}, [
		appServices,
		controllerRef,
		coordinator,
		currentTrack,
		getPlaybackSnapshot,
		loadBeatMap,
		localAudioUrlsRef,
		now,
		playbackIntentId,
		playbackQuality,
		playbackQualityReloadHandle,
		resetLyrics,
		setHomeForcedOpen,
		setHomeSuppressed,
		setLyricsError,
		setLyricsLoading,
		setLyricsPayload,
		setPlaying,
		setSearchError,
		showToast,
	]);

	return {
		playbackQuality,
		trackQualityOptions,
		trialBanner,
		currentBeatMapState,
		originalLyricsPayloadRef,
		clearCurrentBeatMap: () => setCurrentBeatMapState(null),
		dismissTrialBanner: () => setTrialBanner(null),
		setPlaybackQuality,
		togglePlayback,
		handleRuntimeTimeUpdate,
		handleRuntimeDurationChange,
		handleRuntimePlay,
		handleRuntimePause,
		handleRuntimeEnded,
		handleRuntimeError,
	};
}

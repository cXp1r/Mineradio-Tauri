import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import {
	attachControlGlassNode,
	createControlConsoleMotion,
	injectControlGlassStyle,
	type ControlConsoleMotion,
} from "@mineradio/visual-engine";
import type { PlaybackMode } from "../stores/playback-store";
import type { ShelfCameraMode, ShelfMode, ShelfPresence } from "../stores/shelf-store";
import type { PlaybackQuality, Track } from "@mineradio/shared";
import { createProgressDragParticleEmitter, type ProgressDragParticleEmitter } from "./progress-drag-particles";

const PLAYBACK_QUALITY_OPTIONS: Array<{
	value: PlaybackQuality;
	label: string;
	short: string;
	detail: string;
	svip?: boolean;
}> = [
	{ value: "jymaster", label: "超清母带", short: "母带", detail: "SVIP / 最高规格", svip: true },
	{ value: "hires", label: "高清臻音", short: "臻音", detail: "默认 / 细节优先" },
	{ value: "lossless", label: "无损 SQ", short: "SQ", detail: "FLAC 优先" },
	{ value: "exhigh", label: "极高 HQ", short: "HQ", detail: "320kbps" },
	{ value: "standard", label: "标准", short: "STD", detail: "128kbps" },
];

function playbackQualityOption(value: PlaybackQuality | undefined) {
	return PLAYBACK_QUALITY_OPTIONS.find((option) => option.value === value) ?? PLAYBACK_QUALITY_OPTIONS[1];
}

export interface PlayerConsoleHostProps {
	visible?: boolean;
	onReveal?: () => void;
	onTogglePlay?: () => void;
	onPrevious?: () => void;
	onNext?: () => void;
	onModeChange?: (mode: PlaybackMode) => void;
	onQueue?: () => void;
	onLyrics?: () => void;
	onLyricSourceChange?: (mode: "original" | "custom") => void;
	onOpenCustomLyrics?: () => void;
	onCollectCurrent?: () => void;
	onToggleLikeCurrent?: () => void;
	onNotice?: (message: string) => void;
	onSeek?: (positionMs: number) => void;
	onVolumeChange?: (volume: number) => void;
	onToggleMute?: () => void;
	onQualityChange?: (quality: PlaybackQuality) => void;
	onShelfModeChange?: (mode: ShelfMode) => void;
	onShelfCameraModeChange?: (mode: ShelfCameraMode) => void;
	onShelfPresenceChange?: (presence: ShelfPresence) => void;
	onShelfShowPodcastsChange?: (show: boolean) => void;
	onShelfMergeCollectionsChange?: (merge: boolean) => void;
	onPlayQueueIndex?: (index: number) => void;
	onRemoveQueueIndex?: (index: number) => void;
	onInsertQueueNext?: (index: number) => void;
	onMinimize?: () => void;
	onToggleMaximize?: () => void;
	onToggleFullscreen?: () => void;
	onClose?: () => void;
	mode?: PlaybackMode;
	isPlaying?: boolean;
	currentTitle?: string;
	currentArtist?: string;
	currentCoverUrl?: string;
	currentLiked?: boolean;
	currentLikeBusy?: boolean;
	queue?: Track[];
	currentTrack?: Track | null;
	miniQueueOpen?: boolean;
	positionMs?: number;
	durationMs?: number | null;
	volume?: number;
	muted?: boolean;
	playbackQuality?: PlaybackQuality;
	shelfMode?: ShelfMode;
	shelfCameraMode?: ShelfCameraMode;
	shelfPresence?: ShelfPresence;
	shelfShowPodcasts?: boolean;
	shelfMergeCollections?: boolean;
	lyricSourceMode?: "original" | "custom";
	hasCustomLyric?: boolean;
	deps?: {
		controlsHovering?: () => boolean;
		miniQueueOpen?: () => boolean;
		controlsAutoHide?: () => boolean;
		isShelfSuppressed?: () => boolean;
		isHomeControlsLocked?: () => boolean;
	};
}

export function PlayerConsoleHost(props: PlayerConsoleHostProps): ReactElement {
	const barRef = useRef<HTMLDivElement | null>(null);
	const modeBtnRef = useRef<HTMLButtonElement | null>(null);
	const modeIconRef = useRef<SVGSVGElement | null>(null);
	const playBtnRef = useRef<HTMLButtonElement | null>(null);
	const normalBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
	const motionRef = useRef<ControlConsoleMotion | null>(null);
	const visibleRef = useRef(!!props.visible);
	const progressParticleEmitterRef = useRef<ProgressDragParticleEmitter | null>(null);

	visibleRef.current = !!props.visible;
	const onMinimizeRef = useRef(props.onMinimize);
	onMinimizeRef.current = props.onMinimize;
	const onToggleMaximizeRef = useRef(props.onToggleMaximize);
	onToggleMaximizeRef.current = props.onToggleMaximize;
	const onToggleFullscreenRef = useRef(props.onToggleFullscreen);
	onToggleFullscreenRef.current = props.onToggleFullscreen;
	const onCloseRef = useRef(props.onClose);
	onCloseRef.current = props.onClose;
	const onTogglePlayRef = useRef(props.onTogglePlay);
	onTogglePlayRef.current = props.onTogglePlay;
	const onPreviousRef = useRef(props.onPrevious);
	onPreviousRef.current = props.onPrevious;
	const onNextRef = useRef(props.onNext);
	onNextRef.current = props.onNext;
	const onModeChangeRef = useRef(props.onModeChange);
	onModeChangeRef.current = props.onModeChange;
	const onQueueRef = useRef(props.onQueue);
	onQueueRef.current = props.onQueue;
	const onLyricsRef = useRef(props.onLyrics);
	onLyricsRef.current = props.onLyrics;
	const onLyricSourceChangeRef = useRef(props.onLyricSourceChange);
	onLyricSourceChangeRef.current = props.onLyricSourceChange;
	const onOpenCustomLyricsRef = useRef(props.onOpenCustomLyrics);
	onOpenCustomLyricsRef.current = props.onOpenCustomLyrics;
	const onCollectCurrentRef = useRef(props.onCollectCurrent);
	onCollectCurrentRef.current = props.onCollectCurrent;
	const onToggleLikeCurrentRef = useRef(props.onToggleLikeCurrent);
	onToggleLikeCurrentRef.current = props.onToggleLikeCurrent;
	const onNoticeRef = useRef(props.onNotice);
	onNoticeRef.current = props.onNotice;
	const onSeekRef = useRef(props.onSeek);
	onSeekRef.current = props.onSeek;
	const onVolumeChangeRef = useRef(props.onVolumeChange);
	onVolumeChangeRef.current = props.onVolumeChange;
	const onToggleMuteRef = useRef(props.onToggleMute);
	onToggleMuteRef.current = props.onToggleMute;
	const onQualityChangeRef = useRef(props.onQualityChange);
	onQualityChangeRef.current = props.onQualityChange;
	const onShelfModeChangeRef = useRef(props.onShelfModeChange);
	onShelfModeChangeRef.current = props.onShelfModeChange;
	const onShelfCameraModeChangeRef = useRef(props.onShelfCameraModeChange);
	onShelfCameraModeChangeRef.current = props.onShelfCameraModeChange;
	const onShelfPresenceChangeRef = useRef(props.onShelfPresenceChange);
	onShelfPresenceChangeRef.current = props.onShelfPresenceChange;
	const onShelfShowPodcastsChangeRef = useRef(props.onShelfShowPodcastsChange);
	onShelfShowPodcastsChangeRef.current = props.onShelfShowPodcastsChange;
	const onShelfMergeCollectionsChangeRef = useRef(props.onShelfMergeCollectionsChange);
	onShelfMergeCollectionsChangeRef.current = props.onShelfMergeCollectionsChange;
	const onPlayQueueIndexRef = useRef(props.onPlayQueueIndex);
	onPlayQueueIndexRef.current = props.onPlayQueueIndex;
	const onRemoveQueueIndexRef = useRef(props.onRemoveQueueIndex);
	onRemoveQueueIndexRef.current = props.onRemoveQueueIndex;
	const onInsertQueueNextRef = useRef(props.onInsertQueueNext);
	onInsertQueueNextRef.current = props.onInsertQueueNext;
	const depsRef = useRef(props.deps);
	depsRef.current = props.deps;
	const [progressDragging, setProgressDragging] = useState(false);
	const [volumeOpen, setVolumeOpen] = useState(false);
	const [qualityOpen, setQualityOpen] = useState(false);

	const registerNormal = useCallback((id: string) => (el: HTMLButtonElement | null) => {
		normalBtnRefs.current[id] = el;
	}, []);

	useEffect(() => {
		const bar = barRef.current;
		if (!bar || typeof window === "undefined") return;
		injectControlGlassStyle();
		const detachGlass = attachControlGlassNode(bar, { refreshOnResize: true });

		const playButton = playBtnRef.current;
		const modeButton = modeBtnRef.current;
		const modeIcon = modeIconRef.current;
		const normalButtons = Object.values(normalBtnRefs.current).filter((b): b is HTMLButtonElement => !!b);
		const motion = createControlConsoleMotion({
			root: { bar, modeButton, modeIcon, playButton, normalButtons },
			deps: depsRef.current,
		});
		motionRef.current = motion;

		let cancelled = false;
		void motion.init().then(() => {
			if (cancelled) return;
			if (visibleRef.current) motion.reveal(520);
			else motion.setHidden(true);
		});

		const onBarEnter = () => motion.reveal(520);
		const onBarLeave = () => {
			if (!visibleRef.current) motion.setHidden(true);
		};
		bar.addEventListener("pointerenter", onBarEnter);
		bar.addEventListener("pointerleave", onBarLeave);

		const btnBindings: Array<{ el: HTMLElement; kind: "play" | "normal" }> = [];
		if (playButton) btnBindings.push({ el: playButton, kind: "play" });
		for (const nb of normalButtons) btnBindings.push({ el: nb, kind: "normal" });
		if (modeButton) btnBindings.push({ el: modeButton, kind: "normal" });

		const handlers: Array<{ el: HTMLElement; type: string; fn: (e: Event) => void }> = [];
		for (const { el, kind } of btnBindings) {
			const hoverIn = (e: Event) => {
				if ((e as globalThis.PointerEvent).pointerType === "touch") return;
				if (kind === "play") motion.playButtonHover(el, true);
				else motion.normalButtonHover(el, true);
			};
			const hoverOut = () => {
				if (kind === "play") motion.playButtonHover(el, false);
				else motion.normalButtonHover(el, false);
			};
			const pressDown = () => {
				if (kind === "play") motion.playButtonPress(el, true);
				else motion.buttonPress(el, true);
			};
			const release = () => {
				const hovered = typeof el.matches === "function" && el.matches(":hover");
				if (kind === "play") motion.playButtonPress(el, false);
				else motion.buttonPress(el, false);
				motion.buttonRelease(el, { isPlay: kind === "play", hovered });
			};
			const clickPulseFn = () => motion.clickPulse(el, kind);
			el.addEventListener("pointerenter", hoverIn);
			el.addEventListener("pointerleave", hoverOut);
			el.addEventListener("pointercancel", hoverOut);
			el.addEventListener("pointerdown", pressDown);
			el.addEventListener("pointerup", release);
			el.addEventListener("click", clickPulseFn);
			handlers.push(
				{ el, type: "pointerenter", fn: hoverIn as (e: Event) => void },
				{ el, type: "pointerleave", fn: hoverOut as (e: Event) => void },
				{ el, type: "pointercancel", fn: hoverOut as (e: Event) => void },
				{ el, type: "pointerdown", fn: pressDown as (e: Event) => void },
				{ el, type: "pointerup", fn: release as (e: Event) => void },
				{ el, type: "click", fn: clickPulseFn as (e: Event) => void },
			);
		}

		return () => {
			cancelled = true;
			bar.removeEventListener("pointerenter", onBarEnter);
			bar.removeEventListener("pointerleave", onBarLeave);
			for (const h of handlers) h.el.removeEventListener(h.type, h.fn);
			motion.dispose();
			detachGlass();
			motionRef.current = null;
		};
	}, []);

	useEffect(() => {
		progressParticleEmitterRef.current = createProgressDragParticleEmitter();
		return () => {
			progressParticleEmitterRef.current?.dispose();
			progressParticleEmitterRef.current = null;
		};
	}, []);

	useEffect(() => {
		const bar = barRef.current;
		if (!bar) return;
		bar.classList.toggle("visible", !!props.visible);
		bar.classList.toggle("soft-hidden", !props.visible);
	}, [props.visible]);

	const cyclePlayModeStub = useCallback(() => {
		const order: PlaybackMode[] = ["queue", "loop", "single", "shuffle"];
		const current = props.mode ?? "queue";
		const next = order[(order.indexOf(current) + 1) % order.length] ?? "queue";
		onModeChangeRef.current?.(next);
		motionRef.current?.toggleModeButton(next === "loop" ? "repeat" : next);
	}, [props.mode]);

	const toggleFullscreenStub = useCallback(() => {
		onToggleFullscreenRef.current?.();
	}, []);
	const toggleMaximizeStub = useCallback(() => {
		onToggleMaximizeRef.current?.();
	}, []);
	const minimizeStub = useCallback(() => {
		onMinimizeRef.current?.();
	}, []);
	const closeStub = useCallback(() => {
		onCloseRef.current?.();
	}, []);
	const togglePlayStub = useCallback(() => {
		onTogglePlayRef.current?.();
	}, []);
	const previousStub = useCallback(() => {
		onPreviousRef.current?.();
	}, []);
	const nextStub = useCallback(() => {
		onNextRef.current?.();
	}, []);
	const queueStub = useCallback(() => {
		onQueueRef.current?.();
	}, []);
	const lyricsStub = useCallback(() => {
		onLyricsRef.current?.();
	}, []);
	const lyricSourceMode = props.lyricSourceMode === "custom" ? "custom" : "original";
	const shelfMode = props.shelfMode ?? "side";
	const shelfCameraMode = props.shelfCameraMode ?? "static";
	const shelfPresence = props.shelfPresence ?? "always";
	const shelfShowPodcasts = props.shelfShowPodcasts !== false;
	const shelfMergeCollections = props.shelfMergeCollections === true;
	const chooseOriginalLyrics = useCallback(() => {
		onLyricSourceChangeRef.current?.("original");
	}, []);
	const chooseCustomLyrics = useCallback(() => {
		onLyricSourceChangeRef.current?.("custom");
	}, []);
	const noticeStub = useCallback((message: string) => {
		onNoticeRef.current?.(message);
	}, []);
	const positionMs = props.positionMs ?? 0;
	const durationMs = props.durationMs ?? 0;
	const seekFromPointer = useCallback((clientX: number, target: HTMLDivElement) => {
		if (durationMs <= 0) return;
		const rect = target.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		onSeekRef.current?.(Math.floor(durationMs * ratio));
	}, [durationMs]);
	const emitProgressDragParticles = useCallback((clientX: number, target: HTMLDivElement) => {
		const rect = target.getBoundingClientRect();
		progressParticleEmitterRef.current?.emit(clientX, rect.top + rect.height / 2);
	}, []);
	const seekStub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setProgressDragging(true);
		seekFromPointer(event.clientX, event.currentTarget);
		emitProgressDragParticles(event.clientX, event.currentTarget);
	}, [emitProgressDragParticles, seekFromPointer]);
	const seekMoveStub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		if (!progressDragging) return;
		seekFromPointer(event.clientX, event.currentTarget);
		emitProgressDragParticles(event.clientX, event.currentTarget);
	}, [emitProgressDragParticles, progressDragging, seekFromPointer]);
	const seekEndStub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		setProgressDragging(false);
		event.currentTarget.releasePointerCapture?.(event.pointerId);
	}, []);
	const volume = Math.max(0, Math.min(1, props.volume ?? 0.84));
	const muted = !!props.muted;
	const volumePct = Math.round((muted ? 0 : volume) * 100);
	const quality = playbackQualityOption(props.playbackQuality);
	const currentLiked = props.currentLiked === true;
	const currentLikeBusy = props.currentLikeBusy === true;

	const progressPct = durationMs > 0 ? Math.max(0, Math.min(100, (positionMs / durationMs) * 100)) : 0;
	const formatTime = (ms: number): string => {
		const total = Math.max(0, Math.floor(ms / 1000));
		const m = Math.floor(total / 60);
		const s = total % 60;
		return `${m}:${s.toString().padStart(2, "0")}`;
	};

	return (
		<div id="bottom-bar" className={props.visible ? "visible" : "soft-hidden"} ref={barRef}>
			<div id="progress-bar" className={progressDragging ? "is-dragging" : ""} onPointerDown={seekStub} onPointerMove={seekMoveStub} onPointerUp={seekEndStub} onPointerCancel={seekEndStub}>
				<div id="progress-fill" style={{ width: `${progressPct}%` }} />
				<div id="progress-thumb" aria-hidden="true" style={{ left: `${progressPct}%` }} />
			</div>
			<div id="controls">
				<div className="control-cluster actions">
					<div className="control-track">
						<div id="control-cover" className={props.currentCoverUrl ? "control-cover has-cover" : "control-cover cover-empty"} style={props.currentCoverUrl ? { backgroundImage: `url(${props.currentCoverUrl})` } : undefined} aria-hidden="true" />
						<div className="control-meta">
							<div id="control-title" className="control-title">{props.currentTitle ?? ""}</div>
							<div id="control-artist" className="control-artist">{props.currentArtist ?? ""}</div>
						</div>
					</div>
					<div id="quality-control" className="quality-control">
						<button id="quality-btn" className={qualityOpen ? "ctrl-btn quality-pill active" : "ctrl-btn quality-pill"} ref={registerNormal("quality-btn")} type="button" title={`音质: ${quality.label}`} aria-label="音质" onClick={() => setQualityOpen((open) => !open)}>
							<span id="quality-btn-label">{quality.short}</span>
						</button>
						<div className={qualityOpen ? "quality-popover show" : "quality-popover"} onClick={(event) => event.stopPropagation()}>
							{PLAYBACK_QUALITY_OPTIONS.map((option) => (
								<button
									key={option.value}
									className={option.value === quality.value ? "quality-option active" : "quality-option"}
									type="button"
									data-quality={option.value}
									data-svip={option.svip ? "1" : undefined}
									title={option.label}
									onClick={() => {
										setQualityOpen(false);
										onQualityChangeRef.current?.(option.value);
									}}
								>
									<span>{option.label}</span>
									<small>{option.detail}</small>
								</button>
							))}
						</div>
					</div>
					<button
						id="heart-btn"
						ref={registerNormal("heart-btn")}
						className={`ctrl-btn${currentLiked ? " liked active" : ""}${currentLikeBusy ? " busy" : ""}`}
						type="button"
						title={currentLiked ? "取消红心" : "红心喜欢"}
						aria-label={currentLiked ? "取消红心" : "红心喜欢"}
						aria-pressed={currentLiked}
						disabled={currentLikeBusy}
						onClick={() => onToggleLikeCurrentRef.current?.()}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="21" height="21" fill={currentLiked ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2}><path d="M20.8 4.6c-1.7-1.7-4.5-1.7-6.2 0L12 7.2 9.4 4.6c-1.7-1.7-4.5-1.7-6.2 0s-1.7 4.5 0 6.2L12 19.6l8.8-8.8c1.7-1.7 1.7-4.5 0-6.2Z" /></svg>
					</button>
					<button id="collect-btn" ref={registerNormal("collect-btn")} className="ctrl-btn" type="button" title="收藏到歌单" aria-label="收藏到歌单" onClick={() => onCollectCurrentRef.current?.()}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 5v14" /><path d="M5 12h14" /></svg>
					</button>
				</div>
				<div className="control-cluster transport">
					<button id="play-mode-btn" ref={modeBtnRef} className="ctrl-btn" type="button" onClick={cyclePlayModeStub} title={`播放顺序：${props.mode ?? "queue"}`}>
						<svg id="play-mode-icon" ref={modeIconRef} width="19" height="19" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
					</button>
					<button id="prev-btn" ref={registerNormal("prev-btn")} className="ctrl-btn" type="button" title="上一首" aria-label="上一首" onClick={previousStub}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor"><path d="M6 5h2v14H6zM9 12l9-7v14z" /></svg>
					</button>
					<button id="play-btn" ref={playBtnRef} className="ctrl-btn" type="button" title="播放/暂停" aria-label="播放/暂停" data-playing={props.isPlaying ? "true" : "false"} onClick={togglePlayStub}>
						<svg id="play-icon" viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" fill="currentColor">{props.isPlaying ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}</svg>
					</button>
					<button id="next-btn" ref={registerNormal("next-btn")} className="ctrl-btn" type="button" title="下一首" aria-label="下一首" onClick={nextStub}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor"><path d="M16 5h2v14h-2zM6 5l9 7-9 7z" /></svg>
					</button>
					<button id="mini-queue-btn" ref={registerNormal("mini-queue-btn")} className={props.miniQueueOpen ? "ctrl-btn active" : "ctrl-btn"} type="button" title="当前队列" aria-label="当前队列" onClick={queueStub}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth={2}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>
					</button>
					<div id="mini-queue-popover" className={props.miniQueueOpen ? "mini-queue-popover show" : "mini-queue-popover"} onClick={(event) => event.stopPropagation()}>
						<div className="mini-queue-head">
							<div>
								<div className="mini-queue-title">当前队列</div>
								<div id="mini-queue-count" className="mini-queue-count">{props.queue?.length ?? 0} 首</div>
							</div>
						</div>
						<div id="mini-queue-list" className="mini-queue-list">
							{!props.queue || props.queue.length === 0 ? (
								<div className="mini-queue-empty">队列为空</div>
							) : props.queue.map((track, index) => {
								const now = !!props.currentTrack && props.currentTrack.provider === track.provider && props.currentTrack.id === track.id;
								return (
									<div className={now ? "mini-queue-item now" : "mini-queue-item"} key={`${track.provider}-${track.id}-${index}`}>
										<button className="mini-queue-main" type="button" onClick={() => onPlayQueueIndexRef.current?.(index)}>
											{track.coverUrl ? <img src={track.coverUrl} alt="" /> : <span className="mini-queue-cover" />}
											<span className="mini-queue-info">
												<span className="mini-queue-name">{track.title}</span>
												<span className="mini-queue-sub">{track.artists.join(" / ") || "未知艺人"}</span>
											</span>
										</button>
										<button className="mini-queue-remove mini-queue-next" type="button" title="下一首播放" onClick={() => onInsertQueueNextRef.current?.(index)}>+</button>
										<button className="mini-queue-remove" type="button" title="移出队列" onClick={() => onRemoveQueueIndexRef.current?.(index)}>×</button>
									</div>
								);
							})}
						</div>
					</div>
				</div>
				<div className="control-cluster modes">
					<div id="volume-control" className="volume-control">
						<button id="volume-btn" className={volumeOpen ? "ctrl-btn active" : "ctrl-btn"} ref={registerNormal("volume-btn")} type="button" title="音量" aria-label="音量" onClick={() => setVolumeOpen((open) => !open)} onDoubleClick={() => onToggleMuteRef.current?.()}>
							<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}><path d="M11 5 6 9H3v6h3l5 4V5Z" />{volumePct > 0 ? <path d="M15.5 8.5a5 5 0 0 1 0 7" /> : <path d="M16 9l5 5M21 9l-5 5" />}</svg>
						</button>
						<div className={volumeOpen ? "volume-popover show" : "volume-popover"}>
							<input id="volume-slider" type="range" min="0" max="100" value={volumePct} onChange={(event) => onVolumeChangeRef.current?.(Number(event.currentTarget.value) / 100)} aria-label="音量" />
							<div id="volume-value">{volumePct}%</div>
						</div>
					</div>
					<button className="ctrl-btn lyrics-toggle-btn" ref={registerNormal("lyrics-toggle-btn")} type="button" title="歌词" aria-label="歌词" onClick={lyricsStub}>
						<span className="lyrics-word-icon">词</span>
					</button>
					<div className="lyric-source-row console-lyric-source-row">
						<div className="fx-seg lyric-source-seg" id="lyric-source-seg">
							<button id="lyric-source-original" type="button" className={lyricSourceMode === "original" ? "active" : ""} onClick={chooseOriginalLyrics}>原词</button>
							<button id="lyric-source-custom" type="button" className={`${lyricSourceMode === "custom" ? "active" : ""}${props.hasCustomLyric ? " has-custom" : ""}`.trim()} onClick={chooseCustomLyrics}>自定义</button>
						</div>
					</div>
					<div className="console-shelf-controls" aria-label="3D 歌单架">
						<div className="fx-seg console-shelf-seg" id="shelf-seg">
							<button type="button" data-shelf="off" className={shelfMode === "off" ? "active" : ""} onClick={() => onShelfModeChangeRef.current?.("off")}>关</button>
							<button type="button" data-shelf="side" className={shelfMode === "side" ? "active" : ""} onClick={() => onShelfModeChangeRef.current?.("side")}>侧</button>
							<button type="button" data-shelf="stage" className={shelfMode === "stage" ? "active" : ""} onClick={() => onShelfModeChangeRef.current?.("stage")}>台</button>
						</div>
						<div className="fx-seg console-shelf-seg compact" id="shelf-camera-seg">
							<button type="button" data-shelf-camera="static" className={shelfCameraMode === "static" ? "active" : ""} onClick={() => onShelfCameraModeChangeRef.current?.("static")}>静</button>
							<button type="button" data-shelf-camera="dynamic" className={shelfCameraMode === "dynamic" ? "active" : ""} onClick={() => onShelfCameraModeChangeRef.current?.("dynamic")}>动</button>
						</div>
						<div className="fx-seg console-shelf-seg compact" id="shelf-presence-seg">
							<button type="button" data-shelf-presence="always" className={shelfPresence === "always" ? "active" : ""} onClick={() => onShelfPresenceChangeRef.current?.("always")}>常</button>
							<button type="button" data-shelf-presence="auto" className={shelfPresence === "auto" ? "active" : ""} onClick={() => onShelfPresenceChangeRef.current?.("auto")}>隐</button>
						</div>
						<div className="fx-seg console-shelf-seg compact shelf-content-seg" id="shelf-content-seg">
							<button
								type="button"
								data-shelf-content="podcasts"
								className={shelfShowPodcasts ? "active" : ""}
								title="关闭后 3D 歌单架不显示播客收藏"
								onClick={() => onShelfShowPodcastsChangeRef.current?.(!shelfShowPodcasts)}
							>播</button>
							<button
								type="button"
								data-shelf-content="merge"
								className={shelfMergeCollections ? "active" : ""}
								title="开启后我的歌单与收藏歌单按一条线连续滚动"
								onClick={() => onShelfMergeCollectionsChangeRef.current?.(!shelfMergeCollections)}
							>合</button>
						</div>
					</div>
					<button
						className="ctrl-btn fullscreen-toggle-btn"
						ref={registerNormal("fullscreen-toggle-btn")}
						type="button"
						onClick={toggleFullscreenStub}
						title="全屏 (F)"
						aria-label="全屏"
					>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
					</button>
					<div className="console-host-chrome">
						<button className="ctrl-btn console-host-minimize" type="button" onClick={minimizeStub} aria-label="最小化" title="最小化">
							<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2}><path d="M5 12h14" /></svg>
						</button>
						<button className="ctrl-btn console-host-maximize" type="button" onClick={toggleMaximizeStub} aria-label="最大化" title="最大化">
							<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2}><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
						</button>
						<button className="ctrl-btn console-host-close" type="button" onClick={closeStub} aria-label="关闭" title="关闭">
							<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
						</button>
					</div>
					<div id="time-display">{formatTime(positionMs)} / {formatTime(durationMs)}</div>
				</div>
			</div>
		</div>
	);
}

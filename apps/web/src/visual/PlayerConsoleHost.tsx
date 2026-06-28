import { useCallback, useEffect, useRef, type ReactElement } from "react";
import {
	attachControlGlassNode,
	createControlConsoleMotion,
	injectControlGlassStyle,
	type ControlConsoleMotion,
} from "@mineradio/visual-engine";

export interface PlayerConsoleHostProps {
	visible?: boolean;
	onReveal?: () => void;
	onMinimize?: () => void;
	onToggleMaximize?: () => void;
	onToggleFullscreen?: () => void;
	onClose?: () => void;
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

	visibleRef.current = !!props.visible;
	const onMinimizeRef = useRef(props.onMinimize);
	onMinimizeRef.current = props.onMinimize;
	const onToggleMaximizeRef = useRef(props.onToggleMaximize);
	onToggleMaximizeRef.current = props.onToggleMaximize;
	const onToggleFullscreenRef = useRef(props.onToggleFullscreen);
	onToggleFullscreenRef.current = props.onToggleFullscreen;
	const onCloseRef = useRef(props.onClose);
	onCloseRef.current = props.onClose;
	const depsRef = useRef(props.deps);
	depsRef.current = props.deps;

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
				if ((e as PointerEvent).pointerType === "touch") return;
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
		const bar = barRef.current;
		if (!bar) return;
		bar.classList.toggle("visible", !!props.visible);
		bar.classList.toggle("soft-hidden", !props.visible);
	}, [props.visible]);

	const cyclePlayModeStub = useCallback(() => {
		motionRef.current?.toggleModeButton("shuffle");
	}, []);

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

	return (
		<div id="bottom-bar" className={props.visible ? "visible" : "soft-hidden"} ref={barRef}>
			<div id="progress-bar">
				<div id="progress-fill" />
			</div>
			<div id="controls">
				<div className="control-cluster actions">
					<div className="control-track">
						<div id="control-cover" className="control-cover cover-empty" aria-hidden="true" />
						<div className="control-meta">
							<div id="control-title" className="control-title" />
							<div id="control-artist" className="control-artist" />
						</div>
					</div>
					<button id="heart-btn" ref={registerNormal("heart-btn")} className="ctrl-btn" type="button" title="红心喜欢" aria-label="红心喜欢">
						<svg viewBox="0 0 24 24" aria-hidden="true" width="21" height="21" />
					</button>
					<button id="collect-btn" ref={registerNormal("collect-btn")} className="ctrl-btn" type="button" title="收藏到歌单" aria-label="收藏到歌单">
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} />
					</button>
				</div>
				<div className="control-cluster transport">
					<button id="play-mode-btn" ref={modeBtnRef} className="ctrl-btn" type="button" onClick={cyclePlayModeStub} title="播放顺序">
						<svg id="play-mode-icon" ref={modeIconRef} width="19" height="19" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" />
					</button>
					<button id="prev-btn" ref={registerNormal("prev-btn")} className="ctrl-btn" type="button" title="上一首" aria-label="上一首">
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor" />
					</button>
					<button id="play-btn" ref={playBtnRef} className="ctrl-btn" type="button" title="播放/暂停" aria-label="播放/暂停">
						<svg id="play-icon" viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" fill="currentColor" />
					</button>
					<button id="next-btn" ref={registerNormal("next-btn")} className="ctrl-btn" type="button" title="下一首" aria-label="下一首">
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor" />
					</button>
					<button id="mini-queue-btn" ref={registerNormal("mini-queue-btn")} className="ctrl-btn" type="button" title="当前队列" aria-label="当前队列">
						<svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth={2} />
					</button>
				</div>
				<div className="control-cluster modes">
					<button className="ctrl-btn lyrics-toggle-btn" ref={registerNormal("lyrics-toggle-btn")} type="button" title="歌词" aria-label="歌词">
						<span className="lyrics-word-icon">词</span>
					</button>
					<button
						className="ctrl-btn fullscreen-toggle-btn"
						ref={registerNormal("fullscreen-toggle-btn")}
						type="button"
						onClick={toggleFullscreenStub}
						title="全屏 (F)"
						aria-label="全屏"
					>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} />
					</button>
					<div className="console-host-chrome">
						<button className="ctrl-btn console-host-minimize" type="button" onClick={minimizeStub} aria-label="最小化" title="最小化">
							<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} />
						</button>
						<button className="ctrl-btn console-host-maximize" type="button" onClick={toggleMaximizeStub} aria-label="最大化" title="最大化">
							<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} />
						</button>
						<button className="ctrl-btn console-host-close" type="button" onClick={closeStub} aria-label="关闭" title="关闭">
							<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} />
						</button>
					</div>
					<div id="time-display">0:00 / 0:00</div>
				</div>
			</div>
		</div>
	);
}

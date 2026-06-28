import { injectSplashStyle } from "./splash-style";
import { createSplashWebgl } from "./splash-webgl";
import { createSplashCanvas } from "./splash-canvas";
import { createIntroSoundPlayer, type IntroSoundPlayer } from "./intro-sound";

export type SplashEngine = {
	markReadyToEnter(): void;
	dismiss(): void;
	dispose(): void;
};

export type SplashEngineOptions = {
	reducedMotion?: boolean;
	onReadyToEnter?: () => void;
	onDismissed?: () => void;
	audioContext?: AudioContext;
	introSound?: IntroSoundPlayer;
};

const SPLASH_DOM = `
  <canvas id="splash-canvas"></canvas>
  <div class="splash-bg-noise"></div>
  <div class="splash-content">
    <div class="splash-wordmark" id="splash-wordmark" aria-label="Mineradio">
      <span class="splash-word-mine">Mine</span>
      <span class="splash-word-radio" aria-label="radio">rad<span class="splash-word-i" aria-hidden="true"></span><span class="splash-word-o">o</span></span>
    </div>
    <div class="splash-signal-line"></div>
    <div class="splash-sub">private visual radio</div>
    <div class="splash-enter" aria-hidden="true">点击进入</div>
  </div>
`;

export function createSplashEngine(root: HTMLElement, opts: SplashEngineOptions = {}): SplashEngine {
	injectSplashStyle(document.head as HTMLHeadElement);

	const splashEl = document.createElement("div");
	splashEl.id = "splash";
	splashEl.innerHTML = SPLASH_DOM;
	root.appendChild(splashEl);

	document.body.classList.add("splash-active");

	const canvas = splashEl.querySelector("#splash-canvas") as HTMLCanvasElement | null;
	if (!canvas) {
		throw new Error("splash-canvas element missing from splash DOM");
	}

	const reducedMotion = opts.reducedMotion ?? false;
	const startedAt = performance.now();
	let animating = true;
	let rafId: number | null = null;
	let readyTimer: ReturnType<typeof setTimeout> | null = null;
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const introSound = opts.introSound ?? createIntroSoundPlayer({
		audioContext: opts.audioContext,
	});
	introSound.armFallback();

	const glHandler = reducedMotion ? null : createSplashWebgl(canvas);
	const useWebgl = !!glHandler && glHandler.ok;
	const canvasHandler = useWebgl ? null : createSplashCanvas(canvas, { reducedMotion });

	function resize() {
		const w = typeof window !== "undefined" ? window.innerWidth : 0;
		const h = typeof window !== "undefined" ? window.innerHeight : 0;
		if (glHandler && glHandler.ok) glHandler.resize(Math.max(1, Math.floor(w * Math.min(1.6, Math.max(1, window.devicePixelRatio || 1)))), Math.max(1, Math.floor(h * Math.min(1.6, Math.max(1, window.devicePixelRatio || 1)))));
		else if (canvasHandler) canvasHandler.resize(w, h);
	}

	resize();
	if (typeof window !== "undefined") {
		window.addEventListener("resize", resize);
	}

	function frame() {
		if (!animating || disposed) return;
		const elapsed = (performance.now() - startedAt) / 1000;
		if (useWebgl && glHandler) glHandler.render(elapsed);
		else if (canvasHandler) canvasHandler.render(elapsed);
		rafId = requestAnimationFrame(frame);
	}
	rafId = requestAnimationFrame(frame);

	function markReadyToEnter() {
		if (disposed || !splashEl || splashEl.classList.contains("hide") || splashEl.classList.contains("exiting")) return;
		splashEl.classList.add("ready");
		splashEl.setAttribute("role", "button");
		splashEl.setAttribute("tabindex", "0");
		splashEl.setAttribute("aria-label", "点击进入 Mineradio");
		readyTimer = null;
		opts.onReadyToEnter?.();
	}

	const readyDelay = reducedMotion ? 900 : 5000;
	if (reducedMotion) {
		splashEl.classList.add("reduce-motion");
	}
	readyTimer = setTimeout(markReadyToEnter, readyDelay);

	function requestSplashEnter() {
		if (!document.body.classList.contains("splash-active")) return;
		introSound.play();
		if (splashEl.classList.contains("ready")) dismiss();
	}

	function onSplashClick() {
		requestSplashEnter();
	}

	function onDocumentKeydown(event: KeyboardEvent) {
		if (!document.body.classList.contains("splash-active")) return;
		if (event.key !== "Enter" && event.code !== "Space") return;
		event.preventDefault();
		requestSplashEnter();
	}

	splashEl.addEventListener("click", onSplashClick);
	document.addEventListener("keydown", onDocumentKeydown);

	if (!reducedMotion) {
		introSound.play();
	}

	function cleanupReveal() {
		if (typeof window !== "undefined" && splashEl.parentNode) splashEl.style.display = "none";
		document.body.classList.remove("splash-active");
		document.body.classList.remove("splash-revealing");
		animating = false;
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		opts.onDismissed?.();
	}

	function dismiss() {
		if (disposed || !splashEl || splashEl.classList.contains("hide") || splashEl.classList.contains("exiting")) return;
		if (readyTimer) {
			clearTimeout(readyTimer);
			readyTimer = null;
		}
		splashEl.classList.remove("ready");
		document.body.classList.add("splash-revealing");
		splashEl.classList.add("exiting");

		const content = splashEl.querySelector(".splash-content") as HTMLElement | null;
		if (content) {
			content.style.transition = "opacity 680ms cubic-bezier(.22,1,.36,1), transform 980ms cubic-bezier(.22,1,.36,1)";
			content.style.opacity = "0";
			content.style.transform = "translateY(-14px) scale(.986)";
		}

		if (dismissTimer) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			splashEl.classList.add("hide");
			cleanupReveal();
		}, 1180);
	}

	return {
		markReadyToEnter,
		dismiss,
		dispose() {
			if (disposed) return;
			disposed = true;
			animating = false;
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			if (readyTimer) {
				clearTimeout(readyTimer);
				readyTimer = null;
			}
			if (dismissTimer) {
				clearTimeout(dismissTimer);
				dismissTimer = null;
			}
			if (typeof window !== "undefined") {
				window.removeEventListener("resize", resize);
			}
			splashEl.removeEventListener("click", onSplashClick);
			document.removeEventListener("keydown", onDocumentKeydown);
			glHandler?.dispose();
			canvasHandler?.dispose();
			introSound.dispose();
			document.body.classList.remove("splash-active");
			document.body.classList.remove("splash-revealing");
			if (splashEl.parentNode) splashEl.parentNode.removeChild(splashEl);
		},
		};
	}

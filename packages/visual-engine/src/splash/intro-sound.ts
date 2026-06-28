// Ported verbatim from baseline `public/index.html` `playMineradioIntroSound` (L25964-26041)
// and `armSplashSoundFallback` (L26042-26052). Constants are byte-equal baseline values; do not
// "creatively" rewrite — this is a fragile Web Audio graph (gain ramps, filter freq ramps,
// noise buffer decay) and the visual engine AGENTS.md locks baseline-derived audio as
// byte-equal.

export interface IntroSoundPlayer {
	/** Plays the intro sound once. Subsequent calls are no-ops after the first successful play. */
	play(): boolean;
	/** Arms pointerdown/keydown unlock handlers as an autoplay-policy fallback. Idempotent. */
	armFallback(): void;
	/** Cancels any armed fallback listeners and forgets a shared AudioContext if owned. */
	dispose(): void;
	/** True once the intro sound has actually started. */
	hasPlayed(): boolean;
}

export interface IntroSoundPlayerOptions {
	/** Inject a shared AudioContext (e.g. the visual-engine AudioReactivity host's). Optional. */
	audioContext?: AudioContext;
	/** Close a player-created AudioContext on dispose. Baseline keeps splashAudioCtx alive. */
	closeOwnedAudioContextOnDispose?: boolean;
	/** Provide your own document/pointer API surface for tests. Optional. */
	document?: DocumentLike | null;
	/** Provide your own window surface for tests (for AudioContextCtor lookup). Optional. */
	window?: WindowLike | null;
}

export type AudioContextCtor = new () => AudioContext;

export interface WindowLike {
	AudioContext?: AudioContextCtor;
	webkitAudioContext?: AudioContextCtor;
	addEventListener?(type: string, listener: EventListenerOrEventListenerObject, useCapture?: boolean): void;
	removeEventListener?(type: string, listener: EventListenerOrEventListenerObject, useCapture?: boolean): void;
}

export interface DocumentLike {
	addEventListener?(type: string, listener: (event: Event) => void, useCapture?: boolean): void;
	removeEventListener?(type: string, listener: (event: Event) => void, useCapture?: boolean): void;
}

const FALLBACK_USE_CAPTURE = true;

export function createIntroSoundPlayer(opts: IntroSoundPlayerOptions = {}): IntroSoundPlayer {
	const doc = (opts.document ?? (typeof document !== "undefined" ? document : null)) as DocumentLike | null;
	const win = (opts.window ?? (typeof window !== "undefined" ? window : null)) as WindowLike | null;
	let sharedCtx = opts.audioContext ?? null;
	let ownsCtx = false;
	let played = false;
	let fallbackArmed = false;
	let fallbackUnlocked = false;
	let fallbackUnlock: ((event: Event) => void) | null = null;

	function resolveAudioContextCtor(): AudioContextCtor | null {
		if (!win) return null;
		return win.AudioContext ?? win.webkitAudioContext ?? null;
	}

	function playImpl(): boolean {
		if (played) return true;
		const Ctor = resolveAudioContextCtor();
		if (!sharedCtx && !Ctor) return false;
		try {
			if (!sharedCtx) {
				if (!Ctor) return false;
				sharedCtx = new Ctor();
				ownsCtx = true;
			}
			const ctx = sharedCtx;
			if (ctx.state === "suspended" && typeof ctx.resume === "function") {
				ctx.resume()
					.then(() => {
						if (!played) playImpl();
					})
					.catch(() => {
						void 0;
					});
				if (ctx.state === "suspended") return false;
			}
			played = true;
			scheduleIntroGraph(ctx);
			return true;
		} catch {
			return false;
		}
	}

	function scheduleIntroGraph(ctx: AudioContext): void {
		const now = ctx.currentTime + 0.02;
		const master = ctx.createGain();
		master.gain.setValueAtTime(0.0001, now);
		master.gain.exponentialRampToValueAtTime(0.062, now + 0.16);
		master.gain.exponentialRampToValueAtTime(0.040, now + 3.35);
		master.gain.exponentialRampToValueAtTime(0.0001, now + 5.28);
		master.connect(ctx.destination);

		const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2.45), ctx.sampleRate);
		const data = noiseBuffer.getChannelData(0);
		for (let i = 0; i < data.length; i++) {
			const tail = 1 - i / data.length;
			data[i] = (Math.random() * 2 - 1) * Math.pow(tail, 1.35);
		}
		const noise = ctx.createBufferSource();
		const noiseGain = ctx.createGain();
		const noiseFilter = ctx.createBiquadFilter();
		noise.buffer = noiseBuffer;
		noiseFilter.type = "bandpass";
		noiseFilter.frequency.setValueAtTime(720, now);
		noiseFilter.frequency.exponentialRampToValueAtTime(2400, now + 2.2);
		noiseFilter.Q.setValueAtTime(0.72, now);
		noiseGain.gain.setValueAtTime(0.0001, now);
		noiseGain.gain.exponentialRampToValueAtTime(0.020, now + 0.12);
		noiseGain.gain.exponentialRampToValueAtTime(0.010, now + 1.60);
		noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.42);
		noise.connect(noiseFilter);
		noiseFilter.connect(noiseGain);
		noiseGain.connect(master);
		noise.start(now);
		noise.stop(now + 2.46);

		const low = ctx.createOscillator();
		const lowGain = ctx.createGain();
		low.type = "sine";
		low.frequency.setValueAtTime(86, now + 0.18);
		low.frequency.exponentialRampToValueAtTime(43, now + 1.18);
		lowGain.gain.setValueAtTime(0.0001, now + 0.12);
		lowGain.gain.exponentialRampToValueAtTime(0.032, now + 0.30);
		lowGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.34);
		low.connect(lowGain);
		lowGain.connect(master);
		low.start(now + 0.12);
		low.stop(now + 1.40);

		function softTone(type: OscillatorType, f0: number, f1: number, startAt: number, dur: number, peak: number): void {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			const filter = ctx.createBiquadFilter();
			osc.type = type;
			osc.frequency.setValueAtTime(f0, now + startAt);
			osc.frequency.exponentialRampToValueAtTime(f1, now + startAt + dur * 0.72);
			filter.type = "lowpass";
			filter.frequency.setValueAtTime(3400, now + startAt);
			gain.gain.setValueAtTime(0.0001, now + startAt);
			gain.gain.exponentialRampToValueAtTime(peak, now + startAt + 0.08);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + startAt + dur);
			osc.connect(filter);
			filter.connect(gain);
			gain.connect(master);
			osc.start(now + startAt);
			osc.stop(now + startAt + dur + 0.04);
		}
		softTone("triangle", 440, 660, 1.05, 0.72, 0.018);
		softTone("sine", 880, 1320, 2.1, 0.86, 0.013);
		softTone("triangle", 1180, 1760, 2.72, 0.52, 0.01);
		softTone("triangle", 660, 1180, 3.32, 0.82, 0.014);
		softTone("sine", 1760, 1040, 3.64, 0.46, 0.01);
	}

	function armFallback(): void {
		if (fallbackArmed) return;
		fallbackArmed = true;
		if (!doc || !doc.addEventListener) return;
		const unlock = (event: Event): void => {
			void event;
			if (fallbackUnlocked) return;
			if (!played) playImpl();
			fallbackUnlocked = true;
			doc.removeEventListener?.("pointerdown", unlock, FALLBACK_USE_CAPTURE);
			doc.removeEventListener?.("keydown", unlock, FALLBACK_USE_CAPTURE);
			if (win && win.removeEventListener) {
				win.removeEventListener("pointerdown", unlock as EventListenerOrEventListenerObject, FALLBACK_USE_CAPTURE);
			}
			fallbackUnlock = null;
		};
		fallbackUnlock = unlock;
		doc.addEventListener("pointerdown", unlock, FALLBACK_USE_CAPTURE);
		doc.addEventListener("keydown", unlock, FALLBACK_USE_CAPTURE);
	}

	function dispose(): void {
		if (fallbackUnlock) {
			doc?.removeEventListener?.("pointerdown", fallbackUnlock, FALLBACK_USE_CAPTURE);
			doc?.removeEventListener?.("keydown", fallbackUnlock, FALLBACK_USE_CAPTURE);
			win?.removeEventListener?.("pointerdown", fallbackUnlock as EventListenerOrEventListenerObject, FALLBACK_USE_CAPTURE);
			fallbackUnlock = null;
		}
		fallbackArmed = false;
		if (opts.closeOwnedAudioContextOnDispose && ownsCtx && sharedCtx) {
			try {
				sharedCtx.close();
			} catch {
				// best effort; ignore double-close
			}
		}
		ownsCtx = false;
	}

	return {
		play(): boolean {
			return playImpl();
		},
		armFallback,
		dispose,
		hasPlayed(): boolean {
			return played;
		},
	};
}

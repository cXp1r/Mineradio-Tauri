import type {
	AudioReactivityEngine,
	AudioSnapshot,
	FrameContext,
	HomeVisual,
	RuntimeUniforms,
} from "@mineradio/visual-engine";
import type { ManagedAudioFrameSourceDebugState } from "./useVisualEngine";

type DebugFrameSource = {
	getDebugState?: () => ManagedAudioFrameSourceDebugState;
};

type VisualAudioDebuggerInput = {
	frameSource: DebugFrameSource;
	audioEngine: AudioReactivityEngine;
	homeVisual: HomeVisual;
	getAudioElement: () => HTMLAudioElement | null;
	getHomeActive: () => boolean;
	getPlaybackActive: () => boolean;
	getCoverUrl: () => string;
	getFps: () => number;
};

type UniformContainerLike = Record<string, { value: unknown } | undefined>;

type VisualAudioDebugSample = {
	atMs: number;
	audioElement: {
		ready: boolean;
		paused: boolean;
		ended: boolean;
		currentTime: number;
	};
	frameSource: ManagedAudioFrameSourceDebugState | null;
	snapshot: AudioSnapshot;
	runtimeUniforms: Record<string, number>;
	materialUniforms: Record<string, number>;
	visual: {
		fps: number;
		homeActive: boolean;
		playbackActive: boolean;
		coverUrlPresent: boolean;
		preset: number;
		fxPreset: number;
		fxIntensity: number;
		fxBackCover: boolean;
		fieldVisible: boolean;
		bloomVisible: boolean;
	};
	hints: string[];
};

type VisualAudioDebugController = {
	tick(ctx: FrameContext): void;
	dispose(): void;
};

type WindowWithVisualAudioDebug = Window & typeof globalThis & {
	__mineradioVisualAudioDebug?: {
		enable: () => void;
		disable: () => void;
		toggle: () => void;
		sample: () => VisualAudioDebugSample | null;
		isEnabled: () => boolean;
	};
};

const STORAGE_KEY = "mineradio.visualAudioDebug";
const SAMPLE_INTERVAL_MS = 250;
const LOG_INTERVAL_MS = 1000;
const NUMBER_UNIFORMS = ["uTime", "uBass", "uMid", "uTreble", "uEnergy", "uBeat", "uBurstAmt", "uPreset", "uAlpha", "uHasCover"];

function readDebugEnabledFromUrl(): boolean | null {
	if (typeof window === "undefined") return null;
	try {
		const params = new URLSearchParams(window.location.search);
		const raw = params.get("visualAudioDebug") ?? params.get("audioDebug");
		if (raw === null) return null;
		return raw !== "0" && raw.toLowerCase() !== "false" && raw.toLowerCase() !== "off";
	} catch {
		return null;
	}
}

function readDebugEnabledFromStorage(): boolean {
	if (typeof window === "undefined") return false;
	try {
		const raw = window.localStorage?.getItem(STORAGE_KEY);
		return raw === "1" || raw === "true" || raw === "on";
	} catch {
		return false;
	}
}

function writeDebugEnabledToStorage(enabled: boolean): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage?.setItem(STORAGE_KEY, enabled ? "1" : "0");
	} catch {
	}
}

function initialDebugEnabled(): boolean {
	const urlValue = readDebugEnabledFromUrl();
	return urlValue ?? readDebugEnabledFromStorage();
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNumberUniforms(uniforms: UniformContainerLike): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of NUMBER_UNIFORMS) {
		out[key] = finiteNumber(uniforms[key]?.value);
	}
	return out;
}

function runtimeUniformRecord(uniforms: RuntimeUniforms): UniformContainerLike {
	return uniforms as unknown as UniformContainerLike;
}

function fixed(value: number, digits = 3): string {
	if (!Number.isFinite(value)) return "0.000";
	return value.toFixed(digits);
}

function compactNumberMap(values: Record<string, number>, keys: string[]): string {
	return keys.map((key) => `${key}=${fixed(values[key] ?? 0)}`).join(" ");
}

function buildHints(sample: Omit<VisualAudioDebugSample, "hints">): string[] {
	const hints: string[] = [];
	const frame = sample.frameSource;
	const audioInputAlive = !!frame && frame.playing && (frame.mainFreqPeak > 0.01 || frame.mainTimeRms > 0.005);
	const snapshotAlive =
		sample.snapshot.bass > 0.02 ||
		sample.snapshot.mid > 0.02 ||
		sample.snapshot.treble > 0.02 ||
		sample.snapshot.energy > 0.02 ||
		sample.snapshot.beatPulse > 0.02;
	const uniformsAlive =
		(sample.materialUniforms.uBass ?? 0) > 0.02 ||
		(sample.materialUniforms.uEnergy ?? 0) > 0.02 ||
		(sample.materialUniforms.uBeat ?? 0) > 0.02;

	if (!sample.audioElement.ready) {
		hints.push("audio 元素未就绪");
	} else if (!sample.visual.playbackActive || sample.audioElement.paused || !frame?.playing) {
		hints.push("当前不是播放状态");
	} else if (!frame.sourceAttached) {
		hints.push(frame.sourceAttachFailed ? "MediaElementSource 连接失败" : "MediaElementSource 尚未连接");
	} else if (!audioInputAlive) {
		hints.push("analyser 读到的频谱/波形接近 0");
	} else if (!snapshotAlive) {
		hints.push("原始音频有值，但 AudioSnapshot 接近 0");
	} else if (!uniformsAlive) {
		hints.push("AudioSnapshot 有值，但粒子材质 uniforms 接近 0");
	}

	if (sample.visual.preset !== 0) {
		hints.push(`当前 preset=${sample.visual.preset}，不一定是默认封面墙分支`);
	}
	if (!sample.visual.fieldVisible && !sample.visual.bloomVisible) {
		hints.push("封面粒子主层和 bloom 层都不可见");
	}
	if (snapshotAlive && uniformsAlive && (sample.materialUniforms.uBeat ?? 0) < 0.02 && (sample.snapshot.beatPulse ?? 0) < 0.02) {
		hints.push("频段在动，但 beatPulse 很弱，视觉会更像连续流动");
	}
	if (hints.length === 0) {
		hints.push("音频链路看起来已贯通，下一步看 shader 映射强弱");
	}
	return hints;
}

function createOverlay(): HTMLDivElement | null {
	if (typeof document === "undefined") return null;
	const el = document.createElement("div");
	el.id = "visual-audio-debug";
	el.style.cssText = [
		"position:fixed",
		"left:12px",
		"bottom:12px",
		"z-index:2147483647",
		"max-width:min(460px,calc(100vw - 24px))",
		"max-height:min(76vh,calc(100vh - 24px))",
		"overflow:auto",
		"padding:10px 12px",
		"border:1px solid rgba(255,255,255,.22)",
		"border-radius:8px",
		"background:rgba(7,10,14,.86)",
		"color:#dbeafe",
		"font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace",
		"white-space:pre",
		"pointer-events:none",
		"box-shadow:0 12px 28px rgba(0,0,0,.36)",
	].join(";");
	document.body.appendChild(el);
	return el;
}

function renderOverlay(overlay: HTMLDivElement, sample: VisualAudioDebugSample): void {
	const frame = sample.frameSource;
	const lines = [
		"visual-audio-debug  Ctrl+Alt+D  window.__mineradioVisualAudioDebug",
		`state home=${sample.visual.homeActive ? "1" : "0"} playing=${sample.visual.playbackActive ? "1" : "0"} audioPaused=${sample.audioElement.paused ? "1" : "0"} fps=${sample.visual.fps}`,
		frame
			? `source ctx=${frame.audioContextState} ready=${frame.sourceElementReady ? "1" : "0"} attached=${frame.sourceAttached ? "1" : "0"} failed=${frame.sourceAttachFailed ? "1" : "0"} playing=${frame.playing ? "1" : "0"} t=${fixed(frame.currentTimeSeconds, 2)}`
			: "source debug unavailable",
		frame
			? `raw main avg=${fixed(frame.mainFreqAvg)} peak=${fixed(frame.mainFreqPeak)} rms=${fixed(frame.mainTimeRms)} beat avg=${fixed(frame.beatFreqAvg)} peak=${fixed(frame.beatFreqPeak)} rms=${fixed(frame.beatTimeRms)}`
			: "",
		`snapshot bass=${fixed(sample.snapshot.bass)} mid=${fixed(sample.snapshot.mid)} treble=${fixed(sample.snapshot.treble)} energy=${fixed(sample.snapshot.energy)} beat=${fixed(sample.snapshot.beatPulse)} onset=${sample.snapshot.beatOnsetFlag ? "1" : "0"}`,
		`snapshot raw rb=${fixed(sample.snapshot.rb)} rm=${fixed(sample.snapshot.rm)} rt=${fixed(sample.snapshot.rt)} re=${fixed(sample.snapshot.re)} scheduled=${fixed(sample.snapshot.scheduledBeatPulse)}`,
		`runtime ${compactNumberMap(sample.runtimeUniforms, ["uBass", "uMid", "uTreble", "uEnergy", "uBeat", "uBurstAmt", "uTime"])}`,
		`material ${compactNumberMap(sample.materialUniforms, ["uPreset", "uBass", "uMid", "uTreble", "uEnergy", "uBeat", "uBurstAmt", "uAlpha", "uHasCover"])}`,
		`visual preset=${sample.visual.preset} fxPreset=${sample.visual.fxPreset} intensity=${fixed(sample.visual.fxIntensity)} backCover=${sample.visual.fxBackCover ? "1" : "0"} field=${sample.visual.fieldVisible ? "1" : "0"} bloom=${sample.visual.bloomVisible ? "1" : "0"} cover=${sample.visual.coverUrlPresent ? "1" : "0"}`,
		`hint ${sample.hints.join(" / ")}`,
	].filter(Boolean);
	overlay.textContent = lines.join("\n");
}

function logSample(sample: VisualAudioDebugSample): void {
	const frame = sample.frameSource;
	console.log("[DEBUG-visual-audio]", {
		playing: sample.visual.playbackActive,
		audioPaused: sample.audioElement.paused,
		context: frame?.audioContextState ?? "n/a",
		sourceAttached: frame?.sourceAttached ?? false,
		sourceAttachFailed: frame?.sourceAttachFailed ?? false,
		mainFreqPeak: frame?.mainFreqPeak ?? 0,
		mainTimeRms: frame?.mainTimeRms ?? 0,
		bass: sample.snapshot.bass,
		mid: sample.snapshot.mid,
		treble: sample.snapshot.treble,
		energy: sample.snapshot.energy,
		beatPulse: sample.snapshot.beatPulse,
		preset: sample.visual.preset,
		materialBass: sample.materialUniforms.uBass,
		materialBeat: sample.materialUniforms.uBeat,
		fieldVisible: sample.visual.fieldVisible,
		bloomVisible: sample.visual.bloomVisible,
		hints: sample.hints,
	});
}

export function createVisualAudioDebugger(input: VisualAudioDebuggerInput): VisualAudioDebugController {
	if (typeof window === "undefined") {
		return { tick: () => {}, dispose: () => {} };
	}

	const win = window as WindowWithVisualAudioDebug;
	let enabled = initialDebugEnabled();
	let overlay: HTMLDivElement | null = null;
	let latestCtx: FrameContext | null = null;
	let latestSample: VisualAudioDebugSample | null = null;
	let lastSampleAt = 0;
	let lastLogAt = 0;

	const setEnabled = (next: boolean): void => {
		enabled = next;
		writeDebugEnabledToStorage(enabled);
		if (!enabled && overlay) {
			overlay.remove();
			overlay = null;
		}
	};

	const collect = (ctx: FrameContext | null): VisualAudioDebugSample | null => {
		if (!ctx) return null;
		const audioEl = input.getAudioElement();
		const fx = input.homeVisual.getFx();
		const field = input.homeVisual.getField();
		const materialUniforms = readNumberUniforms(field.materialUniforms as unknown as UniformContainerLike);
		const runtimeUniforms = readNumberUniforms(runtimeUniformRecord(ctx.uniforms));
		const visual = {
			fps: input.getFps(),
			homeActive: input.getHomeActive(),
			playbackActive: input.getPlaybackActive(),
			coverUrlPresent: input.getCoverUrl().length > 0,
			preset: input.homeVisual.getPreset(),
			fxPreset: finiteNumber(fx.preset),
			fxIntensity: finiteNumber(fx.intensity),
			fxBackCover: fx.backCover === true,
			fieldVisible: field.points.visible === true,
			bloomVisible: field.bloomPoints.visible === true,
		};
		const sampleWithoutHints = {
			atMs: ctx.now,
			audioElement: {
				ready: !!audioEl,
				paused: audioEl ? audioEl.paused : true,
				ended: audioEl ? audioEl.ended : false,
				currentTime: audioEl ? finiteNumber(audioEl.currentTime) : 0,
			},
			frameSource: input.frameSource.getDebugState?.() ?? null,
			snapshot: input.audioEngine.getSnapshot(),
			runtimeUniforms,
			materialUniforms,
			visual,
		};
		return {
			...sampleWithoutHints,
			hints: buildHints(sampleWithoutHints),
		};
	};

	const ensureOverlay = (): HTMLDivElement | null => {
		if (overlay && overlay.isConnected) return overlay;
		overlay = createOverlay();
		return overlay;
	};

	const publicApi = {
		enable: () => setEnabled(true),
		disable: () => setEnabled(false),
		toggle: () => setEnabled(!enabled),
		sample: () => {
			latestSample = collect(latestCtx);
			if (latestSample) {
				logSample(latestSample);
			}
			return latestSample;
		},
		isEnabled: () => enabled,
	};
	win.__mineradioVisualAudioDebug = publicApi;

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "d") {
			publicApi.toggle();
		}
	};
	window.addEventListener("keydown", onKeyDown);

	return {
		tick(ctx: FrameContext): void {
			latestCtx = ctx;
			if (!enabled) return;
			if (ctx.now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
			lastSampleAt = ctx.now;
			latestSample = collect(ctx);
			if (!latestSample) return;
			const currentOverlay = ensureOverlay();
			if (currentOverlay) renderOverlay(currentOverlay, latestSample);
			if (ctx.now - lastLogAt >= LOG_INTERVAL_MS) {
				lastLogAt = ctx.now;
				logSample(latestSample);
			}
		},
		dispose(): void {
			window.removeEventListener("keydown", onKeyDown);
			if (win.__mineradioVisualAudioDebug === publicApi) {
				delete win.__mineradioVisualAudioDebug;
			}
			if (overlay) {
				overlay.remove();
				overlay = null;
			}
		},
	};
}

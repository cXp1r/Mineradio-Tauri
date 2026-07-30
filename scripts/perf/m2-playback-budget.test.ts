import { expect, test } from "bun:test";
import { PlaybackAudioRuntime } from "../../apps/web/src/audio/playback-audio-runtime";

class BudgetAudioElement extends EventTarget {
	currentTime = 0;
	duration = 180;
	currentSrc = "";
	crossOrigin: string | null = null;
	preload = "";
	volume = 1;
	playbackRate = 1;
	muted = false;
	paused = true;
	ended = false;
	readyState = 4;
	networkState = 2;
	error: MediaError | null = null;
	private source = "";

	get src(): string {
		return this.source;
	}

	set src(value: string) {
		this.source = new URL(value, "https://app.example/").href;
	}

	load(): void {}

	pause(): void {
		this.paused = true;
		this.dispatchEvent(new Event("pause"));
	}

	async play(): Promise<void> {
		this.paused = false;
		this.currentSrc = this.src;
		this.dispatchEvent(new Event("play"));
		this.dispatchEvent(new Event("playing"));
	}

	removeAttribute(name: string): void {
		if (name !== "src") return;
		this.source = "";
		this.currentSrc = "";
	}

	async setSinkId(_id: string): Promise<void> {}
}

function asAudio(element: BudgetAudioElement): HTMLAudioElement {
	return element as unknown as HTMLAudioElement;
}

class BudgetClock {
	private nextId = 1;
	readonly timeouts = new Set<number>();
	readonly intervals = new Set<number>();

	setTimeout = (_callback: () => void, _delayMs: number): number => {
		const id = this.nextId++;
		this.timeouts.add(id);
		return id;
	};

	clearTimeout = (handle: unknown): void => {
		this.timeouts.delete(Number(handle));
	};

	setInterval = (_callback: () => void, _delayMs: number): number => {
		const id = this.nextId++;
		this.intervals.add(id);
		return id;
	};

	clearInterval = (handle: unknown): void => {
		this.intervals.delete(Number(handle));
	};
}

class BudgetAudioNode {
	connect(target: unknown): unknown { return target; }
	disconnect(): void {}
}

class BudgetAnalyserNode extends BudgetAudioNode {
	fftSize = 2048;
	smoothingTimeConstant = 0;
	get frequencyBinCount(): number { return this.fftSize / 2; }
	getByteFrequencyData(data: Uint8Array): void { data.fill(16); }
	getByteTimeDomainData(data: Uint8Array): void { data.fill(132); }
}

class BudgetAudioContext {
	state: AudioContextState = "running";
	sampleRate = 48_000;
	destination = new BudgetAudioNode();
	createAnalyser(): AnalyserNode {
		return new BudgetAnalyserNode() as unknown as AnalyserNode;
	}
	createGain(): GainNode {
		return Object.assign(new BudgetAudioNode(), { gain: { value: 1 } }) as unknown as GainNode;
	}
	createMediaElementSource(_element: HTMLMediaElement): MediaElementAudioSourceNode {
		return new BudgetAudioNode() as unknown as MediaElementAudioSourceNode;
	}
	async resume(): Promise<void> { this.state = "running"; }
	async close(): Promise<void> { this.state = "closed"; }
	async setSinkId(_id: string): Promise<void> {}
}

class BudgetMediaDevices extends EventTarget {
	async enumerateDevices(): Promise<MediaDeviceInfo[]> { return []; }
}

test("M2 连续 240 次切歌后 deck、listener 与 timer 保持固定平台", async () => {
	const primary = new BudgetAudioElement();
	const secondary = new BudgetAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(primary), {
		createAudioElement: () => asAudio(secondary),
		createAudioContext: () => null,
		isDocumentHidden: () => true,
	});

	for (let index = 0; index < 240; index += 1) {
		runtime.load(`https://media.example/${index}.flac`, { index });
		await runtime.play();
	}

	const steady = runtime.diagnostics();
	expect(steady.deckCount).toBe(2);
	expect(steady.committed).not.toBeNull();
	expect(steady.pending).toBeNull();
	expect(steady.preparedCount).toBe(0);
	expect(steady.handoffCount).toBe(0);
	expect(steady.routing.mirrorCount).toBe(0);
	expect(steady.routing.syncTimerActive).toBe(false);
	expect(steady.routing.deviceListenerActive).toBe(false);
	expect(steady.timers.loadProbeCount).toBeLessThanOrEqual(2);
	expect(steady.timers.graphHealthProbeCount).toBeLessThanOrEqual(3);
	expect(steady.timers.audibilityProbeCount).toBeLessThanOrEqual(3);
	expect(steady.timers.handoffActive).toBe(false);

	runtime.stop();
	const stopped = runtime.diagnostics();
	expect(stopped.committed).toBeNull();
	expect(stopped.pending).toBeNull();
	expect(stopped.timers.loadProbeCount).toBe(0);
	expect(stopped.timers.graphHealthProbeCount).toBe(0);
	expect(stopped.timers.audibilityProbeCount).toBe(0);
	expect(stopped.listenerCount).toBe(0);

	runtime.dispose();
	const disposed = runtime.diagnostics();
	expect(disposed.disposed).toBe(true);
	expect(disposed.routing.mirrorCount).toBe(0);
	expect(disposed.routing.syncTimerActive).toBe(false);
});

test("M2 diagnostics 对 ready、stall、Graph、mirror 与 cleanup 资源给出确定性硬上限", async () => {
	const primary = new BudgetAudioElement();
	const secondary = new BudgetAudioElement();
	const mirrors = Array.from({ length: 4 }, () => new BudgetAudioElement());
	const elements = [secondary, ...mirrors];
	const clock = new BudgetClock();
	const context = new BudgetAudioContext();
	const mediaDevices = new BudgetMediaDevices();
	const runtime = new PlaybackAudioRuntime(asAudio(primary), {
		createAudioElement: () => asAudio(elements.shift() ?? new BudgetAudioElement()),
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		mediaDevices: mediaDevices as unknown as MediaDevices,
	});
	primary.readyState = 1;
	runtime.load("https://media.example/budget.flac");
	await runtime.play();
	primary.dispatchEvent(new Event("stalled"));
	await runtime.setOutputRouting({
		enabled: true,
		primarySinkId: "primary",
		mirrorSinkIds: ["mirror-1", "mirror-2", "mirror-3", "mirror-4", "mirror-5"],
	});

	const active = runtime.diagnostics();
	expect(active.timers.readyWaitCount).toBeLessThanOrEqual(1);
	expect(active.recovery.readyRetries).toBeLessThanOrEqual(1);
	expect(active.timers.loadProbeCount).toBeLessThanOrEqual(2);
	expect(active.timers.graphHealthProbeCount).toBeLessThanOrEqual(3);
	expect(active.timers.audibilityProbeCount).toBeLessThanOrEqual(3);
	expect(active.routing.mirrorCount).toBeLessThanOrEqual(4);
	expect(active.routing.syncTimerActive).toBe(true);
	expect(clock.intervals.size).toBeLessThanOrEqual(1);

	await runtime.setOutputRouting({ enabled: false });
	const disabled = runtime.diagnostics();
	expect(disabled.routing.mirrorCount).toBe(0);
	expect(disabled.routing.syncTimerActive).toBe(false);
	expect(disabled.routing.deviceListenerActive).toBe(false);
	expect(clock.intervals.size).toBe(0);

	runtime.dispose();
	const disposed = runtime.diagnostics();
	expect(disposed.deckCount).toBe(0);
	expect(disposed.timers.playDeadlineCount).toBe(0);
	expect(disposed.timers.readyWaitCount).toBe(0);
	expect(disposed.timers.loadProbeCount).toBe(0);
	expect(disposed.timers.graphHealthProbeCount).toBe(0);
	expect(disposed.timers.audibilityProbeCount).toBe(0);
	expect(disposed.routing.mirrorCount).toBe(0);
	expect(disposed.routing.syncTimerActive).toBe(false);
	expect(clock.timeouts.size).toBe(0);
	expect(clock.intervals.size).toBe(0);
});

import { expect, test } from "bun:test";
import { sampleAlbumGaplessCrossfade } from "./album-gapless-transition";
import { PlaybackAudioRuntime, type OwnerChangePayload } from "./playback-audio-runtime";

class TestAudioElement extends EventTarget {
	currentTime = 0;
	duration = Number.NaN;
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
	loadCalls = 0;
	pauseCalls = 0;
	playCalls = 0;
	playError: Error | null = null;
	playErrors: Error[] = [];
	playGate: Promise<void> | null = null;
	sinkCalls: string[] = [];
	currentSinkId = "";
	sinkErrors = new Map<string, Error>();
	sinkGates = new Map<string, Promise<void>>();
	private sourceUrl = "";

	get src(): string {
		return this.sourceUrl;
	}

	set src(value: string) {
		this.sourceUrl = new URL(value, "https://app.example/").href;
	}

	load(): void {
		this.loadCalls += 1;
	}

	pause(): void {
		this.pauseCalls += 1;
		this.paused = true;
		this.dispatchEvent(new Event("pause"));
	}

	async play(): Promise<void> {
		this.playCalls += 1;
		if (this.playGate) await this.playGate;
		const queuedError = this.playErrors.shift();
		if (queuedError) throw queuedError;
		if (this.playError) throw this.playError;
		this.paused = false;
		this.currentSrc = this.src;
		this.dispatchEvent(new Event("play"));
		this.dispatchEvent(new Event("playing"));
	}

	removeAttribute(name: string): void {
		if (name === "src") {
			this.sourceUrl = "";
			this.currentSrc = "";
		}
	}
	async setSinkId(id: string): Promise<void> {
		this.sinkCalls.push(id);
		await this.sinkGates.get(id);
		const error = this.sinkErrors.get(id);
		if (error) throw error;
		this.currentSinkId = id;
	}
}

function deferred<T = void>(): {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function asAudio(audio: TestAudioElement): HTMLAudioElement {
	return audio as unknown as HTMLAudioElement;
}

class TestClock {
	now = 0;
	private nextId = 1;
	private tasks = new Map<number, { at: number; callback: () => void }>();
	private intervals = new Map<number, { at: number; delayMs: number; callback: () => void }>();

	setTimeout = (callback: () => void, delayMs: number): number => {
		const id = this.nextId++;
		this.tasks.set(id, { at: this.now + delayMs, callback });
		return id;
	};

	clearTimeout = (handle: unknown): void => {
		this.tasks.delete(Number(handle));
	};

	setInterval = (callback: () => void, delayMs: number): number => {
		const id = this.nextId++;
		this.intervals.set(id, { at: this.now + delayMs, delayMs, callback });
		return id;
	};

	clearInterval = (handle: unknown): void => {
		this.intervals.delete(Number(handle));
	};

	advance(delayMs: number): void {
		const target = this.now + delayMs;
		while (true) {
			const timeoutDue = [...this.tasks.entries()]
				.filter(([, task]) => task.at <= target)
				.map(([id, task]) => ({ id, ...task, interval: false }))
				.sort((left, right) => left.at - right.at || left.id - right.id)[0];
			const intervalDue = [...this.intervals.entries()]
				.filter(([, task]) => task.at <= target)
				.map(([id, task]) => ({ id, ...task, interval: true }))
				.sort((left, right) => left.at - right.at || left.id - right.id)[0];
			const due = !timeoutDue ? intervalDue : !intervalDue ? timeoutDue
				: (timeoutDue.at <= intervalDue.at ? timeoutDue : intervalDue);
			if (!due) break;
			if (due.interval) {
				const interval = this.intervals.get(due.id);
				if (interval) interval.at += interval.delayMs;
			} else this.tasks.delete(due.id);
			this.now = due.at;
			due.callback();
		}
		this.now = target;
	}
}

class TestMediaDevices extends EventTarget {
	devices: MediaDeviceInfo[] = [];
	async enumerateDevices(): Promise<MediaDeviceInfo[]> { return this.devices; }
}

class TestAudioNode {
	connectCalls: unknown[] = [];
	disconnectCalls = 0;
	connect(target: unknown): unknown {
		this.connectCalls.push(target);
		return target;
	}
	disconnect(): void {
		this.disconnectCalls += 1;
	}
}

class TestAnalyserNode extends TestAudioNode {
	fftSize = 2048;
	smoothingTimeConstant = 0;
	frequencyValue = 24;
	timeValue = 132;
	throwOnRead = false;
	readCalls = 0;
	get frequencyBinCount(): number { return this.fftSize / 2; }
	getByteFrequencyData(data: Uint8Array): void {
		this.readCalls += 1;
		if (this.throwOnRead) throw new Error("analyser read failed");
		data.fill(this.frequencyValue);
	}
	getByteTimeDomainData(data: Uint8Array): void {
		this.readCalls += 1;
		if (this.throwOnRead) throw new Error("analyser read failed");
		data.fill(this.timeValue);
	}
}

class TestGainNode extends TestAudioNode {
	gain = { value: 1 };
}

class TestAudioContext {
	state: AudioContextState = "running";
	sampleRate = 48_000;
	destination = new TestAudioNode();
	sourceElements: HTMLMediaElement[] = [];
	analysers: TestAnalyserNode[] = [];
	gains: TestGainNode[] = [];
	resumeCalls = 0;
	closeCalls = 0;
	sinkCalls: string[] = [];
	currentSinkId = "";
	sinkErrors = new Map<string, Error>();
	throwOnCreateAnalyser = false;
	throwOnCreateMediaElementSource = false;
	sourceCreationCalls = 0;
	createMediaElementSource(element: HTMLMediaElement): MediaElementAudioSourceNode {
		this.sourceCreationCalls += 1;
		if (this.throwOnCreateMediaElementSource) throw new Error("media source attachment failed");
		this.sourceElements.push(element);
		return new TestAudioNode() as unknown as MediaElementAudioSourceNode;
	}
	createAnalyser(): AnalyserNode {
		if (this.throwOnCreateAnalyser) throw new Error("analyser creation failed");
		const node = new TestAnalyserNode();
		this.analysers.push(node);
		return node as unknown as AnalyserNode;
	}
	createGain(): GainNode {
		const node = new TestGainNode();
		this.gains.push(node);
		return node as unknown as GainNode;
	}
	async resume(): Promise<void> { this.resumeCalls += 1; this.state = "running"; }
	async close(): Promise<void> { this.closeCalls += 1; this.state = "closed"; }
	async setSinkId(id: string): Promise<void> {
		this.sinkCalls.push(id);
		const error = this.sinkErrors.get(id);
		if (error) throw error;
		this.currentSinkId = id;
	}
}

async function flushMicrotasks(rounds = 8): Promise<void> {
	for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function expectPromiseToRejectWith(promise: Promise<unknown>, message: string): Promise<void> {
	let captured = "";
	try {
		await promise;
	} catch (error) {
		captured = error instanceof Error ? error.message : String(error);
	}
	expect(captured).toContain(message);
}

function expectNumberCloseTo(actual: number, expected: number, tolerance: number): void {
	expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

test("pending deck only becomes the committed owner after play succeeds", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});

	runtime.load("https://media.example/first.flac", { id: "first" });
	expect(runtime.diagnostics().committed).toBeNull();
	expect(runtime.diagnostics().pending?.sourceUrl).toBe("https://media.example/…");

	await runtime.play();

	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(runtime.diagnostics().committed?.sourceUrl).toBe("https://media.example/…");
	expect(runtime.diagnostics().pending).toBeNull();
});

test("pending native media events stay silent until the owner commit", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	const events: string[] = [];
	runtime.on("play", (payload) => events.push(`play:${payload.generation}`));
	runtime.on("timeupdate", (payload) => events.push(`time:${payload.generation}`));

	runtime.load("https://media.example/first.flac", { id: "first" });
	deckA.dispatchEvent(new Event("play"));
	deckA.dispatchEvent(new Event("timeupdate"));
	expect(events).toEqual([]);

	await runtime.play();
	expect(events).toEqual(["play:1"]);
});

test("a failed incoming deck never interrupts or steals authority from the committed owner", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	const playSources: string[] = [];
	runtime.on("play", (payload) => playSources.push(payload.sourceUrl));

	runtime.load("https://media.example/outgoing.flac", { id: "outgoing" });
	await runtime.play();
	runtime.load("https://media.example/incoming.flac", { id: "incoming" });

	expect(deckA.paused).toBe(false);
	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	deckB.playError = new Error("decoder rejected source");
	await expectPromiseToRejectWith(runtime.play(), "decoder rejected source");

	expect(deckA.paused).toBe(false);
	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(runtime.diagnostics().committed?.sourceUrl).toBe("https://media.example/…");
	deckB.dispatchEvent(new Event("play"));
	expect(playSources).toEqual([deckA.src]);
});

test("prepared handles are generation scoped and abort without touching the outgoing owner", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();

	const stale = runtime.prepareNext("https://media.example/stale.flac", { id: "stale" });
	const current = runtime.prepareNext("https://media.example/current.flac", { id: "current" });
	await expectPromiseToRejectWith(runtime.playPrepared(stale), "stale prepared playback handle");
	current.abort();

	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(deckA.paused).toBe(false);
	expect(runtime.diagnostics().pending).toBeNull();
	await expectPromiseToRejectWith(runtime.playPrepared(current), "aborted prepared playback handle");
});

test("an incoming switch gets one readiness retry and never loops indefinitely", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	deckB.playErrors.push(new Error("transient play rejection"));
	runtime.load("https://media.example/incoming.flac");

	await runtime.play();

	expect(deckB.playCalls).toBe(2);
	expect(runtime.getActiveElement()).toBe(asAudio(deckB));
});

test("the first pending owner receives the same single readiness retry", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	deckA.playErrors.push(new Error("decoder is not ready yet"));
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});

	runtime.load("https://media.example/first.flac");
	await runtime.play();

	expect(deckA.playCalls).toBe(2);
	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
});

test("the first pending owner is bounded by the same 9000ms play deadline", async () => {
	const deckA = new TestAudioElement();
	const clock = new TestClock();
	deckA.playGate = deferred().promise;
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	runtime.load("https://media.example/first-timeout.flac");
	let rejection = "";
	void runtime.play().catch((error) => {
		rejection = error instanceof Error ? error.message : String(error);
	});
	await flushMicrotasks();

	clock.advance(8_999);
	await flushMicrotasks();
	expect(rejection).toBe("");
	clock.advance(1);
	await flushMicrotasks();
	expect(rejection).toContain("9000ms");
});

test("resuming a committed owner keeps the 9000ms play deadline", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	runtime.load("https://media.example/resume.flac");
	await runtime.play();
	runtime.pause();
	deckA.playGate = deferred().promise;
	let rejection = "";
	void runtime.play().catch((error) => {
		rejection = error instanceof Error ? error.message : String(error);
	});
	await flushMicrotasks();

	clock.advance(8_999);
	await flushMicrotasks();
	expect(rejection).toBe("");
	clock.advance(1);
	await flushMicrotasks();
	expect(rejection).toContain("9000ms");
});

test("a committed owner resume receives at most one readiness retry", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/resume-retry.flac");
	await runtime.play();
	runtime.pause();
	deckA.playErrors.push(new Error("resume decoder is not ready"));

	await runtime.play();

	expect(deckA.playCalls).toBe(3);
	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
});

test("committed owner lease stages without pausing and rollback restores playing", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/playing.flac");
	await runtime.play();

	const lease = runtime.stageCommittedOwnerLease();
	expect(lease).not.toBeNull();
	expect(lease?.originallyPlaying).toBe(true);
	expect(lease?.sourceKind).toBe("remote");
	expect(deckA.paused).toBe(false);
	expect(deckA.pauseCalls).toBe(0);

	expect(runtime.pauseCommittedOwnerLease(lease!)).toBe(true);
	expect(deckA.paused).toBe(true);
	expect(await runtime.rollbackCommittedOwnerLease(lease!)).toBe(true);
	expect(deckA.paused).toBe(false);
	expect(await runtime.rollbackCommittedOwnerLease(lease!)).toBe(true);
});

test("committed owner lease rollback preserves an originally paused owner", async () => {
	const deckA = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA));
	runtime.load("blob:https://app.example/local-file");
	await runtime.play();
	runtime.pause();

	const lease = runtime.stageCommittedOwnerLease();
	expect(lease?.originallyPlaying).toBe(false);
	expect(lease?.sourceKind).toBe("blob");
	expect(runtime.pauseCommittedOwnerLease(lease!)).toBe(true);
	expect(await runtime.rollbackCommittedOwnerLease(lease!)).toBe(true);
	expect(deckA.paused).toBe(true);
});

test("a cancelled owner lease cannot pause or resume the new committed owner", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	const staleLease = runtime.stageCommittedOwnerLease();

	expect(runtime.cancelCommittedOwnerLease(staleLease!)).toBe(true);
	runtime.stop();
	runtime.load("https://media.example/incoming.flac");
	await runtime.play();
	const incomingDeck = runtime.diagnostics().committed?.id === "a" ? deckA : deckB;
	const incomingPlayCalls = incomingDeck.playCalls;

	expect(runtime.pauseCommittedOwnerLease(staleLease!)).toBe(false);
	expect(incomingDeck.paused).toBe(false);
	expect(await runtime.rollbackCommittedOwnerLease(staleLease!)).toBe(true);
	expect(incomingDeck.paused).toBe(false);
	expect(incomingDeck.playCalls).toBe(incomingPlayCalls);
});

test("a staged quiescence lease prevents an in-flight pending owner from committing", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const incomingGate = deferred();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	runtime.load("https://media.example/incoming.flac");
	deckB.playGate = incomingGate.promise;
	const incomingPlay = runtime.play();
	await flushMicrotasks();

	const lease = runtime.stageCommittedOwnerLease();
	expect(lease).not.toBeNull();
	expect(runtime.pauseCommittedOwnerLease(lease!)).toBe(true);
	incomingGate.resolve();
	await expectPromiseToRejectWith(incomingPlay, "quiescence");

	expect(runtime.diagnostics().committed?.id).toBe("a");
	expect(runtime.diagnostics().pending).toBeNull();
	expect(deckA.paused).toBe(true);
	expect(deckB.paused).toBe(true);
	expect(runtime.releaseCommittedOwnerLease(lease!)).toBe(true);
});

test("a paused quiescence lease rejects manual resume until exact rollback", async () => {
	const deckA = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA));
	runtime.load("https://media.example/playing.flac");
	await runtime.play();
	const lease = runtime.stageCommittedOwnerLease();
	expect(runtime.pauseCommittedOwnerLease(lease!)).toBe(true);

	await expectPromiseToRejectWith(runtime.play(), "quiescence");
	expect(deckA.paused).toBe(true);
	expect(await runtime.rollbackCommittedOwnerLease(lease!)).toBe(true);
	expect(deckA.paused).toBe(false);
});

test("staging quiescence invalidates an already in-flight committed resume", async () => {
	const deckA = new TestAudioElement();
	const resumeGate = deferred();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA));
	runtime.load("https://media.example/paused.flac");
	await runtime.play();
	runtime.pause();
	deckA.playGate = resumeGate.promise;
	const resume = runtime.play();
	await flushMicrotasks();

	const lease = runtime.stageCommittedOwnerLease();
	expect(lease?.originallyPlaying).toBe(false);
	resumeGate.resolve();
	await expectPromiseToRejectWith(resume, "quiescence");
	expect(runtime.pauseCommittedOwnerLease(lease!)).toBe(true);
	expect(deckA.paused).toBe(true);
	expect(await runtime.rollbackCommittedOwnerLease(lease!)).toBe(true);
	expect(deckA.paused).toBe(true);
});

test("confirmed quiescence settles owner waits and stop cannot reopen the gate", async () => {
	const deckA = new TestAudioElement();
	const resumeGate = deferred();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA));
	runtime.load("https://media.example/paused-for-exit.flac");
	await runtime.play();
	runtime.pause();
	deckA.playGate = resumeGate.promise;
	let rejection = "";
	void runtime.play().catch((error) => {
		rejection = error instanceof Error ? error.message : String(error);
	});
	await flushMicrotasks();
	expect(runtime.diagnostics().timers.playDeadlineCount).toBe(1);

	const lease = runtime.stageCommittedOwnerLease();
	expect(runtime.pauseCommittedOwnerLease(lease!)).toBe(true);
	expect(runtime.diagnostics().timers.playDeadlineCount).toBe(0);
	expect(runtime.diagnostics().timers.readyWaitCount).toBe(0);
	runtime.stop();
	let blockedLoad = "";
	try {
		runtime.load("https://media.example/must-stay-blocked.flac");
	} catch (error) {
		blockedLoad = error instanceof Error ? error.message : String(error);
	}
	expect(blockedLoad).toContain("quiescence");
	expect(await runtime.rollbackCommittedOwnerLease(lease!)).toBe(true);

	resumeGate.resolve();
	await flushMicrotasks();
	expect(rejection).toContain("cancelled");
	expect(deckA.paused).toBe(true);
});

test("a staged quiescence lease blocks prepared handoff and exact release rejects owner replacement", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/incoming.flac");
	const lease = runtime.stageCommittedOwnerLease();
	expect(runtime.pauseCommittedOwnerLease(lease!)).toBe(true);

	await expectPromiseToRejectWith(runtime.playPrepared(prepared), "quiescence");
	expect(runtime.adoptPrepared(prepared, { id: "new-owner" })).toBe(false);
	expect(runtime.diagnostics().committed?.id).toBe("a");
	expect(runtime.releaseCommittedOwnerLease(lease!)).toBe(true);
	let blockedLoad = "";
	try {
		runtime.load("https://media.example/replacement.flac");
	} catch (error) {
		blockedLoad = error instanceof Error ? error.message : String(error);
	}
	expect(blockedLoad).toContain("quiescence");
	await expectPromiseToRejectWith(runtime.play(), "quiescence");
	expect(await runtime.rollbackCommittedOwnerLease(lease!)).toBe(true);
	runtime.load("https://media.example/replacement.flac");
	await runtime.play();
	expect(runtime.releaseCommittedOwnerLease(lease!)).toBe(false);
});

test("one owner generation cannot spend the readiness retry budget twice", async () => {
	const deckA = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA));
	runtime.load("https://media.example/retry-budget.flac");
	await runtime.play();
	runtime.pause();
	deckA.playErrors.push(new Error("first resume retry"));
	await runtime.play();
	runtime.pause();
	deckA.playErrors.push(new Error("second resume must not retry"));

	await expectPromiseToRejectWith(runtime.play(), "second resume must not retry");

	expect(deckA.playCalls).toBe(4);
});

test("dispose immediately cancels an in-flight play deadline", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	deckA.playGate = deferred().promise;
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	runtime.load("https://media.example/cancel-play.flac");
	let rejection = "";
	void runtime.play().catch((error) => {
		rejection = error instanceof Error ? error.message : String(error);
	});
	await flushMicrotasks();

	runtime.dispose();
	await flushMicrotasks();

	expect(rejection).toContain("cancelled");
	expect(runtime.diagnostics().timers.playDeadlineCount).toBe(0);
});

test("a new load generation cancels the previous owner resume deadline", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/committed.flac");
	await runtime.play();
	runtime.pause();
	deckA.playGate = deferred().promise;
	let rejection = "";
	void runtime.play().catch((error) => {
		rejection = error instanceof Error ? error.message : String(error);
	});
	await flushMicrotasks();
	expect(runtime.diagnostics().timers.playDeadlineCount).toBe(1);

	runtime.load("https://media.example/new-generation.flac");
	await flushMicrotasks();

	expect(rejection).toContain("cancelled");
	expect(runtime.diagnostics().timers.playDeadlineCount).toBe(0);
});

test("a new load generation removes the previous owner readiness wait", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/committed-ready.flac");
	await runtime.play();
	runtime.pause();
	deckA.readyState = 0;
	deckA.playErrors.push(new Error("resume waits for decoder"));
	void runtime.play().catch(() => {});
	await flushMicrotasks();
	expect(runtime.diagnostics().timers.readyWaitCount).toBe(1);

	runtime.load("https://media.example/new-ready-generation.flac");
	await flushMicrotasks();

	expect(runtime.diagnostics().timers.readyWaitCount).toBe(0);
});

test("stop immediately cancels an in-flight committed resume", async () => {
	const deckA = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA));
	runtime.load("https://media.example/stop-resume.flac");
	await runtime.play();
	runtime.pause();
	deckA.playGate = deferred().promise;
	let rejection = "";
	void runtime.play().catch((error) => {
		rejection = error instanceof Error ? error.message : String(error);
	});
	await flushMicrotasks();

	runtime.stop();
	await flushMicrotasks();

	expect(rejection).toContain("cancelled");
	expect(runtime.diagnostics().timers.playDeadlineCount).toBe(0);
});

test("dispose removes the one-shot ready retry listeners and timer", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	deckA.readyState = 0;
	deckA.playErrors.push(new Error("decoder still loading"));
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	runtime.load("https://media.example/cancel-ready.flac");
	let rejection = "";
	void runtime.play().catch((error) => {
		rejection = error instanceof Error ? error.message : String(error);
	});
	await flushMicrotasks();
	expect(runtime.diagnostics().timers.readyWaitCount).toBe(1);

	runtime.dispose();
	await flushMicrotasks();

	expect(rejection).toContain("decoder still loading");
	expect(runtime.diagnostics().timers.readyWaitCount).toBe(0);
});

test("committed stall waits for the 1600/3600ms probes before requesting recovery", async () => {
	const deckA = new TestAudioElement();
	deckA.readyState = 0;
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	const phases: string[] = [];
	runtime.on("waiting", (payload) => phases.push(`waiting:${payload.probe}:${payload.generation}`));
	runtime.on("stalled", (payload) => phases.push(`stalled:${payload.probe}:${payload.generation}`));

	runtime.load("https://media.example/slow.flac");
	await runtime.play();
	const generation = runtime.diagnostics().committed!.generation;
	const loadCalls = deckA.loadCalls;
	deckA.dispatchEvent(new Event("stalled"));
	clock.advance(1_599);
	expect(phases).toEqual([]);
	clock.advance(1);
	clock.advance(2_000);
	deckA.dispatchEvent(new Event("waiting"));
	deckA.dispatchEvent(new Event("stalled"));

	expect(phases).toEqual([
		`waiting:early:${generation}`,
		`stalled:late:${generation}`,
	]);
	expect(deckA.loadCalls).toBe(loadCalls);
});

test("stall probes cancel when the committed media clock resumes", async () => {
	const deckA = new TestAudioElement();
	deckA.readyState = 1;
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	const phases: string[] = [];
	runtime.on("waiting", (payload) => phases.push(`waiting:${payload.probe}`));
	runtime.on("stalled", (payload) => phases.push(`stalled:${payload.probe}`));

	runtime.load("https://media.example/recovered.flac");
	await runtime.play();
	deckA.dispatchEvent(new Event("waiting"));
	clock.advance(1_000);
	deckA.currentTime = 0.75;
	clock.advance(3_000);

	expect(phases).toEqual([]);
	expect(runtime.diagnostics().timers.loadProbeCount).toBe(0);
});

test("stalled events do not schedule recovery probes for paused, ended, or source-less owners", async () => {
	const deckA = new TestAudioElement();
	deckA.readyState = 1;
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	});
	runtime.load("https://media.example/probe-eligibility.flac");
	await runtime.play();

	runtime.pause();
	deckA.dispatchEvent(new Event("stalled"));
	expect(runtime.diagnostics().timers.loadProbeCount).toBe(0);

	await runtime.play();
	deckA.ended = true;
	deckA.dispatchEvent(new Event("stalled"));
	expect(runtime.diagnostics().timers.loadProbeCount).toBe(0);

	deckA.ended = false;
	deckA.networkState = 0;
	deckA.dispatchEvent(new Event("waiting"));
	expect(runtime.diagnostics().timers.loadProbeCount).toBe(0);
});

test("playPrepared resolves at owner commit while the cancellable 720ms handoff finishes in background", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/incoming.flac");
	const handoff = runtime.playPrepared(prepared);
	let ownerCommitted = false;
	void handoff.then(() => { ownerCommitted = true; });
	await flushMicrotasks();

	expect(ownerCommitted).toBe(true);
	expect(prepared.status).toBe("committed");
	expect(runtime.getActiveElement()).toBe(asAudio(deckB));
	expect(deckA.paused).toBe(false);
	expectNumberCloseTo(deckB.volume, 0, 0.001);
	clock.advance(48);
	const attack = sampleAlbumGaplessCrossfade({ elapsedMs: 48, durationMs: 720 });
	expectNumberCloseTo(deckA.volume, attack.outgoingGain, 0.005);
	expectNumberCloseTo(deckB.volume, attack.incomingGain, 0.005);
	clock.advance(672);
	await flushMicrotasks();

	expect(deckA.paused).toBe(true);
	expect(deckA.volume).toBe(0);
	expect(deckB.volume).toBe(1);
	expect(runtime.diagnostics().timers.handoffActive).toBe(false);
});

test("prepared handoff without crossfade never overlaps audible owners", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
		isDocumentHidden: () => false,
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/incoming.flac");

	const handoff = runtime.playPrepared(prepared, { crossfade: false, durationMs: 0 });
	await flushMicrotasks();

	expect(deckA.paused).toBe(true);
	expect(deckA.volume).toBe(0);
	expect(deckB.paused).toBe(false);
	expect(deckB.volume).toBe(1);
	expect(runtime.diagnostics().timers.handoffActive).toBe(false);
	await handoff;
});

test("pausing during a crossfade converges and pauses both physical decks", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
	});
	runtime.load("https://media.example/pause-outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/pause-incoming.flac");
	await runtime.playPrepared(prepared, { durationMs: 720 });
	clock.advance(48);

	runtime.pause();

	expect(runtime.getActiveElement()).toBe(asAudio(deckB));
	expect(deckA.paused).toBe(true);
	expect(deckA.volume).toBe(0);
	expect(deckB.paused).toBe(true);
	expect(deckB.volume).toBe(1);
	expect(runtime.diagnostics().timers.handoffActive).toBe(false);
	clock.advance(720);
	expect(deckA.volume).toBe(0);
	expect(deckB.volume).toBe(1);
});

test("seeking during a crossfade retires outgoing before moving the committed owner", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
	});
	runtime.load("https://media.example/seek-outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/seek-incoming.flac");
	await runtime.playPrepared(prepared, { durationMs: 720 });
	clock.advance(48);

	runtime.seek(12_500);

	expect(deckA.paused).toBe(true);
	expect(deckA.volume).toBe(0);
	expect(deckB.paused).toBe(false);
	expect(deckB.volume).toBe(1);
	expect(deckB.currentTime).toBe(12.5);
	expect(runtime.diagnostics().timers.handoffActive).toBe(false);
});

test("master volume changes preserve the active fade envelope and its single completion", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
	});
	runtime.load("https://media.example/volume-outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/volume-incoming.flac");
	await runtime.playPrepared(prepared, { durationMs: 720 });
	clock.advance(48);
	const sample = sampleAlbumGaplessCrossfade({ elapsedMs: 48, durationMs: 720 });

	runtime.setVolume(0.4);

	expectNumberCloseTo(deckA.volume, sample.outgoingGain * 0.4, 0.005);
	expectNumberCloseTo(deckB.volume, sample.incomingGain * 0.4, 0.005);
	expect(runtime.diagnostics().timers.handoffActive).toBe(true);
	clock.advance(672);
	expect(deckA.paused).toBe(true);
	expect(deckA.volume).toBe(0);
	expect(deckB.volume).toBe(0.4);
	expect(runtime.diagnostics().timers.handoffActive).toBe(false);
});

test("a new load intent cancels an unadopted fade and restores outgoing authority", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
	});
	runtime.load("https://media.example/intent-outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/intent-unadopted.flac");
	await runtime.playPrepared(prepared, { durationMs: 720 });
	clock.advance(48);

	runtime.load("https://media.example/intent-new.flac");
	await flushMicrotasks();

	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(deckA.paused).toBe(false);
	expect(deckA.volume).toBe(1);
	expect(deckB.paused).toBe(true);
	expect(runtime.diagnostics().pending?.sourceUrl).toBe("https://media.example/…");
	expect(runtime.diagnostics().timers.handoffActive).toBe(false);
});

test("prepared preroll warms the decoder at zero gain without changing owner", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/incoming.flac");

	await runtime.prerollPrepared(prepared, { isCurrent: () => true });

	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(deckA.paused).toBe(false);
	expect(deckB.playCalls).toBe(1);
	expect(deckB.paused).toBe(true);
	expect(deckB.currentTime).toBe(0);
	expect(runtime.diagnostics().pending?.generation).toBe(prepared.generation);
});

test("adoptPrepared swaps only the committed handle context once without reloading media", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	const preloadContext = { preloadSessionId: "preload-1" };
	const playbackContext = { playbackSessionId: "playback-2" };
	const prepared = runtime.prepareNext("https://media.example/incoming.flac", preloadContext);
	await runtime.playPrepared(prepared, { durationMs: 0 });
	const loadCalls = deckB.loadCalls;
	let publishedContext: object | null = null;
	const adoptionEvents: OwnerChangePayload[] = [];
	runtime.on("timeupdate", (payload) => { publishedContext = payload.loadContext; });
	runtime.on("ownerchange", (payload) => { adoptionEvents.push(payload); });

	expect(runtime.adoptPrepared(prepared, playbackContext)).toBe(true);
	expect(runtime.adoptPrepared(prepared, { playbackSessionId: "duplicate" })).toBe(false);
	deckB.dispatchEvent(new Event("timeupdate"));

	expect(deckB.loadCalls).toBe(loadCalls);
	expect(deckA.src).toBe("");
	expect(publishedContext).toBe(playbackContext);
	expect(adoptionEvents.length).toBe(1);
	expect(adoptionEvents[0]?.reason).toBe("adopted");
	expect(adoptionEvents[0]?.previous?.loadContext).toBe(preloadContext);
	expect(adoptionEvents[0]?.current.loadContext).toBe(playbackContext);
	expect(adoptionEvents[0]?.previous?.generation).toBe(prepared.generation);
	expect(adoptionEvents[0]?.current.generation).toBe(prepared.generation);
	const stale = runtime.prepareNext("https://media.example/stale.flac");
	expect(runtime.adoptPrepared(stale, {})).toBe(false);
	expect(adoptionEvents.length).toBe(1);
});

test("a committed prepared handle can roll back until application adoption succeeds", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		isDocumentHidden: () => true,
	});
	runtime.load("https://media.example/outgoing.flac", { id: "outgoing" });
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/incoming.flac", {
		id: "incoming",
	});
	await runtime.playPrepared(prepared, { durationMs: 0 });
	expect(runtime.getActiveElement()).toBe(asAudio(deckB));

	prepared.abort();
	await flushMicrotasks();

	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(deckA.paused).toBe(false);
	expect(deckB.paused).toBe(true);
});

test("store rejection can roll back immediately while the background handoff is active", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
	});
	runtime.load("https://media.example/rejected-outgoing.flac", { id: "outgoing" });
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/rejected-incoming.flac", { id: "incoming" });
	await runtime.playPrepared(prepared, { durationMs: 720 });
	clock.advance(48);

	prepared.abort();

	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(deckA.paused).toBe(false);
	expect(deckA.volume).toBe(1);
	expect(deckB.paused).toBe(true);
	expect(deckB.src).toBe("");
	expect(runtime.diagnostics().timers.handoffActive).toBe(false);
});

test("application adoption retains the retiring deck until the background handoff settles", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
	});
	runtime.load("https://media.example/adopt-outgoing.flac", { id: "outgoing" });
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/adopt-incoming.flac", { id: "preload" });
	await runtime.playPrepared(prepared, { durationMs: 720 });

	expect(runtime.adoptPrepared(prepared, { id: "application" })).toBe(true);
	expect(deckA.src).not.toBe("");
	expect(deckA.paused).toBe(false);
	clock.advance(720);
	await flushMicrotasks();

	expect(deckA.paused).toBe(true);
	expect(deckA.src).toBe("");
	expect(deckB.paused).toBe(false);
	expect(runtime.diagnostics().timers.handoffActive).toBe(false);
});

test("one shared AudioContext owns both lifetime media sources and supplies visual analyser frames", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const context = new TestAudioContext();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => context as unknown as AudioContext,
	});
	runtime.load("https://media.example/a.flac", { trackKey: "a" });
	await runtime.play();
	deckA.currentTime = 12.5;
	const frameSource = runtime.getAudioFrameSource();
	const first = frameSource();
	frameSource();
	const prepared = runtime.prepareNext("https://media.example/b.flac", { trackKey: "b" });
	await runtime.playPrepared(prepared, { durationMs: 0 });
	deckB.currentTime = 0.25;
	const second = frameSource();

	expect(context.sourceElements).toEqual([asAudio(deckA), asAudio(deckB)]);
	expect(context.analysers.length).toBe(2);
	expect(context.gains.length).toBe(2);
	expect(first?.mainSampleRate).toBe(48_000);
	expect(first?.currentTimeSeconds).toBe(12.5);
	expect(second?.currentTimeSeconds).toBe(0.25);
	expect(second?.playing).toBe(true);
});

test("play establishes and resumes the shared Audio Graph before committing media", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const context = new TestAudioContext();
	context.state = "suspended";
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => context as unknown as AudioContext,
	});

	runtime.load("https://media.example/graph-start.flac");
	await runtime.play();

	expect(context.sourceElements).toContain(asAudio(deckA));
	expect(context.resumeCalls).toBe(1);
	expect(runtime.diagnostics().committed?.sourceUrl).toBe("https://media.example/…");
});

test("output routing makes the virtual bridge primary, caps mirrors at four, and releases all resources when disabled", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const mirrors = Array.from({ length: 4 }, () => new TestAudioElement());
	const queue = [deckB, ...mirrors];
	const clock = new TestClock();
	const mediaDevices = new TestMediaDevices();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(queue.shift()!),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		mediaDevices: mediaDevices as unknown as MediaDevices,
	});
	runtime.load("https://media.example/main.flac");
	await runtime.play();
	const routing = await runtime.setOutputRouting({
		enabled: true,
		primarySinkId: "speakers",
		virtualBridgeSinkId: "virtual-cable",
		mirrorSinkIds: ["monitor-1", "monitor-2", "monitor-3", "monitor-4", "monitor-5"],
	});

	expect(routing.effectivePrimarySinkId).toBe("virtual-cable");
	expect(routing.mirrorSinkIds).toEqual(["monitor-1", "monitor-2", "monitor-3", "monitor-4"]);
	expect(deckA.sinkCalls).toContain("virtual-cable");
	expect(runtime.diagnostics().routing.mirrorCount).toBe(4);
	expect(runtime.diagnostics().routing.syncTimerActive).toBe(true);
	expect(runtime.diagnostics().routing.deviceListenerActive).toBe(true);

	await runtime.setOutputRouting({ enabled: false });
	expect(runtime.diagnostics().routing.mirrorCount).toBe(0);
	expect(runtime.diagnostics().routing.syncTimerActive).toBe(false);
	expect(runtime.diagnostics().routing.deviceListenerActive).toBe(false);
});

test("an available AudioContext sink is the exclusive primary output target", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const context = new TestAudioContext();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => context as unknown as AudioContext,
	});
	runtime.load("https://media.example/context-route.flac");
	await runtime.play();

	await runtime.setOutputRouting({ enabled: true, primarySinkId: "studio" });

	expect(context.sinkCalls).toEqual(["studio"]);
	expect(deckA.sinkCalls).not.toContain("studio");
	expect(deckB.sinkCalls).not.toContain("studio");
});

test("disabling output routing resets an AudioContext sink to the system default", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const context = new TestAudioContext();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => context as unknown as AudioContext,
	});
	runtime.load("https://media.example/context-route-reset.flac");
	await runtime.play();
	await runtime.setOutputRouting({ enabled: true, primarySinkId: "studio" });

	await runtime.setOutputRouting({ enabled: false });

	expect(context.sinkCalls).toEqual(["studio", ""]);
	expect(deckA.sinkCalls).toEqual([]);
	expect(deckB.sinkCalls).toEqual([]);
	expect(runtime.diagnostics().routing.effectivePrimarySinkId).toBe("");
});

test("a failed AudioContext default reset falls back to resetting both deck sinks", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const context = new TestAudioContext();
	context.sinkErrors.set("", new Error("context default reset failed"));
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => context as unknown as AudioContext,
	});
	runtime.load("https://media.example/context-route-fallback.flac");
	await runtime.play();
	await runtime.setOutputRouting({ enabled: true, primarySinkId: "studio" });

	const routing = await runtime.setOutputRouting({ enabled: false });

	expect(context.sinkCalls).toEqual(["studio", ""]);
	expect(deckA.sinkCalls).toEqual([""]);
	expect(deckB.sinkCalls).toEqual([""]);
	expect(routing.errors.map((error) => error.target)).toEqual(["context"]);
});

test("a configured primary route is applied to the Graph before the first owner plays", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const context = new TestAudioContext();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => context as unknown as AudioContext,
	});

	await runtime.setOutputRouting({ enabled: true, primarySinkId: "studio" });
	runtime.load("https://media.example/late-owner.flac");
	await runtime.play();

	expect(context.sinkCalls).toEqual(["studio"]);
	expect(runtime.diagnostics().routing.effectivePrimarySinkId).toBe("studio");
});

test("a missing primary output atomically falls back to the system default", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const missing = new Error("device disappeared");
	missing.name = "NotFoundError";
	deckA.sinkErrors.set("removed-device", missing);
	deckB.sinkErrors.set("removed-device", missing);
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});

	const routing = await runtime.setOutputRouting({
		enabled: true,
		primarySinkId: "removed-device",
	});

	expect(routing.fellBackToDefault).toBe(true);
	expect(routing.effectivePrimarySinkId).toBe("");
	expect(deckA.sinkCalls).toEqual(["removed-device", ""]);
	expect(routing.errors.map((error) => error.name)).toEqual(["NotFoundError", "NotFoundError"]);
});

test("a stale async routing request cannot recreate mirrors after routing is disabled", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const mirror = new TestAudioElement();
	const sinkGate = deferred();
	mirror.sinkGates.set("mirror-1", sinkGate.promise);
	const queue = [deckB, mirror];
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(queue.shift()!),
	});
	runtime.load("https://media.example/routing.flac");
	await runtime.play();

	const enabling = runtime.setOutputRouting({
		enabled: true,
		mirrorSinkIds: ["mirror-1"],
	});
	await flushMicrotasks();
	await runtime.setOutputRouting({ enabled: false });
	sinkGate.resolve(undefined);
	await enabling;

	const routing = runtime.diagnostics().routing;
	expect(routing.enabled).toBe(false);
	expect(routing.mirrorCount).toBe(0);
	expect(routing.syncTimerActive).toBe(false);
});

test("a stale primary sink request cannot overwrite a newer disabled route", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const sinkGate = deferred();
	deckA.sinkGates.set("slow-primary", sinkGate.promise);
	deckB.sinkGates.set("slow-primary", sinkGate.promise);
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => null,
	});

	const enabling = runtime.setOutputRouting({
		enabled: true,
		primarySinkId: "slow-primary",
	});
	await flushMicrotasks();
	await runtime.setOutputRouting({ enabled: false });
	sinkGate.resolve(undefined);
	await enabling;

	expect(runtime.diagnostics().routing.enabled).toBe(false);
	expect(runtime.diagnostics().routing.effectivePrimarySinkId).toBe("");
	expect(deckA.currentSinkId).toBe("");
	expect(deckB.currentSinkId).toBe("");
});

test("diagnostics are immutable serializable snapshots with redacted media sources", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const context = new TestAudioContext();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => context as unknown as AudioContext,
	});
	runtime.load("https://media.example/private/song.flac?token=secret-value");
	await runtime.play();
	runtime.prepareNext("https://media.example/private/next.flac?token=next-secret");

	const diagnostics = runtime.diagnostics();
	const serialized = JSON.stringify(diagnostics);

	expect(Object.isFrozen(diagnostics)).toBe(true);
	expect(Object.isFrozen(diagnostics.committed)).toBe(true);
	expect(Object.isFrozen(diagnostics.pending)).toBe(true);
	expect(Object.isFrozen(diagnostics.graph)).toBe(true);
	expect(Object.isFrozen(diagnostics.routing)).toBe(true);
	expect(Object.isFrozen(diagnostics.timers)).toBe(true);
	expect(Object.isFrozen(diagnostics.recovery)).toBe(true);
	expect(Object.isFrozen(diagnostics.routing.mirrorSinkIds)).toBe(true);
	expect(Object.isFrozen(diagnostics.routing.errors)).toBe(true);
	expect(serialized).not.toContain("secret-value");
	expect(serialized).not.toContain("/private/song.flac");
	expect(diagnostics.recovery.readyRetries).toBe(0);
	expect(diagnostics.recovery.lastErrorCode).toBeNull();
});

test("expired authority after incoming play resolves rejects before owner commit", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const gate = deferred();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
	});
	runtime.load("https://media.example/outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/incoming.flac");
	deckB.playGate = gate.promise;
	let current = true;
	const handoff = runtime.playPrepared(prepared, { isCurrent: () => current });
	current = false;
	gate.resolve(undefined);

	await expectPromiseToRejectWith(handoff, "playback authority expired");
	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(deckA.paused).toBe(false);
	expect(deckB.paused).toBe(true);
});

test("one owner generation performs at most one graph recovery action", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const replacement = new TestAudioElement();
	const queue = [deckB, replacement];
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(queue.shift()!),
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/silent.flac");
	await runtime.play();
	runtime.getAudioFrameSource()();
	for (const analyser of context.analysers) {
		analyser.frequencyValue = 0;
		analyser.timeValue = 128;
	}

	deckA.currentTime = 0.5;
	clock.advance(720);
	expect(runtime.diagnostics().graph.reconnects).toBe(0);
	deckA.currentTime = 1;
	clock.advance(880);
	expect(runtime.diagnostics().graph.reconnects).toBe(1);
	deckA.currentTime = 1.5;
	clock.advance(1_200);

	expect(runtime.diagnostics().graph.replacements).toBe(0);
	expect(runtime.getActiveElement()).toBe(asAudio(deckA));
	expect(runtime.diagnostics().timers.graphHealthProbeCount).toBe(0);
	expect(runtime.diagnostics().timers.audibilityProbeCount).toBe(1);
});

test("frame read failure and health probes share one recovery budget per owner generation", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/shared-budget.flac");
	await runtime.play();
	const frames = runtime.getAudioFrameSource();
	frames();
	for (const analyser of context.analysers) analyser.throwOnRead = true;
	frames();
	expect(runtime.diagnostics().graph.reconnects).toBe(1);
	for (const analyser of context.analysers) {
		analyser.throwOnRead = false;
		analyser.frequencyValue = 0;
		analyser.timeValue = 128;
	}
	deckA.currentTime = 0.5;
	clock.advance(720);
	deckA.currentTime = 1;
	clock.advance(880);
	deckA.currentTime = 1.5;
	clock.advance(1_200);

	expect(runtime.diagnostics().graph.reconnects).toBe(1);
	expect(runtime.diagnostics().graph.replacements).toBe(0);
});

test("persistent frame read failure is latched after one recovery validation instead of retrying every frame", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
	});
	runtime.load("https://media.example/frame-failure.flac");
	await runtime.play();
	const frames = runtime.getAudioFrameSource();
	frames();
	const readsBeforeFailure = context.analysers.reduce((total, analyser) => total + analyser.readCalls, 0);
	for (const analyser of context.analysers) analyser.throwOnRead = true;

	for (let frame = 0; frame < 12; frame += 1) frames();

	const failedReads = context.analysers.reduce((total, analyser) => total + analyser.readCalls, 0) - readsBeforeFailure;
	expect(failedReads).toBe(2);
	expect(runtime.diagnostics().graph.reconnects).toBe(1);
	expect(runtime.diagnostics().recovery.graphRecoveries).toBe(1);
	expect(runtime.diagnostics().recovery.lastErrorCode).toBe("graph-frame-read-failed");
});

test("graph creation failure receives one owner-generation recovery attempt and then latches", async () => {
	const deckA = new TestAudioElement();
	let contextCreations = 0;
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => {
			contextCreations += 1;
			const context = new TestAudioContext();
			context.throwOnCreateAnalyser = true;
			return context as unknown as AudioContext;
		},
	});
	runtime.load("https://media.example/graph-create-failure.flac");
	await runtime.play();
	const frames = runtime.getAudioFrameSource();

	for (let frame = 0; frame < 12; frame += 1) frames();

	expect(contextCreations).toBe(2);
	expect(runtime.diagnostics().recovery.graphRecoveries).toBe(1);
	expect(runtime.diagnostics().recovery.lastErrorCode).toBe("graph-create-failed");
});

test("a null AudioContext factory shares the bounded graph creation recovery budget", async () => {
	const deckA = new TestAudioElement();
	let contextCreations = 0;
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => {
			contextCreations += 1;
			return null;
		},
	});
	runtime.load("https://media.example/graph-context-unavailable.flac");
	await runtime.play();
	const frames = runtime.getAudioFrameSource();

	for (let frame = 0; frame < 12; frame += 1) frames();

	expect(contextCreations).toBe(2);
	expect(runtime.diagnostics().recovery.graphRecoveries).toBe(1);
	expect(runtime.diagnostics().recovery.lastErrorCode).toBe("graph-create-failed");
});

test("graph source attachment failure shares the same bounded owner-generation recovery budget", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	context.throwOnCreateMediaElementSource = true;
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
	});
	runtime.load("https://media.example/graph-attach-failure.flac");
	await runtime.play();
	const frames = runtime.getAudioFrameSource();

	for (let frame = 0; frame < 12; frame += 1) frames();

	expect(context.sourceCreationCalls).toBe(2);
	expect(runtime.diagnostics().recovery.graphRecoveries).toBe(1);
	expect(runtime.diagnostics().recovery.lastErrorCode).toBe("graph-attach-failed");
});

test("graph health probes never classify a frozen media clock as silent playback", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/frozen.flac");
	await runtime.play();
	runtime.getAudioFrameSource()();
	for (const analyser of context.analysers) {
		analyser.frequencyValue = 0;
		analyser.timeValue = 128;
	}
	clock.advance(2_800);

	expect(runtime.diagnostics().graph.reconnects).toBe(0);
	expect(runtime.diagnostics().graph.replacements).toBe(0);
});

test("graph health probes ignore a paused owner even if its test clock advances", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/paused-silent.flac");
	await runtime.play();
	runtime.getAudioFrameSource()();
	for (const analyser of context.analysers) {
		analyser.frequencyValue = 0;
		analyser.timeValue = 128;
	}
	runtime.pause();
	deckA.currentTime = 0.5;
	clock.advance(720);
	deckA.currentTime = 1;
	clock.advance(880);
	deckA.currentTime = 1.5;
	clock.advance(1_200);

	expect(runtime.diagnostics().graph.reconnects).toBe(0);
});

test("graph health probes ignore an intentionally muted owner", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/muted-silent.flac");
	await runtime.play();
	runtime.getAudioFrameSource()();
	for (const analyser of context.analysers) {
		analyser.frequencyValue = 0;
		analyser.timeValue = 128;
	}
	deckA.muted = true;
	deckA.currentTime = 0.5;
	clock.advance(720);
	deckA.currentTime = 1;
	clock.advance(880);
	deckA.currentTime = 1.5;
	clock.advance(1_200);

	expect(runtime.diagnostics().graph.reconnects).toBe(0);
});

test("graph health probes do not inspect an owner while crossfade is active", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/fade-outgoing.flac");
	await runtime.play();
	const prepared = runtime.prepareNext("https://media.example/fade-incoming.flac");
	const handoff = runtime.playPrepared(prepared, { durationMs: 3_000 });
	await flushMicrotasks();
	for (const analyser of context.analysers) {
		analyser.frequencyValue = 0;
		analyser.timeValue = 128;
	}
	deckB.currentTime = 0.5;
	clock.advance(720);
	deckB.currentTime = 1;
	clock.advance(880);
	deckB.currentTime = 1.5;
	clock.advance(1_200);

	expect(runtime.diagnostics().timers.handoffActive).toBe(true);
	expect(runtime.diagnostics().graph.reconnects).toBe(0);
	clock.advance(200);
	await handoff;
});

test("graph health probes stay disabled for the owner probe window after seek", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/seek-silent.flac");
	await runtime.play();
	runtime.getAudioFrameSource()();
	for (const analyser of context.analysers) {
		analyser.frequencyValue = 0;
		analyser.timeValue = 128;
	}
	runtime.seek(500);
	deckA.currentTime = 1;
	clock.advance(720);
	deckA.currentTime = 1.5;
	clock.advance(880);
	deckA.currentTime = 2;
	clock.advance(1_200);

	expect(runtime.diagnostics().graph.reconnects).toBe(0);
});

test("a closed shared graph is replaced once with a fresh element lifetime", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const replacement = new TestAudioElement();
	const elements = [deckB, replacement];
	const firstContext = new TestAudioContext();
	const secondContext = new TestAudioContext();
	const contexts = [firstContext, secondContext];
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(elements.shift()!),
		createAudioContext: () => contexts.shift() as unknown as AudioContext,
	});
	runtime.load("https://media.example/context-reset.flac");
	await runtime.play();
	const frames = runtime.getAudioFrameSource();
	frames();
	firstContext.state = "closed";

	const recovered = frames();

	expect(recovered).not.toBeNull();
	if (!recovered) throw new Error("重建后的 Audio Frame 不应为空");
	expect(recovered.mainSampleRate).toBe(48_000);
	expect(runtime.getActiveElement()).toBe(asAudio(replacement));
	expect(runtime.diagnostics().graph.replacements).toBe(1);
	expect(secondContext.sourceElements).toEqual([asAudio(replacement)]);
});

test("audibility probes restore a nonzero owner gain outside handoff and seek", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/audible.flac");
	await runtime.play();
	runtime.getAudioFrameSource()();
	context.gains[0]!.gain.value = 0;
	deckA.currentTime = 0.5;

	clock.advance(520);

	expect(context.gains[0]!.gain.value).toBe(1);
});

test("audibility probes do not alter gain while the media clock is frozen", async () => {
	const deckA = new TestAudioElement();
	const context = new TestAudioContext();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioContext: () => context as unknown as AudioContext,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		now: () => clock.now,
	});
	runtime.load("https://media.example/frozen-audibility.flac");
	await runtime.play();
	runtime.getAudioFrameSource()();
	context.gains[0]!.gain.value = 0;

	clock.advance(3_200);

	expect(context.gains[0]!.gain.value).toBe(0);
	expect(runtime.diagnostics().recovery.audibilityRecoveries).toBe(0);
});

test("stop revokes every owner and clears pending, handoff, and playback timers", async () => {
	const deckA = new TestAudioElement();
	const deckB = new TestAudioElement();
	const clock = new TestClock();
	const runtime = new PlaybackAudioRuntime(asAudio(deckA), {
		createAudioElement: () => asAudio(deckB),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		now: () => clock.now,
	});
	runtime.load("https://media.example/committed.flac");
	await runtime.play();
	runtime.prepareNext("https://media.example/pending.flac");
	let timeEvents = 0;
	runtime.on("timeupdate", () => { timeEvents += 1; });

	runtime.stop();
	deckA.dispatchEvent(new Event("timeupdate"));
	deckB.dispatchEvent(new Event("timeupdate"));

	const diagnostics = runtime.diagnostics();
	expect(diagnostics.committed).toBeNull();
	expect(diagnostics.pending).toBeNull();
	expect(diagnostics.timers.loadProbeCount).toBe(0);
	expect(diagnostics.timers.graphHealthProbeCount).toBe(0);
	expect(diagnostics.timers.audibilityProbeCount).toBe(0);
	expect(diagnostics.timers.handoffActive).toBe(false);
	expect(timeEvents).toBe(0);
});

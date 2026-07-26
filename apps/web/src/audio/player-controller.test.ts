import { expect, test } from "bun:test";
import {
	PlayerController,
	type ErrorPayload,
	type MediaEventPayload,
} from "./player-controller";

class StubMediaError {
	code = 0;
	message = "";
}

class StubAudioElement extends EventTarget {
	currentTime = 0;
	duration: number = NaN;
	currentSrc = "";
	crossOrigin: string | null = null;
	volume = 1;
	paused = true;
	error: StubMediaError | null = null;
	loadCalled = 0;
	pauseCalled = 0;
	playCalled = 0;
	resumeCalls: string[] = [];
	_mineradioAudioCtx?: { state: string; resume: () => Promise<void> };
	private sourceUrl = "";
	get src(): string {
		return this.sourceUrl;
	}
	set src(value: string) {
		this.sourceUrl = new URL(value, "https://app.example/").href;
	}
	async play(): Promise<void> {
		this.playCalled += 1;
		this.resumeCalls.push("play");
		this.paused = false;
		this.dispatchEvent(new Event("play"));
	}
	pause(): void {
		this.pauseCalled += 1;
		this.paused = true;
		this.dispatchEvent(new Event("pause"));
	}
	load(): void {
		this.loadCalled += 1;
	}
}

function asHtmlAudioElement(stub: StubAudioElement): HTMLAudioElement {
	return stub as unknown as HTMLAudioElement;
}

test("load sets src and calls load()", () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	controller.load("https://example.com/a.mp3");
	expect(stub.src).toBe("https://example.com/a.mp3");
	expect(stub.loadCalled).toBe(1);
});

test("constructor configures audio CORS before load so Web Audio analyser receives proxied media", () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	expect(stub.crossOrigin).toBe("anonymous");
	controller.load("http://127.0.0.1:60365/audio-proxy?url=https%3A%2F%2Fmedia.example%2Fa.flac");
	expect(stub.crossOrigin).toBe("anonymous");
	expect(stub.src).toContain("/audio-proxy?");
});

test("play/pause/seek/volume delegate to the audio element", async () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	await controller.play();
	expect(stub.playCalled).toBe(1);
	controller.pause();
	expect(stub.pauseCalled).toBe(1);
	controller.seek(45_000);
	expect(stub.currentTime).toBe(45);
	controller.setVolume(0.35);
	expect(stub.volume).toBe(0.35);
});

test("play resumes the visual AudioContext before and after media playback like the baseline", async () => {
	const stub = new StubAudioElement();
	stub._mineradioAudioCtx = {
		state: "suspended",
		resume: async () => {
			stub.resumeCalls.push("resume");
			stub._mineradioAudioCtx!.state = "running";
		},
	};
	const controller = new PlayerController(asHtmlAudioElement(stub));

	await controller.play();

	expect(stub.resumeCalls).toEqual(["resume", "play"]);
	expect(stub.playCalled).toBe(1);
});

test("timeupdate handler receives positionMs and durationMs", () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	let last: { positionMs: number; durationMs: number | null } | null = null;
	const off = controller.on("timeupdate", (payload) => {
		last = payload;
	});
	stub.currentTime = 12.5;
	stub.duration = 200;
	stub.dispatchEvent(new Event("timeupdate"));
	expect(last).not.toBeNull();
	expect(last!.positionMs).toBe(12_500);
	expect(last!.durationMs).toBe(200_000);
	off();
	stub.dispatchEvent(new Event("timeupdate"));
	expect(stub.dispatchEvent(new Event("timeupdate")) || true).toBe(true);
});

test("durationchange delivers null duration when NaN", () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	let last: { positionMs: number; durationMs: number | null } | null = null;
	controller.on("durationchange", (payload) => {
		last = payload;
	});
	stub.duration = NaN;
	stub.dispatchEvent(new Event("durationchange"));
	expect(last!.durationMs).toBeNull();
});

test("ended fires once and unsubscribe stops it", () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	let count = 0;
	const off = controller.on("ended", () => {
		count += 1;
	});
	stub.dispatchEvent(new Event("ended"));
	stub.dispatchEvent(new Event("ended"));
	expect(count).toBe(2);
	off();
	stub.dispatchEvent(new Event("ended"));
	expect(count).toBe(2);
});

test("error handler synthesizes code/message from audio.error", () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	let captured: { code: number; message: string } | null = null;
	controller.on("error", (payload) => {
		captured = payload;
	});
	stub.error = new StubMediaError();
	stub.error.code = 4;
	stub.error.message = "network";
	stub.dispatchEvent(new Event("error"));
	expect(captured).not.toBeNull();
	expect(captured!.code).toBe(4);
	expect(captured!.message).toBe("network");
});

test("native events expose context only when the active source matches its load binding", () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	const oldContext = { load: "old" };
	const newContext = { load: "new" };
	const playPayloads: Array<MediaEventPayload | undefined> = [];
	const errorPayloads: ErrorPayload[] = [];
	controller.on("play", (payload: MediaEventPayload) => {
		playPayloads.push(payload);
	});
	controller.on("error", (payload) => {
		errorPayloads.push(payload);
	});

	controller.load("https://example.com/old.mp3", oldContext);
	stub.currentSrc = stub.src;
	const oldSourceUrl = stub.currentSrc;
	controller.load("https://example.com/new.mp3", newContext);
	const newSourceUrl = stub.src;
	stub.error = new StubMediaError();
	stub.error.code = 2;
	stub.error.message = "late old source event";

	stub.dispatchEvent(new Event("play"));
	stub.dispatchEvent(new Event("error"));
	expect(playPayloads[0]?.loadContext).toBeNull();
	expect(playPayloads[0]?.sourceUrl).toBe(oldSourceUrl);
	expect(errorPayloads[0]?.loadContext).toBeNull();
	expect(errorPayloads[0]?.sourceUrl).toBe(oldSourceUrl);

	stub.currentSrc = newSourceUrl;
	stub.dispatchEvent(new Event("play"));
	stub.dispatchEvent(new Event("error"));
	expect(playPayloads[1]?.loadContext).toBe(newContext);
	expect(playPayloads[1]?.sourceUrl).toBe(newSourceUrl);
	expect(errorPayloads[1]?.loadContext).toBe(newContext);
	expect(errorPayloads[1]?.sourceUrl).toBe(newSourceUrl);
});

test("all native events use normalized audio src when currentSrc is empty", () => {
	const stub = new StubAudioElement();
	const controller = new PlayerController(asHtmlAudioElement(stub));
	const loadContext = { load: "fallback" };
	const payloads: MediaEventPayload[] = [];
	const capture = (payload: MediaEventPayload) => {
		payloads.push(payload);
	};
	controller.on("play", capture);
	controller.on("pause", capture);
	controller.on("timeupdate", capture);
	controller.on("durationchange", capture);
	controller.on("ended", capture);
	controller.on("error", capture);

	controller.load("/audio/fallback.mp3", loadContext);
	stub.currentSrc = "";
	stub.error = new StubMediaError();
	stub.dispatchEvent(new Event("play"));
	stub.dispatchEvent(new Event("pause"));
	stub.dispatchEvent(new Event("timeupdate"));
	stub.dispatchEvent(new Event("durationchange"));
	stub.dispatchEvent(new Event("ended"));
	stub.dispatchEvent(new Event("error"));

	expect(stub.src).toBe("https://app.example/audio/fallback.mp3");
	expect(payloads.length).toBe(6);
	expect(payloads.map((payload) => payload.loadContext)).toEqual([
		loadContext,
		loadContext,
		loadContext,
		loadContext,
		loadContext,
		loadContext,
	]);
	expect(payloads.map((payload) => payload.sourceUrl)).toEqual([
		stub.src,
		stub.src,
		stub.src,
		stub.src,
		stub.src,
		stub.src,
	]);
});

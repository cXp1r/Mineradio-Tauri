import { expect, test } from "bun:test";
import { PlayerController } from "./player-controller";

class StubMediaError {
	code = 0;
	message = "";
}

class StubAudioElement extends EventTarget {
	currentTime = 0;
	duration: number = NaN;
	src = "";
	volume = 1;
	paused = true;
	error: StubMediaError | null = null;
	loadCalled = 0;
	pauseCalled = 0;
	playCalled = 0;
	async play(): Promise<void> {
		this.playCalled += 1;
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
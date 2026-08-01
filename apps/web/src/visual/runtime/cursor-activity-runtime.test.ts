import { expect, test } from "bun:test";
import {
	createCursorActivityRuntime,
	type CursorActivityDocument,
	type CursorActivityWindow,
} from "./cursor-activity-runtime";

class FakeClock {
	private now = 0;
	private nextHandle = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	setTimeout = (callback: () => void, delayMs: number): number => {
		const handle = this.nextHandle++;
		this.timers.set(handle, { at: this.now + delayMs, callback });
		return handle;
	};

	clearTimeout = (handle: number): void => {
		this.timers.delete(handle);
	};

	advance(delayMs: number): void {
		const target = this.now + delayMs;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) break;
			this.now = due[1].at;
			this.timers.delete(due[0]);
			due[1].callback();
		}
		this.now = target;
	}

	get activeTimerCount(): number {
		return this.timers.size;
	}
}

function createHarness() {
	const clock = new FakeClock();
	const classes = new Set<string>();
	const windowListeners = new Map<string, Set<EventListener>>();
	const documentListeners = new Map<string, Set<EventListener>>();
	let documentHidden = false;
	const windowTarget = {
		addEventListener(type: string, listener: EventListener) {
			let listeners = windowListeners.get(type);
			if (!listeners) windowListeners.set(type, listeners = new Set());
			listeners.add(listener);
		},
		removeEventListener(type: string, listener: EventListener) {
			windowListeners.get(type)?.delete(listener);
		},
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
	} as CursorActivityWindow;
	const documentTarget = {
		get hidden() { return documentHidden; },
		body: {
			classList: {
				add: (value: string) => { classes.add(value); },
				remove: (value: string) => { classes.delete(value); },
			},
		},
		addEventListener(type: string, listener: EventListener) {
			let listeners = documentListeners.get(type);
			if (!listeners) documentListeners.set(type, listeners = new Set());
			listeners.add(listener);
		},
		removeEventListener(type: string, listener: EventListener) {
			documentListeners.get(type)?.delete(listener);
		},
	} as CursorActivityDocument;
	return {
		classes,
		clock,
		documentTarget,
		windowTarget,
		emitWindow(type: string) {
			for (const listener of [...(windowListeners.get(type) ?? [])]) listener(new Event(type));
		},
		emitDocument(type: string) {
			for (const listener of [...(documentListeners.get(type) ?? [])]) listener(new Event(type));
		},
		setDocumentHidden(hidden: boolean) {
			documentHidden = hidden;
		},
		windowListenerCount() {
			return [...windowListeners.values()].reduce((count, listeners) => count + listeners.size, 0);
		},
		documentListenerCount() {
			return [...documentListeners.values()].reduce((count, listeners) => count + listeners.size, 0);
		},
	};
}

test("cursor activity runtime hides the cursor after 2500ms of inactivity", () => {
	const harness = createHarness();
	const runtime = createCursorActivityRuntime({
		window: harness.windowTarget,
		document: harness.documentTarget,
	});

	expect(runtime.getSnapshot()).toEqual({ hidden: false, revision: 0 });
	expect(harness.clock.activeTimerCount).toBe(1);
	harness.clock.advance(2499);
	expect(runtime.getSnapshot()).toEqual({ hidden: false, revision: 0 });
	harness.clock.advance(1);
	expect(runtime.getSnapshot()).toEqual({ hidden: true, revision: 1 });
	expect(harness.classes.has("cursor-hidden")).toBe(true);
});

test("cursor activity reveals immediately and keeps exactly one rescheduled idle timer", () => {
	const harness = createHarness();
	const runtime = createCursorActivityRuntime({
		window: harness.windowTarget,
		document: harness.documentTarget,
	});
	harness.clock.advance(2500);
	expect(runtime.getSnapshot()).toEqual({ hidden: true, revision: 1 });

	harness.emitWindow("pointermove");
	expect(runtime.getSnapshot()).toEqual({ hidden: false, revision: 2 });
	expect(harness.clock.activeTimerCount).toBe(1);
	for (const eventType of ["mousemove", "mousedown", "wheel", "touchstart"]) {
		harness.emitWindow(eventType);
		expect(harness.clock.activeTimerCount).toBe(1);
	}
	expect(runtime.getSnapshot()).toEqual({ hidden: false, revision: 2 });
	harness.clock.advance(2500);
	expect(runtime.getSnapshot()).toEqual({ hidden: true, revision: 3 });
});

test("a hidden document cancels the timer and visibility restore starts a fresh idle budget", () => {
	const harness = createHarness();
	const runtime = createCursorActivityRuntime({
		window: harness.windowTarget,
		document: harness.documentTarget,
	});
	harness.clock.advance(2500);
	expect(runtime.getSnapshot()).toEqual({ hidden: true, revision: 1 });

	harness.setDocumentHidden(true);
	harness.emitDocument("visibilitychange");
	expect(runtime.getSnapshot()).toEqual({ hidden: false, revision: 2 });
	expect(harness.clock.activeTimerCount).toBe(0);

	harness.setDocumentHidden(false);
	harness.emitDocument("visibilitychange");
	expect(runtime.getSnapshot()).toEqual({ hidden: false, revision: 2 });
	expect(harness.clock.activeTimerCount).toBe(1);
	harness.clock.advance(2500);
	expect(runtime.getSnapshot()).toEqual({ hidden: true, revision: 3 });
});

test("dispose removes every listener, timer, class and subscriber exactly once", () => {
	const harness = createHarness();
	const runtime = createCursorActivityRuntime({
		window: harness.windowTarget,
		document: harness.documentTarget,
	});
	let notifications = 0;
	runtime.subscribe(() => { notifications += 1; });
	expect(harness.windowListenerCount()).toBe(5);
	expect(harness.documentListenerCount()).toBe(1);
	harness.clock.advance(2500);
	expect(notifications).toBe(1);

	runtime.dispose();
	runtime.dispose();
	expect(harness.windowListenerCount()).toBe(0);
	expect(harness.documentListenerCount()).toBe(0);
	expect(harness.clock.activeTimerCount).toBe(0);
	expect(harness.classes.has("cursor-hidden")).toBe(false);

	harness.emitWindow("mousemove");
	harness.emitDocument("visibilitychange");
	harness.clock.advance(5000);
	expect(notifications).toBe(1);
});

test("StrictMode-style mount and unmount leaves no cursor runtime resources", () => {
	const harness = createHarness();
	for (let cycle = 0; cycle < 2; cycle += 1) {
		const runtime = createCursorActivityRuntime({
			window: harness.windowTarget,
			document: harness.documentTarget,
		});
		expect(harness.windowListenerCount()).toBe(5);
		expect(harness.documentListenerCount()).toBe(1);
		runtime.dispose();
		expect(harness.windowListenerCount()).toBe(0);
		expect(harness.documentListenerCount()).toBe(0);
		expect(harness.clock.activeTimerCount).toBe(0);
	}
});

test("background documents stay cursor-visible and visibility restore restarts the idle budget", () => {
	const harness = createHarness();
	const runtime = createCursorActivityRuntime({
		window: harness.windowTarget,
		document: harness.documentTarget,
	});
	harness.clock.advance(2500);
	expect(runtime.getSnapshot()).toEqual({ hidden: true, revision: 1 });

	harness.setDocumentHidden(true);
	harness.emitDocument("visibilitychange");
	expect(runtime.getSnapshot()).toEqual({ hidden: false, revision: 2 });
	expect(harness.clock.activeTimerCount).toBe(0);
	harness.clock.advance(10_000);
	expect(runtime.getSnapshot()).toEqual({ hidden: false, revision: 2 });

	harness.setDocumentHidden(false);
	harness.emitDocument("visibilitychange");
	expect(harness.clock.activeTimerCount).toBe(1);
	harness.clock.advance(2500);
	expect(runtime.getSnapshot()).toEqual({ hidden: true, revision: 3 });
});

test("dispose and StrictMode remount release timer listeners class and subscribers", () => {
	const harness = createHarness();
	const first = createCursorActivityRuntime({
		window: harness.windowTarget,
		document: harness.documentTarget,
	});
	let notifications = 0;
	first.subscribe(() => { notifications += 1; });
	expect(harness.windowListenerCount()).toBe(5);
	expect(harness.documentListenerCount()).toBe(1);
	harness.clock.advance(2500);
	expect(notifications).toBe(1);
	expect(harness.classes.has("cursor-hidden")).toBe(true);

	first.dispose();
	first.dispose();
	expect(first.getSnapshot()).toEqual({ hidden: false, revision: 2 });
	expect(harness.clock.activeTimerCount).toBe(0);
	expect(harness.windowListenerCount()).toBe(0);
	expect(harness.documentListenerCount()).toBe(0);
	expect(harness.classes.has("cursor-hidden")).toBe(false);
	harness.emitWindow("pointermove");
	harness.clock.advance(5000);
	expect(notifications).toBe(1);

	const second = createCursorActivityRuntime({
		window: harness.windowTarget,
		document: harness.documentTarget,
	});
	expect(harness.windowListenerCount()).toBe(5);
	expect(harness.documentListenerCount()).toBe(1);
	expect(harness.clock.activeTimerCount).toBe(1);
	second.dispose();
	expect(harness.windowListenerCount()).toBe(0);
	expect(harness.documentListenerCount()).toBe(0);
});

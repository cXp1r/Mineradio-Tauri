import { expect, test } from "bun:test";
import {
	createVisualScheduler,
	type VisualSchedulerAnimationCallback,
	type VisualSchedulerDriver,
	type VisualSchedulerErrorReporter,
	type VisualSchedulerMaintenanceCallback,
} from "../index";

if (false) {
	// @ts-expect-error 动画回调必须同步完成
	const asyncAnimation: VisualSchedulerAnimationCallback = async () => {};
	// @ts-expect-error 维护回调必须同步完成
	const asyncMaintenance: VisualSchedulerMaintenanceCallback = async () => {};
	// @ts-expect-error 错误上报器必须同步完成
	const asyncReporter: VisualSchedulerErrorReporter = async () => {};
	void asyncAnimation;
	void asyncMaintenance;
	void asyncReporter;
}

const foregroundVisibility = {
	documentVisible: true,
	windowVisible: true,
	windowFocused: true,
	windowMinimized: false,
} as const;

class FakeVisualSchedulerDriver implements VisualSchedulerDriver {
	private nextHandle = 1;
	private nowMs = 0;
	readonly frameCallbacks = new Map<number, (nowMs: number) => void>();
	readonly timerCallbacks = new Map<number, () => void>();
	readonly activeFrames = new Set<number>();
	readonly activeTimers = new Map<number, number>();
	readonly cancelledFrames: number[] = [];
	readonly clearedTimers: number[] = [];

	now(): number {
		return this.nowMs;
	}

	setNow(nowMs: number): void {
		this.nowMs = nowMs;
	}

	requestFrame(callback: (nowMs: number) => void): number {
		const handle = this.nextHandle++;
		this.frameCallbacks.set(handle, callback);
		this.activeFrames.add(handle);
		return handle;
	}

	cancelFrame(handle: number): void {
		this.cancelledFrames.push(handle);
		this.activeFrames.delete(handle);
	}

	setTimer(callback: () => void, delayMs: number): number {
		const handle = this.nextHandle++;
		this.timerCallbacks.set(handle, callback);
		this.activeTimers.set(handle, delayMs);
		return handle;
	}

	clearTimer(handle: number): void {
		this.clearedTimers.push(handle);
		this.activeTimers.delete(handle);
	}

	get onlyFrameHandle(): number {
		const handles = [...this.activeFrames];
		if (handles.length !== 1) {
			throw new Error(`expected one active frame, received ${handles.length}`);
		}
		return handles[0] as number;
	}

	get onlyTimerHandle(): number {
		const handles = [...this.activeTimers.keys()];
		if (handles.length !== 1) {
			throw new Error(`expected one active timer, received ${handles.length}`);
		}
		return handles[0] as number;
	}

	triggerFrame(handle: number, nowMs: number): void {
		this.activeFrames.delete(handle);
		this.frameCallbacks.get(handle)?.(nowMs);
	}

	triggerTimer(handle: number, nowMs = this.nowMs): void {
		this.nowMs = nowMs;
		this.activeTimers.delete(handle);
		this.timerCallbacks.get(handle)?.();
	}
}

test("start is idempotent and owns exactly one animation frame", () => {
	const driver = new FakeVisualSchedulerDriver();
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {},
		initialVisibility: foregroundVisibility,
	});

	scheduler.start();
	scheduler.start();

	expect(driver.activeFrames.size).toBe(1);
	expect(driver.activeTimers.size).toBe(0);
});

test("visibility inputs are copied at construction and setter boundaries", () => {
	const driver = new FakeVisualSchedulerDriver();
	const initialVisibility = {
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	};
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {},
		initialVisibility,
	});

	initialVisibility.documentVisible = false;
	scheduler.setBackgroundPolicy("keep");
	expect(scheduler.getMode()).toBe("foreground");

	const blurredVisibility = {
		...foregroundVisibility,
		windowFocused: false,
	};
	scheduler.setVisibility(blurredVisibility);
	expect(scheduler.getMode()).toBe("background");

	blurredVisibility.windowFocused = true;
	scheduler.setBackgroundPolicy("release");
	expect(scheduler.getMode()).toBe("released");
});

test("stop is idempotent and cancels its owned animation frame once", () => {
	const driver = new FakeVisualSchedulerDriver();
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {},
		initialVisibility: foregroundVisibility,
	});
	scheduler.start();
	const frameHandle = driver.onlyFrameHandle;
	const runningGeneration = scheduler.getGeneration();

	scheduler.stop();
	scheduler.stop();

	expect(driver.activeFrames.size).toBe(0);
	expect(driver.cancelledFrames).toEqual([frameHandle]);
	expect(scheduler.getGeneration()).toBe(runningGeneration + 1);
});

test("dispose is idempotent, stops once, and prevents restart", () => {
	const driver = new FakeVisualSchedulerDriver();
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {},
		initialVisibility: foregroundVisibility,
	});
	scheduler.start();
	const frameHandle = driver.onlyFrameHandle;
	const runningGeneration = scheduler.getGeneration();

	scheduler.dispose();
	scheduler.dispose();
	scheduler.start();

	expect(driver.activeFrames.size).toBe(0);
	expect(driver.cancelledFrames).toEqual([frameHandle]);
	expect(scheduler.getGeneration()).toBe(runningGeneration + 1);
});

test("the default VSync policy runs animation on every frame and keeps one RAF", () => {
	const driver = new FakeVisualSchedulerDriver();
	const animationTicks: { nowMs: number; dtSec: number }[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation(nowMs, decision) {
			animationTicks.push({ nowMs, dtSec: decision.dtSec });
		},
		initialVisibility: foregroundVisibility,
	});
	scheduler.start();

	const firstHandle = driver.onlyFrameHandle;
	driver.triggerFrame(firstHandle, 100);
	const secondHandle = driver.onlyFrameHandle;
	driver.triggerFrame(secondHandle, 116);

	expect(secondHandle).not.toBe(firstHandle);
	expect(animationTicks).toEqual([
		{ nowMs: 100, dtSec: 0 },
		{ nowMs: 116, dtSec: 0.016 },
	]);
	expect(driver.activeFrames.size).toBe(1);
});

test("a stale RAF callback after stop cannot execute or revive the loop", () => {
	const driver = new FakeVisualSchedulerDriver();
	let animationCalls = 0;
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {
			animationCalls += 1;
		},
		initialVisibility: foregroundVisibility,
	});
	scheduler.start();
	const staleHandle = driver.onlyFrameHandle;
	scheduler.stop();
	scheduler.start();
	const currentHandle = driver.onlyFrameHandle;

	driver.triggerFrame(staleHandle, 100);

	expect(animationCalls).toBe(0);
	expect(driver.activeFrames).toEqual(new Set([currentHandle]));
});

test("deep-sleep cancels RAF and owns exactly one maintenance timer", () => {
	const driver = new FakeVisualSchedulerDriver();
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {},
		initialVisibility: foregroundVisibility,
		maintenanceIntervalMs: 250,
	});
	scheduler.start();
	const frameHandle = driver.onlyFrameHandle;

	scheduler.setVisibility({
		...foregroundVisibility,
		documentVisible: false,
	});

	expect(scheduler.getMode()).toBe("deep-sleep");
	expect(driver.activeFrames.size).toBe(0);
	expect(driver.cancelledFrames).toContain(frameHandle);
	expect(driver.activeTimers).toEqual(new Map([[driver.onlyTimerHandle, 250]]));
});

test("maintenance timers run only maintenance work and retain one timer", () => {
	const driver = new FakeVisualSchedulerDriver();
	let animationCalls = 0;
	const maintenanceTicks: number[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {
			animationCalls += 1;
		},
		onMaintenance(nowMs) {
			maintenanceTicks.push(nowMs);
		},
		initialVisibility: {
			...foregroundVisibility,
			windowMinimized: true,
		},
		maintenanceIntervalMs: 400,
	});
	scheduler.start();
	const firstHandle = driver.onlyTimerHandle;

	driver.triggerTimer(firstHandle, 500);

	expect(maintenanceTicks).toEqual([500]);
	expect(animationCalls).toBe(0);
	expect(driver.activeFrames.size).toBe(0);
	expect(driver.activeTimers.size).toBe(1);
	expect(driver.onlyTimerHandle).not.toBe(firstHandle);
});

test("waking cancels maintenance, advances generation, and resets frame cadence", () => {
	const driver = new FakeVisualSchedulerDriver();
	const animationTicks: { nowMs: number; dtSec: number }[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation(nowMs, decision) {
			animationTicks.push({ nowMs, dtSec: decision.dtSec });
		},
		initialVisibility: foregroundVisibility,
	});
	scheduler.start();
	driver.triggerFrame(driver.onlyFrameHandle, 100);
	scheduler.setVisibility({
		...foregroundVisibility,
		documentVisible: false,
	});
	const sleepingGeneration = scheduler.getGeneration();
	const timerHandle = driver.onlyTimerHandle;

	scheduler.setVisibility(foregroundVisibility);

	expect(scheduler.getGeneration()).toBe(sleepingGeneration + 1);
	expect(driver.clearedTimers).toContain(timerHandle);
	expect(driver.activeTimers.size).toBe(0);
	expect(driver.activeFrames.size).toBe(1);
	driver.triggerFrame(driver.onlyFrameHandle, 600);
	expect(animationTicks).toEqual([
		{ nowMs: 100, dtSec: 0 },
		{ nowMs: 600, dtSec: 0 },
	]);
	expect(driver.activeFrames.size).toBe(1);
});

test("hidden keep policy retains an RAF instead of maintenance timing", () => {
	const driver = new FakeVisualSchedulerDriver();
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {},
		initialVisibility: foregroundVisibility,
	});
	scheduler.start();
	scheduler.setVisibility({
		...foregroundVisibility,
		windowVisible: false,
	});
	const timerHandle = driver.onlyTimerHandle;

	scheduler.setBackgroundPolicy("keep");

	expect(scheduler.getMode()).toBe("background");
	expect(driver.clearedTimers).toContain(timerHandle);
	expect(driver.activeTimers.size).toBe(0);
	expect(driver.activeFrames.size).toBe(1);
});

test("stepOnce runs exactly once without changing ownership or running state", () => {
	const driver = new FakeVisualSchedulerDriver();
	const ticks: number[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation(nowMs, decision) {
			expect(decision.run).toBe(true);
			ticks.push(nowMs);
		},
		initialVisibility: foregroundVisibility,
	});

	scheduler.stepOnce(250);
	expect(ticks).toEqual([250]);
	expect(driver.activeFrames.size).toBe(0);
	expect(driver.activeTimers.size).toBe(0);

	scheduler.start();
	const scheduledHandle = driver.onlyFrameHandle;
	scheduler.stepOnce(300);
	expect(ticks).toEqual([250, 300]);
	expect(driver.activeFrames).toEqual(new Set([scheduledHandle]));
});

test("stepOnce does not rewrite a running fixed-FPS cadence", () => {
	const driver = new FakeVisualSchedulerDriver();
	const ticks: { nowMs: number; run: boolean }[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation(nowMs, decision) {
			ticks.push({ nowMs, run: decision.run });
		},
		initialVisibility: foregroundVisibility,
		initialForegroundFramePolicy: { mode: "fixed", fps: 30 },
	});
	scheduler.start();
	driver.triggerFrame(driver.onlyFrameHandle, 0);
	driver.triggerFrame(driver.onlyFrameHandle, 16);
	const scheduledHandle = driver.onlyFrameHandle;

	scheduler.stepOnce(20);
	expect(driver.activeFrames).toEqual(new Set([scheduledHandle]));
	driver.triggerFrame(scheduledHandle, 32);
	driver.triggerFrame(driver.onlyFrameHandle, 34);

	expect(ticks).toEqual([
		{ nowMs: 0, run: true },
		{ nowMs: 16, run: false },
		{ nowMs: 20, run: true },
		{ nowMs: 32, run: false },
		{ nowMs: 34, run: true },
	]);
	expect(driver.activeFrames.size).toBe(1);
});

test("animation errors are reported without blocking later frames or rescheduling", () => {
	const driver = new FakeVisualSchedulerDriver();
	const animationError = new Error("animation failed");
	const reporterError = new Error("reporter failed");
	let animationAttempts = 0;
	const reports: { error: unknown; source: string }[] = [];
	const originalConsoleError = console.error;
	const consoleErrorCalls: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		consoleErrorCalls.push(args);
	};
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {
			animationAttempts += 1;
			if (animationAttempts === 1) throw animationError;
		},
		onError(error, source) {
			reports.push({ error, source });
			throw reporterError;
		},
		initialVisibility: foregroundVisibility,
	});
	try {
		scheduler.start();

		expect(() => driver.triggerFrame(driver.onlyFrameHandle, 100)).not.toThrow();
		expect(driver.activeFrames.size).toBe(1);
		driver.triggerFrame(driver.onlyFrameHandle, 116);

		expect(animationAttempts).toBe(2);
		expect(reports).toEqual([{ error: animationError, source: "animation" }]);
		expect(consoleErrorCalls).toEqual([
			[
				"[visual-scheduler] error reporter failed",
				reporterError,
				"Original animation error:",
				animationError,
			],
		]);
		expect(driver.activeFrames.size).toBe(1);
	} finally {
		console.error = originalConsoleError;
	}
});

test("maintenance errors are reported without blocking later timers", () => {
	const driver = new FakeVisualSchedulerDriver();
	const maintenanceError = new Error("maintenance failed");
	let maintenanceAttempts = 0;
	const reports: { error: unknown; source: string }[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {},
		onMaintenance() {
			maintenanceAttempts += 1;
			if (maintenanceAttempts === 1) throw maintenanceError;
		},
		onError(error, source) {
			reports.push({ error, source });
		},
		initialVisibility: {
			...foregroundVisibility,
			documentVisible: false,
		},
	});
	scheduler.start();

	expect(() => driver.triggerTimer(driver.onlyTimerHandle, 100)).not.toThrow();
	expect(driver.activeTimers.size).toBe(1);
	driver.triggerTimer(driver.onlyTimerHandle, 200);

	expect(maintenanceAttempts).toBe(2);
	expect(reports).toEqual([{ error: maintenanceError, source: "maintenance" }]);
	expect(driver.activeTimers.size).toBe(1);
});

test("fixed FPS is opt-in and switching back to VSync resets cadence", () => {
	const driver = new FakeVisualSchedulerDriver();
	const ticks: {
		nowMs: number;
		run: boolean;
		dtSec: number;
		pendingDtSec: number;
	}[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation(nowMs, decision) {
			ticks.push({
				nowMs,
				run: decision.run,
				dtSec: decision.dtSec,
				pendingDtSec: decision.pendingDtSec,
			});
		},
		initialVisibility: foregroundVisibility,
	});
	scheduler.start();
	const originalHandle = driver.onlyFrameHandle;

	scheduler.setForegroundFramePolicy({ mode: "fixed", fps: 30 });
	expect(driver.activeFrames).toEqual(new Set([originalHandle]));
	driver.triggerFrame(originalHandle, 0);
	driver.triggerFrame(driver.onlyFrameHandle, 16);
	driver.triggerFrame(driver.onlyFrameHandle, 34);
	expect(ticks).toEqual([
		{ nowMs: 0, run: true, dtSec: 0, pendingDtSec: 0 },
		{ nowMs: 16, run: false, dtSec: 0, pendingDtSec: 0.016 },
		{ nowMs: 34, run: true, dtSec: 0.034, pendingDtSec: 0 },
	]);

	const fixedHandle = driver.onlyFrameHandle;
	scheduler.setForegroundFramePolicy({ mode: "vsync" });
	expect(driver.activeFrames).toEqual(new Set([fixedHandle]));
	driver.triggerFrame(fixedHandle, 50);
	driver.triggerFrame(driver.onlyFrameHandle, 66);

	expect(ticks).toEqual([
		{ nowMs: 0, run: true, dtSec: 0, pendingDtSec: 0 },
		{ nowMs: 16, run: false, dtSec: 0, pendingDtSec: 0.016 },
		{ nowMs: 34, run: true, dtSec: 0.034, pendingDtSec: 0 },
		{ nowMs: 50, run: true, dtSec: 0, pendingDtSec: 0 },
		{ nowMs: 66, run: true, dtSec: 0.016, pendingDtSec: 0 },
	]);
	expect(driver.activeFrames.size).toBe(1);
});

test("frame policy inputs are copied and later legal setters update cadence", () => {
	const driver = new FakeVisualSchedulerDriver();
	const policy: { mode: "fixed"; fps: 30 | 60 } = {
		mode: "fixed",
		fps: 30,
	};
	const decisions: { nowMs: number; run: boolean }[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation(nowMs, decision) {
			decisions.push({ nowMs, run: decision.run });
		},
		initialVisibility: foregroundVisibility,
		initialForegroundFramePolicy: policy,
	});

	policy.fps = 60;
	scheduler.setForegroundFramePolicy(policy);
	scheduler.start();
	driver.triggerFrame(driver.onlyFrameHandle, 0);
	driver.triggerFrame(driver.onlyFrameHandle, 17);
	expect(decisions).toEqual([
		{ nowMs: 0, run: true },
		{ nowMs: 17, run: true },
	]);

	policy.fps = 30;
	scheduler.setForegroundFramePolicy({ mode: "fixed", fps: 30 });
	driver.triggerFrame(driver.onlyFrameHandle, 100);
	driver.triggerFrame(driver.onlyFrameHandle, 117);
	expect(decisions).toEqual([
		{ nowMs: 0, run: true },
		{ nowMs: 17, run: true },
		{ nowMs: 100, run: true },
		{ nowMs: 117, run: false },
	]);
});

test("released owns no handle and stale maintenance cannot revive after generations change", () => {
	const driver = new FakeVisualSchedulerDriver();
	let maintenanceCalls = 0;
	const scheduler = createVisualScheduler({
		driver,
		onAnimation() {},
		onMaintenance() {
			maintenanceCalls += 1;
		},
		initialVisibility: {
			...foregroundVisibility,
			documentVisible: false,
		},
	});
	scheduler.start();
	const staleTimerHandle = driver.onlyTimerHandle;
	const sleepingGeneration = scheduler.getGeneration();

	scheduler.setBackgroundPolicy("release");
	expect(scheduler.getMode()).toBe("released");
	expect(scheduler.getGeneration()).toBe(sleepingGeneration + 1);
	expect(driver.activeFrames.size).toBe(0);
	expect(driver.activeTimers.size).toBe(0);

	scheduler.setBackgroundPolicy("auto");
	const currentTimerHandle = driver.onlyTimerHandle;
	driver.triggerTimer(staleTimerHandle, 500);

	expect(maintenanceCalls).toBe(0);
	expect(driver.activeTimers).toEqual(new Map([[currentTimerHandle, 1_000]]));
});

test("a released scheduler wakes to one immediate foreground RAF", () => {
	const driver = new FakeVisualSchedulerDriver();
	const ticks: { nowMs: number; dtSec: number }[] = [];
	const scheduler = createVisualScheduler({
		driver,
		onAnimation(nowMs, decision) {
			ticks.push({ nowMs, dtSec: decision.dtSec });
		},
		initialVisibility: {
			...foregroundVisibility,
			windowVisible: false,
		},
		initialBackgroundPolicy: "release",
	});
	scheduler.start();
	const releasedGeneration = scheduler.getGeneration();
	expect(scheduler.getMode()).toBe("released");
	expect(driver.activeFrames.size).toBe(0);
	expect(driver.activeTimers.size).toBe(0);

	scheduler.setVisibility(foregroundVisibility);

	expect(scheduler.getMode()).toBe("foreground");
	expect(scheduler.getGeneration()).toBe(releasedGeneration + 1);
	expect(driver.activeFrames.size).toBe(1);
	expect(driver.activeTimers.size).toBe(0);
	driver.triggerFrame(driver.onlyFrameHandle, 750);
	expect(ticks).toEqual([{ nowMs: 750, dtSec: 0 }]);
	expect(driver.activeFrames.size).toBe(1);
});

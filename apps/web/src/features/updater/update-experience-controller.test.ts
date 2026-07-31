import { expect, test } from "bun:test";
import type {
	UpdateIntent,
	UpdateReceipt,
	UpdateRuntimePort,
	UpdateSnapshot,
} from "../../ports/update-runtime-port";
import { createUpdateExperienceController } from "./update-experience-controller";
import type { UpdateExperienceClock } from "./update-experience-controller";

function snapshot(
	revision: number,
	overrides: Partial<UpdateSnapshot> = {},
): UpdateSnapshot {
	return {
		revision,
		phase: "idle",
		currentVersion: "0.9.0",
		candidate: null,
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
		...overrides,
	};
}

class MemoryUpdateRuntime implements UpdateRuntimePort {
	private current: UpdateSnapshot;
	private readonly listeners = new Set<() => void>();
	readonly intents: UpdateIntent[] = [];
	subscribeCalls = 0;
	receipt: UpdateReceipt = "accepted";

	constructor(initial: UpdateSnapshot) {
		this.current = initial;
	}

	getSnapshot(): UpdateSnapshot {
		return this.current;
	}

	subscribe(listener: () => void): () => void {
		this.subscribeCalls += 1;
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispatch(intent: UpdateIntent): Promise<UpdateReceipt> {
		this.intents.push(intent);
		return this.receipt;
	}

	publish(next: UpdateSnapshot): void {
		this.current = next;
		for (const listener of this.listeners) listener();
	}
}

class FakeClock implements UpdateExperienceClock {
	private current: number;
	private nextId = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	constructor(now: number) {
		this.current = now;
	}

	now(): number {
		return this.current;
	}

	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		const id = this.nextId;
		this.nextId += 1;
		this.timers.set(id, { at: this.current + delayMs, callback });
		return id as ReturnType<typeof setTimeout>;
	}

	clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		this.timers.delete(handle as number);
	}

	pendingTimerCount(): number {
		return this.timers.size;
	}

	advanceTo(now: number): void {
		this.current = now;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= now)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (!due) return;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}
}

const CANDIDATE = {
	id: "candidate-1.0.0",
	version: "1.0.0",
	notes: ["修复播放链路"],
	publishedAt: "2026-07-31T00:00:00Z",
} as const;

test("普通窗口只为同一个可信候选自动提示一次", () => {
	const runtime = new MemoryUpdateRuntime(snapshot(1));
	const controller = createUpdateExperienceController(runtime);
	controller.setPresentation("normal");

	runtime.publish(snapshot(2, { phase: "available", candidate: CANDIDATE }));
	expect(controller.getSnapshot().modalOpen).toBe(true);

	controller.closeModal();
	runtime.publish(snapshot(3, { phase: "available", candidate: CANDIDATE }));
	expect(controller.getSnapshot().modalOpen).toBe(false);
	expect(runtime.intents).toEqual([]);
	controller.dispose();
});

test("同一候选短暂离开快照后恢复也不会重复提示", () => {
	const runtime = new MemoryUpdateRuntime(snapshot(1, {
		phase: "available",
		candidate: CANDIDATE,
	}));
	const controller = createUpdateExperienceController(runtime);
	controller.setPresentation("normal");
	expect(controller.getSnapshot().modalOpen).toBe(true);
	controller.closeModal();

	runtime.publish(snapshot(2, { phase: "checking", candidate: null }));
	runtime.publish(snapshot(3, { phase: "available", candidate: CANDIDATE }));
	expect(controller.getSnapshot().modalOpen).toBe(false);
	controller.dispose();
});

test("未知、全屏和完整桌面状态只显示徽标，退出沉浸态后才提示一次", () => {
	const runtime = new MemoryUpdateRuntime(
		snapshot(1, { phase: "available", candidate: CANDIDATE }),
	);
	const controller = createUpdateExperienceController(runtime);

	expect(controller.getSnapshot().presentation).toBe("unknown");
	expect(controller.getSnapshot().badgeVisible).toBe(true);
	expect(controller.getSnapshot().modalOpen).toBe(false);

	controller.setPresentation("fullscreen");
	expect(controller.getSnapshot().modalOpen).toBe(false);
	controller.setPresentation("full-desktop");
	expect(controller.getSnapshot().modalOpen).toBe(false);
	controller.setPresentation("normal");
	expect(controller.getSnapshot().modalOpen).toBe(true);

	controller.closeModal();
	controller.setPresentation("fullscreen");
	controller.setPresentation("normal");
	expect(controller.getSnapshot().modalOpen).toBe(false);
	controller.dispose();
});

test("稍后提醒到期前保持静默，到期后为同一候选再提示一次", () => {
	const clock = new FakeClock(1_000);
	const runtime = new MemoryUpdateRuntime(snapshot(1, {
		phase: "available",
		candidate: CANDIDATE,
		remindAfter: 2_000,
	}));
	const controller = createUpdateExperienceController(runtime, clock);
	controller.setPresentation("normal");
	expect(controller.getSnapshot().modalOpen).toBe(false);

	clock.advanceTo(1_999);
	expect(controller.getSnapshot().modalOpen).toBe(false);
	clock.advanceTo(2_000);
	expect(controller.getSnapshot().modalOpen).toBe(true);

	controller.closeModal();
	clock.advanceTo(3_000);
	expect(controller.getSnapshot().modalOpen).toBe(false);
	controller.dispose();
});

test("候选消失、被跳过或离开提示阶段时立即取消 reminder timer", () => {
	const clock = new FakeClock(1_000);
	const runtime = new MemoryUpdateRuntime(snapshot(1, {
		phase: "available",
		candidate: CANDIDATE,
		remindAfter: 2_000,
	}));
	const controller = createUpdateExperienceController(runtime, clock);
	expect(clock.pendingTimerCount()).toBe(1);

	runtime.publish(snapshot(2, { phase: "current", candidate: null }));
	expect(clock.pendingTimerCount()).toBe(0);

	runtime.publish(snapshot(3, {
		phase: "available",
		candidate: CANDIDATE,
		remindAfter: 3_000,
	}));
	expect(clock.pendingTimerCount()).toBe(1);
	runtime.publish(snapshot(4, {
		phase: "available",
		candidate: CANDIDATE,
		remindAfter: 3_000,
		skippedVersion: CANDIDATE.version,
	}));
	expect(clock.pendingTimerCount()).toBe(0);

	runtime.publish(snapshot(5, {
		phase: "available",
		candidate: CANDIDATE,
		remindAfter: 4_000,
	}));
	expect(clock.pendingTimerCount()).toBe(1);
	runtime.publish(snapshot(6, {
		phase: "checking",
		candidate: CANDIDATE,
		remindAfter: 4_000,
	}));
	expect(clock.pendingTimerCount()).toBe(0);
	controller.dispose();
});

test("跳过 exact version 只压制自动提示，手动检查仍可查看候选", async () => {
	const skipped = snapshot(1, {
		phase: "available",
		candidate: CANDIDATE,
		skippedVersion: CANDIDATE.version,
	});
	const runtime = new MemoryUpdateRuntime(skipped);
	const controller = createUpdateExperienceController(runtime);
	controller.setPresentation("normal");
	expect(controller.getSnapshot().modalOpen).toBe(false);

	expect(await controller.checkNow()).toBe("accepted");
	runtime.publish(snapshot(2, {
		phase: "checking",
		candidate: CANDIDATE,
		skippedVersion: CANDIDATE.version,
	}));
	runtime.publish(snapshot(3, {
		phase: "available",
		candidate: CANDIDATE,
		skippedVersion: CANDIDATE.version,
	}));
	expect(controller.getSnapshot().modalOpen).toBe(true);
	controller.dispose();
});

test("手动检查错误与后台错误使用不同展示通道", async () => {
	const backgroundFault = {
		stage: "check",
		code: "UPDATE_SOURCE_UNAVAILABLE",
		retryable: true,
		message: "后台检查暂时不可用",
	} as const;
	const runtime = new MemoryUpdateRuntime(snapshot(1, { fault: backgroundFault }));
	const controller = createUpdateExperienceController(runtime);
	controller.setPresentation("normal");
	expect(controller.getSnapshot().backgroundFault?.code).toBe(backgroundFault.code);
	expect(controller.getSnapshot().manualFault).toBeNull();
	expect(controller.getSnapshot().modalOpen).toBe(false);

	expect(await controller.checkNow()).toBe("accepted");
	runtime.publish(snapshot(2, { phase: "checking" }));
	const manualFault = {
		...backgroundFault,
		code: "UPDATE_CHECK_TIMEOUT",
		message: "手动检查超时",
	};
	runtime.publish(snapshot(3, { phase: "current", fault: manualFault }));
	expect(controller.getSnapshot().manualFault?.code).toBe(manualFault.code);
	expect(controller.getSnapshot().backgroundFault).toBeNull();
	expect(controller.getSnapshot().modalOpen).toBe(true);

	controller.closeModal();
	runtime.publish(snapshot(4, { phase: "checking", fault: manualFault }));
	runtime.publish(snapshot(5, { phase: "current", fault: manualFault }));
	expect(controller.getSnapshot().manualFault).toBeNull();
	expect(controller.getSnapshot().backgroundFault?.code).toBe(manualFault.code);
	expect(controller.getSnapshot().modalOpen).toBe(false);
	controller.dispose();
});

test("用户操作只提交当前快照中的 exact candidate 与 operation identity", async () => {
	const runtime = new MemoryUpdateRuntime(snapshot(1, {
		phase: "available",
		candidate: CANDIDATE,
	}));
	const controller = createUpdateExperienceController(runtime);
	expect(await controller.invokePrimary(controller.getSnapshot().primaryIntent)).toBe("accepted");
	expect(await controller.remindLater(CANDIDATE.id)).toBe("accepted");
	expect(await controller.skipVersion(CANDIDATE.id)).toBe("accepted");
	expect(await controller.openRelease(CANDIDATE.id)).toBe("accepted");

	runtime.publish(snapshot(2, {
		phase: "ready-to-install",
		candidate: CANDIDATE,
	}));
	expect(await controller.invokePrimary(controller.getSnapshot().primaryIntent)).toBe("accepted");
	runtime.publish(snapshot(3, {
		phase: "downloading",
		candidate: CANDIDATE,
		operation: {
			id: "download-operation-1",
			kind: "download",
			receivedBytes: 1,
			totalBytes: null,
			cancellable: true,
		},
	}));
	expect(await controller.invokePrimary(controller.getSnapshot().primaryIntent)).toBe("accepted");
	expect(runtime.intents).toEqual([
		{ kind: "download", candidateId: CANDIDATE.id },
		{ kind: "remind-later", candidateId: CANDIDATE.id },
		{ kind: "skip-version", candidateId: CANDIDATE.id },
		{ kind: "open-release", candidateId: CANDIDATE.id },
		{ kind: "install-and-restart", candidateId: CANDIDATE.id },
		{ kind: "cancel-download", operationId: "download-operation-1" },
	]);
	controller.dispose();
});

test("手动检查首次发现候选后不会再补发一次自动提示", async () => {
	const runtime = new MemoryUpdateRuntime(snapshot(1, { phase: "current" }));
	const controller = createUpdateExperienceController(runtime);
	controller.setPresentation("normal");
	expect(await controller.checkNow()).toBe("accepted");
	runtime.publish(snapshot(2, { phase: "checking" }));
	runtime.publish(snapshot(3, { phase: "available", candidate: CANDIDATE }));
	expect(controller.getSnapshot().modalOpen).toBe(true);

	controller.closeModal();
	runtime.publish(snapshot(4, { phase: "available", candidate: CANDIDATE }));
	expect(controller.getSnapshot().modalOpen).toBe(false);
	controller.dispose();
});

test("点击只提交用户实际看到的 exact action，不读取更新后的运行时动作", async () => {
	const runtime = new MemoryUpdateRuntime(snapshot(1, {
		phase: "available",
		candidate: CANDIDATE,
	}));
	const controller = createUpdateExperienceController(runtime);
	const renderedPrimary = controller.getSnapshot().primaryIntent;
	runtime.publish(snapshot(2, {
		phase: "ready-to-install",
		candidate: CANDIDATE,
	}));

	expect(await controller.invokePrimary(renderedPrimary)).toBe("accepted");
	expect(runtime.intents).toEqual([
		{ kind: "download", candidateId: CANDIDATE.id },
	]);
	controller.dispose();
});

test("remind/skip 只有 native 接受后才关闭，对拒绝结果保留 modal 并给出反馈", async () => {
	const runtime = new MemoryUpdateRuntime(snapshot(1, {
		phase: "available",
		candidate: CANDIDATE,
	}));
	const controller = createUpdateExperienceController(runtime);
	controller.setPresentation("normal");
	runtime.receipt = "stale-candidate";
	expect(await controller.remindLater(CANDIDATE.id)).toBe("stale-candidate");
	expect(controller.getSnapshot().modalOpen).toBe(true);
	expect(controller.getSnapshot().actionRejection).toBe("stale-candidate");

	runtime.receipt = "accepted";
	expect(await controller.skipVersion(CANDIDATE.id)).toBe("accepted");
	expect(controller.getSnapshot().modalOpen).toBe(false);
	expect(controller.getSnapshot().actionRejection).toBeNull();
	controller.dispose();
});

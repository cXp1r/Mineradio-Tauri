import { expect, test } from "bun:test";
import { SettingsTransactionController } from "./settings-transaction-controller";

test("设置事务只有提交成功后才进入历史，并可只恢复变更路径", async () => {
	const state: Record<string, unknown> = {
		"visual.intensity": 1,
		"visual.depth": 0.8,
	};
	const controller = new SettingsTransactionController();

	await controller.apply({
		label: "调整律动强度",
		changes: {
			"visual.intensity": { before: 1, after: 1.25 },
		},
		commit: async () => {
			state["visual.intensity"] = 1.25;
		},
	});

	expect(controller.getSnapshot().entries.length).toBe(1);
	expect(state["visual.intensity"]).toBe(1.25);

	await controller.undo(async (values) => {
		Object.assign(state, values);
	});

	expect(state).toEqual({
		"visual.intensity": 1,
		"visual.depth": 0.8,
	});
	expect(controller.getSnapshot().entries.length).toBe(0);
});

test("没有产生可观察变化的设置事务不会提交也不会记录", async () => {
	let commits = 0;
	const controller = new SettingsTransactionController();

	const changed = await controller.apply({
		label: "保持原值",
		changes: {
			"visual.depth": { before: 0.8, after: 0.8 },
		},
		commit: () => {
			commits += 1;
		},
	});

	expect(changed).toBe(false);
	expect(commits).toBe(0);
	expect(controller.getSnapshot().entries.length).toBe(0);
});

test("同一滑杆手势窗口内的连续提交合并成一条历史", async () => {
	let now = 1_000;
	const controller = new SettingsTransactionController({ now: () => now });

	await controller.apply({
		label: "调整立体感",
		mergeKey: "visual.depth",
		changes: { "visual.depth": { before: 0.8, after: 0.9 } },
		commit() {},
	});
	now += 400;
	await controller.apply({
		label: "调整立体感",
		mergeKey: "visual.depth",
		changes: { "visual.depth": { before: 0.9, after: 1.1 } },
		commit() {},
	});

	const entries = controller.getSnapshot().entries;
	expect(entries.length).toBe(1);
	expect(entries[0]?.before).toEqual({ "visual.depth": 0.8 });
	expect(entries[0]?.after).toEqual({ "visual.depth": 1.1 });
});

test("回滚到历史点会恢复区间内每个路径最早的值", async () => {
	const state: Record<string, unknown> = { a: 0, b: 0, c: 0 };
	const controller = new SettingsTransactionController();
	const apply = async (
		label: string,
		changes: Record<string, { before: unknown; after: unknown }>,
	) => {
		await controller.apply({
			label,
			changes,
			commit: () => {
				for (const [path, change] of Object.entries(changes)) {
					state[path] = change.after;
				}
			},
		});
	};

	await apply("a=1", { a: { before: 0, after: 1 } });
	await apply("b=2", { b: { before: 0, after: 2 } });
	await apply("a/c=3", {
		a: { before: 1, after: 3 },
		c: { before: 0, after: 3 },
	});
	const target = controller.getSnapshot().entries[1];
	expect(target === undefined).toBe(false);

	await controller.rollbackTo(target!.id, async (values) => {
		Object.assign(state, values);
	});

	expect(state).toEqual({ a: 1, b: 0, c: 0 });
	expect(controller.getSnapshot().entries.map((entry) => entry.label)).toEqual([
		"a=1",
	]);
});

test("undo 持久化失败时保留历史并暴露错误", async () => {
	const controller = new SettingsTransactionController();
	await controller.apply({
		label: "修改背景透明度",
		changes: { opacity: { before: 0.5, after: 0.8 } },
		commit() {},
	});

	let message = "";
	try {
		await controller.undo(async () => {
			throw new Error("persist failed");
		});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}

	expect(message).toBe("persist failed");
	expect(controller.getSnapshot().entries.length).toBe(1);
	expect(controller.getSnapshot().error).toBe("persist failed");
});

test("订阅快照在状态未变化时保持引用稳定", () => {
	const controller = new SettingsTransactionController();
	expect(controller.getSnapshot()).toBe(controller.getSnapshot());
});

test("连续触发两次 undo 时会串行恢复两条历史而不会重复消费同一条", async () => {
	const controller = new SettingsTransactionController();
	for (const value of [1, 2]) {
		await controller.apply({
			label: `value=${value}`,
			changes: { value: { before: value - 1, after: value } },
			commit() {},
		});
	}
	const restored: unknown[] = [];
	let releaseFirst: (() => void) | null = null;
	const first = controller.undo(async (values) => {
		restored.push(values.value);
		await new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
	});
	const second = controller.undo(async (values) => {
		restored.push(values.value);
	});

	expect(restored).toEqual([1]);
	(releaseFirst as (() => void) | null)?.();
	expect(await first).toBe(true);
	expect(await second).toBe(true);
	expect(restored).toEqual([1, 0]);
	expect(controller.getSnapshot().entries.length).toBe(0);
});

test("设置历史只保留最近四十条已提交变化", async () => {
	const controller = new SettingsTransactionController();
	for (let value = 1; value <= 45; value += 1) {
		await controller.apply({
			label: `value=${value}`,
			changes: { value: { before: value - 1, after: value } },
			commit() {},
		});
	}

	const entries = controller.getSnapshot().entries;
	expect(entries.length).toBe(40);
	expect(entries[0]?.label).toBe("value=6");
	expect(entries.at(-1)?.label).toBe("value=45");
});

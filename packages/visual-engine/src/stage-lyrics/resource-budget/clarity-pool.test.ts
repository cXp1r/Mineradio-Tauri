import { expect, test } from "bun:test";
import {
	MIB,
	createStageClarityPool,
	getStageClarityBudget,
} from "./clarity-pool";

test("clarity budget matches the Electron parity table and single-item cap", () => {
	expect(getStageClarityBudget("eco", 1)).toEqual({ budgetBytes: 0, residentRows: 4, singleItemCapBytes: 0 });
	expect(getStageClarityBudget("eco", 2)).toEqual({ budgetBytes: 32 * MIB, residentRows: 4, singleItemCapBytes: Math.floor(17.6 * MIB) });
	expect(getStageClarityBudget("balanced", 3)).toEqual({ budgetBytes: 96 * MIB, residentRows: 6, singleItemCapBytes: Math.floor(52.8 * MIB) });
	expect(getStageClarityBudget("ultra", 4)).toEqual({ budgetBytes: 192 * MIB, residentRows: 8, singleItemCapBytes: 64 * MIB });
});

test("clarity pool evicts the least-recent non-essential row and never evicts current", () => {
	const released: string[] = [];
	const pool = createStageClarityPool<string>({
		quality: "high",
		tier: 2,
		budgetBytesOverride: 10,
		singleItemCapBytesOverride: 10,
	});
	pool.put({ key: "current", value: "current", bytes: 4, priority: "essential", release: () => released.push("current") });
	pool.put({ key: "old", value: "old", bytes: 3, priority: "normal", release: () => released.push("old") });
	pool.put({ key: "recent", value: "recent", bytes: 3, priority: "normal", release: () => released.push("recent") });
	pool.acquire("recent")?.release();
	expect(pool.put({ key: "next", value: "next", bytes: 3, priority: "normal", release: () => released.push("next") })).toBe(true);
	expect(released).toEqual(["old"]);
	const current = pool.acquire("current");
	expect(current?.value).toBe("current");
	current?.release();
});

test("clarity pool pauses background warmup at soft pressure and rejects optional work at hard pressure", () => {
	const pool = createStageClarityPool<string>({ quality: "balanced", tier: 2 });
	pool.setPressure("soft");
	expect(pool.put({ key: "warm", value: "warm", bytes: 1, priority: "background", release() {} })).toBe(false);
	pool.setPressure("hard");
	expect(pool.put({ key: "optional", value: "optional", bytes: 1, priority: "optional", release() {} })).toBe(false);
	expect(pool.put({ key: "visible", value: "visible", bytes: 1, priority: "normal", release() {} })).toBe(true);
});

test("clarity reservation owns bytes before build and pinned rows cannot be evicted", () => {
	const released: string[] = [];
	const pool = createStageClarityPool<string>({
		quality: "high",
		tier: 2,
		budgetBytesOverride: 6,
		singleItemCapBytesOverride: 6,
	});
	const reservation = pool.reserve({ key: "building", bytes: 3, priority: "normal" });
	expect(reservation?.active).toBe(true);
	expect(pool.getDiagnostics().bytes).toBe(3);
	expect(reservation?.commit("ready", () => released.push("building"))).toBe(true);
	const pinned = pool.acquire("building");
	expect(pool.put({ key: "other", value: "other", bytes: 4, priority: "normal", release: () => released.push("other") })).toBe(false);
	expect(released).toEqual([]);
	pinned?.release();
	expect(pool.put({ key: "other", value: "other", bytes: 4, priority: "normal", release: () => released.push("other") })).toBe(true);
	expect(released).toEqual(["building"]);
});

test("replacement capacity is temporary and can be finalized for later takeovers", () => {
	const released: string[] = [];
	const pool = createStageClarityPool<string>({
		quality: "high",
		tier: 2,
		budgetBytesOverride: 20,
		singleItemCapBytesOverride: 20,
	});
	for (let index = 0; index < 8; index += 1) {
		expect(pool.put({
			key: `row-${index}`,
			value: `row-${index}`,
			bytes: 1,
			priority: "normal",
			release: () => released.push(`row-${index}`),
		})).toBe(true);
	}
	const first = pool.reserve({ key: "replacement-1", bytes: 1, priority: "essential", replacement: true });
	expect(first?.commit("replacement-1", () => released.push("replacement-1"))).toBe(true);
	expect(pool.getDiagnostics().entries).toBe(9);
	expect(pool.reserve({ key: "replacement-2", bytes: 1, priority: "essential", replacement: true })).toBeNull();

	expect(pool.finalizeReplacement("replacement-1")).toBe(true);
	expect(pool.getDiagnostics().entries).toBe(8);
	expect(released).toEqual(["row-0"]);
	expect(pool.reserve({ key: "replacement-2", bytes: 1, priority: "essential", replacement: true })).not.toBeNull();
});

test("an in-flight reservation cannot be evicted by LRU or pressure trimming", () => {
	const pool = createStageClarityPool<string>({
		quality: "high",
		tier: 2,
		budgetBytesOverride: 6,
		singleItemCapBytesOverride: 6,
	});
	const building = pool.reserve({ key: "building", bytes: 3, priority: "background" });
	expect(building?.active).toBe(true);
	expect(pool.put({ key: "other", value: "other", bytes: 4, priority: "normal", release() {} })).toBe(false);
	expect(building?.active).toBe(true);
	pool.setPressure("hard");
	expect(building?.active).toBe(true);
	expect(pool.getDiagnostics().reserved).toBe(1);
	building?.cancel();
	expect(pool.getDiagnostics().reserved).toBe(0);
});

test("a replacement may use one temporary item of byte headroom beside pinned current", () => {
	const pool = createStageClarityPool<string>({
		quality: "high",
		tier: 2,
		budgetBytesOverride: 10,
		singleItemCapBytesOverride: 5.5,
	});
	expect(pool.put({
		key: "current",
		value: "current",
		bytes: 5.5,
		priority: "essential",
		release() {},
	})).toBe(true);
	const current = pool.acquire("current");
	const replacement = pool.reserve({
		key: "replacement",
		bytes: 5.5,
		priority: "essential",
		replacement: true,
	});
	expect(replacement).not.toBeNull();
	expect(pool.getDiagnostics().bytes).toBe(11);
	expect(replacement?.commit("replacement", () => {})).toBe(true);
	expect(pool.finalizeReplacement("replacement")).toBe(false);
	expect(pool.reserve({ key: "too-early", bytes: 1, priority: "essential", replacement: true })).toBeNull();
	current?.release();
	expect(pool.delete("current")).toBe(true);
	expect(pool.finalizeReplacement("replacement")).toBe(true);
	expect(pool.getDiagnostics().bytes).toBe(5.5);
});

test("runtime reconfigure to tier one preserves protected visible rows and disables new admission", () => {
	const released: string[] = [];
	const pool = createStageClarityPool<string>({ quality: "balanced", tier: 2 });
	for (const [key, priority] of [
		["current", "essential"],
		["outgoing", "normal"],
		["cached-a", "normal"],
		["cached-b", "normal"],
	] as const) {
		expect(pool.put({
			key,
			value: key,
			bytes: 1,
			priority,
			release: () => released.push(key),
		})).toBe(true);
	}

	pool.reconfigure({
		quality: "balanced",
		tier: 1,
		protectedKeys: ["current", "outgoing"],
	});

	expect(released).toEqual(["cached-a", "cached-b"]);
	expect(pool.acquire("current")?.value).toBe("current");
	expect(pool.acquire("outgoing")?.value).toBe("outgoing");
	expect(pool.canAdmit()).toBe(false);
	expect(pool.put({ key: "new-cache", value: "new-cache", bytes: 1, priority: "normal", release() {} })).toBe(false);
	const tierOne = pool.getDiagnostics();
	expect(tierOne.quality).toBe("balanced");
	expect(tierOne.tier).toBe(1);
	expect(tierOne.admissionEnabled).toBe(false);
	expect(tierOne.budgetBytes).toBe(0);
	expect(tierOne.entries).toBe(2);
});

test("runtime quality reconfigure trims to low and later admits the high resident window", () => {
	const released: string[] = [];
	const pool = createStageClarityPool<string>({ quality: "balanced", tier: 2 });
	expect(pool.put({ key: "current", value: "current", bytes: 1, priority: "essential", release: () => released.push("current") })).toBe(true);
	for (let index = 0; index < 5; index += 1) {
		expect(pool.put({ key: `row-${index}`, value: `row-${index}`, bytes: 1, priority: "normal", release: () => released.push(`row-${index}`) })).toBe(true);
	}

	pool.reconfigure({ quality: "low", tier: 2, protectedKeys: ["current"] });
	const low = pool.getDiagnostics();
	expect(low.quality).toBe("low");
	expect(low.tier).toBe(2);
	expect(low.residentRows).toBe(4);
	expect(low.entries).toBe(4);
	expect(released).toEqual(["row-0", "row-1"]);

	pool.reconfigure({ quality: "high", tier: 2, protectedKeys: ["current"] });
	for (let index = 5; index < 9; index += 1) {
		expect(pool.put({ key: `row-${index}`, value: `row-${index}`, bytes: 1, priority: "normal", release: () => released.push(`row-${index}`) })).toBe(true);
	}
	const high = pool.getDiagnostics();
	expect(high.quality).toBe("high");
	expect(high.tier).toBe(2);
	expect(high.admissionEnabled).toBe(true);
	expect(high.residentRows).toBe(8);
	expect(high.entries).toBe(8);
});

import { expect, test } from "bun:test";
import type { LyricTextureLease } from "../textures/texture-lease";
import {
	createStageLyricUploadGate,
	type StageLyricUploadBatch,
} from "./upload-gate";

function makeLease(id: string, released: string[]): LyricTextureLease {
	let isReleased = false;
	return {
		texture: { id } as never,
		ownership: "owned",
		estimatedBytes: 1,
		get released() { return isReleased; },
		release() {
			if (isReleased) return;
			isReleased = true;
			released.push(id);
		},
	};
}

function makeBatch(
	generation: number,
	leaseIds: string[],
	released: string[],
): StageLyricUploadBatch<{ generation: number }> {
	const leases = leaseIds.map((id) => makeLease(id, released));
	let releasedBatch = false;
	return {
		owner: "stage",
		key: "current",
		generation,
		leases,
		candidate: { generation },
		isCurrent: () => true,
		release() {
			if (releasedBatch) return;
			releasedBatch = true;
			for (const lease of leases) lease.release();
		},
	};
}

test("upload gate uploads at most one texture per frame and keeps scene commit separate", () => {
	const released: string[] = [];
	const uploaded: string[] = [];
	const gate = createStageLyricUploadGate();
	gate.enqueue(makeBatch(1, ["mask", "glow"], released));
	gate.beginFrame(10);
	expect(gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id))?.status).toBe("uploaded");
	expect(gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id))).toBeNull();
	expect(gate.takeReady()).toBeNull();
	gate.beginFrame(11);
	expect(gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id))?.status).toBe("ready");
	const ready = gate.takeReady();
	expect(uploaded).toEqual(["mask", "glow"]);
	expect(ready?.candidate).toEqual({ generation: 1 });
	expect(released).toEqual([]);
});

test("upload gate only refreshes its upload allowance for a strictly newer frame", () => {
	const released: string[] = [];
	const uploaded: string[] = [];
	const gate = createStageLyricUploadGate();
	gate.enqueue(makeBatch(1, ["mask", "glow"], released));

	gate.beginFrame(10);
	expect(gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id))).not.toBeNull();

	gate.beginFrame(10);
	expect(gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id))).toBeNull();
	gate.beginFrame(9);
	expect(gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id))).toBeNull();

	gate.beginFrame(11);
	expect(gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id))?.status).toBe("ready");
	expect(uploaded).toEqual(["mask", "glow"]);
});

test("upload gate keeps only one replacement batch and releases the superseded candidate", () => {
	const released: string[] = [];
	const gate = createStageLyricUploadGate();
	gate.enqueue(makeBatch(1, ["old"], released));
	gate.enqueue(makeBatch(2, ["new"], released));
	expect(released).toEqual(["old"]);
	expect(gate.getDiagnostics().pendingReplacementCount).toBe(1);
	gate.dispose();
	expect(released).toEqual(["old", "new"]);
});

test("a stale incoming batch cannot evict a valid pending replacement", () => {
	const released: string[] = [];
	const gate = createStageLyricUploadGate();
	gate.enqueue(makeBatch(2, ["valid"], released));
	const stale = makeBatch(1, ["stale"], released);
	(stale as { isCurrent(): boolean }).isCurrent = () => false;
	expect(gate.enqueue(stale)).toBe(false);
	gate.beginFrame(1);
	const uploaded: string[] = [];
	gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id));
	expect(uploaded).toEqual(["valid"]);
	expect(released).toEqual(["stale"]);
});

test("upload gate skips borrowed shared textures in a row batch", () => {
	const released: string[] = [];
	const gate = createStageLyricUploadGate();
	const batch = makeBatch(1, ["owned"], released);
	const borrowed = makeLease("shared", released) as LyricTextureLease & { ownership: "borrowed" };
	Object.defineProperty(borrowed, "ownership", { value: "borrowed" });
	(batch.leases as LyricTextureLease[]).unshift(borrowed);
	gate.enqueue(batch);
	gate.beginFrame(1);
	const uploaded: string[] = [];
	gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id));
	expect(uploaded).toEqual(["owned"]);
});

test("a failed renderer upload still consumes the current frame allowance", () => {
	const released: string[] = [];
	let executorCalls = 0;
	const gate = createStageLyricUploadGate();
	gate.enqueue(makeBatch(1, ["broken"], released));
	gate.beginFrame(7);
	expect(() => gate.uploadOne(() => {
		executorCalls += 1;
		throw new Error("renderer upload failed");
	})).toThrow("renderer upload failed");

	gate.enqueue(makeBatch(2, ["replacement"], released));
	expect(gate.uploadOne(() => { executorCalls += 1; })).toBeNull();
	expect(executorCalls).toBe(1);

	gate.beginFrame(8);
	expect(gate.uploadOne(() => { executorCalls += 1; })?.status).toBe("ready");
	expect(executorCalls).toBe(2);
});

test("disposed gate releases an incoming batch instead of abandoning ownership", () => {
	const released: string[] = [];
	const gate = createStageLyricUploadGate();
	gate.dispose();
	expect(gate.enqueue(makeBatch(1, ["late"], released))).toBe(false);
	expect(released).toEqual(["late"]);
});

test("re-enqueuing the identical pending batch is an idempotent no-op", () => {
	const released: string[] = [];
	const uploaded: string[] = [];
	const gate = createStageLyricUploadGate();
	const batch = makeBatch(1, ["same"], released);
	expect(gate.enqueue(batch)).toBe(true);
	expect(gate.enqueue(batch)).toBe(true);
	gate.beginFrame(1);
	expect(gate.uploadOne((lease) => uploaded.push((lease.texture as unknown as { id: string }).id))?.status).toBe("ready");
	expect(uploaded).toEqual(["same"]);
	expect(released).toEqual([]);
});

test("a batch that becomes stale during upload is released without returning it", () => {
	const released: string[] = [];
	let current = true;
	const gate = createStageLyricUploadGate();
	const batch = makeBatch(1, ["stale-after-upload"], released);
	(batch as { isCurrent(): boolean }).isCurrent = () => current;
	gate.enqueue(batch);
	gate.beginFrame(1);
	expect(gate.uploadOne(() => { current = false; })).toBeNull();
	expect(gate.takeReady()).toBeNull();
	expect(released).toEqual(["stale-after-upload"]);
});

test("frame ids must be non-negative integers", () => {
	const gate = createStageLyricUploadGate();
	expect(() => gate.beginFrame(-1)).toThrow();
	expect(() => gate.beginFrame(1.5)).toThrow();
});

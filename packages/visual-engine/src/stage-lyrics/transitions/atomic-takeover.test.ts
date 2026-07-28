import { expect, test } from "bun:test";
import {
	createStageAtomicTakeover,
	type StageTakeoverCandidate,
} from "./atomic-takeover";

function candidate(id: string, released: string[], current = true): StageTakeoverCandidate<string> {
	let disposed = false;
	return {
		owner: "stage",
		generation: Number(id.replace(/\D/g, "")) || 0,
		value: id,
		isCurrent: () => current,
		release() {
			if (disposed) return;
			disposed = true;
			released.push(id);
		},
	};
}

test("atomic takeover keeps current visible until commit and transfers the old current to outgoing", () => {
	const released: string[] = [];
	const takeover = createStageAtomicTakeover<string>();
	takeover.adoptInitial(candidate("old1", released));
	takeover.offer(candidate("new2", released));
	expect(takeover.getCurrent()?.value).toBe("old1");
	const applied: string[] = [];
	const commit = takeover.commitReady((next, previous) => {
		applied.push(`${previous?.value ?? "none"}->${next.value}`);
	});
	expect(commit?.current.value).toBe("new2");
	expect(commit?.outgoing?.value).toBe("old1");
	expect(applied).toEqual(["old1->new2"]);
	expect(released).toEqual([]);
	commit?.outgoing?.release();
	expect(released).toEqual(["old1"]);
});

test("failed or stale candidate is released while the committed current remains", () => {
	const released: string[] = [];
	const takeover = createStageAtomicTakeover<string>();
	takeover.adoptInitial(candidate("old1", released));
	expect(takeover.offer(candidate("stale2", released, false))).toBe(false);
	expect(takeover.getCurrent()?.value).toBe("old1");
	expect(released).toEqual(["stale2"]);
	takeover.offer(candidate("next3", released));
	takeover.failPending();
	expect(takeover.getCurrent()?.value).toBe("old1");
	expect(released).toEqual(["stale2", "next3"]);
});

test("scene commit failure rolls back the candidate and preserves the old current", () => {
	const released: string[] = [];
	const takeover = createStageAtomicTakeover<string>();
	takeover.adoptInitial(candidate("old1", released));
	takeover.offer(candidate("next2", released));
	expect(() => takeover.commitReady(() => { throw new Error("scene attach failed"); })).toThrow();
	expect(takeover.getCurrent()?.value).toBe("old1");
	expect(takeover.getPending()).toBeNull();
	expect(released).toEqual(["next2"]);
});

test("adoptInitial releases a candidate when ownership cannot be accepted", () => {
	const released: string[] = [];
	const takeover = createStageAtomicTakeover<string>();
	takeover.adoptInitial(candidate("old1", released));
	expect(takeover.adoptInitial(candidate("extra2", released))).toBe(false);
	expect(released).toEqual(["extra2"]);
});

test("reset releases owned candidates and allows a fresh initial takeover", () => {
	const released: string[] = [];
	const takeover = createStageAtomicTakeover<string>();
	expect(takeover.adoptInitial(candidate("old1", released))).toBe(true);
	expect(takeover.offer(candidate("pending2", released))).toBe(true);
	takeover.reset();
	expect(released).toEqual(["pending2", "old1"]);
	expect(takeover.getCurrent()).toBeNull();
	expect(takeover.getPending()).toBeNull();
	expect(takeover.adoptInitial(candidate("fresh3", released))).toBe(true);
	expect(takeover.getCurrent()?.value).toBe("fresh3");
});

test("scene commit rollback restores partial mutations before preserving current", () => {
	const released: string[] = [];
	const scene = ["old1"];
	const takeover = createStageAtomicTakeover<string>();
	takeover.adoptInitial(candidate("old1", released));
	takeover.offer(candidate("next2", released));
	const applySceneCommit = ((
		next: StageTakeoverCandidate<string>,
		previous: StageTakeoverCandidate<string> | null,
		transaction?: { deferRollback(rollback: () => void): void },
	) => {
		transaction?.deferRollback(() => {
			const index = scene.indexOf(next.value);
			if (index >= 0) scene.splice(index, 1);
		});
		scene.push(next.value);
		transaction?.deferRollback(() => {
			if (previous && !scene.includes(previous.value)) scene.push(previous.value);
		});
		const previousIndex = previous ? scene.indexOf(previous.value) : -1;
		if (previousIndex >= 0) scene.splice(previousIndex, 1);
		throw new Error("scene mutation failed");
	}) as never;

	expect(() => takeover.commitReady(applySceneCommit)).toThrow("scene mutation failed");
	expect(scene).toEqual(["old1"]);
	expect(takeover.getCurrent()?.value).toBe("old1");
	expect(released).toEqual(["next2"]);
});

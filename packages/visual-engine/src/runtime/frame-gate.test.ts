import { expect, test } from "bun:test";
import {
	createFrameGate,
	type FrameGate,
	type FrameGateDecision,
	type FrameGateRate,
} from "../index";

function simulate(rate: number, displayHz: number, seconds: number): number {
	const gate = createFrameGate({ rate });
	let runs = 0;
	for (let frame = 0; frame <= displayHz * seconds; frame += 1) {
		const decision = gate.advance((frame * 1000) / displayHz);
		if (decision.run) runs += 1;
	}
	return runs;
}

test("fixed rates stay within one run of their long-term targets across presentation timelines", () => {
	for (const rate of [24, 30, 45, 60]) {
		for (const displayHz of [60, 120, 144]) {
			const seconds = 120;
			const runs = simulate(rate, displayHz, seconds);
			expect(Math.abs(runs - rate * seconds)).toBeLessThanOrEqual(1);
		}
	}
});

test("the first active tick runs immediately", () => {
	const gate = createFrameGate({ rate: 30 });

	expect(gate.advance(250).run).toBe(true);
});

test("a delayed tick runs at most once and drops whole-cycle catch-up debt", () => {
	const gate = createFrameGate({ rate: 10 });

	expect(gate.advance(0).run).toBe(true);
	expect(gate.advance(350).run).toBe(true);
	expect(gate.advance(351).run).toBe(false);
	expect(gate.advance(400).run).toBe(true);
});

test("skipped task time accumulates into the next run and is then consumed", () => {
	const gate = createFrameGate({ rate: 20 });
	gate.advance(0);

	const skipped = gate.advance(20);
	expect(skipped.run).toBe(false);
	expect(skipped.dtSec).toBe(0);
	expect(skipped.pendingDtSec).toBeCloseTo(0.02);
	expect(gate.getPendingDtSec()).toBeCloseTo(0.02);

	const run = gate.advance(50);
	expect(run.run).toBe(true);
	expect(run.dtSec).toBeCloseTo(0.05);
	expect(run.pendingDtSec).toBe(0);
	expect(gate.getPendingDtSec()).toBe(0);
});

test("a run caps its task delta at fifty milliseconds", () => {
	const gate = createFrameGate({ rate: 2 });
	gate.advance(0);

	const decision = gate.advance(500);
	expect(decision.run).toBe(true);
	expect(decision.dtSec).toBe(0.05);
	expect(decision.pendingDtSec).toBe(0);
});

test("clock rollback resets phase and pending task time", () => {
	const gate = createFrameGate({ rate: 10 });
	gate.advance(0);
	expect(gate.advance(40).run).toBe(false);

	const rollback = gate.advance(20);
	expect(rollback).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(gate.getPendingDtSec()).toBe(0);
	expect(gate.advance(70).run).toBe(false);
	expect(gate.advance(120).run).toBe(true);
});

test("only stalls over one second reset phase and task time", () => {
	const boundaryGate = createFrameGate({ rate: 1 });
	boundaryGate.advance(0);
	expect(boundaryGate.advance(1000).dtSec).toBe(0.05);

	const stalledGate = createFrameGate({ rate: 10 });
	stalledGate.advance(0);
	expect(stalledGate.advance(40).run).toBe(false);

	const stalled = stalledGate.advance(1041);
	expect(stalled).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(stalledGate.advance(1091).run).toBe(false);
	expect(stalledGate.advance(1141).run).toBe(true);
});

test("inactive time is discarded and the first resumed tick runs immediately", () => {
	const gate = createFrameGate({ rate: 10 });
	gate.advance(0);
	expect(gate.advance(40).run).toBe(false);

	expect(gate.advance(500, false)).toEqual({
		run: false,
		dtSec: 0,
		pendingDtSec: 0,
	});
	expect(gate.getPendingDtSec()).toBe(0);
	expect(gate.advance(900)).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(gate.advance(950).run).toBe(false);
});

test("setRate clears prior phase and pending task time", () => {
	const gate = createFrameGate({ rate: 10 });
	gate.advance(0);
	expect(gate.advance(40).run).toBe(false);

	gate.setRate(20);
	expect(gate.getPendingDtSec()).toBe(0);
	expect(gate.advance(40)).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(gate.advance(65).run).toBe(false);
	expect(gate.advance(90).run).toBe(true);
});

test("reset clears phase and pending task time with or without a clock anchor", () => {
	const gate = createFrameGate({ rate: 10 });
	gate.advance(0);
	expect(gate.advance(40).run).toBe(false);

	gate.reset(40);
	expect(gate.getPendingDtSec()).toBe(0);
	expect(gate.advance(90).run).toBe(false);
	expect(gate.advance(140).run).toBe(true);

	gate.reset();
	expect(gate.getPendingDtSec()).toBe(0);
	expect(gate.advance(500)).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
});

test("presentation mode runs every valid active tick and resets around anomalies", () => {
	const gate = createFrameGate({ rate: "presentation" });

	expect(gate.advance(0)).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(gate.advance(16).dtSec).toBeCloseTo(0.016);
	expect(gate.advance(16)).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(gate.advance(516).dtSec).toBe(0.05);
	expect(gate.advance(1517)).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(gate.advance(1500)).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(gate.advance(2000, false)).toEqual({ run: false, dtSec: 0, pendingDtSec: 0 });
	expect(gate.advance(5000)).toEqual({ run: true, dtSec: 0, pendingDtSec: 0 });
	expect(gate.advance(5016).dtSec).toBeCloseTo(0.016);
});

test("the frame gate contract is available from the package barrel", () => {
	const rates: readonly FrameGateRate[] = [30, "presentation"];
	const gate: FrameGate = createFrameGate({ rate: rates[0] });
	const decision: FrameGateDecision = gate.advance(0);

	expect(decision.run).toBe(true);
	gate.setRate(rates[1]);
	gate.reset();
});

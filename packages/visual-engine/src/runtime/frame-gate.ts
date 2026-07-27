const PHASE_EPSILON = 1e-9;
const MAX_TASK_DT_SEC = 0.05;

export type FrameGateRate = "presentation" | number;

export interface FrameGateDecision {
	readonly run: boolean;
	readonly dtSec: number;
	readonly pendingDtSec: number;
}

export interface FrameGate {
	advance(nowMs: number, active?: boolean): FrameGateDecision;
	reset(nowMs?: number): void;
	setRate(rate: FrameGateRate): void;
	getPendingDtSec(): number;
}

export function createFrameGate(options: { readonly rate: FrameGateRate }): FrameGate {
	let rate = options.rate;
	let lastNowMs: number | undefined;
	let phaseCredit = 0;
	let pendingDtSec = 0;
	const clearTimingState = (nowMs?: number) => {
		lastNowMs = nowMs;
		phaseCredit = 0;
		pendingDtSec = 0;
	};

	return {
		advance(nowMs: number, active = true): FrameGateDecision {
			if (!active) {
				clearTimingState();
				return { run: false, dtSec: 0, pendingDtSec: 0 };
			}

			if (lastNowMs === undefined) {
				lastNowMs = nowMs;
				return { run: true, dtSec: 0, pendingDtSec: 0 };
			}

			const deltaSec = (nowMs - lastNowMs) / 1000;
			lastNowMs = nowMs;
			if (deltaSec < 0 || deltaSec > 1) {
				phaseCredit = 0;
				pendingDtSec = 0;
				return { run: true, dtSec: 0, pendingDtSec: 0 };
			}
			pendingDtSec += deltaSec;
			if (rate === "presentation") {
				const dtSec = Math.min(pendingDtSec, MAX_TASK_DT_SEC);
				pendingDtSec = 0;
				return { run: true, dtSec, pendingDtSec: 0 };
			}

			phaseCredit += deltaSec * rate;

			const due = phaseCredit + PHASE_EPSILON >= 1;
			if (!due) {
				return { run: false, dtSec: 0, pendingDtSec };
			}

			phaseCredit = Math.max(0, phaseCredit - 1);
			if (phaseCredit >= 1) phaseCredit %= 1;
			const dtSec = Math.min(pendingDtSec, MAX_TASK_DT_SEC);
			pendingDtSec = 0;
			return { run: true, dtSec, pendingDtSec: 0 };
		},
		setRate(nextRate: FrameGateRate) {
			rate = nextRate;
			clearTimingState();
		},
		reset(nowMs?: number) {
			clearTimingState(nowMs);
		},
		getPendingDtSec: () => pendingDtSec,
	};
}

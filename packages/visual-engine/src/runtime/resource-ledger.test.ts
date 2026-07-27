import { expect, test } from "bun:test";
import {
	createVisualResourceLedger,
	type VisualResourceBudget,
} from "../index";

const budget: VisualResourceBudget = {
	textureBytes: 100,
	geometryBytes: 50,
	meshCount: 10,
	queuedTaskCost: 20,
	cacheBytes: 200,
};

test("admitted allocations track current, peak, pressure, and exactly-once releases", () => {
	const ledger = createVisualResourceLedger({ budget });

	expect(ledger.getSnapshot()).toEqual({
		current: {
			textureBytes: 0,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 0,
		},
		peak: {
			textureBytes: 0,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 0,
		},
		budget,
		pressure: "normal",
		allocations: 0,
		releases: 0,
	});

	const first = ledger.admit(
		{ textureBytes: 79, queuedTaskCost: 5 },
		"normal",
	);
	expect(first.admitted).toBe(true);
	expect(first.projectedPressure).toBe("normal");
	expect(first.allocation).not.toBeNull();

	const threshold = ledger.admit(
		{ textureBytes: 1, cacheBytes: 160 },
		"normal",
	);
	expect(threshold.admitted).toBe(true);
	expect(threshold.projectedPressure).toBe("soft");
	expect(ledger.getSnapshot()).toEqual({
		current: {
			textureBytes: 80,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 5,
			cacheBytes: 160,
		},
		peak: {
			textureBytes: 80,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 5,
			cacheBytes: 160,
		},
		budget,
		pressure: "soft",
		allocations: 2,
		releases: 0,
	});

	threshold.allocation?.release();
	threshold.allocation?.release();
	expect(threshold.allocation?.released).toBe(true);
	expect(ledger.getSnapshot()).toEqual({
		current: {
			textureBytes: 79,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 5,
			cacheBytes: 0,
		},
		peak: {
			textureBytes: 80,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 5,
			cacheBytes: 160,
		},
		budget,
		pressure: "normal",
		allocations: 2,
		releases: 1,
	});

	first.allocation?.release();
	expect(ledger.getSnapshot().current).toEqual({
		textureBytes: 0,
		geometryBytes: 0,
		meshCount: 0,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});
	expect(ledger.getSnapshot().releases).toBe(2);
});

test("hard projected pressure denies only optional and background allocations", () => {
	const ledger = createVisualResourceLedger({
		budget: {
			textureBytes: 10,
			geometryBytes: 10,
			meshCount: 10,
			queuedTaskCost: 10,
			cacheBytes: 10,
		},
	});
	const atBudget = ledger.admit({ queuedTaskCost: 10 }, "normal");
	expect(atBudget.admitted).toBe(true);
	expect(atBudget.projectedPressure).toBe("soft");
	expect(ledger.getSnapshot().pressure).toBe("soft");

	const beforeDenials = ledger.getSnapshot();
	const optional = ledger.admit({ queuedTaskCost: 1 }, "optional");
	const background = ledger.admit({ cacheBytes: 11 }, "background");
	expect(optional.admitted).toBe(false);
	expect(optional.projectedPressure).toBe("hard");
	expect(optional.allocation).toBeNull();
	expect(background.admitted).toBe(false);
	expect(background.projectedPressure).toBe("hard");
	expect(background.allocation).toBeNull();
	expect(ledger.getSnapshot()).toEqual(beforeDenials);

	const normal = ledger.admit({ queuedTaskCost: 1 }, "normal");
	const essential = ledger.admit({ geometryBytes: 11 }, "essential");
	expect(normal.admitted).toBe(true);
	expect(essential.admitted).toBe(true);
	expect(ledger.getSnapshot()).toEqual({
		current: {
			textureBytes: 0,
			geometryBytes: 11,
			meshCount: 0,
			queuedTaskCost: 11,
			cacheBytes: 0,
		},
		peak: {
			textureBytes: 0,
			geometryBytes: 11,
			meshCount: 0,
			queuedTaskCost: 11,
			cacheBytes: 0,
		},
		budget: {
			textureBytes: 10,
			geometryBytes: 10,
			meshCount: 10,
			queuedTaskCost: 10,
			cacheBytes: 10,
		},
		pressure: "hard",
		allocations: 3,
		releases: 0,
	});

	normal.allocation?.release();
	essential.allocation?.release();
	expect(ledger.getSnapshot().pressure).toBe("soft");
	atBudget.allocation?.release();
	expect(ledger.getSnapshot()).toEqual({
		current: {
			textureBytes: 0,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 0,
		},
		peak: {
			textureBytes: 0,
			geometryBytes: 11,
			meshCount: 0,
			queuedTaskCost: 11,
			cacheBytes: 0,
		},
		budget: {
			textureBytes: 10,
			geometryBytes: 10,
			meshCount: 10,
			queuedTaskCost: 10,
			cacheBytes: 10,
		},
		pressure: "normal",
		allocations: 3,
		releases: 3,
	});
});

test("budget, usage, admissions, and snapshots do not retain mutable aliases", () => {
	const mutableBudget = { ...budget };
	const ledger = createVisualResourceLedger({ budget: mutableBudget });
	mutableBudget.textureBytes = 1;

	const mutableUsage = { textureBytes: 25, cacheBytes: 50 };
	const admission = ledger.admit(mutableUsage, "normal");
	mutableUsage.textureBytes = 99;
	(admission.usage as { textureBytes: number }).textureBytes = 88;
	(admission.projected as { textureBytes: number }).textureBytes = 77;
	(admission.allocation?.usage as { textureBytes: number }).textureBytes = 66;

	const snapshot = ledger.getSnapshot();
	(snapshot.current as { textureBytes: number }).textureBytes = 55;
	(snapshot.peak as { textureBytes: number }).textureBytes = 44;
	(snapshot.budget as { textureBytes: number }).textureBytes = 33;

	expect(ledger.getSnapshot()).toEqual({
		current: {
			textureBytes: 25,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 50,
		},
		peak: {
			textureBytes: 25,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 50,
		},
		budget,
		pressure: "normal",
		allocations: 1,
		releases: 0,
	});

	admission.allocation?.release();
	expect(ledger.getSnapshot().current).toEqual({
		textureBytes: 0,
		geometryBytes: 0,
		meshCount: 0,
		queuedTaskCost: 0,
		cacheBytes: 0,
	});
});

test("invalid budgets, usages, and soft pressure ratios are rejected", () => {
	for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		for (const field of Object.keys(budget) as (keyof VisualResourceBudget)[]) {
			expect(() =>
				createVisualResourceLedger({
					budget: { ...budget, [field]: invalid },
				}),
			).toThrow(RangeError);
		}
	}

	for (const softPressureRatio of [
		0,
		1,
		-0.1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	]) {
		expect(() =>
			createVisualResourceLedger({ budget, softPressureRatio }),
		).toThrow(RangeError);
	}

	const zeroBudget = createVisualResourceLedger({
		budget: {
			textureBytes: 0,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 0,
		},
	});
	expect(zeroBudget.getSnapshot().pressure).toBe("normal");

	const ledger = createVisualResourceLedger({ budget });
	for (const invalid of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
		for (const field of Object.keys(budget) as (keyof VisualResourceBudget)[]) {
			expect(() => ledger.admit({ [field]: invalid }, "normal")).toThrow(
				RangeError,
			);
		}
	}
	expect(ledger.getSnapshot()).toEqual({
		current: {
			textureBytes: 0,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 0,
		},
		peak: {
			textureBytes: 0,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 0,
		},
		budget,
		pressure: "normal",
		allocations: 0,
		releases: 0,
	});
});

test("custom soft thresholds and zero budgets have explicit boundaries", () => {
	const custom = createVisualResourceLedger({ budget, softPressureRatio: 0.5 });
	expect(custom.admit({ textureBytes: 49 }, "normal").projectedPressure).toBe(
		"normal",
	);
	expect(custom.admit({ textureBytes: 1 }, "normal").projectedPressure).toBe(
		"soft",
	);

	const zeroBudget = createVisualResourceLedger({
		budget: {
			textureBytes: 0,
			geometryBytes: 0,
			meshCount: 0,
			queuedTaskCost: 0,
			cacheBytes: 0,
		},
	});
	expect(zeroBudget.admit({}, "optional").projectedPressure).toBe("normal");
	const denied = zeroBudget.admit({ cacheBytes: 1 }, "optional");
	expect(denied.admitted).toBe(false);
	expect(denied.projectedPressure).toBe("hard");
	expect(zeroBudget.getSnapshot().pressure).toBe("normal");
});

test("finite allocations that overflow their projected sum are rejected atomically", () => {
	const ledger = createVisualResourceLedger({
		budget: {
			textureBytes: Number.MAX_VALUE,
			geometryBytes: 1,
			meshCount: 1,
			queuedTaskCost: 1,
			cacheBytes: 1,
		},
	});
	const first = ledger.admit({ textureBytes: Number.MAX_VALUE }, "essential");
	const beforeOverflow = ledger.getSnapshot();

	expect(() =>
		ledger.admit({ textureBytes: Number.MAX_VALUE }, "normal"),
	).toThrow(RangeError);
	expect(ledger.getSnapshot()).toEqual(beforeOverflow);

	first.allocation?.release();
	expect(ledger.getSnapshot().current.textureBytes).toBe(0);
});

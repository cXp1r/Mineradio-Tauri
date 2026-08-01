import { expect, test } from "bun:test";
import { createGpuFrameTimer } from "./gpu-frame-timer";

interface FakeQuery {
	readonly id: number;
}

class FakeGpuTimerContext {
	readonly QUERY_RESULT_AVAILABLE = 0x8867;
	readonly QUERY_RESULT = 0x8866;
	readonly extension = {
		TIME_ELAPSED_EXT: 0x88bf,
		GPU_DISJOINT_EXT: 0x8fbb,
	};
	readonly deleted: FakeQuery[] = [];
	readonly queries: FakeQuery[] = [];
	available = false;
	disjoint = false;
	contextLost = false;
	resultNanoseconds = 2_500_000;
	beginCalls = 0;
	endCalls = 0;
	availabilityReads = 0;
	resultReads = 0;

	getExtension(name: string) {
		return name === "EXT_disjoint_timer_query_webgl2" ? this.extension : null;
	}

	createQuery(): FakeQuery {
		const query = { id: this.queries.length + 1 };
		this.queries.push(query);
		return query;
	}

	deleteQuery(query: FakeQuery): void {
		this.deleted.push(query);
	}

	beginQuery(): void {
		this.beginCalls += 1;
	}

	endQuery(): void {
		this.endCalls += 1;
	}

	getQueryParameter(_query: FakeQuery, parameter: number): unknown {
		if (parameter === this.QUERY_RESULT_AVAILABLE) {
			this.availabilityReads += 1;
			return this.available;
		}
		if (parameter === this.QUERY_RESULT) {
			this.resultReads += 1;
			if (!this.available) throw new Error("同步读取了尚未完成的 GPU query");
			return this.resultNanoseconds;
		}
		throw new Error(`unexpected query parameter ${parameter}`);
	}

	getParameter(parameter: number): unknown {
		if (parameter === this.extension.GPU_DISJOINT_EXT) return this.disjoint;
		throw new Error(`unexpected parameter ${parameter}`);
	}

	isContextLost(): boolean {
		return this.contextLost;
	}
}

test("GPU timer 只在 query 可用后非阻塞读取真实 sample", () => {
	const gl = new FakeGpuTimerContext();
	const timer = createGpuFrameTimer(gl as never, { capacity: 5 });
	let rendered = 0;

	timer.capture(() => { rendered += 1; });
	const pending = timer.getSnapshot();

	expect(rendered).toBe(1);
	expect(pending.extensionSupported).toBe(true);
	expect(pending.sampleCount).toBe(0);
	expect(pending.pendingQueryCount).toBe(1);
	expect(gl.resultReads).toBe(0);

	gl.available = true;
	const measured = timer.getSnapshot();
	expect(measured.sampleCount).toBe(1);
	expect(measured.pendingQueryCount).toBe(0);
	expect(measured.p50Ms).toBe(2.5);
	expect(measured.p95Ms).toBe(2.5);
	expect(gl.resultReads).toBe(1);
	expect(gl.deleted).toHaveLength(1);

	timer.dispose();
});

test("渲染异常仍结束 GPU query 并保留原始异常", () => {
	const gl = new FakeGpuTimerContext();
	const timer = createGpuFrameTimer(gl as never);
	const renderError = new Error("render failed");

	expect(() => timer.capture(() => { throw renderError; })).toThrow(renderError);
	expect(gl.beginCalls).toBe(1);
	expect(gl.endCalls).toBe(1);
	expect(timer.getSnapshot().pendingQueryCount).toBe(1);

	timer.dispose();
	expect(gl.deleted).toHaveLength(1);
});

test("GPU disjoint 会丢弃未决 query 而不会伪造 sample", () => {
	const gl = new FakeGpuTimerContext();
	const timer = createGpuFrameTimer(gl as never);
	timer.capture(() => {});
	gl.available = true;
	gl.disjoint = true;

	const snapshot = timer.getSnapshot();

	expect(snapshot.sampleCount).toBe(0);
	expect(snapshot.pendingQueryCount).toBe(0);
	expect(snapshot.disjointQueryCount).toBe(1);
	expect(gl.resultReads).toBe(0);
	expect(gl.deleted).toHaveLength(1);
	timer.dispose();
});

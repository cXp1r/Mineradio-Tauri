interface DisjointTimerQueryExtension {
	readonly TIME_ELAPSED_EXT: number;
	readonly GPU_DISJOINT_EXT: number;
}

interface TimerQueryContext {
	readonly QUERY_RESULT_AVAILABLE: number;
	readonly QUERY_RESULT: number;
	getExtension(name: "EXT_disjoint_timer_query_webgl2"): DisjointTimerQueryExtension | null;
	createQuery(): WebGLQuery | null;
	deleteQuery(query: WebGLQuery): void;
	beginQuery(target: number, query: WebGLQuery): void;
	endQuery(target: number): void;
	getQueryParameter(query: WebGLQuery, parameter: number): unknown;
	getParameter(parameter: number): unknown;
	isContextLost?(): boolean;
}

export interface GpuFrameTimingSnapshot {
	readonly extensionSupported: boolean;
	readonly sampleCount: number;
	readonly pendingQueryCount: number;
	readonly p50Ms: number | null;
	readonly p95Ms: number | null;
	readonly disjointQueryCount: number;
	readonly droppedQueryCount: number;
	readonly errorCount: number;
	readonly contextLost: boolean;
}

export interface GpuFrameTimer {
	capture<T>(render: () => T): T;
	getSnapshot(): GpuFrameTimingSnapshot;
	dispose(): void;
}

export interface GpuFrameTimerOptions {
	readonly capacity?: number;
	readonly maxPendingQueries?: number;
}

class FixedGpuSampleBuffer {
	readonly #samples: Float64Array;
	#length = 0;
	#next = 0;

	constructor(capacity: number) {
		this.#samples = new Float64Array(capacity);
	}

	get length(): number {
		return this.#length;
	}

	push(value: number): void {
		this.#samples[this.#next] = value;
		this.#next = (this.#next + 1) % this.#samples.length;
		this.#length = Math.min(this.#length + 1, this.#samples.length);
	}

	percentile(percent: number): number | null {
		if (this.#length === 0) return null;
		const ordered = Array.from(this.#samples.slice(0, this.#length)).sort((left, right) => left - right);
		return ordered[Math.ceil(percent * ordered.length) - 1] ?? null;
	}
}

function isTimerQueryContext(value: WebGLRenderingContext | WebGL2RenderingContext): value is WebGL2RenderingContext & TimerQueryContext {
	const candidate = value as Partial<TimerQueryContext>;
	return typeof candidate.createQuery === "function"
		&& typeof candidate.deleteQuery === "function"
		&& typeof candidate.beginQuery === "function"
		&& typeof candidate.endQuery === "function"
		&& typeof candidate.getQueryParameter === "function";
}

export function createGpuFrameTimer(
	context: WebGLRenderingContext | WebGL2RenderingContext,
	options: GpuFrameTimerOptions = {},
): GpuFrameTimer {
	const capacity = Math.max(1, Math.floor(options.capacity ?? 240));
	const maxPendingQueries = Math.max(1, Math.floor(options.maxPendingQueries ?? 8));
	const gl = isTimerQueryContext(context) ? context : null;
	let extension: DisjointTimerQueryExtension | null = null;
	try {
		extension = gl?.getExtension("EXT_disjoint_timer_query_webgl2") ?? null;
	} catch {
		extension = null;
	}
	const samples = new FixedGpuSampleBuffer(capacity);
	const pending: WebGLQuery[] = [];
	let disposed = false;
	let contextLost = false;
	let disjointQueryCount = 0;
	let droppedQueryCount = 0;
	let errorCount = 0;

	const deleteQuery = (query: WebGLQuery): void => {
		if (!gl) return;
		try {
			gl.deleteQuery(query);
		} catch {
			errorCount += 1;
		}
	};

	const drainAvailable = (): void => {
		if (!gl || !extension || disposed) return;
		if (gl.isContextLost?.()) {
			contextLost = true;
			for (const query of pending.splice(0)) deleteQuery(query);
			return;
		}
		try {
			if (Boolean(gl.getParameter(extension.GPU_DISJOINT_EXT))) {
				disjointQueryCount += pending.length;
				for (const query of pending.splice(0)) deleteQuery(query);
				return;
			}
		} catch {
			errorCount += 1;
			droppedQueryCount += pending.length;
			for (const query of pending.splice(0)) deleteQuery(query);
			return;
		}
		while (pending.length > 0) {
			const query = pending[0];
			if (!query) break;
			let available = false;
			try {
				available = Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE));
			} catch {
				errorCount += 1;
				pending.shift();
				deleteQuery(query);
				continue;
			}
			if (!available) break;
			pending.shift();
			try {
				const nanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
				if (Number.isFinite(nanoseconds) && nanoseconds >= 0) samples.push(nanoseconds / 1_000_000);
				else droppedQueryCount += 1;
			} catch {
				errorCount += 1;
				droppedQueryCount += 1;
			} finally {
				deleteQuery(query);
			}
		}
	};

	return {
		capture(render) {
			drainAvailable();
			if (!gl || !extension || disposed || contextLost || pending.length >= maxPendingQueries) return render();
			const query = gl.createQuery();
			if (!query) return render();
			try {
				gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
			} catch {
				errorCount += 1;
				deleteQuery(query);
				return render();
			}
			try {
				return render();
			} finally {
				try {
					gl.endQuery(extension.TIME_ELAPSED_EXT);
					pending.push(query);
				} catch {
					errorCount += 1;
					deleteQuery(query);
				}
			}
		},
		getSnapshot() {
			drainAvailable();
			return {
				extensionSupported: extension !== null,
				sampleCount: samples.length,
				pendingQueryCount: pending.length,
				p50Ms: samples.percentile(0.5),
				p95Ms: samples.percentile(0.95),
				disjointQueryCount,
				droppedQueryCount,
				errorCount,
				contextLost,
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const query of pending.splice(0)) deleteQuery(query);
		},
	};
}

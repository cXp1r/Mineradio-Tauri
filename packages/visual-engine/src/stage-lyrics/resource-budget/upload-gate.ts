import type { LyricTextureLease } from "../textures/texture-lease";

export interface StageLyricUploadBatch<Candidate> {
	readonly owner: string;
	readonly key: string;
	readonly generation: number;
	readonly leases: readonly LyricTextureLease[];
	readonly candidate: Candidate;
	isCurrent(): boolean;
	release(): void;
}

export interface StageLyricUploadResult<Candidate> {
	readonly status: "uploaded" | "ready";
	readonly batch: StageLyricUploadBatch<Candidate>;
	readonly uploadedLease: LyricTextureLease | null;
	readonly remainingTextures: number;
}

export interface StageLyricUploadDiagnostics {
	readonly pendingReplacementCount: 0 | 1;
	readonly pendingTextures: number;
	readonly uploadsThisFrame: number;
	readonly uploadedTextures: number;
	readonly replacedBatches: number;
	readonly staleBatches: number;
	readonly failedBatches: number;
}

export interface StageLyricUploadGate<Candidate> {
	beginFrame(frameId: number): void;
	enqueue(batch: StageLyricUploadBatch<Candidate>): boolean;
	uploadOne(executor: (lease: LyricTextureLease) => void): StageLyricUploadResult<Candidate> | null;
	takeReady(): StageLyricUploadBatch<Candidate> | null;
	cancelOwner(owner: string): void;
	getDiagnostics(): StageLyricUploadDiagnostics;
	dispose(): void;
}

interface PendingBatch<Candidate> {
	readonly batch: StageLyricUploadBatch<Candidate>;
	readonly uploadLeases: readonly LyricTextureLease[];
	nextTextureIndex: number;
}

function assertBatch(batch: StageLyricUploadBatch<unknown>): void {
	if (!batch.owner || !batch.key) throw new TypeError("Stage upload owner and key are required.");
	if (!Number.isInteger(batch.generation) || batch.generation < 0) {
		throw new RangeError("Stage upload generation must be a non-negative integer.");
	}
}

export function createStageLyricUploadGate<Candidate = unknown>(): StageLyricUploadGate<Candidate> {
	let pending: PendingBatch<Candidate> | null = null;
	let ready: StageLyricUploadBatch<Candidate> | null = null;
	let frameId: number | null = null;
	let uploadsThisFrame = 0;
	let uploadedTextures = 0;
	let replacedBatches = 0;
	let staleBatches = 0;
	let failedBatches = 0;
	let disposed = false;

	const releaseBatch = (batch: StageLyricUploadBatch<Candidate> | null) => {
		if (!batch) return;
		try {
			batch.release();
		} catch {
			// Batch 自身必须幂等；异常也不能阻断 gate 清空引用。
		}
	};
	const clearOwnedCandidate = () => {
		if (pending) releaseBatch(pending.batch);
		if (ready && ready !== pending?.batch) releaseBatch(ready);
		pending = null;
		ready = null;
	};
	const pendingReplacementCount = (): 0 | 1 => pending || ready ? 1 : 0;

	return {
		beginFrame(nextFrameId) {
			if (!Number.isInteger(nextFrameId) || nextFrameId < 0) {
				throw new RangeError("Stage upload frameId must be a non-negative integer.");
			}
			if (frameId !== null && nextFrameId <= frameId) return;
			frameId = nextFrameId;
			uploadsThisFrame = 0;
		},
		enqueue(batch) {
			assertBatch(batch as StageLyricUploadBatch<unknown>);
			if (disposed) {
				releaseBatch(batch);
				return false;
			}
			if (!batch.isCurrent()) {
				staleBatches += 1;
				releaseBatch(batch);
				return false;
			}
			const existing = pending?.batch ?? ready;
			if (existing === batch) return true;
			if (
				existing &&
				existing.owner === batch.owner &&
				existing.key === batch.key &&
				batch.generation <= existing.generation
			) {
				staleBatches += 1;
				releaseBatch(batch);
				return false;
			}
			if (pending || ready) {
				replacedBatches += 1;
				clearOwnedCandidate();
			}
			pending = {
				batch,
				uploadLeases: batch.leases.filter((lease) => lease.ownership === "owned"),
				nextTextureIndex: 0,
			};
			return true;
		},
		uploadOne(executor) {
			if (disposed || !pending || uploadsThisFrame >= 1) return null;
			const current = pending;
			if (!current.batch.isCurrent()) {
				pending = null;
				staleBatches += 1;
				releaseBatch(current.batch);
				return null;
			}
			if (current.nextTextureIndex >= current.uploadLeases.length) {
				pending = null;
				ready = current.batch;
				return {
					status: "ready",
					batch: current.batch,
					uploadedLease: null,
					remainingTextures: 0,
				};
			}
			const lease = current.uploadLeases[current.nextTextureIndex];
			// renderer 可能在真正提交 GPU 调用后抛错；额度必须在调用前消费，
			// 否则同一帧可通过失败重试突破每帧一次的硬限制。
			uploadsThisFrame = 1;
			try {
				executor(lease);
			} catch (error) {
				if (pending === current) pending = null;
				failedBatches += 1;
				releaseBatch(current.batch);
				throw error;
			}
			uploadedTextures += 1;
			if (pending !== current) return null;
			if (!current.batch.isCurrent()) {
				pending = null;
				staleBatches += 1;
				releaseBatch(current.batch);
				return null;
			}
			current.nextTextureIndex += 1;
			const remainingTextures = current.uploadLeases.length - current.nextTextureIndex;
			if (remainingTextures === 0) {
				pending = null;
				ready = current.batch;
			}
			return {
				status: ready === current.batch ? "ready" : "uploaded",
				batch: current.batch,
				uploadedLease: lease,
				remainingTextures,
			};
		},
		takeReady() {
			if (disposed || !ready) return null;
			const batch = ready;
			ready = null;
			if (!batch.isCurrent()) {
				staleBatches += 1;
				releaseBatch(batch);
				return null;
			}
			return batch;
		},
		cancelOwner(owner) {
			if (pending?.batch.owner === owner) {
				const batch = pending.batch;
				pending = null;
				releaseBatch(batch);
			}
			if (ready?.owner === owner) {
				const batch = ready;
				ready = null;
				releaseBatch(batch);
			}
		},
		getDiagnostics() {
			return {
				pendingReplacementCount: pendingReplacementCount(),
				pendingTextures: pending
					? Math.max(0, pending.uploadLeases.length - pending.nextTextureIndex)
					: 0,
				uploadsThisFrame,
				uploadedTextures,
				replacedBatches,
				staleBatches,
				failedBatches,
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearOwnedCandidate();
		},
	};
}

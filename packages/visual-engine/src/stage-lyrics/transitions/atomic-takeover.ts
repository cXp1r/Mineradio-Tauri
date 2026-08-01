export interface StageTakeoverCandidate<Value> {
	readonly owner: string;
	readonly generation: number;
	readonly value: Value;
	isCurrent(): boolean;
	release(): void;
}

export interface StageTakeoverCommit<Value> {
	readonly current: StageTakeoverCandidate<Value>;
	/** 旧 current 的所有权转交给 outgoing transition，由 transition 完成后释放。 */
	readonly outgoing: StageTakeoverCandidate<Value> | null;
}

export interface StageTakeoverTransaction {
	/** 在对应 scene mutation 之前登记；失败时按逆序执行。 */
	deferRollback(rollback: () => void): void;
}

export interface StageAtomicTakeover<Value> {
	adoptInitial(candidate: StageTakeoverCandidate<Value>): boolean;
	offer(candidate: StageTakeoverCandidate<Value>): boolean;
	getCurrent(): StageTakeoverCandidate<Value> | null;
	getPending(): StageTakeoverCandidate<Value> | null;
	commitReady(
		applySceneCommit: (
			next: StageTakeoverCandidate<Value>,
			previous: StageTakeoverCandidate<Value> | null,
			transaction: StageTakeoverTransaction,
		) => void,
	): StageTakeoverCommit<Value> | null;
	failPending(): void;
	/** 释放当前/待提交候选并恢复为可重新 adopt 的空状态。 */
	reset(): void;
	dispose(): void;
}

export function createStageAtomicTakeover<Value>(): StageAtomicTakeover<Value> {
	let current: StageTakeoverCandidate<Value> | null = null;
	let pending: StageTakeoverCandidate<Value> | null = null;
	let disposed = false;

	const release = (candidate: StageTakeoverCandidate<Value> | null) => {
		if (!candidate) return;
		try {
			candidate.release();
		} catch {
			// 单个候选释放失败不能阻断 takeover 状态收口。
		}
	};
	const resetOwnedCandidates = () => {
		const committed = current;
		const replacement = pending;
		current = null;
		pending = null;
		release(replacement);
		if (committed !== replacement) release(committed);
	};

	return {
		adoptInitial(candidate) {
			if (disposed || current) {
				release(candidate);
				return false;
			}
			if (!candidate.isCurrent()) {
				release(candidate);
				return false;
			}
			current = candidate;
			return true;
		},
		offer(candidate) {
			if (disposed) {
				release(candidate);
				return false;
			}
			if (!candidate.isCurrent()) {
				release(candidate);
				return false;
			}
			if (pending) release(pending);
			pending = candidate;
			return true;
		},
		getCurrent() {
			return current;
		},
		getPending() {
			return pending;
		},
		commitReady(applySceneCommit) {
			if (disposed || !pending) return null;
			const next = pending;
			pending = null;
			if (!next.isCurrent()) {
				release(next);
				return null;
			}
			const outgoing = current;
			const rollbacks: Array<() => void> = [];
			const transaction: StageTakeoverTransaction = {
				deferRollback(rollback) {
					rollbacks.push(rollback);
				},
			};
			try {
				applySceneCommit(next, outgoing, transaction);
			} catch (error) {
				for (let index = rollbacks.length - 1; index >= 0; index -= 1) {
					try {
						rollbacks[index]();
					} catch {
						// 单个 scene rollback 失败不能阻断其余补偿动作。
					}
				}
				release(next);
				throw error;
			}
			current = next;
			return { current: next, outgoing };
		},
		failPending() {
			const failed = pending;
			pending = null;
			release(failed);
		},
		reset() {
			if (disposed) return;
			resetOwnedCandidates();
		},
		dispose() {
			if (disposed) return;
			resetOwnedCandidates();
			disposed = true;
		},
	};
}

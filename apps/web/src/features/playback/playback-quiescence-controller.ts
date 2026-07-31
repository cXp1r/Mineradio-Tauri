import type {
	CommittedPlaybackOwnerLease,
} from "../../audio/player-controller";
import type {
	CapturePlaybackExitCheckpointRequest,
	PlaybackExitCheckpointV1,
	PlaybackCheckpointRestoreResult,
	RestorePlaybackExitCheckpointRequest,
} from "../../stores/playback-store";

export interface PlaybackQuiescenceIdentity {
	readonly operationId: string;
	readonly operationGeneration: number;
	readonly receipt: string;
}

export interface PlaybackQuiescenceAudioPort {
	stageCommittedOwnerLease(): CommittedPlaybackOwnerLease | null;
	pauseCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean;
	rollbackCommittedOwnerLease(
		lease: CommittedPlaybackOwnerLease,
	): Promise<boolean>;
	releaseCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean;
	cancelCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean;
}

export interface PlaybackQuiescenceCheckpointPort {
	capturePlaybackExitCheckpoint(
		request: CapturePlaybackExitCheckpointRequest,
	): PlaybackExitCheckpointV1 | null;
	restorePlaybackExitCheckpoint(
		request: RestorePlaybackExitCheckpointRequest,
	): PlaybackCheckpointRestoreResult;
}

export interface PlaybackQuiescenceControllerOptions {
	readonly audio: PlaybackQuiescenceAudioPort;
	readonly checkpoint: PlaybackQuiescenceCheckpointPort;
}

export type PlaybackQuiescencePrepareResult =
	| {
			readonly status: "prepared" | "already-prepared";
			readonly checkpoint: PlaybackExitCheckpointV1;
	  }
	| {
			readonly status: "rejected";
			readonly reason:
				| "operation-active"
				| "checkpoint-rejected"
				| "owner-checkpoint-mismatch"
				| "source-not-restart-restorable";
	  };

export type PlaybackQuiescenceRollbackResult =
	| "restored"
	| "no-op-not-prepared"
	| "no-op-not-paused"
	| "owner-stale"
	| "rejected";

interface ActivePlaybackQuiescence {
	readonly identity: PlaybackQuiescenceIdentity;
	readonly checkpoint: PlaybackExitCheckpointV1 | null;
	readonly owner: CommittedPlaybackOwnerLease | null;
	phase: "not-prepared" | "staged" | "paused" | "pause-failed" | "sealed-for-exit" | "released";
	rollback: Promise<PlaybackQuiescenceRollbackResult> | null;
	rollbackResult: PlaybackQuiescenceRollbackResult | null;
}

function sameIdentity(
	left: PlaybackQuiescenceIdentity,
	right: PlaybackQuiescenceIdentity,
): boolean {
	return left.operationId === right.operationId
		&& left.receipt === right.receipt
		&& left.operationGeneration === right.operationGeneration;
}

function validIdentity(identity: PlaybackQuiescenceIdentity): boolean {
	return /^[0-9a-f]{32}$/u.test(identity.operationId)
		&& Number.isSafeInteger(identity.operationGeneration)
		&& identity.operationGeneration > 0
		&& /^[0-9a-f]{32}$/u.test(identity.receipt);
}

/**
 * Web 播放静默的窄协调器。prepare 只生成 checkpoint 与 owner lease；只有 native
 * 已确认 checkpoint 落盘后，caller 才能用 exact identity 进入暂停阶段。
 */
export class PlaybackQuiescenceController {
	private active: ActivePlaybackQuiescence | null = null;
	private readonly consumed = new Map<number, {
		readonly identity: PlaybackQuiescenceIdentity;
		readonly result: PlaybackQuiescenceRollbackResult;
	}>();
	private highestConsumedGeneration = 0;

	constructor(
		private readonly options: PlaybackQuiescenceControllerOptions,
	) {}

	prepare(identity: PlaybackQuiescenceIdentity): PlaybackQuiescencePrepareResult {
		if (!validIdentity(identity)) {
			return { status: "rejected", reason: "checkpoint-rejected" };
		}
		if (identity.operationGeneration <= this.highestConsumedGeneration) {
			return { status: "rejected", reason: "operation-active" };
		}
		const active = this.active;
		if (active && sameIdentity(active.identity, identity)) {
			return active.phase === "released" || !active.checkpoint
				? { status: "rejected", reason: "operation-active" }
				: { status: "already-prepared", checkpoint: active.checkpoint };
		}
		if (active && active.phase !== "released") {
			return { status: "rejected", reason: "operation-active" };
		}

		const owner = this.options.audio.stageCommittedOwnerLease();
		const checkpoint = this.options.checkpoint.capturePlaybackExitCheckpoint({
			operationId: identity.operationId,
			receipt: identity.receipt,
			sourceKind: owner?.sourceKind ?? "opaque",
			ownerOriginallyPlaying: owner?.originallyPlaying,
		});
		if (!checkpoint) {
			if (owner) this.options.audio.cancelCommittedOwnerLease(owner);
			return { status: "rejected", reason: "checkpoint-rejected" };
		}
		const checkpointHasOwner = checkpoint.currentTrackRef.length > 0;
		if (
			checkpoint.operationId !== identity.operationId
			|| checkpoint.receipt !== identity.receipt
			|| (!!owner !== checkpointHasOwner)
			|| (owner && (
				owner.trackRef !== checkpoint.currentTrackRef
				|| owner.playbackIntentId !== checkpoint.capturedPlaybackIntentId
			))
		) {
			if (owner) this.options.audio.cancelCommittedOwnerLease(owner);
			return { status: "rejected", reason: "owner-checkpoint-mismatch" };
		}
		if (!checkpoint.restartRestorable) {
			if (owner) this.options.audio.cancelCommittedOwnerLease(owner);
			return {
				status: "rejected",
				reason: "source-not-restart-restorable",
			};
		}
		this.active = {
			identity: Object.freeze({ ...identity }),
			checkpoint,
			owner,
			phase: "staged",
			rollback: null,
			rollbackResult: null,
		};
		return { status: "prepared", checkpoint };
	}

	hydratePersistedCheckpoint(
		identity: PlaybackQuiescenceIdentity,
		checkpoint: PlaybackExitCheckpointV1 | null,
	): "hydrated" | "already-hydrated" | "rejected" {
		if (!validIdentity(identity)) return "rejected";
		const consumed = this.consumed.get(identity.operationGeneration);
		if (consumed) return sameIdentity(consumed.identity, identity)
			? "already-hydrated"
			: "rejected";
		if (identity.operationGeneration < this.highestConsumedGeneration) return "rejected";
		if (this.active && this.active.phase !== "released") {
			return sameIdentity(this.active.identity, identity)
				? "already-hydrated"
				: "rejected";
		}
		if (checkpoint && (
			checkpoint.operationId !== identity.operationId
			|| checkpoint.receipt !== identity.receipt
			|| !checkpoint.restartRestorable
		)) return "rejected";
		this.active = {
			identity: Object.freeze({ ...identity }),
			checkpoint,
			owner: null,
			phase: checkpoint ? "paused" : "not-prepared",
			rollback: null,
			rollbackResult: null,
		};
		return "hydrated";
	}

	confirmCheckpointPersisted(identity: PlaybackQuiescenceIdentity): boolean {
		const active = this.active;
		if (!active || !sameIdentity(active.identity, identity)) return false;
		if (active.phase === "paused") return true;
		if (active.phase !== "staged") return false;
		if (!active.owner) {
			active.phase = "paused";
			return true;
		}
		const paused = this.options.audio.pauseCommittedOwnerLease(active.owner);
		active.phase = paused ? "paused" : "pause-failed";
		return paused;
	}

	rollback(
		identity: PlaybackQuiescenceIdentity,
	): Promise<PlaybackQuiescenceRollbackResult> {
		const active = this.active;
		if (!active) {
			const prior = this.consumed.get(identity.operationGeneration);
			if (prior) {
				return Promise.resolve(sameIdentity(prior.identity, identity)
					? prior.result
					: "rejected");
			}
			if (!validIdentity(identity)) return Promise.resolve("rejected");
			return Promise.resolve("rejected");
		}
		if (!sameIdentity(active.identity, identity)) {
			return Promise.resolve("rejected");
		}
		if (active.rollback) return active.rollback;
		if (active.rollbackResult) return Promise.resolve(active.rollbackResult);
		if (active.phase === "not-prepared") {
			active.phase = "released";
			active.rollbackResult = this.consume(active.identity, "no-op-not-prepared");
			return Promise.resolve(active.rollbackResult);
		}
		if (!active.owner && active.checkpoint) {
			const restored = this.options.checkpoint.restorePlaybackExitCheckpoint({
				operationId: active.identity.operationId,
				receipt: active.identity.receipt,
				mode: "restart-reconciliation",
				checkpoint: active.checkpoint,
			});
			active.phase = "released";
			active.rollbackResult = this.consume(
				active.identity,
				restored === "restored" || restored === "already-restored"
					? "restored"
					: "rejected",
			);
			return Promise.resolve(active.rollbackResult);
		}
		if (
			(active.phase !== "paused" && active.phase !== "sealed-for-exit")
			|| !active.owner
		) {
			if (active.owner) this.options.audio.cancelCommittedOwnerLease(active.owner);
			active.phase = "released";
			active.rollbackResult = this.consume(active.identity, "no-op-not-paused");
			return Promise.resolve(active.rollbackResult);
		}
		const checkpoint = active.checkpoint;
		active.rollback = this.options.audio.rollbackCommittedOwnerLease(active.owner)
			.then((restored) => {
				const storeRestored = restored && checkpoint
					? this.options.checkpoint.restorePlaybackExitCheckpoint({
						operationId: active.identity.operationId,
						receipt: active.identity.receipt,
						mode: "same-process-rollback",
						checkpoint,
					})
					: null;
				const result: PlaybackQuiescenceRollbackResult = !restored
					? "owner-stale"
					: storeRestored === "restored" || storeRestored === "already-restored"
						? "restored"
						: "rejected";
				active.phase = "released";
				active.rollbackResult = this.consume(active.identity, result);
				return result;
			}, () => {
				active.phase = "released";
				active.rollbackResult = this.consume(active.identity, "owner-stale");
				return "owner-stale";
			});
		return active.rollback;
	}

	releaseForExit(identity: PlaybackQuiescenceIdentity): boolean {
		const active = this.active;
		if (!active || !sameIdentity(active.identity, identity)) return false;
		if (active.phase === "released") return true;
		if (active.phase === "sealed-for-exit") return true;
		if (active.phase !== "paused") return false;
		if (active.owner && !this.options.audio.releaseCommittedOwnerLease(active.owner)) {
			return false;
		}
		active.phase = "sealed-for-exit";
		return true;
	}

	private consume(
		identity: PlaybackQuiescenceIdentity,
		result: PlaybackQuiescenceRollbackResult,
	): PlaybackQuiescenceRollbackResult {
		const frozenIdentity = Object.freeze({ ...identity });
		this.consumed.set(identity.operationGeneration, {
			identity: frozenIdentity,
			result,
		});
		this.highestConsumedGeneration = Math.max(
			this.highestConsumedGeneration,
			identity.operationGeneration,
		);
		while (this.consumed.size > 32) {
			const oldest = this.consumed.keys().next().value;
			if (oldest === undefined) break;
			this.consumed.delete(oldest);
		}
		return result;
	}
}

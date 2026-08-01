import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import type { CommittedPlaybackOwnerLease } from "../../audio/player-controller";
import type {
	CapturePlaybackExitCheckpointRequest,
	PlaybackExitCheckpointV1,
} from "../../stores/playback-store";
import { usePlaybackStore } from "../../stores/playback-store";
import { PlaybackQuiescenceController } from "./playback-quiescence-controller";

const OPERATION_A = "00000000000000000000000000000001";
const OPERATION_B = "00000000000000000000000000000002";
const RECEIPT_A = "10000000000000000000000000000001";
const RECEIPT_B = "10000000000000000000000000000002";

function identity(
	operationGeneration: number,
	operationId = OPERATION_A,
	receipt = RECEIPT_A,
) {
	return { operationId, operationGeneration, receipt } as const;
}

function operationIdentity(
	operationGeneration: number,
	operationId = OPERATION_A,
) {
	return { operationId, operationGeneration } as const;
}

const OWNER: CommittedPlaybackOwnerLease = Object.freeze({
	deckId: "a",
	generation: 7,
	originallyPlaying: true,
	sourceKind: "remote",
	trackRef: "netease:track",
	playbackIntentId: 7,
});

function checkpointFor(
	request: CapturePlaybackExitCheckpointRequest,
): PlaybackExitCheckpointV1 {
	return {
		schema: "playback-exit-checkpoint-v1",
		operationId: request.operationId,
		receipt: request.receipt,
		queue: [],
		currentTrackIndex: 0,
		currentTrackRef: "netease:track",
		capturedPlaybackIntentId: 7,
		positionMs: 0,
		durationMs: null,
		wasPlaying: false,
		mode: "loop",
		volume: 0.84,
		muted: false,
		sourceKind: "remote",
		restartRestorable: true,
	};
}

const restoreCheckpoint = () => "restored" as const;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("quiescence prepare stages checkpoint before exact owner pause", () => {
	const calls: string[] = [];
	const capturedRequests: CapturePlaybackExitCheckpointRequest[] = [];
	let receiptCalls = 0;
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => {
			receiptCalls += 1;
			return RECEIPT_A;
		},
		audio: {
			stageCommittedOwnerLease() {
				calls.push("stage-owner");
				return OWNER;
			},
			pauseCommittedOwnerLease(lease) {
				calls.push(`pause-${lease.generation}`);
				return true;
			},
			async rollbackCommittedOwnerLease() {
				calls.push("rollback-owner");
				return true;
			},
			releaseCommittedOwnerLease() {
				calls.push("release-owner");
				return true;
			},
			cancelCommittedOwnerLease() {
				calls.push("cancel-owner");
				return true;
			},
		},
		checkpoint: {
			capturePlaybackExitCheckpoint(request) {
				calls.push("capture-checkpoint");
				capturedRequests.push(request);
				return checkpointFor(request);
			},
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});

	const operation = operationIdentity(1);
	const prepared = controller.prepare(operation);
	expect(prepared.status).toBe("prepared");
	if (prepared.status !== "prepared") throw new Error("checkpoint 应已生成");
	const exact = { ...operation, receipt: prepared.checkpoint.receipt };
	expect(controller.prepare(operation)).toEqual({
		status: "already-prepared",
		checkpoint: prepared.checkpoint,
	});
	expect(receiptCalls).toBe(1);
	expect(calls).toEqual(["stage-owner", "capture-checkpoint"]);
	expect(capturedRequests[0]?.ownerOriginallyPlaying).toBe(true);
	expect(controller.confirmCheckpointPersisted(exact)).toBe(true);
	expect(calls).toEqual([
		"stage-owner",
		"capture-checkpoint",
		"pause-7",
	]);
});

test("stale operation or receipt cannot pause the staged owner", () => {
	let pauseCalls = 0;
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => OWNER,
			pauseCommittedOwnerLease: () => {
				pauseCalls += 1;
				return true;
			},
			rollbackCommittedOwnerLease: async () => true,
			releaseCommittedOwnerLease: () => true,
			cancelCommittedOwnerLease: () => true,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: checkpointFor,
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});
	controller.prepare(identity(2));

	expect(controller.confirmCheckpointPersisted(identity(1, OPERATION_B, RECEIPT_A)))
		.toBe(false);
	expect(controller.confirmCheckpointPersisted(identity(2, OPERATION_A, RECEIPT_B)))
		.toBe(false);
	expect(pauseCalls).toBe(0);
});

test("local, blob, and opaque owners fail closed before pause", () => {
	for (const sourceKind of ["local", "blob", "opaque"] as const) {
		let pauseCalls = 0;
		let releaseCalls = 0;
		const owner = Object.freeze({ ...OWNER, sourceKind });
		const controller = new PlaybackQuiescenceController({
			createReceipt: () => RECEIPT_A,
			audio: {
				stageCommittedOwnerLease: () => owner,
				pauseCommittedOwnerLease: () => {
					pauseCalls += 1;
					return true;
				},
				rollbackCommittedOwnerLease: async () => true,
				releaseCommittedOwnerLease: () => {
					releaseCalls += 1;
					return true;
				},
				cancelCommittedOwnerLease: () => {
					releaseCalls += 1;
					return true;
				},
			},
			checkpoint: {
				capturePlaybackExitCheckpoint(request) {
					return {
						...checkpointFor(request),
						sourceKind,
						restartRestorable: false,
					};
				},
				restorePlaybackExitCheckpoint: restoreCheckpoint,
			},
		});

		expect(controller.prepare(identity(3))).toEqual({
			status: "rejected",
			reason: "source-not-restart-restorable",
		});
		expect(pauseCalls).toBe(0);
		expect(releaseCalls).toBe(1);
	}
});

test("quiescence rollback is exact and idempotently restores original owner state", async () => {
	let rollbackCalls = 0;
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => OWNER,
			pauseCommittedOwnerLease: () => true,
			rollbackCommittedOwnerLease: async () => {
				rollbackCalls += 1;
				return true;
			},
			releaseCommittedOwnerLease: () => true,
			cancelCommittedOwnerLease: () => true,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: checkpointFor,
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});
	const exact = identity(4);
	controller.prepare(exact);
	controller.confirmCheckpointPersisted(exact);

	expect(await controller.rollback(identity(3, OPERATION_B, RECEIPT_A)))
		.toBe("rejected");
	expect(await controller.rollback(identity(4, OPERATION_A, RECEIPT_B)))
		.toBe("rejected");
	expect(await controller.rollback(exact)).toBe("restored");
	expect(await controller.rollback(exact)).toBe("restored");
	expect(rollbackCalls).toBe(1);
});

test("same-process rollback restores the captured store snapshot and audio owner", async () => {
	const capturedTrack: Track = {
		provider: "netease",
		id: "track",
		sourceId: "track",
		title: "捕获曲目",
		artists: ["歌手"],
		album: "捕获专辑",
		coverUrl: "https://image.example/cover.jpg?token=secret",
		qualityHints: ["standard"],
		playableState: "playable",
	};
	const replacementTrack: Track = {
		...capturedTrack,
		id: "replacement",
		sourceId: "replacement",
		title: "替换曲目",
	};
	usePlaybackStore.setState({
		currentTrack: capturedTrack,
		playbackIntentId: 7,
		isPlaying: true,
		positionMs: 12_345,
		durationMs: 98_765,
		volume: 0.42,
		muted: true,
		mode: "queue",
		queue: [capturedTrack],
		checkpointRestore: null,
	});
	let ownerRollbackCalls = 0;
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => OWNER,
			pauseCommittedOwnerLease: () => true,
			rollbackCommittedOwnerLease: async () => {
				ownerRollbackCalls += 1;
				return true;
			},
			releaseCommittedOwnerLease: () => true,
			cancelCommittedOwnerLease: () => true,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: (request) => (
				usePlaybackStore.getState().capturePlaybackExitCheckpoint(request)
			),
			restorePlaybackExitCheckpoint: (request) => (
				usePlaybackStore.getState().restorePlaybackExitCheckpoint(request)
			),
		},
	});
	const exact = identity(10);
	expect(controller.prepare(exact).status).toBe("prepared");
	expect(controller.confirmCheckpointPersisted(exact)).toBe(true);
	usePlaybackStore.setState({
		currentTrack: replacementTrack,
		playbackIntentId: 8,
		isPlaying: false,
		positionMs: 1,
		durationMs: 2,
		volume: 1,
		muted: false,
		mode: "single",
		queue: [replacementTrack],
	});

	expect(await controller.rollback(exact)).toBe("restored");
	const restored = usePlaybackStore.getState();
	expect(restored.currentTrack?.id).toBe("track");
	expect(restored.queue.map((track) => track.id)).toEqual(["track"]);
	expect(restored.positionMs).toBe(12_345);
	expect(restored.durationMs).toBe(98_765);
	expect(restored.isPlaying).toBe(true);
	expect(restored.mode).toBe("queue");
	expect(restored.volume).toBe(0.42);
	expect(restored.muted).toBe(true);
	expect(ownerRollbackCalls).toBe(1);
	usePlaybackStore.setState({
		currentTrack: null,
		playbackIntentId: 0,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		volume: 0.84,
		muted: false,
		mode: "loop",
		queue: [],
		checkpointRestore: null,
	});
});

test("same-process rollback publishes checkpoint state only after exact owner resume settles", async () => {
	const capturedTrack: Track = {
		provider: "netease",
		id: "captured",
		sourceId: "captured",
		title: "捕获曲目",
		artists: ["歌手"],
		album: "捕获专辑",
		coverUrl: "",
		qualityHints: ["standard"],
		playableState: "playable",
	};
	const replacementTrack: Track = {
		...capturedTrack,
		id: "replacement",
		sourceId: "replacement",
		title: "替换曲目",
	};
	usePlaybackStore.setState({
		currentTrack: capturedTrack,
		playbackIntentId: 21,
		isPlaying: true,
		positionMs: 12_345,
		durationMs: 98_765,
		volume: 0.42,
		muted: false,
		mode: "queue",
		queue: [capturedTrack],
		checkpointRestore: null,
	});
	const ownerResume = deferred<boolean>();
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => ({
				...OWNER,
				trackRef: "netease:captured",
				playbackIntentId: 21,
			}),
			pauseCommittedOwnerLease: () => true,
			rollbackCommittedOwnerLease: () => ownerResume.promise,
			releaseCommittedOwnerLease: () => true,
			cancelCommittedOwnerLease: () => true,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: (request) => (
				usePlaybackStore.getState().capturePlaybackExitCheckpoint(request)
			),
			restorePlaybackExitCheckpoint: (request) => (
				usePlaybackStore.getState().restorePlaybackExitCheckpoint(request)
			),
		},
	});
	const exact = identity(12);
	expect(controller.prepare(exact).status).toBe("prepared");
	expect(controller.confirmCheckpointPersisted(exact)).toBe(true);
	usePlaybackStore.setState({
		currentTrack: replacementTrack,
		playbackIntentId: 22,
		isPlaying: false,
		positionMs: 1,
		durationMs: 2,
		queue: [replacementTrack],
	});

	const rollback = controller.rollback(exact);
	await Promise.resolve();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("replacement");
	expect(usePlaybackStore.getState().checkpointRestore).toBeNull();

	ownerResume.resolve(true);
	expect(await rollback).toBe("restored");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("captured");
	expect(usePlaybackStore.getState().isPlaying).toBe(true);
	usePlaybackStore.setState({
		currentTrack: null,
		playbackIntentId: 0,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		volume: 0.84,
		muted: false,
		mode: "loop",
		queue: [],
		checkpointRestore: null,
	});
});

test("prepare rejects a checkpoint spliced from a different owner track or intent", () => {
	let cancelCalls = 0;
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => OWNER,
			pauseCommittedOwnerLease: () => true,
			rollbackCommittedOwnerLease: async () => true,
			releaseCommittedOwnerLease: () => true,
			cancelCommittedOwnerLease: () => {
				cancelCalls += 1;
				return true;
			},
		},
		checkpoint: {
			capturePlaybackExitCheckpoint(request) {
				return {
					...checkpointFor(request),
					currentTrackRef: "netease:other",
					capturedPlaybackIntentId: 8,
				};
			},
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});
	expect(controller.prepare(identity(5))).toEqual({
		status: "rejected",
		reason: "owner-checkpoint-mismatch",
	});
	expect(cancelCalls).toBe(1);
});

test("consumed operation generations cannot be replay-prepared after a newer operation", async () => {
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => OWNER,
			pauseCommittedOwnerLease: () => true,
			rollbackCommittedOwnerLease: async () => true,
			releaseCommittedOwnerLease: () => true,
			cancelCommittedOwnerLease: () => true,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: checkpointFor,
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});
	const first = identity(6);
	controller.prepare(first);
	controller.confirmCheckpointPersisted(first);
	expect(await controller.rollback(first)).toBe("restored");
	const second = identity(7, OPERATION_B);
	controller.prepare(second);
	controller.confirmCheckpointPersisted(second);
	expect(await controller.rollback(second)).toBe("restored");
	expect(controller.prepare(first)).toEqual({
		status: "rejected",
		reason: "operation-active",
	});
});

test("persisted reconciliation returns exact no-op-not-prepared when no checkpoint exists", async () => {
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => null,
			pauseCommittedOwnerLease: () => false,
			rollbackCommittedOwnerLease: async () => false,
			releaseCommittedOwnerLease: () => false,
			cancelCommittedOwnerLease: () => false,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: () => null,
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});
	const exact = operationIdentity(8);
	expect(controller.hydratePersistedCheckpoint(exact, null)).toBe("hydrated");
	expect(await controller.rollback(exact)).toBe("no-op-not-prepared");
	expect(await controller.rollback(exact)).toBe("no-op-not-prepared");
	expect(await controller.rollback(operationIdentity(7))).toBe("rejected");
	expect(await controller.rollback(operationIdentity(8, OPERATION_B)))
		.toBe("rejected");
});

test("a later lost prepare event can hydrate after an earlier operation was released", async () => {
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => OWNER,
			pauseCommittedOwnerLease: () => true,
			rollbackCommittedOwnerLease: async () => true,
			releaseCommittedOwnerLease: () => true,
			cancelCommittedOwnerLease: () => true,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: checkpointFor,
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});
	const first = identity(13);
	controller.prepare(first);
	controller.confirmCheckpointPersisted(first);
	expect(await controller.rollback(first)).toBe("restored");

	const second = operationIdentity(14, OPERATION_B);
	expect(controller.hydratePersistedCheckpoint(second, null)).toBe("hydrated");
	expect(await controller.rollback(second)).toBe("no-op-not-prepared");
});

test("an unknown direct rollback cannot manufacture a persisted no-op", async () => {
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => null,
			pauseCommittedOwnerLease: () => false,
			rollbackCommittedOwnerLease: async () => false,
			releaseCommittedOwnerLease: () => false,
			cancelCommittedOwnerLease: () => false,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: () => null,
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});
	expect(await controller.rollback(identity(11))).toBe("rejected");
});

test("sealed-for-exit ownership remains compensatable until irreversible process exit", async () => {
	let rollbackCalls = 0;
	const controller = new PlaybackQuiescenceController({
		createReceipt: () => RECEIPT_A,
		audio: {
			stageCommittedOwnerLease: () => OWNER,
			pauseCommittedOwnerLease: () => true,
			rollbackCommittedOwnerLease: async () => {
				rollbackCalls += 1;
				return true;
			},
			releaseCommittedOwnerLease: () => true,
			cancelCommittedOwnerLease: () => true,
		},
		checkpoint: {
			capturePlaybackExitCheckpoint: checkpointFor,
			restorePlaybackExitCheckpoint: restoreCheckpoint,
		},
	});
	const exact = identity(9);
	controller.prepare(exact);
	controller.confirmCheckpointPersisted(exact);
	expect(controller.releaseForExit(exact)).toBe(true);
	expect(await controller.rollback(exact)).toBe("restored");
	expect(rollbackCalls).toBe(1);
});

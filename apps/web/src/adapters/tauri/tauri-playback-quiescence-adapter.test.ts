import { expect, test } from "bun:test";
import type { PlaybackExitCheckpointV1 } from "../../stores/playback-store";
import {
	TAURI_PLAYBACK_QUIESCENCE_EVENTS,
	TAURI_PLAYBACK_QUIESCENCE_RECONCILE_COMMAND,
	TAURI_PLAYBACK_QUIESCENCE_ACK_COMMAND,
	createTauriPlaybackQuiescenceAdapter,
	type PlaybackQuiescenceControllerPort,
	type TauriPlaybackQuiescenceTransport,
} from "./tauri-playback-quiescence-adapter";

const OPERATION_ID = "a".repeat(32);
const CANDIDATE_ID = "b".repeat(64);
const RECEIPT = "c".repeat(32);

const CHECKPOINT = Object.freeze({
	schema: "playback-exit-checkpoint-v1",
	operationId: OPERATION_ID,
	receipt: RECEIPT,
	queue: Object.freeze([]),
	currentTrackIndex: null,
	currentTrackRef: "",
	capturedPlaybackIntentId: 1,
	positionMs: 0,
	durationMs: null,
	wasPlaying: false,
	mode: "queue",
	volume: 0.8,
	muted: false,
	sourceKind: "none",
	restartRestorable: true,
} satisfies PlaybackExitCheckpointV1);

class FakeTransport implements TauriPlaybackQuiescenceTransport {
	readonly calls: string[] = [];
	readonly acknowledgements: unknown[] = [];
	readonly listeners = new Map<string, (payload: unknown) => void>();

	async listen(eventName: string, handler: (payload: unknown) => void) {
		this.calls.push(`listen:${eventName}`);
		this.listeners.set(eventName, handler);
		return () => {
			this.calls.push(`unlisten:${eventName}`);
			this.listeners.delete(eventName);
		};
	}

	async invoke(command: string, args?: Record<string, unknown>) {
		this.calls.push(`invoke:${command}`);
		if (command === TAURI_PLAYBACK_QUIESCENCE_ACK_COMMAND) {
			this.acknowledgements.push(args?.acknowledgement);
		}
		return null;
	}

	emit(eventName: string, payload: unknown): void {
		const listener = this.listeners.get(eventName);
		if (!listener) throw new Error(`missing listener: ${eventName}`);
		listener(payload);
	}
}

function fakeController(): PlaybackQuiescenceControllerPort & {
	readonly calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		prepare(identity) {
			calls.push(`prepare:${identity.operationId}:${identity.operationGeneration}`);
			return { status: "prepared", checkpoint: CHECKPOINT };
		},
		hydratePersistedCheckpoint() {
			return "rejected";
		},
		confirmCheckpointPersisted() {
			calls.push("confirm");
			return true;
		},
		rollback() {
			return Promise.resolve("rejected");
		},
		releaseForExit() {
			calls.push("release");
			return true;
		},
	};
}

async function flushAcknowledgement(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("installs every listener before reconciliation and returns an exact prepare acknowledgement", async () => {
	const transport = new FakeTransport();
	const controller = fakeController();
	await createTauriPlaybackQuiescenceAdapter({ transport, controller });

	expect(transport.calls).toEqual([
		`listen:${TAURI_PLAYBACK_QUIESCENCE_EVENTS.prepare}`,
		`listen:${TAURI_PLAYBACK_QUIESCENCE_EVENTS.confirm}`,
		`listen:${TAURI_PLAYBACK_QUIESCENCE_EVENTS.rollback}`,
		`listen:${TAURI_PLAYBACK_QUIESCENCE_EVENTS.release}`,
		`invoke:${TAURI_PLAYBACK_QUIESCENCE_RECONCILE_COMMAND}`,
	]);

	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.prepare, {
		operationId: OPERATION_ID,
		operationGeneration: 1,
		candidateId: CANDIDATE_ID,
	});
	await flushAcknowledgement();

	expect(controller.calls).toEqual([`prepare:${OPERATION_ID}:1`]);
	expect(transport.acknowledgements).toEqual([{
		kind: "prepare",
		operationId: OPERATION_ID,
		operationGeneration: 1,
		candidateId: CANDIDATE_ID,
		receipt: RECEIPT,
		checkpoint: CHECKPOINT,
		result: "prepared",
	}]);
});

test("confirm and release preserve exact evidence while a candidate mismatch fails closed", async () => {
	const transport = new FakeTransport();
	const controller = fakeController();
	await createTauriPlaybackQuiescenceAdapter({ transport, controller });
	const envelope = {
		operationId: OPERATION_ID,
		operationGeneration: 1,
		candidateId: CANDIDATE_ID,
	};

	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.prepare, envelope);
	await flushAcknowledgement();
	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.confirm, {
		...envelope,
		receipt: RECEIPT,
		checkpointDigest: "d".repeat(64),
	});
	await flushAcknowledgement();
	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.release, {
		...envelope,
		receipt: RECEIPT,
		checkpointDigest: "d".repeat(64),
	});
	await flushAcknowledgement();
	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.confirm, {
		...envelope,
		candidateId: "e".repeat(64),
		receipt: RECEIPT,
		checkpointDigest: "d".repeat(64),
	});
	await flushAcknowledgement();

	expect(controller.calls).toEqual([
		`prepare:${OPERATION_ID}:1`,
		"confirm",
		"release",
	]);
	expect(transport.acknowledgements.slice(1)).toEqual([
		{
			kind: "confirm",
			...envelope,
			receipt: RECEIPT,
			checkpointDigest: "d".repeat(64),
			result: "confirmed",
		},
		{
			kind: "release",
			...envelope,
			receipt: RECEIPT,
			checkpointDigest: "d".repeat(64),
			result: "released",
		},
		{
			kind: "confirm",
			...envelope,
			candidateId: "e".repeat(64),
			receipt: RECEIPT,
			checkpointDigest: "d".repeat(64),
			result: "rejected",
		},
	]);
});

test("restart rollback hydrates the persisted checkpoint before restore and rejects an older generation", async () => {
	const calls: string[] = [];
	const controller: PlaybackQuiescenceControllerPort = {
		prepare: () => ({ status: "rejected", reason: "operation-active" }),
		hydratePersistedCheckpoint(identity, checkpoint) {
			calls.push(`hydrate:${identity.operationGeneration}:${checkpoint?.receipt ?? "none"}`);
			return "hydrated";
		},
		confirmCheckpointPersisted: () => false,
		async rollback(identity) {
			calls.push(`rollback:${identity.operationGeneration}:${"receipt" in identity ? identity.receipt : "none"}`);
			return identity.operationGeneration === 2
				? "no-op-not-prepared"
				: "restored";
		},
		releaseForExit: () => false,
	};
	const transport = new FakeTransport();
	await createTauriPlaybackQuiescenceAdapter({ transport, controller });
	const first = {
		operationId: OPERATION_ID,
		operationGeneration: 1,
		candidateId: CANDIDATE_ID,
	};

	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.rollback, {
		...first,
		checkpoint: {
			receipt: RECEIPT,
			digest: "d".repeat(64),
			payload: CHECKPOINT,
		},
	});
	await flushAcknowledgement();
	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.rollback, {
		operationId: "e".repeat(32),
		operationGeneration: 2,
		candidateId: "f".repeat(64),
		checkpoint: null,
	});
	await flushAcknowledgement();
	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.rollback, {
		...first,
		checkpoint: {
			receipt: RECEIPT,
			digest: "d".repeat(64),
			payload: CHECKPOINT,
		},
	});
	await flushAcknowledgement();

	expect(calls).toEqual([
		`hydrate:1:${RECEIPT}`,
		`rollback:1:${RECEIPT}`,
		"hydrate:2:none",
		"rollback:2:none",
	]);
	expect(transport.acknowledgements).toEqual([
		{
			kind: "rollback",
			...first,
			receipt: RECEIPT,
			checkpointDigest: "d".repeat(64),
			result: "restored",
		},
		{
			kind: "rollback",
			operationId: "e".repeat(32),
			operationGeneration: 2,
			candidateId: "f".repeat(64),
			receipt: null,
			checkpointDigest: null,
			result: "no-op-not-prepared",
		},
		{
			kind: "rollback",
			...first,
			receipt: RECEIPT,
			checkpointDigest: "d".repeat(64),
			result: "rejected",
		},
	]);
});

test("serializes confirm behind the exact prepare acknowledgement", async () => {
	let releasePrepareAcknowledgement = () => {};
	const prepareAcknowledgementReleased = new Promise<void>((resolve) => {
		releasePrepareAcknowledgement = resolve;
	});
	class BlockingTransport extends FakeTransport {
		override async invoke(command: string, args?: Record<string, unknown>) {
			const acknowledgement = args?.acknowledgement as { kind?: unknown } | undefined;
			if (
				command === TAURI_PLAYBACK_QUIESCENCE_ACK_COMMAND
				&& acknowledgement?.kind === "prepare"
			) {
				this.calls.push(`invoke:${command}`);
				this.acknowledgements.push(acknowledgement);
				await prepareAcknowledgementReleased;
				return null;
			}
			return super.invoke(command, args);
		}
	}
	const transport = new BlockingTransport();
	const controller = fakeController();
	await createTauriPlaybackQuiescenceAdapter({ transport, controller });
	const envelope = {
		operationId: OPERATION_ID,
		operationGeneration: 1,
		candidateId: CANDIDATE_ID,
	};

	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.prepare, envelope);
	transport.emit(TAURI_PLAYBACK_QUIESCENCE_EVENTS.confirm, {
		...envelope,
		receipt: RECEIPT,
		checkpointDigest: "d".repeat(64),
	});
	await flushAcknowledgement();
	expect(controller.calls).toEqual([`prepare:${OPERATION_ID}:1`]);

	releasePrepareAcknowledgement();
	await flushAcknowledgement();
	await flushAcknowledgement();
	expect(controller.calls).toEqual([
		`prepare:${OPERATION_ID}:1`,
		"confirm",
	]);
});

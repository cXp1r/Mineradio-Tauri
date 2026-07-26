import type { ApiRuntimeStatus } from "../../ports/api-runtime-port";
import type { SidecarRecoveryNoticeState } from "../../components/shell/SidecarRecoveryNotice";

export const SIDECAR_STATUS_POLL_MS = 1500;
export const SIDECAR_STATUS_READY_MAX_POLL_MS = 12000;
export const SIDECAR_STATUS_HIDDEN_MAX_POLL_MS = 60000;
export const SIDECAR_RECOVERED_NOTICE_MS = 2600;

export function deriveSidecarRecoveryNoticeState(
	status: ApiRuntimeStatus,
	previous: SidecarRecoveryNoticeState | null,
): SidecarRecoveryNoticeState {
	const recovered =
		status.phase === "ready" &&
		!!previous &&
		(previous.phase === "recovering" ||
			previous.phase === "stopped" ||
			previous.phase === "error" ||
			status.restarts > previous.restarts);
	return {
		phase: status.phase,
		restarts: status.restarts,
		lastError: status.lastError,
		recovered,
	};
}

export function nextSidecarStatusPollDelayMs(input: {
	status: ApiRuntimeStatus;
	consecutiveReadyPolls: number;
	documentHidden?: boolean;
}): number {
	if (input.status.phase !== "ready") return SIDECAR_STATUS_POLL_MS;
	const readySteps = Math.max(
		0,
		Math.min(3, Math.floor(input.consecutiveReadyPolls)),
	);
	const foregroundDelay = Math.min(
		SIDECAR_STATUS_READY_MAX_POLL_MS,
		SIDECAR_STATUS_POLL_MS * 2 ** readySteps,
	);
	if (!input.documentHidden) return foregroundDelay;
	if (readySteps >= 3) return SIDECAR_STATUS_HIDDEN_MAX_POLL_MS;
	return Math.min(SIDECAR_STATUS_HIDDEN_MAX_POLL_MS, foregroundDelay * 2);
}

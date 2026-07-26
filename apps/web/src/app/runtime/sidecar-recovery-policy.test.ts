import { expect, test } from "bun:test";
import type { ApiRuntimeStatus } from "../../ports/api-runtime-port";
import {
	deriveSidecarRecoveryNoticeState,
	nextSidecarStatusPollDelayMs,
} from "./sidecar-recovery-policy";

function sidecarStatus(
	overrides: Partial<ApiRuntimeStatus> = {},
): ApiRuntimeStatus {
	return {
		phase: "ready",
		pid: 1,
		restarts: 0,
		lastError: null,
		lastHealthOkMs: 10,
		providers: ["netease", "qq"],
		logPath: "",
		...overrides,
	};
}

test("recovery policy only marks ready after an unhealthy phase or restart", () => {
	const firstReady = deriveSidecarRecoveryNoticeState(sidecarStatus(), null);
	expect(firstReady.recovered).toBe(false);

	const recovering = deriveSidecarRecoveryNoticeState(
		sidecarStatus({ phase: "recovering", restarts: 1 }),
		firstReady,
	);
	const recovered = deriveSidecarRecoveryNoticeState(
		sidecarStatus({ phase: "ready", restarts: 1 }),
		recovering,
	);
	expect(recovered.recovered).toBe(true);

	const restartedWhileReady = deriveSidecarRecoveryNoticeState(
		sidecarStatus({ phase: "ready", restarts: 2 }),
		firstReady,
	);
	expect(restartedWhileReady.recovered).toBe(true);
});

test("recovery polling backs off only during stable ready polling", () => {
	expect(nextSidecarStatusPollDelayMs({
		status: sidecarStatus(),
		consecutiveReadyPolls: 0,
		documentHidden: false,
	})).toBe(1500);
	expect(nextSidecarStatusPollDelayMs({
		status: sidecarStatus(),
		consecutiveReadyPolls: 3,
		documentHidden: false,
	})).toBe(12000);
	expect(nextSidecarStatusPollDelayMs({
		status: sidecarStatus(),
		consecutiveReadyPolls: 4,
		documentHidden: true,
	})).toBe(60000);
	expect(nextSidecarStatusPollDelayMs({
		status: sidecarStatus({ phase: "recovering" }),
		consecutiveReadyPolls: 4,
		documentHidden: true,
	})).toBe(1500);
});

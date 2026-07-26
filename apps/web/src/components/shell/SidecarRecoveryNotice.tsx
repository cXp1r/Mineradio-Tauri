import type { ReactElement } from "react";
import type { ApiRuntimePhase } from "../../ports/api-runtime-port";

export interface SidecarRecoveryNoticeState {
	phase: ApiRuntimePhase;
	restarts: number;
	lastError: string | null;
	recovered: boolean;
}

export interface SidecarRecoveryNoticeView {
	tone: "recovering" | "recovered" | "stopped" | "error";
	text: string;
	detail: string | null;
}

function restartDetail(restarts: number): string | null {
	return restarts > 0 ? `已自动重启 ${restarts} 次` : null;
}

export function resolveSidecarRecoveryNotice(state: SidecarRecoveryNoticeState): SidecarRecoveryNoticeView | null {
	if (state.phase === "recovering") {
		return {
			tone: "recovering",
			text: "sidecar 正在恢复连接",
			detail: restartDetail(state.restarts),
		};
	}
	if (state.phase === "ready" && state.recovered) {
		return {
			tone: "recovered",
			text: "sidecar 已恢复",
			detail: restartDetail(state.restarts),
		};
	}
	if (state.phase === "stopped") {
		return {
			tone: "stopped",
			text: "sidecar 连接已停止",
			detail: restartDetail(state.restarts),
		};
	}
	if (state.phase === "error") {
		return {
			tone: "error",
			text: "sidecar 连接异常",
			detail: state.lastError?.trim() || restartDetail(state.restarts),
		};
	}
	return null;
}

export function SidecarRecoveryNotice({ state }: { state: SidecarRecoveryNoticeState }): ReactElement | null {
	const notice = resolveSidecarRecoveryNotice(state);
	if (!notice) return null;
	return (
		<div id="sidecar-recovery-notice" className={`sidecar-recovery-notice ${notice.tone}`} role="status" aria-live="polite">
			<span className="sidecar-recovery-dot" aria-hidden="true" />
			<span className="sidecar-recovery-text">{notice.text}</span>
			{notice.detail ? <span className="sidecar-recovery-detail">{notice.detail}</span> : null}
		</div>
	);
}

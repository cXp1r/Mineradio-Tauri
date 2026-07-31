import type {
	UpdateCandidateView,
	UpdateFaultView,
	UpdateIntent,
	UpdatePhase,
	UpdateReceipt,
	UpdateSnapshot,
} from "../../ports/update-runtime-port";
import type { DesktopWindowState } from "../../ports/desktop-runtime-port";
import type { FullDesktopRuntimeState } from "../../ports/full-desktop-runtime-port";

export type UpdatePresentationMode =
	| "normal"
	| "fullscreen"
	| "full-desktop"
	| "unknown";

export type UpdatePrimaryAction =
	| "check-now"
	| "download"
	| "cancel-download"
	| "install-and-restart"
	| null;

export type UpdatePrimaryIntent = Extract<
	UpdateIntent,
	{ readonly kind: "check-now" | "download" | "cancel-download" | "install-and-restart" }
>;

export interface UpdateProgressViewModel {
	readonly receivedBytes: number;
	readonly totalBytes: number | null;
	readonly percentage: number | null;
	readonly indeterminate: boolean;
	readonly label: string;
}

export interface UpdateViewModel {
	readonly revision: number;
	readonly phase: UpdatePhase;
	readonly currentVersion: string;
	readonly candidate: UpdateCandidateView | null;
	readonly modalOpen: boolean;
	readonly badgeVisible: boolean;
	readonly attentionSuppressed: boolean;
	readonly presentation: UpdatePresentationMode;
	readonly primaryAction: UpdatePrimaryAction;
	readonly primaryIntent: UpdatePrimaryIntent | null;
	readonly primaryLabel: string;
	readonly primaryDisabled: boolean;
	readonly progress: UpdateProgressViewModel | null;
	readonly manualFault: UpdateFaultView | null;
	readonly backgroundFault: UpdateFaultView | null;
	readonly actionRejection: Exclude<UpdateReceipt, "accepted"> | null;
	readonly canRemindLater: boolean;
	readonly canSkipVersion: boolean;
	readonly canOpenRelease: boolean;
}

export interface UpdateViewModelContext {
	readonly modalOpen: boolean;
	readonly presentation: UpdatePresentationMode;
	readonly manualFaultKey: string | null;
	readonly actionRejection?: Exclude<UpdateReceipt, "accepted"> | null;
}

export function resolveUpdatePresentationMode(
	windowState: Pick<
		DesktopWindowState,
		"isFullScreen" | "isNativeFullScreen" | "isHtmlFullScreen" | "isWindowFullScreen"
	> | null,
	fullDesktopState: Pick<
		FullDesktopRuntimeState,
		"phase" | "effectiveMode"
	> | null,
): UpdatePresentationMode {
	if (fullDesktopState?.effectiveMode === "passive" || fullDesktopState?.effectiveMode === "interactive") {
		return "full-desktop";
	}
	if (
		windowState?.isFullScreen
		|| windowState?.isNativeFullScreen
		|| windowState?.isHtmlFullScreen
		|| windowState?.isWindowFullScreen
	) return "fullscreen";
	if (!windowState || !fullDesktopState) return "unknown";
	if (fullDesktopState.phase !== "disabled" || fullDesktopState.effectiveMode !== "disabled") {
		return "unknown";
	}
	return "normal";
}

export function updateFaultKey(fault: UpdateFaultView | null): string | null {
	if (!fault) return null;
	return `${fault.stage}:${fault.code}:${fault.retryable ? "retryable" : "terminal"}`;
}

function byteLabel(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KiB", "MiB", "GiB"] as const;
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	const digits = unitIndex === 0 || value >= 10 || Number.isInteger(value) ? 0 : 1;
	return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function progressView(snapshot: UpdateSnapshot): UpdateProgressViewModel | null {
	const operation = snapshot.operation;
	if (!operation || (operation.kind !== "download" && operation.kind !== "verify")) {
		return null;
	}
	const receivedBytes = Math.max(0, operation.receivedBytes);
	const totalBytes = operation.totalBytes && operation.totalBytes > 0
		? operation.totalBytes
		: null;
	const percentage = totalBytes === null
		? null
		: Math.min(100, Math.max(0, (receivedBytes / totalBytes) * 100));
	return {
		receivedBytes,
		totalBytes,
		percentage,
		indeterminate: totalBytes === null,
		label: totalBytes === null
			? `已下载 ${byteLabel(receivedBytes)}`
			: `${byteLabel(receivedBytes)} / ${byteLabel(totalBytes)}（${Math.round(percentage ?? 0)}%）`,
	};
}

function primaryAction(snapshot: UpdateSnapshot): UpdatePrimaryAction {
	if (
		snapshot.phase === "downloading"
		&& snapshot.operation?.kind === "download"
		&& snapshot.operation.cancellable
	) {
		return "cancel-download";
	}
	if (snapshot.phase === "available" && snapshot.candidate) return "download";
	if (snapshot.phase === "ready-to-install" && snapshot.candidate) {
		return "install-and-restart";
	}
	if (
		snapshot.phase === "idle"
		|| snapshot.phase === "current"
		|| (snapshot.fault?.stage === "check" && snapshot.fault.retryable)
	) {
		return "check-now";
	}
	return null;
}

function primaryIntent(snapshot: UpdateSnapshot): UpdatePrimaryIntent | null {
	const action = primaryAction(snapshot);
	switch (action) {
		case "check-now": return { kind: "check-now" };
		case "download": return snapshot.candidate
			? { kind: "download", candidateId: snapshot.candidate.id }
			: null;
		case "install-and-restart": return snapshot.candidate
			? { kind: "install-and-restart", candidateId: snapshot.candidate.id }
			: null;
		case "cancel-download": return snapshot.operation
			? { kind: "cancel-download", operationId: snapshot.operation.id }
			: null;
		default: return null;
	}
}

function primaryLabel(action: UpdatePrimaryAction, phase: UpdatePhase): string {
	if (phase === "checking") return "正在检查";
	if (phase === "verifying") return "正在验证";
	if (phase === "preparing-install") return "正在准备安装";
	if (phase === "installing") return "正在启动安装程序";
	switch (action) {
		case "check-now": return "检查更新";
		case "download": return "下载更新";
		case "cancel-download": return "取消下载";
		case "install-and-restart": return "安装并重启";
		default: return "请稍候";
	}
}

export function projectUpdateViewModel(
	snapshot: UpdateSnapshot,
	context: UpdateViewModelContext,
): UpdateViewModel {
	const action = primaryAction(snapshot);
	const currentFaultKey = updateFaultKey(snapshot.fault);
	const isManualCheckFault = !!snapshot.fault && currentFaultKey === context.manualFaultKey;
	const isBackgroundFault = snapshot.fault?.stage === "check" && !isManualCheckFault;
	const busy = snapshot.phase === "checking"
		|| snapshot.phase === "recovering-cache"
		|| snapshot.phase === "verifying"
		|| snapshot.phase === "preparing-install"
		|| snapshot.phase === "installing";
	return Object.freeze({
		revision: snapshot.revision,
		phase: snapshot.phase,
		currentVersion: snapshot.currentVersion,
		candidate: snapshot.candidate,
		modalOpen: context.modalOpen && context.presentation === "normal",
		badgeVisible: !!snapshot.candidate || !!snapshot.operation || !!snapshot.fault || !!context.actionRejection,
		attentionSuppressed: context.presentation !== "normal",
		presentation: context.presentation,
		primaryAction: action,
		primaryIntent: primaryIntent(snapshot),
		primaryLabel: primaryLabel(action, snapshot.phase),
		primaryDisabled: busy || action === null,
		progress: progressView(snapshot),
		manualFault: snapshot.fault && !isBackgroundFault ? snapshot.fault : null,
		backgroundFault: isBackgroundFault ? snapshot.fault : null,
		actionRejection: context.actionRejection ?? null,
		canRemindLater: !!snapshot.candidate
			&& (snapshot.phase === "available" || snapshot.phase === "ready-to-install"),
		canSkipVersion: !!snapshot.candidate
			&& (snapshot.phase === "available" || snapshot.phase === "ready-to-install"),
		canOpenRelease: !!snapshot.candidate,
	});
}

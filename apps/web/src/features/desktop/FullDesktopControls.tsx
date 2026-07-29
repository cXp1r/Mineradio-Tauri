import type {
	FullDesktopMode,
	FullDesktopRuntimePhase,
} from "../../ports/full-desktop-runtime-port";
import type { FullDesktopRuntimeController } from "./useFullDesktopRuntime";

const MODE_OPTIONS: Array<{ mode: FullDesktopMode; label: string }> = [
	{ mode: "disabled", label: "普通窗口" },
	{ mode: "passive", label: "桌面背景" },
	{ mode: "interactive", label: "桌面交互" },
];

const PHASE_LABELS: Record<FullDesktopRuntimePhase, string> = {
	disabled: "普通窗口",
	attaching: "正在附着",
	passive: "桌面背景运行中",
	interactive: "桌面交互运行中",
	recovering: "正在恢复",
	detaching: "正在退出完整桌面",
	recoveryRequired: "需要恢复",
};

function modeLabel(mode: FullDesktopMode): string {
	return MODE_OPTIONS.find((item) => item.mode === mode)?.label ?? mode;
}

export function FullDesktopControls(props: FullDesktopRuntimeController) {
	const state = props.state;
	const controlsDisabled = props.busy || !state;
	const desktopMutationDisabled = controlsDisabled || state?.effectiveMode === "disabled";

	return (
		<div
			className="full-desktop-controls"
			data-busy={props.busy ? "true" : "false"}
			data-phase={state?.phase ?? "unavailable"}
		>
			<div className="fx-section-label">完整桌面</div>
			<div className="fx-runtime-summary">
				<strong>{state ? PHASE_LABELS[state.phase] : "运行时不可用"}</strong>
				<small>
					{state
						? `请求 ${modeLabel(state.requestedMode)} · 生效 ${modeLabel(state.effectiveMode)}`
						: "等待 Native 状态"}
				</small>
			</div>
			<div className="fx-seg" role="group" aria-label="完整桌面模式">
				{MODE_OPTIONS.map(({ mode, label }) => (
					<button
						key={mode}
						type="button"
						className={state?.requestedMode === mode ? "active" : ""}
						aria-pressed={state?.requestedMode === mode}
						disabled={controlsDisabled}
						onClick={() => void props.setMode(mode)}
					>
						{label}
					</button>
				))}
			</div>

			<div className="full-desktop-facts" aria-label="完整桌面运行状态">
				<div>
					<span>桌面图标</span>
					<strong>{state ? (state.iconsVisible ? "显示" : "隐藏") : "—"}</strong>
				</div>
				<div>
					<span>软件交互</span>
					<strong>{state ? (state.interactionLocked ? "已锁定" : "可交互") : "—"}</strong>
				</div>
				<div>
					<span>Explorer 代次</span>
					<strong>{state?.explorerGeneration ?? "—"}</strong>
				</div>
			</div>

			<div className="fx-seg" role="group" aria-label="桌面图标可见性">
				<button
					type="button"
					className={state?.iconsVisible ? "active" : ""}
					aria-pressed={state?.iconsVisible === true}
					disabled={desktopMutationDisabled}
					onClick={() => void props.setIconsVisible(true)}
				>
					显示图标
				</button>
				<button
					type="button"
					className={state && !state.iconsVisible ? "active" : ""}
					aria-pressed={state ? !state.iconsVisible : false}
					disabled={desktopMutationDisabled}
					onClick={() => void props.setIconsVisible(false)}
				>
					隐藏图标
				</button>
			</div>

			<div className="fx-seg" role="group" aria-label="完整桌面软件交互">
				<button
					type="button"
					className={state && !state.interactionLocked ? "active" : ""}
					aria-pressed={state ? !state.interactionLocked : false}
					disabled={desktopMutationDisabled}
					onClick={() => void props.setInteractionLocked(false)}
				>
					允许交互
				</button>
				<button
					type="button"
					className={state?.interactionLocked ? "active" : ""}
					aria-pressed={state?.interactionLocked === true}
					disabled={desktopMutationDisabled}
					onClick={() => void props.setInteractionLocked(true)}
				>
					锁定软件
				</button>
			</div>

			{state?.autoResumeSuppressed ? (
				<div className="fx-runtime-warning">
					自动恢复已暂停：本次启动曾处理恢复日志，请手动选择完整桌面模式。
				</div>
			) : null}
			{state?.recoveryRequired ? (
				<div className="full-desktop-recovery" role="alert">
					<span>Native 状态需要显式恢复，恢复完成前不会重新附着 Explorer。</span>
					<button
						type="button"
						className="fx-mini-btn fx-runtime-primary-action"
						data-full-desktop-recover
						disabled={props.busy}
						onClick={() => void props.recover()}
					>
						立即恢复普通窗口
					</button>
				</div>
			) : null}
			{state?.lastError ? <div className="fx-runtime-warning">{state.lastError}</div> : null}
			{props.error ? <div className="fx-runtime-warning">{props.error}</div> : null}
			<div className="fx-runtime-actions">
				<button
					type="button"
					className="fx-mini-btn ghost"
					disabled={props.busy}
					onClick={() => void props.refresh()}
				>
					刷新状态
				</button>
			</div>
		</div>
	);
}

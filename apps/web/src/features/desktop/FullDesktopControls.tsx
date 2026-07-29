import type {
	FullDesktopMode,
	FullDesktopRuntimePhase,
} from "../../ports/full-desktop-runtime-port";
import type { FullDesktopRuntimeController } from "./useFullDesktopRuntime";

const MODE_OPTIONS = [
	{ mode: "disabled", label: "普通窗口" },
	{ mode: "passive", label: "桌面背景" },
	{ mode: "interactive", label: "桌面交互" },
] as const satisfies ReadonlyArray<{ mode: FullDesktopMode; label: string }>;

const PHASE_LABELS: Record<FullDesktopRuntimePhase, string> = {
	disabled: "普通窗口",
	attaching: "正在附着",
	passive: "桌面背景运行中",
	interactive: "桌面交互运行中",
	recovering: "正在恢复",
	detaching: "正在退出完整桌面",
	recoveryRequired: "需要恢复",
};

/** 完整桌面控件与设置搜索共用的唯一文案目录。 */
export const FULL_DESKTOP_CONTROL_DEFINITIONS = Object.freeze({
	sectionLabel: "完整桌面",
	modeGroupLabel: "完整桌面模式",
	modeOptions: MODE_OPTIONS,
	facts: Object.freeze({
		icons: "桌面图标",
		interaction: "软件交互",
		explorerGeneration: "Explorer 代次",
	}),
	iconsGroupLabel: "桌面图标可见性",
	iconActions: Object.freeze({ show: "显示图标", hide: "隐藏图标" }),
	interactionGroupLabel: "完整桌面软件交互",
	interactionActions: Object.freeze({ allow: "允许交互", lock: "锁定软件" }),
	recoveryAction: "立即恢复普通窗口",
	refreshAction: "刷新状态",
});

export const FULL_DESKTOP_SETTINGS_SEARCH_TERMS = Object.freeze([
	FULL_DESKTOP_CONTROL_DEFINITIONS.sectionLabel,
	FULL_DESKTOP_CONTROL_DEFINITIONS.modeGroupLabel,
	...FULL_DESKTOP_CONTROL_DEFINITIONS.modeOptions.map(({ label }) => label),
	...Object.values(PHASE_LABELS),
	...Object.values(FULL_DESKTOP_CONTROL_DEFINITIONS.facts),
	FULL_DESKTOP_CONTROL_DEFINITIONS.iconsGroupLabel,
	...Object.values(FULL_DESKTOP_CONTROL_DEFINITIONS.iconActions),
	FULL_DESKTOP_CONTROL_DEFINITIONS.interactionGroupLabel,
	...Object.values(FULL_DESKTOP_CONTROL_DEFINITIONS.interactionActions),
	FULL_DESKTOP_CONTROL_DEFINITIONS.recoveryAction,
	FULL_DESKTOP_CONTROL_DEFINITIONS.refreshAction,
]);

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
			<div className="fx-section-label">{FULL_DESKTOP_CONTROL_DEFINITIONS.sectionLabel}</div>
			<div className="fx-runtime-summary">
				<strong>{state ? PHASE_LABELS[state.phase] : "运行时不可用"}</strong>
				<small>
					{state
						? `请求 ${modeLabel(state.requestedMode)} · 生效 ${modeLabel(state.effectiveMode)}`
						: "等待 Native 状态"}
				</small>
			</div>
			<div className="fx-seg" role="group" aria-label={FULL_DESKTOP_CONTROL_DEFINITIONS.modeGroupLabel}>
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
					<span>{FULL_DESKTOP_CONTROL_DEFINITIONS.facts.icons}</span>
					<strong>{state ? (state.iconsVisible ? "显示" : "隐藏") : "—"}</strong>
				</div>
				<div>
					<span>{FULL_DESKTOP_CONTROL_DEFINITIONS.facts.interaction}</span>
					<strong>{state ? (state.interactionLocked ? "已锁定" : "可交互") : "—"}</strong>
				</div>
				<div>
					<span>{FULL_DESKTOP_CONTROL_DEFINITIONS.facts.explorerGeneration}</span>
					<strong>{state?.explorerGeneration ?? "—"}</strong>
				</div>
			</div>

			<div className="fx-seg" role="group" aria-label={FULL_DESKTOP_CONTROL_DEFINITIONS.iconsGroupLabel}>
				<button
					type="button"
					className={state?.iconsVisible ? "active" : ""}
					aria-pressed={state?.iconsVisible === true}
					disabled={desktopMutationDisabled}
					onClick={() => void props.setIconsVisible(true)}
				>
					{FULL_DESKTOP_CONTROL_DEFINITIONS.iconActions.show}
				</button>
				<button
					type="button"
					className={state && !state.iconsVisible ? "active" : ""}
					aria-pressed={state ? !state.iconsVisible : false}
					disabled={desktopMutationDisabled}
					onClick={() => void props.setIconsVisible(false)}
				>
					{FULL_DESKTOP_CONTROL_DEFINITIONS.iconActions.hide}
				</button>
			</div>

			<div className="fx-seg" role="group" aria-label={FULL_DESKTOP_CONTROL_DEFINITIONS.interactionGroupLabel}>
				<button
					type="button"
					className={state && !state.interactionLocked ? "active" : ""}
					aria-pressed={state ? !state.interactionLocked : false}
					disabled={desktopMutationDisabled}
					onClick={() => void props.setInteractionLocked(false)}
				>
					{FULL_DESKTOP_CONTROL_DEFINITIONS.interactionActions.allow}
				</button>
				<button
					type="button"
					className={state?.interactionLocked ? "active" : ""}
					aria-pressed={state?.interactionLocked === true}
					disabled={desktopMutationDisabled}
					onClick={() => void props.setInteractionLocked(true)}
				>
					{FULL_DESKTOP_CONTROL_DEFINITIONS.interactionActions.lock}
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
						{FULL_DESKTOP_CONTROL_DEFINITIONS.recoveryAction}
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
					{FULL_DESKTOP_CONTROL_DEFINITIONS.refreshAction}
				</button>
			</div>
		</div>
	);
}

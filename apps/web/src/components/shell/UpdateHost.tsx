import { type ReactElement, useLayoutEffect, useRef } from "react";
import type { UpdateViewModel } from "../../features/updater/update-view-model";
import type { UpdateState } from "../../stores/update-store";

export interface LegacyUpdateHostProps {
	state: UpdateState;
	open: boolean;
	onOpen: () => void;
	onClose: () => void;
	onCheck: () => void;
	onInstall: () => void;
}

export interface UpdateExperienceHostProps {
	viewModel: UpdateViewModel;
	onOpen: () => void;
	onClose: () => void;
	onPrimary: () => void;
	onRemindLater: () => void;
	onSkipVersion: () => void;
	onOpenRelease: () => void;
}

export type UpdateHostProps = LegacyUpdateHostProps | UpdateExperienceHostProps;

export function shouldShowUpdateEntry(state: Pick<UpdateState, "status" | "version" | "error">): boolean {
	return state.status === "checking" || state.status === "available" || state.status === "error" || !!state.version;
}

function updateEntryClass(state: UpdateState): string {
	const classes = ["update-entry"];
	if (shouldShowUpdateEntry(state)) classes.push("available");
	if (state.status === "checking" || state.status === "downloading" || state.status === "installing") classes.push("downloading");
	if (state.installState === "ready-to-download") classes.push("ready");
	return classes.join(" ");
}

function updateModalClass(state: UpdateState): string {
	const classes = ["modal", "update-modal"];
	if (state.installState === "ready-to-download") classes.push("ready");
	if (state.status === "error" || state.signatureGate) classes.push("error");
	return classes.join(" ");
}

function updateHeroText(state: UpdateState): string {
	if (state.signatureGate) return "发现新版本，但 Tauri 更新签名密钥尚未配置。";
	if (state.status === "checking") return "正在检查更新。";
	if (state.status === "error") return state.message || state.error || "更新检测失败。";
	if (state.status === "not-available") return "当前版本已是最新。";
	if (state.status === "available") return state.message || "发现新版本，建议更新。";
	return state.message || "更新检测已就绪。";
}

function updateNotes(state: UpdateState): string[] {
	const raw = state.body || state.message || "";
	const notes = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 4);
	if (state.signatureGate) {
		return [
			"签名密钥未配置，当前构建不会下载或安装更新。",
			...notes,
		].slice(0, 4);
	}
	if (notes.length > 0) return notes;
	if (state.status === "error") return [state.error || "更新检测失败"];
	return ["更新检测已就绪"];
}

function primaryLabel(state: UpdateState): string {
	if (state.status === "checking") return "正在检查";
	if (state.status === "downloading") return "正在下载";
	if (state.status === "installing") return "正在安装";
	if (state.signatureGate) return "暂不可安装";
	if (state.status === "error") return "重新检查";
	if (state.installState === "ready-to-download") return "下载并安装";
	if (state.status === "available") return "检查更新";
	if (state.status === "not-available") return "重新检查";
	return "检查更新";
}

function footnote(state: UpdateState): string {
	if (state.signatureGate) return "签名密钥未配置前，Tauri 主线只展示更新信息，不执行下载或安装。";
	if (state.status === "error") return state.error || "请稍后重试。";
	if (state.status === "available") return "安装流程会通过 Tauri updater 执行。";
	if (state.status === "checking") return "正在连接更新通道。";
	return "当前版本检测状态会显示在这里。";
}

function experienceEntryClass(model: UpdateViewModel): string {
	const classes = ["update-entry"];
	if (model.badgeVisible) classes.push("available");
	if (
		model.phase === "checking"
		|| model.phase === "downloading"
		|| model.phase === "verifying"
		|| model.phase === "preparing-install"
		|| model.phase === "installing"
	) classes.push("downloading");
	if (model.phase === "ready-to-install") classes.push("ready");
	return classes.join(" ");
}

function experienceHeroText(model: UpdateViewModel): string {
	if (model.actionRejection) return "更新状态已经变化，本次操作未执行。";
	if (model.manualFault) return model.manualFault.message;
	if (model.phase === "checking") return "正在检查 GitHub Releases。";
	if (model.phase === "downloading") return "正在下载已验证来源的安装包。";
	if (model.phase === "verifying") return "正在验证安装包签名与来源。";
	if (model.phase === "ready-to-install") return "安装包已验证，可以安装并重启。";
	if (model.phase === "preparing-install") return "正在安全暂停播放并准备安装。";
	if (model.phase === "installing") return "正在启动安装程序。";
	if (model.candidate) return "发现可信的新版本。";
	if (model.phase === "current") return "当前版本已是最新。";
	return model.backgroundFault ? "后台更新检查暂时不可用。" : "可以检查 GitHub Releases 更新。";
}

function actionRejectionText(model: UpdateViewModel): string | null {
	switch (model.actionRejection) {
		case "stale-candidate": return "候选版本已经变化，请核对当前版本后重试。";
		case "stale-operation": return "下载任务已经变化，请核对当前进度后重试。";
		case "invalid-order": return "当前更新阶段不接受这个操作。";
		case "policy-blocked": return "安全策略暂时阻止了这个操作。";
		case "runtime-unavailable": return "更新运行时暂时不可用，请稍后重试。";
		default: return null;
	}
}

function ExperienceUpdateHost({
	viewModel,
	onOpen,
	onClose,
	onPrimary,
	onRemindLater,
	onSkipVersion,
	onOpenRelease,
}: UpdateExperienceHostProps): ReactElement | null {
	const entryRef = useRef<HTMLButtonElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useLayoutEffect(() => {
		if (typeof document === "undefined") return;
		const restoreDialogFocus = (clearTarget: boolean) => {
			const restoreTarget = restoreFocusRef.current;
			if (!restoreTarget) return;
			if (document.documentElement.contains(restoreTarget)) {
				restoreTarget.focus({ preventScroll: true });
			} else {
				entryRef.current?.focus({ preventScroll: true });
			}
			if (clearTarget) restoreFocusRef.current = null;
		};
		if (!viewModel.modalOpen) {
			restoreDialogFocus(true);
			return;
		}
		const previousFocus = document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
		restoreFocusRef.current = previousFocus;
		const dialog = dialogRef.current;
		if (!dialog) return;
		dialog.focus({ preventScroll: true });
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = [...dialog.querySelectorAll<HTMLElement>(
				'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
			)].filter((element) => !element.hasAttribute("inert"));
			if (focusable.length === 0) {
				event.preventDefault();
				dialog.focus({ preventScroll: true });
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
				event.preventDefault();
				last.focus({ preventScroll: true });
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus({ preventScroll: true });
			} else if (!dialog.contains(document.activeElement)) {
				event.preventDefault();
				first.focus({ preventScroll: true });
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			// dependency 切换时 DOM mutation 可能覆盖这次 focus；关闭态 effect 会再恢复并清空。
			restoreDialogFocus(false);
		};
	}, [viewModel.modalOpen]);

	if (!viewModel.badgeVisible && !viewModel.modalOpen) return null;
	const version = viewModel.candidate?.version ?? viewModel.currentVersion;
	const rejectionText = actionRejectionText(viewModel);
	const notes = viewModel.candidate?.notes.length
		? viewModel.candidate.notes.slice(0, 4)
		: [rejectionText ?? viewModel.manualFault?.message ?? "暂无更新说明"];
	const progress = viewModel.progress;
	const progressOffset = progress?.percentage === null || progress?.percentage === undefined
		? undefined
		: 55.29 * (1 - progress.percentage / 100);
	const entryLabel = viewModel.candidate
		? `查看 MineRadio v${viewModel.candidate.version} 更新`
		: "查看更新状态";
	const modalClass = ["modal", "update-modal"];
	if (viewModel.phase === "ready-to-install") modalClass.push("ready");
	if (viewModel.manualFault || viewModel.backgroundFault || viewModel.actionRejection) modalClass.push("error");
	const visibleFault = viewModel.manualFault ?? viewModel.backgroundFault;

	return (
		<>
			<button
				ref={entryRef}
				id="update-entry"
				className={experienceEntryClass(viewModel)}
				type="button"
				onClick={onOpen}
				title={entryLabel}
				aria-label={entryLabel}
				aria-haspopup="dialog"
				aria-expanded={viewModel.modalOpen}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<circle className="update-ring" cx="12" cy="12" r="8.8" />
					<circle
						id="update-progress-ring"
						className="update-progress-ring"
						cx="12"
						cy="12"
						r="8.8"
						style={progressOffset === undefined ? undefined : { strokeDashoffset: progressOffset }}
					/>
					<path className="update-arrow" d="M12 16.5V7.5" />
					<path className="update-arrow" d="M8.7 10.7 12 7.4l3.3 3.3" />
				</svg>
			</button>
			<div
				id="update-modal"
				className={viewModel.modalOpen ? "modal-mask show" : "modal-mask"}
				role="presentation"
				aria-hidden={!viewModel.modalOpen}
				inert={!viewModel.modalOpen}
				onClick={(event) => {
					if (event.target === event.currentTarget) onClose();
				}}
			>
				<div
					ref={dialogRef}
					className={modalClass.join(" ")}
					role="dialog"
					tabIndex={-1}
					aria-modal="true"
					aria-labelledby="update-modal-version"
					aria-describedby="update-hero-main"
				>
					<div className="update-panel-inner">
						<div className="update-panel-head">
							<div>
								<div className="update-kicker">MINERADIO · GITHUB RELEASES</div>
								<div id="update-modal-title" className="update-title">New release</div>
								<div id="update-modal-version" className="update-version">v{version}</div>
							</div>
						</div>
						<div className="update-hero">
							<div id="update-hero-main" className="update-hero-main" aria-live="polite" aria-atomic="true">
								{experienceHeroText(viewModel)}
							</div>
							{progress ? (
								<div
									className="update-progress-status"
									role="progressbar"
									aria-label="更新下载进度"
									aria-valuemin={progress.indeterminate ? undefined : 0}
									aria-valuemax={progress.indeterminate ? undefined : 100}
									aria-valuenow={progress.percentage === null ? undefined : Math.round(progress.percentage)}
									aria-valuetext={progress.label}
								>
									{progress.label}
								</div>
							) : null}
						</div>
						<div id="update-list" className="update-list">
							{notes.map((text, index) => (
								<div className="update-item" key={`${index}:${text}`}>
									<span className="update-item-dot" data-index={String(index + 1).padStart(2, "0")} />
									<div className="update-item-text">{text}</div>
								</div>
							))}
						</div>
						<div className="update-actions">
							<button
								id="update-primary-btn"
								className="update-primary-btn"
								type="button"
								onClick={onPrimary}
								disabled={viewModel.primaryDisabled}
							>
								<span id="update-btn-fill" className="update-btn-fill" />
								<span id="update-btn-label" className="update-btn-label">{viewModel.primaryLabel}</span>
							</button>
							<button className="update-secondary-btn" type="button" onClick={onClose}>关闭</button>
						</div>
						{viewModel.candidate ? (
							<div className="update-policy-actions" aria-label="更新选项">
								{viewModel.canRemindLater ? <button type="button" onClick={onRemindLater}>稍后提醒</button> : null}
								{viewModel.canSkipVersion ? <button type="button" onClick={onSkipVersion}>跳过此版本</button> : null}
								{viewModel.canOpenRelease ? <button type="button" onClick={onOpenRelease}>查看发布页</button> : null}
							</div>
						) : null}
						<div id="update-footnote" className="update-footnote">
							{rejectionText ?? (visibleFault
								? `${visibleFault.code} · ${visibleFault.retryable ? "可以重试" : "已阻止继续操作"}`
								: "安装前会再次验证来源、哈希和 Minisign 签名。")}
						</div>
					</div>
				</div>
			</div>
		</>
	);
}

function LegacyUpdateHost({ state, open, onOpen, onClose, onCheck, onInstall }: LegacyUpdateHostProps): ReactElement | null {
	if (!shouldShowUpdateEntry(state) && !open) return null;
	const version = state.version || state.currentVersion || "0.0.0";
	const readyToInstall = state.installState === "ready-to-download" && !state.signatureGate;
	const disabled = state.status === "checking" || state.status === "downloading" || state.status === "installing" || state.signatureGate;
	const primaryAction = readyToInstall ? onInstall : onCheck;
	return (
		<>
			<button
				id="update-entry"
				className={updateEntryClass(state)}
				type="button"
				onClick={onOpen}
				title="发现新版本"
				aria-label="发现新版本"
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<circle className="update-ring" cx="12" cy="12" r="8.8" />
					<circle id="update-progress-ring" className="update-progress-ring" cx="12" cy="12" r="8.8" />
					<path className="update-arrow" d="M12 16.5V7.5" />
					<path className="update-arrow" d="M8.7 10.7 12 7.4l3.3 3.3" />
				</svg>
			</button>
			<div id="update-modal" className={open ? "modal-mask show" : "modal-mask"} role="presentation" onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}>
				<div className={updateModalClass(state)} role="dialog" aria-modal="true" aria-labelledby="update-modal-version">
					<div className="update-panel-inner">
						<div className="update-panel-head">
							<div>
								<div className="update-kicker">MINERADIO</div>
								<div id="update-modal-title" className="update-title">New release</div>
								<div id="update-modal-version" className="update-version">v{version}</div>
							</div>
						</div>
						<div className="update-hero">
							<div id="update-hero-main" className="update-hero-main">{updateHeroText(state)}</div>
						</div>
						<div id="update-list" className="update-list">
							{updateNotes(state).map((text, index) => (
								<div className="update-item" key={`${index}:${text}`}>
									<span className="update-item-dot" data-index={String(index + 1).padStart(2, "0")} />
									<div className="update-item-text">{text}</div>
								</div>
							))}
						</div>
						<div className="update-actions">
							<button id="update-primary-btn" className="update-primary-btn" type="button" onClick={primaryAction} disabled={disabled}>
								<span id="update-btn-fill" className="update-btn-fill" />
								<span id="update-btn-label" className="update-btn-label">{primaryLabel(state)}</span>
							</button>
							<button className="update-secondary-btn" type="button" onClick={onClose}>取消</button>
						</div>
						<div id="update-footnote" className="update-footnote">{footnote(state)}</div>
					</div>
				</div>
			</div>
		</>
	);
}

export function UpdateHost(props: UpdateHostProps): ReactElement | null {
	return "viewModel" in props
		? <ExperienceUpdateHost {...props} />
		: <LegacyUpdateHost {...props} />;
}

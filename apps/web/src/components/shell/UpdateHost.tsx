import { type ReactElement, useLayoutEffect, useRef } from "react";
import type { UpdateViewModel } from "../../features/updater/update-view-model";

export interface UpdateHostProps {
	viewModel: UpdateViewModel;
	onOpen: () => void;
	onClose: () => void;
	onPrimary: () => void;
	onRemindLater: () => void;
	onSkipVersion: () => void;
	onOpenRelease: () => void;
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

export function UpdateHost({
	viewModel,
	onOpen,
	onClose,
	onPrimary,
	onRemindLater,
	onSkipVersion,
	onOpenRelease,
}: UpdateHostProps): ReactElement | null {
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

	// official runtime 在 idle/current 也保留手动检查入口；只有明确 disabled 的
	// 开发/自编译构建隐藏整个 surface。
	if (viewModel.phase === "disabled" && !viewModel.modalOpen) return null;
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

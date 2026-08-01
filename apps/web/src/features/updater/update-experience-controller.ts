import type {
	UpdateReceipt,
	UpdateRuntimePort,
	UpdateSnapshot,
} from "../../ports/update-runtime-port";
import {
	projectUpdateViewModel,
	updateFaultKey,
	type UpdatePresentationMode,
	type UpdatePrimaryIntent,
	type UpdateViewModel,
} from "./update-view-model";

export interface UpdateExperienceClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: UpdateExperienceClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export interface UpdateExperienceController {
	getSnapshot(): UpdateViewModel;
	subscribe(listener: () => void): () => void;
	setPresentation(mode: UpdatePresentationMode): void;
	openModal(): void;
	closeModal(): void;
	checkNow(): Promise<UpdateReceipt>;
	invokePrimary(intent: UpdatePrimaryIntent | null): Promise<UpdateReceipt>;
	remindLater(candidateId: string | null): Promise<UpdateReceipt>;
	skipVersion(candidateId: string | null): Promise<UpdateReceipt>;
	openRelease(candidateId: string | null): Promise<UpdateReceipt>;
	dispose(): void;
}

interface ManualCheckState {
	readonly generation: number;
	readonly baseRevision: number;
	accepted: boolean;
}

interface PendingManualPrompt {
	readonly token: string;
	readonly candidateId: string | null;
	readonly faultKey: string | null;
}

function isCandidateAttentionPhase(snapshot: UpdateSnapshot): boolean {
	return !!snapshot.candidate
		&& (snapshot.phase === "available" || snapshot.phase === "ready-to-install");
}

function boundedTimerDelay(delayMs: number): number {
	return Math.min(Math.max(0, delayMs), 2_147_483_647);
}

export function createUpdateExperienceController(
	runtime: UpdateRuntimePort,
	clock: UpdateExperienceClock = systemClock,
): UpdateExperienceController {
	let disposed = false;
	let presentation: UpdatePresentationMode = "unknown";
	let modalOpen = false;
	const promptTokens = new Set<string>();
	let reminderTimer: ReturnType<typeof setTimeout> | null = null;
	let reminderTimerAt: number | null = null;
	let manualGeneration = 0;
	let manualCheck: ManualCheckState | null = null;
	let manualFaultKey: string | null = null;
	let actionRejection: Exclude<UpdateReceipt, "accepted"> | null = null;
	let pendingManualPrompt: PendingManualPrompt | null = null;
	let viewModel = projectUpdateViewModel(runtime.getSnapshot(), {
		modalOpen,
		presentation,
		manualFaultKey,
		actionRejection,
	});
	const listeners = new Set<() => void>();

	const notifyIfChanged = () => {
		const next = projectUpdateViewModel(runtime.getSnapshot(), {
			modalOpen,
			presentation,
			manualFaultKey,
			actionRejection,
		});
		if (
			next.revision === viewModel.revision
			&& next.modalOpen === viewModel.modalOpen
			&& next.presentation === viewModel.presentation
			&& next.manualFault === viewModel.manualFault
			&& next.backgroundFault === viewModel.backgroundFault
			&& next.actionRejection === viewModel.actionRejection
		) return;
		viewModel = next;
		for (const listener of listeners) listener();
	};

	const clearReminderTimer = () => {
		if (reminderTimer !== null) clock.clearTimeout(reminderTimer);
		reminderTimer = null;
		reminderTimerAt = null;
	};

	const scheduleReminder = (at: number) => {
		if (reminderTimerAt === at) return;
		clearReminderTimer();
		reminderTimerAt = at;
		reminderTimer = clock.setTimeout(() => {
			reminderTimer = null;
			reminderTimerAt = null;
			reconcile();
		}, boundedTimerDelay(at - clock.now()));
	};

	const automaticPromptToken = (snapshot: UpdateSnapshot): string | null => {
		const candidate = snapshot.candidate;
		if (!candidate || !isCandidateAttentionPhase(snapshot)) {
			clearReminderTimer();
			return null;
		}
		if (snapshot.skippedVersion === candidate.version) {
			clearReminderTimer();
			return null;
		}
		if (snapshot.remindAfter !== null && snapshot.remindAfter > clock.now()) {
			scheduleReminder(snapshot.remindAfter);
			return null;
		}
		clearReminderTimer();
		return snapshot.remindAfter === null
			? `candidate:${candidate.id}`
			: `reminder:${candidate.id}:${snapshot.remindAfter}`;
	};

	function reconcile(): void {
		if (disposed) return;
		const snapshot = runtime.getSnapshot();
		if (!manualCheck && snapshot.phase === "checking") {
			manualFaultKey = null;
			pendingManualPrompt = null;
		}
		if (manualCheck?.accepted && snapshot.revision > manualCheck.baseRevision && snapshot.phase !== "checking") {
			const generation = manualCheck.generation;
			manualFaultKey = snapshot.fault?.stage === "check"
				? updateFaultKey(snapshot.fault)
				: null;
			pendingManualPrompt = snapshot.candidate || snapshot.fault?.stage === "check"
				? {
					token: `manual:${generation}:${snapshot.candidate?.id ?? snapshot.fault?.code ?? "result"}`,
					candidateId: snapshot.candidate?.id ?? null,
					faultKey: snapshot.fault?.stage === "check" ? updateFaultKey(snapshot.fault) : null,
				}
				: null;
			manualCheck = null;
		} else if (!snapshot.fault || updateFaultKey(snapshot.fault) !== manualFaultKey) {
			manualFaultKey = null;
		}

		if (
			pendingManualPrompt
			&& (
				pendingManualPrompt.candidateId !== (snapshot.candidate?.id ?? null)
				|| (
					pendingManualPrompt.candidateId === null
					&& pendingManualPrompt.faultKey !== updateFaultKey(snapshot.fault)
				)
			)
		) pendingManualPrompt = null;
		const promptToken = pendingManualPrompt?.token ?? automaticPromptToken(snapshot);
		if (promptToken && presentation === "normal" && !promptTokens.has(promptToken)) {
			const isManualPrompt = promptToken === pendingManualPrompt?.token;
			promptTokens.add(promptToken);
			modalOpen = true;
			if (isManualPrompt) {
				pendingManualPrompt = null;
				const automaticToken = automaticPromptToken(snapshot);
				if (automaticToken) promptTokens.add(automaticToken);
			}
		}
		if (presentation !== "normal") modalOpen = false;
		notifyIfChanged();
	}

	const unsubscribeRuntime = runtime.subscribe(reconcile);
	const applyReceipt = (
		receipt: UpdateReceipt,
		options: { readonly closeOnAccepted?: boolean } = {},
	): UpdateReceipt => {
		if (receipt === "accepted") {
			actionRejection = null;
			if (options.closeOnAccepted) modalOpen = false;
		} else {
			actionRejection = receipt;
		}
		notifyIfChanged();
		return receipt;
	};

	const dispatchCandidateIntent = async (
		kind: "download" | "remind-later" | "skip-version" | "install-and-restart" | "open-release",
		candidateId: string | null,
	): Promise<UpdateReceipt> => {
		if (disposed) return "runtime-unavailable";
		if (!candidateId) return "invalid-order";
		switch (kind) {
			case "download": return runtime.dispatch({ kind: "download", candidateId });
			case "remind-later": return runtime.dispatch({ kind: "remind-later", candidateId });
			case "skip-version": return runtime.dispatch({ kind: "skip-version", candidateId });
			case "install-and-restart": return runtime.dispatch({ kind: "install-and-restart", candidateId });
			case "open-release": return runtime.dispatch({ kind: "open-release", candidateId });
		}
	};

	const controller: UpdateExperienceController = {
		getSnapshot: () => viewModel,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setPresentation(mode) {
			if (presentation === mode || disposed) return;
			presentation = mode;
			reconcile();
		},
		openModal() {
			if (disposed || presentation !== "normal") return;
			modalOpen = true;
			notifyIfChanged();
		},
		closeModal() {
			if (disposed || !modalOpen) return;
			modalOpen = false;
			notifyIfChanged();
		},
		async checkNow() {
			if (disposed) return "runtime-unavailable";
			// 重复点击仍交给 native single-flight 判定，但不能覆盖首个手动检查的展示归属。
			if (manualCheck) return applyReceipt(await runtime.dispatch({ kind: "check-now" }));
			const previousManualFaultKey = manualFaultKey;
			manualFaultKey = null;
			manualGeneration += 1;
			const pending: ManualCheckState = {
				generation: manualGeneration,
				baseRevision: runtime.getSnapshot().revision,
				accepted: false,
			};
			manualCheck = pending;
			const receipt = await runtime.dispatch({ kind: "check-now" });
			if (manualCheck !== pending) return applyReceipt(receipt);
			if (receipt !== "accepted") {
				manualCheck = null;
				manualFaultKey = previousManualFaultKey;
				return applyReceipt(receipt);
			}
			pending.accepted = true;
			applyReceipt(receipt);
			reconcile();
			return receipt;
		},
		async invokePrimary(intent) {
			if (disposed) return "runtime-unavailable";
			if (!intent) return "invalid-order";
			switch (intent.kind) {
				case "check-now": return controller.checkNow();
				case "download": return applyReceipt(await dispatchCandidateIntent("download", intent.candidateId));
				case "install-and-restart": return applyReceipt(await dispatchCandidateIntent("install-and-restart", intent.candidateId));
				case "cancel-download": return applyReceipt(await runtime.dispatch(intent));
				default: return "invalid-order";
			}
		},
		async remindLater(candidateId) {
			if (disposed) return "runtime-unavailable";
			return applyReceipt(
				await dispatchCandidateIntent("remind-later", candidateId),
				{ closeOnAccepted: true },
			);
		},
		async skipVersion(candidateId) {
			if (disposed) return "runtime-unavailable";
			return applyReceipt(
				await dispatchCandidateIntent("skip-version", candidateId),
				{ closeOnAccepted: true },
			);
		},
		async openRelease(candidateId) {
			return applyReceipt(await dispatchCandidateIntent("open-release", candidateId));
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearReminderTimer();
			listeners.clear();
			unsubscribeRuntime();
		},
	};

	reconcile();
	return controller;
}

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	FullDesktopMode,
	FullDesktopRuntimePort,
	FullDesktopRuntimeState,
} from "../../ports/full-desktop-runtime-port";
import { createDesktopRequestGuard } from "./desktop-request-guard";

export interface FullDesktopRuntimeController {
	state: FullDesktopRuntimeState | null;
	busy: boolean;
	error: string | null;
	refresh(): Promise<void>;
	setMode(mode: FullDesktopMode): Promise<void>;
	setIconsVisible(visible: boolean): Promise<void>;
	setInteractionLocked(locked: boolean): Promise<void>;
	recover(): Promise<void>;
}

function describeFullDesktopError(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isEditableEscapeTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	if (target.closest("input, textarea, select")) return true;
	const editable = target.closest("[contenteditable]");
	if (!editable) return false;
	const value = (editable.getAttribute("contenteditable") ?? "").toLowerCase();
	return value === "" || value === "true" || value === "plaintext-only";
}

export function useFullDesktopRuntime(
	port: FullDesktopRuntimePort,
): FullDesktopRuntimeController {
	const [state, setState] = useState<FullDesktopRuntimeState | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestGuardRef = useRef(createDesktopRequestGuard());
	const busyRef = useRef(false);
	const mutationGenerationRef = useRef(0);

	const refresh = useCallback(async () => {
		if (busyRef.current) return;
		const guard = requestGuardRef.current;
		const generation = guard.begin();
		try {
			const next = await port.getRuntimeState();
			if (!guard.isCurrent(generation)) return;
			setState(next);
			setError(null);
		} catch (cause) {
			if (guard.isCurrent(generation)) setError(describeFullDesktopError(cause));
		}
	}, [port]);

	useEffect(() => {
		requestGuardRef.current.dispose();
		const guard = createDesktopRequestGuard();
		requestGuardRef.current = guard;
		mutationGenerationRef.current += 1;
		busyRef.current = false;
		setBusy(false);
		setState(null);
		setError(null);
		void refresh();
		return () => {
			guard.dispose();
			mutationGenerationRef.current += 1;
			busyRef.current = false;
		};
	}, [refresh]);

	const runMutation = useCallback(async (
		mutation: () => Promise<FullDesktopRuntimeState>,
	) => {
		if (busyRef.current) return;
		const guard = requestGuardRef.current;
		const requestGeneration = guard.begin();
		const mutationGeneration = mutationGenerationRef.current + 1;
		mutationGenerationRef.current = mutationGeneration;
		busyRef.current = true;
		setBusy(true);
		try {
			const next = await mutation();
			if (!guard.isCurrent(requestGeneration)) return;
			setState(next);
			setError(null);
		} catch (cause) {
			if (guard.isCurrent(requestGeneration)) setError(describeFullDesktopError(cause));
		} finally {
			if (mutationGenerationRef.current === mutationGeneration) {
				busyRef.current = false;
				if (guard.isCurrent(requestGeneration)) setBusy(false);
			}
		}
	}, []);

	const setMode = useCallback(
		(mode: FullDesktopMode) => runMutation(() => port.setMode(mode)),
		[port, runMutation],
	);
	const setIconsVisible = useCallback(
		(visible: boolean) => runMutation(() => port.setIconsVisible(visible)),
		[port, runMutation],
	);
	const setInteractionLocked = useCallback(
		(locked: boolean) => runMutation(() => port.setInteractionLocked(locked)),
		[port, runMutation],
	);
	const recover = useCallback(
		() => runMutation(() => port.recover()),
		[port, runMutation],
	);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const recoveryRequired = state?.recoveryRequired === true;
		const fullDesktopActive = state?.effectiveMode === "passive"
			|| state?.effectiveMode === "interactive";
		if (!recoveryRequired && !fullDesktopActive) return;
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (event.repeat || event.isComposing) return;
			if (isEditableEscapeTarget(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			if (recoveryRequired) {
				void recover();
				return;
			}
			void setMode("disabled");
		};
		window.addEventListener("keydown", handleEscape, true);
		return () => window.removeEventListener("keydown", handleEscape, true);
	}, [recover, setMode, state?.effectiveMode, state?.recoveryRequired]);

	return {
		state,
		busy,
		error,
		refresh,
		setMode,
		setIconsVisible,
		setInteractionLocked,
		recover,
	};
}

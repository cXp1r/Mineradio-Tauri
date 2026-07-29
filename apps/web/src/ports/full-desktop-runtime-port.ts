export type FullDesktopMode = "disabled" | "passive" | "interactive";

export type FullDesktopRuntimePhase =
	| "disabled"
	| "attaching"
	| "passive"
	| "interactive"
	| "recovering"
	| "detaching"
	| "recoveryRequired";

export interface FullDesktopRuntimeState {
	phase: FullDesktopRuntimePhase;
	requestedMode: FullDesktopMode;
	effectiveMode: FullDesktopMode;
	iconsVisible: boolean;
	interactionLocked: boolean;
	recoveryRequired: boolean;
	autoResumeSuppressed: boolean;
	explorerGeneration: number;
	lastError?: string;
}

export interface FullDesktopRuntimePort {
	getRuntimeState(): Promise<FullDesktopRuntimeState>;
	setMode(mode: FullDesktopMode): Promise<FullDesktopRuntimeState>;
	setIconsVisible(visible: boolean): Promise<FullDesktopRuntimeState>;
	setInteractionLocked(locked: boolean): Promise<FullDesktopRuntimeState>;
	recover(): Promise<FullDesktopRuntimeState>;
}

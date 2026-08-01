import type {
	VisualBackgroundPolicy,
	VisualRuntimeMode,
	VisualVisibilityState,
} from "./visual-engine-contract";

export function deriveVisualRuntimeMode(
	state: VisualVisibilityState,
	policy: VisualBackgroundPolicy,
): VisualRuntimeMode {
	const foreground =
		state.documentVisible &&
		state.windowVisible &&
		state.windowFocused &&
		!state.windowMinimized;
	if (foreground) return "foreground";
	if (policy === "release") return "released";
	if (policy === "keep") return "background";

	const visible =
		state.documentVisible && state.windowVisible && !state.windowMinimized;
	return visible ? "background" : "deep-sleep";
}

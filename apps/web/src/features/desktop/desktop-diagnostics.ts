import type { VisualPerformanceSnapshot } from "@mineradio/visual-engine";
import type { DesktopDiagnosticsSnapshot } from "../../ports/desktop-runtime-port";

export type DesktopVisualPerformanceReader = () => VisualPerformanceSnapshot | null;

export interface DesktopDiagnosticsComposition {
	readonly native: DesktopDiagnosticsSnapshot | null;
	readonly visual: VisualPerformanceSnapshot | null;
	readonly visualError: string | null;
}

export function composeDesktopDiagnostics(
	native: DesktopDiagnosticsSnapshot | null,
	readVisualPerformance?: DesktopVisualPerformanceReader,
): DesktopDiagnosticsComposition {
	if (!readVisualPerformance) return { native, visual: null, visualError: null };
	try {
		return {
			native,
			visual: readVisualPerformance(),
			visualError: null,
		};
	} catch (error) {
		return {
			native,
			visual: null,
			visualError: String(error),
		};
	}
}

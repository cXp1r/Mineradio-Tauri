import { expect, test } from "bun:test";
import {
	deriveVisualRuntimeMode,
	type VisualBackgroundPolicy,
	type VisualRuntimeMode,
	type VisualVisibilityState,
} from "../index";

const foregroundVisibility: VisualVisibilityState = {
	documentVisible: true,
	windowVisible: true,
	windowFocused: true,
	windowMinimized: false,
};

test("derives every visibility and background-policy runtime mode", () => {
	const cases: readonly {
		readonly visibility: VisualVisibilityState;
		readonly policy: VisualBackgroundPolicy;
		readonly expected: VisualRuntimeMode;
	}[] = [
		{ visibility: foregroundVisibility, policy: "auto", expected: "foreground" },
		{ visibility: foregroundVisibility, policy: "keep", expected: "foreground" },
		{ visibility: foregroundVisibility, policy: "release", expected: "foreground" },
		{
			visibility: { ...foregroundVisibility, windowFocused: false },
			policy: "auto",
			expected: "background",
		},
		{
			visibility: { ...foregroundVisibility, documentVisible: false },
			policy: "auto",
			expected: "deep-sleep",
		},
		{
			visibility: { ...foregroundVisibility, windowVisible: false },
			policy: "auto",
			expected: "deep-sleep",
		},
		{
			visibility: { ...foregroundVisibility, windowMinimized: true },
			policy: "auto",
			expected: "deep-sleep",
		},
		{
			visibility: { ...foregroundVisibility, documentVisible: false },
			policy: "keep",
			expected: "background",
		},
		{
			visibility: { ...foregroundVisibility, windowVisible: false },
			policy: "keep",
			expected: "background",
		},
		{
			visibility: { ...foregroundVisibility, windowMinimized: true },
			policy: "keep",
			expected: "background",
		},
		{
			visibility: { ...foregroundVisibility, windowFocused: false },
			policy: "release",
			expected: "released",
		},
		{
			visibility: { ...foregroundVisibility, documentVisible: false },
			policy: "release",
			expected: "released",
		},
	];

	for (const entry of cases) {
		expect(deriveVisualRuntimeMode(entry.visibility, entry.policy)).toBe(
			entry.expected,
		);
	}
});

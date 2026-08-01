import { expect, test } from "bun:test";
import type { UpdateSnapshot } from "../../ports/update-runtime-port";
import {
	projectUpdateViewModel,
	resolveUpdatePresentationMode,
} from "./update-view-model";

function snapshot(overrides: Partial<UpdateSnapshot>): UpdateSnapshot {
	return {
		revision: 1,
		phase: "idle",
		currentVersion: "0.9.0",
		candidate: null,
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
		...overrides,
	};
}

const context = {
	modalOpen: true,
	presentation: "normal",
	manualFaultKey: null,
} as const;

test("有总长度的下载显示字节和百分比，未知长度显示不确定进度", () => {
	const known = projectUpdateViewModel(snapshot({
		phase: "downloading",
		operation: {
			id: "download-1",
			kind: "download",
			receivedBytes: 512 * 1024,
			totalBytes: 1024 * 1024,
			cancellable: true,
		},
	}), context);
	expect(known.progress?.percentage).toBe(50);
	expect(known.progress?.indeterminate).toBe(false);
	expect(known.progress?.label).toBe("512 KiB / 1 MiB（50%）");
	expect(known.primaryAction).toBe("cancel-download");

	const unknown = projectUpdateViewModel(snapshot({
		phase: "downloading",
		operation: {
			id: "download-2",
			kind: "download",
			receivedBytes: 2048,
			totalBytes: null,
			cancellable: false,
		},
	}), context);
	expect(unknown.progress?.percentage).toBeNull();
	expect(unknown.progress?.indeterminate).toBe(true);
	expect(unknown.progress?.label).toBe("已下载 2 KiB");
});

test("verified candidate 的唯一主操作是安装并重启", () => {
	const model = projectUpdateViewModel(snapshot({
		phase: "ready-to-install",
		candidate: {
			id: "candidate-1.0.0",
			version: "1.0.0",
			notes: [],
			publishedAt: null,
		},
	}), context);
	expect(model.primaryAction).toBe("install-and-restart");
	expect(model.primaryLabel).toBe("安装并重启");
	expect(model.primaryDisabled).toBe(false);
});

test("窗口或完整桌面状态未知时 fail closed，已确认退出后才回到普通提示", () => {
	const normalWindow = {
		isFullScreen: false,
		isNativeFullScreen: false,
		isHtmlFullScreen: false,
		isWindowFullScreen: false,
	};
	const disabledDesktop = { phase: "disabled", effectiveMode: "disabled" } as const;
	expect(resolveUpdatePresentationMode(null, null)).toBe("unknown");
	expect(resolveUpdatePresentationMode(normalWindow, null)).toBe("unknown");
	expect(resolveUpdatePresentationMode(normalWindow, {
		phase: "interactive",
		effectiveMode: "interactive",
	})).toBe("full-desktop");
	expect(resolveUpdatePresentationMode({
		...normalWindow,
		isNativeFullScreen: true,
	}, disabledDesktop)).toBe("fullscreen");
	expect(resolveUpdatePresentationMode(normalWindow, disabledDesktop)).toBe("normal");
});

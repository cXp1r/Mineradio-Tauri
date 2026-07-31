import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { UpdateHost } from "./UpdateHost";
import { projectUpdateViewModel } from "../../features/updater/update-view-model";
import type { UpdateSnapshot } from "../../ports/update-runtime-port";

function idleSnapshot(phase: UpdateSnapshot["phase"]): UpdateSnapshot {
	return {
		revision: 0,
		phase,
		currentVersion: "1.0.0",
		candidate: null,
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
	};
}

test("idle and current official runtimes keep manual check reachable while disabled builds stay hidden", () => {
	const props = {
		onOpen: () => {},
		onClose: () => {},
		onPrimary: () => {},
		onRemindLater: () => {},
		onSkipVersion: () => {},
		onOpenRelease: () => {},
	};
	for (const phase of ["idle", "current"] as const) {
		const html = renderToStaticMarkup(
			<UpdateHost
				{...props}
				viewModel={projectUpdateViewModel(idleSnapshot(phase), {
					modalOpen: false,
					presentation: "normal",
					manualFaultKey: null,
				})}
			/>,
		);
		expect(html).toContain('id="update-entry"');
		expect(html).toContain("查看更新状态");
	}
	const disabled = renderToStaticMarkup(
		<UpdateHost
			{...props}
			viewModel={projectUpdateViewModel(idleSnapshot("disabled"), {
				modalOpen: false,
				presentation: "normal",
				manualFaultKey: null,
			})}
		/>,
	);
	expect(disabled).toBe("");
});

test("UpdateHost renders the new runtime projection with accessible determinate progress", () => {
	const snapshot: UpdateSnapshot = {
		revision: 3,
		phase: "downloading",
		currentVersion: "0.9.0",
		candidate: {
			id: "candidate-1.0.0",
			version: "1.0.0",
			notes: ["可信更新摘要"],
			publishedAt: "2026-07-31T00:00:00Z",
		},
		operation: {
			id: "download-1",
			kind: "download",
			receivedBytes: 512 * 1024,
			totalBytes: 1024 * 1024,
			cancellable: true,
		},
		fault: null,
		checkedAt: Date.now(),
		remindAfter: null,
		skippedVersion: null,
	};
	const html = renderToStaticMarkup(
		<UpdateHost
			viewModel={projectUpdateViewModel(snapshot, {
				modalOpen: true,
				presentation: "normal",
				manualFaultKey: null,
			})}
			onOpen={() => {}}
			onClose={() => {}}
			onPrimary={() => {}}
			onRemindLater={() => {}}
			onSkipVersion={() => {}}
			onOpenRelease={() => {}}
		/>,
	);
	expect(html).toContain('role="progressbar"');
	expect(html).toContain('aria-valuenow="50"');
	expect(html).toContain("512 KiB / 1 MiB（50%）");
	expect(html).toContain("取消下载");
	expect(html).toContain('aria-live="polite"');
});

test("UpdateHost exposes install-and-restart and exact-candidate policy actions", () => {
	const html = renderToStaticMarkup(
		<UpdateHost
			viewModel={projectUpdateViewModel({
				revision: 4,
				phase: "ready-to-install",
				currentVersion: "0.9.0",
				candidate: {
					id: "candidate-1.0.0",
					version: "1.0.0",
					notes: ["安装包已完成签名验证"],
					publishedAt: null,
				},
				operation: null,
				fault: null,
				checkedAt: Date.now(),
				remindAfter: null,
				skippedVersion: null,
			}, {
				modalOpen: true,
				presentation: "normal",
				manualFaultKey: null,
			})}
			onOpen={() => {}}
			onClose={() => {}}
			onPrimary={() => {}}
			onRemindLater={() => {}}
			onSkipVersion={() => {}}
			onOpenRelease={() => {}}
		/>,
	);
	expect(html).toContain("安装并重启");
	expect(html).toContain("稍后提醒");
	expect(html).toContain("跳过此版本");
	expect(html).toContain("查看发布页");
	expect(html).toContain('aria-modal="true"');
});

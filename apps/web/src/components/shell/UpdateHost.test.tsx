import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { UpdateHost, shouldShowUpdateEntry } from "./UpdateHost";
import type { UpdateState } from "../../stores/update-store";
import { projectUpdateViewModel } from "../../features/updater/update-view-model";
import type { UpdateSnapshot } from "../../ports/update-runtime-port";

function updateState(overrides: Partial<UpdateState> = {}): UpdateState {
	return {
		status: "idle",
		version: null,
		currentVersion: "0.1.0",
		body: null,
		message: null,
		date: null,
		error: null,
		requiresSignature: true,
		signatureGate: true,
		installState: "signature-key-missing",
		setStatus: () => {},
		setVersion: () => {},
		setMessage: () => {},
		applyCheckResult: () => {},
		reset: () => {},
		...overrides,
	};
}

test("shouldShowUpdateEntry follows baseline hidden-until-actionable update entry behavior", () => {
	expect(shouldShowUpdateEntry(updateState())).toBe(false);
	expect(shouldShowUpdateEntry(updateState({ status: "checking" }))).toBe(true);
	expect(shouldShowUpdateEntry(updateState({ status: "available", version: "0.2.0" }))).toBe(true);
	expect(shouldShowUpdateEntry(updateState({ status: "error", error: "UPDATER_CHECK_FAILED" }))).toBe(true);
	expect(shouldShowUpdateEntry(updateState({ status: "not-available" }))).toBe(false);
});

test("UpdateHost renders baseline entry and signature-gated modal copy", () => {
	const html = renderToStaticMarkup(
		<UpdateHost
			state={updateState({
				status: "available",
				version: "0.2.0",
				currentVersion: "0.1.0",
				message: "新版更新说明",
				body: "修复播放链路\n优化 3D 歌单架",
				signatureGate: true,
				installState: "signature-key-missing",
			})}
			open
			onOpen={() => {}}
			onClose={() => {}}
			onCheck={() => {}}
			onInstall={() => {}}
		/>
	);
	expect(html).toContain('id="update-entry"');
	expect(html).toContain("available");
	expect(html).toContain('id="update-modal"');
	expect(html).toContain("v0.2.0");
	expect(html).toContain("修复播放链路");
	expect(html).toContain("签名密钥未配置");
	expect(html).toContain("暂不可安装");
});

test("UpdateHost renders signed updater install action when ready", () => {
	let installs = 0;
	const html = renderToStaticMarkup(
		<UpdateHost
			state={updateState({
				status: "available",
				version: "0.2.0",
				signatureGate: false,
				installState: "ready-to-download",
			})}
			open
			onOpen={() => {}}
			onClose={() => {}}
			onCheck={() => {}}
			onInstall={() => { installs += 1; }}
		/>
	);
	expect(html).toContain("下载并安装");
	expect(html).toContain("ready");
	expect(installs).toBe(0);
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

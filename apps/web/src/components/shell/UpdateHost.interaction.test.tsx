import { expect, test } from "bun:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { projectUpdateViewModel } from "../../features/updater/update-view-model";
import { UpdateHost } from "./UpdateHost";

test("首次以沉浸态静默徽标挂载时不会抢走现有焦点", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const prior = document.createElement("button");
	prior.textContent = "播放";
	document.body.appendChild(prior);
	prior.focus();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const badgeOnly = projectUpdateViewModel({
		revision: 1,
		phase: "available",
		currentVersion: "0.9.0",
		candidate: {
			id: "candidate-1.0.0",
			version: "1.0.0",
			notes: [],
			publishedAt: null,
		},
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
	}, {
		modalOpen: false,
		presentation: "fullscreen",
		manualFaultKey: null,
	});
	try {
		flushSync(() => root.render(
			<UpdateHost
				viewModel={badgeOnly}
				onOpen={() => {}}
				onClose={() => {}}
				onPrimary={() => {}}
				onRemindLater={() => {}}
				onSkipVersion={() => {}}
				onOpenRelease={() => {}}
			/>,
		));
		expect(document.activeElement?.textContent).toBe("播放");
	} finally {
		root.unmount();
		host.remove();
		prior.remove();
	}
});

test("阶段播报区域不包含高频下载进度", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const downloading = projectUpdateViewModel({
		revision: 2,
		phase: "downloading",
		currentVersion: "0.9.0",
		candidate: {
			id: "candidate-1.0.0",
			version: "1.0.0",
			notes: [],
			publishedAt: null,
		},
		operation: {
			id: "download-1",
			kind: "download",
			receivedBytes: 512,
			totalBytes: 1024,
			cancellable: true,
		},
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
	}, {
		modalOpen: true,
		presentation: "normal",
		manualFaultKey: null,
	});
	try {
		flushSync(() => root.render(
			<UpdateHost
				viewModel={downloading}
				onOpen={() => {}}
				onClose={() => {}}
				onPrimary={() => {}}
				onRemindLater={() => {}}
				onSkipVersion={() => {}}
				onOpenRelease={() => {}}
			/>,
		));
		const liveRegion = host.querySelector<HTMLElement>('[aria-live="polite"]');
		const progress = host.querySelector<HTMLElement>('[role="progressbar"]');
		expect(liveRegion?.textContent).toContain("正在下载");
		expect(liveRegion?.contains(progress ?? null)).toBe(false);
		expect(progress?.getAttribute("aria-valuenow")).toBe("50");
	} finally {
		root.unmount();
		host.remove();
	}
});

test("UpdateHost traps modal focus, handles Escape, and restores the previous control", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const prior = document.createElement("button");
	prior.textContent = "播放";
	document.body.appendChild(prior);
	prior.focus();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	let closeCalls = 0;
	const ready = projectUpdateViewModel({
		revision: 5,
		phase: "ready-to-install",
		currentVersion: "0.9.0",
		candidate: {
			id: "candidate-1.0.0",
			version: "1.0.0",
			notes: [],
			publishedAt: null,
		},
		operation: null,
		fault: null,
		checkedAt: null,
		remindAfter: null,
		skippedVersion: null,
	}, {
		modalOpen: true,
		presentation: "normal",
		manualFaultKey: null,
	});
	const render = (viewModel: typeof ready) => (
		<UpdateHost
			viewModel={viewModel}
			onOpen={() => {}}
			onClose={() => { closeCalls += 1; }}
			onPrimary={() => {}}
			onRemindLater={() => {}}
			onSkipVersion={() => {}}
			onOpenRelease={() => {}}
		/>
	);
	try {
		flushSync(() => root.render(render(ready)));
		await Promise.resolve();
		const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
		expect(document.activeElement === dialog).toBe(true);
		const focusable = [...(dialog?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
		document.dispatchEvent(new window.KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}));
		expect(document.activeElement === focusable.at(-1)).toBe(true);
		focusable.at(-1)?.focus();
		document.dispatchEvent(new window.KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		}));
		expect(document.activeElement === focusable[0]).toBe(true);

		document.dispatchEvent(new window.KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		}));
		expect(closeCalls).toBe(1);
		flushSync(() => root.render(render({ ...ready, modalOpen: false })));
		expect(document.activeElement?.textContent).toBe("播放");
	} finally {
		root.unmount();
		host.remove();
		prior.remove();
	}
});

import { expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AccountPort } from "../../ports/music/account-port";
import {
	useAccountSessionController,
	type AccountSessionControllerResult,
} from "./useAccountSessionController";

test("Cookie import preserves session, status, library and UI lifecycle order", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const events: string[] = [];
	const accounts = {
		async setSessionCookie() {
			events.push("set-session");
			return { provider: "qq", stored: true };
		},
		async loginStatus() {
			events.push("login-status");
			return { provider: "qq", loggedIn: true, userId: "10001" };
		},
	} as unknown as AccountPort;
	const controllerRef: { current: AccountSessionControllerResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useAccountSessionController({
			accounts,
			syncProviderPlaylists: async () => {
				events.push("sync-provider");
			},
			refreshHome: async () => undefined,
			refreshLibrary: async () => {
				events.push("refresh-library");
			},
			providerLabel: () => "QQ 音乐",
			showToast: (message) => events.push(`toast:${message}`),
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));

	await controllerRef.current!.importProviderCookie("qq", "uin=1", {
		onStored: () => events.push("stored"),
		onFinished: () => events.push("finished"),
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(events).toEqual([
		"set-session",
		"stored",
		"login-status",
		"sync-provider",
		"toast:QQ 音乐已登录: 10001",
		"finished",
	]);
	expect(controllerRef.current?.statusByProvider.qq).toEqual({
		provider: "qq",
		loggedIn: true,
		userId: "10001",
	});

	root.unmount();
	host.remove();
});

test("logout publishes logged-out status before refreshing the library", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const events: string[] = [];
	const accounts = {
		async logout(provider: string) {
			events.push(`logout:${provider}`);
			return { provider: "soda", loggedOut: true };
		},
	} as unknown as AccountPort;
	const controllerRef: { current: AccountSessionControllerResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useAccountSessionController({
			accounts,
			syncProviderPlaylists: async () => undefined,
			refreshHome: async () => undefined,
			refreshLibrary: () => {
				events.push("refresh-library");
			},
			providerLabel: () => "汽水音乐",
			showToast: (message) => events.push(`toast:${message}`),
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	controllerRef.current!.acceptProviderStatus({
		provider: "soda",
		loggedIn: true,
		userId: "soda-user",
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	await controllerRef.current!.logoutProvider("soda");
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(events).toEqual([
		"logout:soda",
		"refresh-library",
		"toast:汽水音乐会话已清除",
	]);
	expect(controllerRef.current?.statusByProvider.soda).toEqual({
		provider: "soda",
		loggedIn: false,
	});

	root.unmount();
	host.remove();
});

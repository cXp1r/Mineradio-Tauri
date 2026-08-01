import { expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Track } from "@mineradio/shared";
import type { LikesPort } from "../../ports/music/likes-port";
import {
	useLikesController,
	type LikesControllerResult,
} from "./useLikesController";

const track: Track = {
	id: "song-1",
	sourceId: "source-1",
	provider: "netease",
	title: "测试歌曲",
	artists: ["测试歌手"],
	album: "测试专辑",
	coverUrl: "",
	qualityHints: [],
	playableState: "playable",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("like mutation applies optimistic state and rolls back on failure", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const mutation = deferred<Awaited<ReturnType<LikesPort["likeSong"]>>>();
	const messages: string[] = [];
	const controllerRef: { current: LikesControllerResult | null } = { current: null };
	const likes = {
		async checkSongLikes(provider: Track["provider"], ids: string[]) {
			return { provider, ids, liked: { "source-1": false } };
		},
		likeSong() {
			return mutation.promise;
		},
	} as LikesPort;

	function Harness() {
		controllerRef.current = useLikesController({
			likes,
			currentTrack: track,
			showToast: (message) => messages.push(message),
			openProviderLogin: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const pending = controllerRef.current!.toggle(track);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(controllerRef.current?.isLiked(track)).toBe(true);
	expect(controllerRef.current?.isBusy(track)).toBe(true);

	mutation.reject(new Error("network"));
	await pending;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(controllerRef.current?.isLiked(track)).toBe(false);
	expect(controllerRef.current?.isBusy(track)).toBe(false);
	expect(messages).toContain("红心操作失败");

	root.unmount();
	host.remove();
});

test("LOGIN_REQUIRED rolls back and opens provider login", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const messages: string[] = [];
	let loginOpenCount = 0;
	const controllerRef: { current: LikesControllerResult | null } = { current: null };
	const likes = {
		async checkSongLikes(provider: Track["provider"], ids: string[]) {
			return { provider, ids, liked: { "source-1": false } };
		},
		async likeSong() {
			throw { code: "LOGIN_REQUIRED" };
		},
	} as LikesPort;

	function Harness() {
		controllerRef.current = useLikesController({
			likes,
			currentTrack: track,
			showToast: (message) => messages.push(message),
			openProviderLogin: () => {
				loginOpenCount += 1;
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	await controllerRef.current!.toggle(track);
	expect(controllerRef.current?.isLiked(track)).toBe(false);
	expect(loginOpenCount).toBe(1);
	expect(messages).toContain("登录后可同步到网易云");

	root.unmount();
	host.remove();
});

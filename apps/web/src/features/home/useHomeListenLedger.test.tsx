import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Track } from "@mineradio/shared";
import { createEmptyHomeListenLedger } from "./home-listen-ledger";
import type { HomeListenRepository } from "./home-listen-repository";
import {
	type HomeListenLedgerController,
	useHomeListenLedger,
} from "./useHomeListenLedger";

const track: Track = {
	provider: "netease",
	id: "song-1",
	sourceId: "song-1",
	title: "测试歌曲",
	artists: ["测试歌手"],
	album: "测试专辑",
	coverUrl: "",
	durationMs: 120_000,
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

test("failed async persistence never publishes an uncommitted listen session", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT = true;
	let saveCalls = 0;
	const repository: HomeListenRepository = {
		read: createEmptyHomeListenLedger,
		save: async () => {
			saveCalls += 1;
			throw new Error("save failed");
		},
	};
	const controllerRef: { current: HomeListenLedgerController | null } = {
		current: null,
	};
	let clock = 1_000;

	function Harness() {
		controllerRef.current = useHomeListenLedger({
			currentTrack: track,
			positionMs: 0,
			durationMs: track.durationMs ?? null,
			repository,
			now: () => clock,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	clock = 2_500;
	await act(async () => {
		controllerRef.current!.finalize(true);
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(saveCalls).toBe(1);
	expect(controllerRef.current?.ledger.songs).toEqual([]);
	expect(controllerRef.current?.summary).toBeNull();

	await act(async () => root.unmount());
	host.remove();
});

test("listen saves are serialized and each snapshot publishes only after commit", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT = true;
	const firstCommit = deferred<void>();
	const secondCommit = deferred<void>();
	const persisted: Array<ReturnType<typeof createEmptyHomeListenLedger>> = [];
	const repository: HomeListenRepository = {
		read: createEmptyHomeListenLedger,
		save: (next) => {
			persisted.push(next);
			return persisted.length === 1
				? firstCommit.promise
				: secondCommit.promise;
		},
	};
	const controllerRef: { current: HomeListenLedgerController | null } = {
		current: null,
	};
	let currentTrack = track;
	let clock = 1_000;

	function Harness() {
		controllerRef.current = useHomeListenLedger({
			currentTrack,
			positionMs: 0,
			durationMs: currentTrack.durationMs ?? null,
			repository,
			now: () => clock,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	clock = 2_500;
	await act(async () => {
		controllerRef.current!.finalize(true);
		await Promise.resolve();
	});
	expect(persisted.length).toBe(1);
	expect(controllerRef.current?.ledger.songs).toEqual([]);

	currentTrack = {
		...track,
		id: "song-2",
		sourceId: "song-2",
		title: "第二首歌",
	};
	clock = 3_000;
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	clock = 4_500;
	await act(async () => {
		controllerRef.current!.finalize(true);
		await Promise.resolve();
	});
	expect(persisted.length).toBe(1);

	firstCommit.resolve();
	await act(async () => {
		await firstCommit.promise;
		await Promise.resolve();
		await Promise.resolve();
	});
	expect(persisted.length).toBe(2);
	expect(controllerRef.current?.ledger.songs.map(({ track }) => track.id)).toEqual([
		"song-1",
	]);

	secondCommit.resolve();
	await act(async () => {
		await secondCommit.promise;
		await Promise.resolve();
	});
	expect(controllerRef.current?.ledger.songs.map(({ track }) => track.id)).toEqual([
		"song-2",
		"song-1",
	]);

	await act(async () => root.unmount());
	host.remove();
});

test("a later successful save does not revive a previously failed session", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT = true;
	const failedCommit = deferred<void>();
	const successfulCommit = deferred<void>();
	const persisted: Array<ReturnType<typeof createEmptyHomeListenLedger>> = [];
	const repository: HomeListenRepository = {
		read: createEmptyHomeListenLedger,
		save: (next) => {
			persisted.push(next);
			return persisted.length === 1
				? failedCommit.promise
				: successfulCommit.promise;
		},
	};
	const controllerRef: { current: HomeListenLedgerController | null } = {
		current: null,
	};
	let currentTrack = track;
	let clock = 1_000;

	function Harness() {
		controllerRef.current = useHomeListenLedger({
			currentTrack,
			positionMs: 0,
			durationMs: currentTrack.durationMs ?? null,
			repository,
			now: () => clock,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	clock = 2_500;
	await act(async () => {
		controllerRef.current!.finalize(true);
		await Promise.resolve();
	});

	currentTrack = {
		...track,
		id: "song-after-failure",
		sourceId: "song-after-failure",
		title: "失败后的歌曲",
	};
	clock = 3_000;
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	clock = 4_500;
	await act(async () => {
		controllerRef.current!.finalize(true);
		await Promise.resolve();
	});
	expect(persisted.length).toBe(1);

	failedCommit.reject(new Error("first save failed"));
	await act(async () => {
		await failedCommit.promise.catch(() => undefined);
		await Promise.resolve();
		await Promise.resolve();
	});
	expect(persisted.length).toBe(2);
	expect(persisted[1]?.songs.map(({ track }) => track.id)).toEqual([
		"song-after-failure",
	]);
	expect(controllerRef.current?.ledger.songs).toEqual([]);

	successfulCommit.resolve();
	await act(async () => {
		await successfulCommit.promise;
		await Promise.resolve();
	});
	expect(controllerRef.current?.ledger.songs.map(({ track }) => track.id)).toEqual([
		"song-after-failure",
	]);

	await act(async () => root.unmount());
	host.remove();
});

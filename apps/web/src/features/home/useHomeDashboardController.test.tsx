import { expect, test } from "bun:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { DiscoverHomeResponse, Track } from "@mineradio/shared";
import {
	useHomeDashboardController,
	type HomeDashboardController,
} from "./useHomeDashboardController";

function song(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: id,
		artists: [`artist-${id}`],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
	};
}

test("dashboard actions resume current playback, advance Next Up, and play the exact For You list", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const queue = [song("one"), song("two")];
	const discover: DiscoverHomeResponse = {
		loggedIn: true,
		user: null,
		dailySongs: [song("daily-1"), song("daily-2"), song("daily-3")],
		playlists: [],
		podcasts: [],
		mode: "member",
		updatedAt: 1,
	};
	const calls: string[] = [];
	const queues: string[][] = [];
	const controllerRef: { current: HomeDashboardController | null } = {
		current: null,
	};

	function Harness() {
		controllerRef.current = useHomeDashboardController({
			discover,
			listenSummary: null,
			queue,
			currentIndex: 0,
			currentTrack: queue[0],
			isPlaying: false,
			playback: {
				setQueue: (tracks) => queues.push(tracks.map((track) => track.id)),
				playAt: (index) => calls.push(`play:${index}`),
				resume: () => calls.push("resume"),
			},
			enterPlayback: () => calls.push("enter"),
			showToast: (message) => calls.push(`toast:${message}`),
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	controllerRef.current!.continueListening();
	controllerRef.current!.playNextUp();
	controllerRef.current!.playForYou(1);

	expect(calls).toEqual(["resume", "enter", "play:1", "enter", "play:1", "enter"]);
	expect(queues.length).toBe(1);
	expect(queues[0]?.length).toBe(3);
	expect(new Set(queues[0]).size).toBe(3);

	root.unmount();
	host.remove();
});

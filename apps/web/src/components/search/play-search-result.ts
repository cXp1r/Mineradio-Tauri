import type { Track } from "@mineradio/shared";
import { usePlaybackStore } from "../../stores/playback-store";

export function playSearchResult(track: Track): void {
	const store = usePlaybackStore.getState();
	store.enqueue(track);
	const queue = usePlaybackStore.getState().queue;
	const index = queue.findIndex(
		(t) => t.provider === track.provider && t.id === track.id,
	);
	if (index >= 0) {
		store.playAt(index);
	}
}

export function isPlayable(state: Track["playableState"]): boolean {
	return (
		state === "playable" ||
		state === "trial_only" ||
		state === "unknown"
	);
}
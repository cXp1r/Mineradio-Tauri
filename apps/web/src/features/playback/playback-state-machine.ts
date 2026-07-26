export type PlaybackPhase =
	| "idle"
	| "resolving"
	| "loading"
	| "playing"
	| "paused"
	| "ended"
	| "recovering"
	| "failed";

export interface PlaybackMachineState {
	phase: PlaybackPhase;
	playbackSessionId: number;
	loadRequestId: number;
	trackKey: string;
	recoveryAttempts: number;
	failureReason: string | null;
}

export type PlaybackReloadReason =
	| "media-error"
	| "long-pause"
	| "url-age"
	| "quality";

export type PlaybackMachineEvent =
	| {
			type: "PLAY_TRACK";
			playbackSessionId: number;
			loadRequestId: number;
			trackKey: string;
	  }
	| {
			type: "SWITCH_TRACK";
			playbackSessionId: number;
			loadRequestId: number;
			trackKey: string;
	  }
	| {
			type: "BEGIN_RELOAD";
			playbackSessionId: number;
			loadRequestId: number;
			reason: PlaybackReloadReason;
	  }
	| {
			type: "SOURCE_READY";
			playbackSessionId: number;
			loadRequestId: number;
	  }
	| { type: "MEDIA_PLAYING"; playbackSessionId: number }
	| { type: "PAUSE"; playbackSessionId: number }
	| { type: "RESUME"; playbackSessionId: number }
	| { type: "MEDIA_ENDED"; playbackSessionId: number }
	| {
			type: "MEDIA_FAILED";
			playbackSessionId: number;
			recoverable: boolean;
			reason: string;
	  }
	| {
			type: "RESOLVE_FAILED";
			playbackSessionId: number;
			loadRequestId: number;
			reason: string;
	  }
	| {
			type: "RECOVERY_EXHAUSTED";
			playbackSessionId: number;
			reason: string;
	  }
	| { type: "STOP"; playbackSessionId: number };

export function createPlaybackState(): PlaybackMachineState {
	return {
		phase: "idle",
		playbackSessionId: 0,
		loadRequestId: 0,
		trackKey: "",
		recoveryAttempts: 0,
		failureReason: null,
	};
}

function isCurrentSession(
	state: PlaybackMachineState,
	playbackSessionId: number,
): boolean {
	return state.playbackSessionId === playbackSessionId;
}

function isCurrentLoad(
	state: PlaybackMachineState,
	playbackSessionId: number,
	loadRequestId: number,
): boolean {
	return (
		isCurrentSession(state, playbackSessionId) &&
		state.loadRequestId === loadRequestId
	);
}

export function reducePlaybackState(
	state: PlaybackMachineState,
	event: PlaybackMachineEvent,
): PlaybackMachineState {
	switch (event.type) {
		case "PLAY_TRACK":
		case "SWITCH_TRACK":
			if (event.playbackSessionId <= state.playbackSessionId) return state;
			return {
				phase: "resolving",
				playbackSessionId: event.playbackSessionId,
				loadRequestId: event.loadRequestId,
				trackKey: event.trackKey,
				recoveryAttempts: 0,
				failureReason: null,
			};

		case "BEGIN_RELOAD":
			if (
				!isCurrentSession(state, event.playbackSessionId) ||
				state.phase === "idle" ||
				state.phase === "ended"
			) {
				return state;
			}
			return {
				...state,
				phase: event.reason === "media-error" ? "recovering" : "resolving",
				loadRequestId: event.loadRequestId,
				failureReason: null,
			};

		case "SOURCE_READY":
			if (
				!isCurrentLoad(
					state,
					event.playbackSessionId,
					event.loadRequestId,
				) ||
				(state.phase !== "resolving" && state.phase !== "recovering")
			) {
				return state;
			}
			return { ...state, phase: "loading" };

		case "MEDIA_PLAYING":
			if (
				!isCurrentSession(state, event.playbackSessionId) ||
				state.phase !== "loading"
			) {
				return state;
			}
			return { ...state, phase: "playing" };

		case "PAUSE":
			if (
				!isCurrentSession(state, event.playbackSessionId) ||
				state.phase !== "playing"
			) {
				return state;
			}
			return { ...state, phase: "paused" };

		case "RESUME":
			if (
				!isCurrentSession(state, event.playbackSessionId) ||
				state.phase !== "paused"
			) {
				return state;
			}
			return { ...state, phase: "playing" };

		case "MEDIA_ENDED":
			if (
				!isCurrentSession(state, event.playbackSessionId) ||
				(state.phase !== "playing" && state.phase !== "paused")
			) {
				return state;
			}
			return { ...state, phase: "ended" };

		case "MEDIA_FAILED":
			if (
				!isCurrentSession(state, event.playbackSessionId) ||
				(state.phase !== "loading" &&
					state.phase !== "playing" &&
					state.phase !== "paused")
			) {
				return state;
			}
			if (event.recoverable && state.recoveryAttempts < 1) {
				return {
					...state,
					phase: "recovering",
					recoveryAttempts: state.recoveryAttempts + 1,
					failureReason: null,
				};
			}
			return { ...state, phase: "failed", failureReason: event.reason };

		case "RESOLVE_FAILED":
			if (
				!isCurrentLoad(
					state,
					event.playbackSessionId,
					event.loadRequestId,
				) ||
				(state.phase !== "resolving" && state.phase !== "recovering")
			) {
				return state;
			}
			return { ...state, phase: "failed", failureReason: event.reason };

		case "RECOVERY_EXHAUSTED":
			if (
				!isCurrentSession(state, event.playbackSessionId) ||
				state.phase !== "recovering"
			) {
				return state;
			}
			return { ...state, phase: "failed", failureReason: event.reason };

		case "STOP":
			if (event.playbackSessionId <= state.playbackSessionId) return state;
			return {
				...createPlaybackState(),
				playbackSessionId: event.playbackSessionId,
			};
	}
}

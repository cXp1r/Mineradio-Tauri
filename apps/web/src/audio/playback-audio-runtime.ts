import type { AudioFrameBytes, AudioFrameSource } from "@mineradio/visual-engine";
import { sampleAlbumGaplessCrossfade } from "./album-gapless-transition";

export type PlaybackDeckId = "a" | "b";

export type PlaybackAudioEventName =
	| "play"
	| "playing"
	| "pause"
	| "timeupdate"
	| "durationchange"
	| "ended"
	| "error"
	| "waiting"
	| "stalled"
	| "canplay"
	| "ownerchange";

export interface MediaEventPayload {
	readonly loadContext: object | null;
	readonly sourceUrl: string;
	readonly generation: number;
	readonly deckId: PlaybackDeckId;
}

export interface TimeUpdatePayload extends MediaEventPayload {
	readonly positionMs: number;
	readonly durationMs: number | null;
}

export interface ErrorPayload extends MediaEventPayload {
	readonly code: number;
	readonly message: string;
}

export interface PlaybackOwnerSnapshot extends MediaEventPayload {}

export type PlaybackOwnerSourceKind = "remote" | "blob" | "local" | "opaque";

/**
 * 安装前静默阶段持有的 Committed Owner 证据。该对象只描述捕获时状态；
 * 真正的暂停和回滚仍必须回到创建它的 runtime 做 exact owner 校验。
 */
export interface CommittedPlaybackOwnerLease {
	readonly deckId: PlaybackDeckId;
	readonly generation: number;
	readonly originallyPlaying: boolean;
	readonly sourceKind: PlaybackOwnerSourceKind;
	readonly trackRef: string | null;
	readonly playbackIntentId: number | null;
}

export interface OwnerChangePayload extends MediaEventPayload {
	readonly previous: PlaybackOwnerSnapshot | null;
	readonly current: PlaybackOwnerSnapshot;
	readonly reason: "play" | "prepared" | "adopted";
}

export interface PlaybackReadinessPayload extends MediaEventPayload {
	readonly probe: "native" | "early" | "late";
}

export type PlaybackAudioEventPayload =
	| MediaEventPayload
	| TimeUpdatePayload
	| ErrorPayload
	| OwnerChangePayload
	| PlaybackReadinessPayload;

export type PlaybackAudioListener = (payload: PlaybackAudioEventPayload) => void;

export type PlaybackAudioHandlerForEvent<E extends PlaybackAudioEventName> =
	E extends "timeupdate" | "durationchange"
		? (payload: TimeUpdatePayload) => void
		: E extends "error"
			? (payload: ErrorPayload) => void
			: E extends "ownerchange"
				? (payload: OwnerChangePayload) => void
				: E extends "waiting" | "stalled" | "canplay"
					? (payload: PlaybackReadinessPayload) => void
					: (payload: MediaEventPayload) => void;

export interface PlaybackAudioRuntimeOptions {
	readonly createAudioElement?: () => HTMLAudioElement | null;
	readonly createAudioContext?: () => AudioContext | null;
	readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
	readonly clearTimeout?: (handle: unknown) => void;
	readonly setInterval?: (callback: () => void, delayMs: number) => unknown;
	readonly clearInterval?: (handle: unknown) => void;
	readonly now?: () => number;
	readonly isDocumentHidden?: () => boolean;
	readonly mediaDevices?: Pick<MediaDevices, "enumerateDevices" | "addEventListener" | "removeEventListener"> | null;
}

export const PLAYBACK_PLAY_TIMEOUT_MS = 9_000;
export const PLAYBACK_READY_RETRY_TIMEOUT_MS = 3_600;
export const PLAYBACK_STALL_PROBE_EARLY_MS = 1_600;
export const PLAYBACK_STALL_PROBE_LATE_MS = 3_600;
export const PLAYBACK_FADE_IN_MS = 460;
export const PLAYBACK_FADE_OUT_MS = 420;
export const PLAYBACK_CROSSFADE_MS = 720;
export const PLAYBACK_MAX_FADE_MS = 3_000;
const PLAYBACK_FADE_STEP_MS = 24;
export const PLAYBACK_MIRROR_SYNC_MS = 2_200;
export const PLAYBACK_MIRROR_DRIFT_SECONDS = 0.22;
export const PLAYBACK_MAX_MIRRORS = 4;
export const PLAYBACK_GRAPH_HEALTH_PROBE_MS = [720, 1_600, 2_800] as const;
export const PLAYBACK_AUDIBILITY_PROBE_MS = [520, 1_400, 3_200] as const;
export const PLAYBACK_SILENT_SIGNAL_THRESHOLD = 0.0025;
export const PLAYBACK_SEEK_PROBE_SUPPRESSION_MS = 3_200;

export interface PlaybackTransitionPreferences {
	readonly fadeInMs?: number;
	readonly fadeOutMs?: number;
	readonly crossfadeMs?: number;
	readonly crossfadeEnabled?: boolean;
}

interface NormalizedTransitionPreferences {
	fadeInMs: number;
	fadeOutMs: number;
	crossfadeMs: number;
	crossfadeEnabled: boolean;
}

export interface OutputRoutingConfig {
	readonly enabled?: boolean;
	readonly primarySinkId?: string | null;
	readonly mirrorSinkIds?: readonly string[];
	readonly virtualBridgeSinkId?: string | null;
}

export interface OutputRoutingError {
	readonly target: "primary" | "mirror" | "context";
	readonly sinkId: string;
	readonly name: string;
	readonly message: string;
}

export interface OutputRoutingSnapshot {
	readonly enabled: boolean;
	readonly requestedPrimarySinkId: string;
	readonly effectivePrimarySinkId: string;
	readonly mirrorSinkIds: readonly string[];
	readonly virtualBridgeSinkId: string;
	readonly fellBackToDefault: boolean;
	readonly errors: readonly OutputRoutingError[];
}

export interface AudioOutputDevice {
	readonly deviceId: string;
	readonly label: string;
	readonly groupId: string;
	readonly isDefault: boolean;
}

export type PreparedPlaybackStatus = "prepared" | "playing" | "committed" | "aborted" | "stale" | "failed";

export interface PreparedPlaybackHandle {
	readonly generation: number;
	readonly sourceUrl: string;
	readonly loadContext: object | null;
	readonly status: PreparedPlaybackStatus;
	abort(): void;
}

export interface PlayPreparedOptions {
	readonly crossfade?: boolean;
	readonly durationMs?: number;
	readonly isCurrent?: () => boolean;
}

export interface PrerollPreparedOptions {
	readonly isCurrent?: () => boolean;
}

export interface PlaybackDeckDiagnostics {
	readonly id: PlaybackDeckId;
	readonly generation: number;
	readonly sourceUrl: string;
	readonly paused: boolean;
}

export interface PlaybackAudioDiagnostics {
	readonly disposed: boolean;
	readonly deckCount: number;
	readonly listenerCount: number;
	readonly preparedCount: number;
	readonly handoffCount: number;
	readonly committed: PlaybackDeckDiagnostics | null;
	readonly pending: PlaybackDeckDiagnostics | null;
	readonly graph: {
		readonly state: AudioContextState | "missing";
		readonly reconnects: number;
		readonly replacements: number;
	};
	readonly routing: OutputRoutingSnapshot & {
		readonly mirrorCount: number;
		readonly syncTimerActive: boolean;
		readonly deviceListenerActive: boolean;
	};
	readonly timers: {
		readonly playDeadlineCount: number;
		readonly readyWaitCount: number;
		readonly loadProbeCount: number;
		readonly graphHealthProbeCount: number;
		readonly audibilityProbeCount: number;
		readonly handoffActive: boolean;
	};
	readonly recovery: {
		readonly readyRetries: number;
		readonly stallRequests: number;
		readonly graphRecoveries: number;
		readonly audibilityRecoveries: number;
		readonly lastErrorCode: string | null;
	};
}

interface SourceBinding {
	readonly loadContext: object | null;
	readonly sourceUrl: string;
	readonly generation: number;
}

interface Deck {
	readonly id: PlaybackDeckId;
	audio: HTMLAudioElement;
	binding: SourceBinding | null;
	readonly nativeRelays: Map<string, EventListener>;
	probeGeneration: number;
	probeHandles: unknown[];
	probeStartedMediaTime: number;
	probeStartedBufferedEnd: number;
	readonly readinessPublished: Set<"waiting" | "stalled" | "canplay">;
	cancelPlayAttempt: ((latePlayGuard?: () => boolean) => void) | null;
	cancelReadyWait: (() => void) | null;
	readyRetryGeneration: number;
	fadeGain: number;
}

const MINERADIO_AUDIO_CONTEXT_KEY = "_mineradioAudioCtx";
const MINERADIO_MEDIA_SOURCE_KEY = "_mineradioMediaSource";

type RuntimeAudioElement = HTMLAudioElement & {
	[MINERADIO_AUDIO_CONTEXT_KEY]?: AudioContext;
	[MINERADIO_MEDIA_SOURCE_KEY]?: MediaElementAudioSourceNode;
};

interface DeckGraphBinding {
	readonly gain: GainNode;
	source: MediaElementAudioSourceNode | null;
	connected: boolean;
}

interface PlaybackAudioGraph {
	readonly context: AudioContext;
	readonly ownedContext: boolean;
	readonly mainAnalyser: AnalyserNode;
	readonly beatAnalyser: AnalyserNode;
	readonly deckBindings: Map<PlaybackDeckId, DeckGraphBinding>;
	readonly mainFreqData: Uint8Array<ArrayBuffer>;
	readonly mainTimeData: Uint8Array<ArrayBuffer>;
	readonly beatFreqData: Uint8Array<ArrayBuffer>;
	readonly beatTimeData: Uint8Array<ArrayBuffer>;
}

interface PreparedRecord {
	readonly deck: Deck;
	readonly generation: number;
	status: PreparedPlaybackStatus;
	adopted: boolean;
	outgoing: Deck | null;
	prerolled: boolean;
	transition: Promise<boolean> | null;
	transitionSettled: boolean;
}

interface PendingPlaybackCommit {
	readonly transition: Promise<boolean> | null;
}

interface CommittedOwnerLeaseRecord {
	readonly deck: Deck;
	readonly generation: number;
	readonly sourceUrl: string;
	readonly originallyPlaying: boolean;
	phase: "staged" | "paused" | "sealed-for-exit" | "stale" | "rolled-back";
	rollbackResult: boolean | null;
}

type GraphFailureCode = "graph-create-failed" | "graph-attach-failed" | "graph-frame-read-failed";

function configureAudioElement(audio: HTMLAudioElement): void {
	audio.crossOrigin = "anonymous";
	audio.preload = "auto";
}

function createBrowserAudioElement(): HTMLAudioElement | null {
	if (typeof window === "undefined") return null;
	const AudioCtor = (window as unknown as { Audio?: typeof Audio }).Audio;
	if (typeof AudioCtor !== "function") return null;
	return new AudioCtor();
}

function createBrowserAudioContext(): AudioContext | null {
	if (typeof window === "undefined") return null;
	const win = window as unknown as {
		AudioContext?: typeof AudioContext;
		webkitAudioContext?: typeof AudioContext;
	};
	const AudioContextCtor = win.AudioContext ?? win.webkitAudioContext;
	if (typeof AudioContextCtor !== "function") return null;
	try {
		return new AudioContextCtor();
	} catch {
		return null;
	}
}

function clampFadeDuration(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(PLAYBACK_MAX_FADE_MS, Math.round(value)));
}

function normalizeSinkId(value: string | null | undefined): string {
	return String(value ?? "").trim();
}

function normalizeSinkIds(values: readonly string[] | undefined): string[] {
	const normalized: string[] = [];
	for (const value of values ?? []) {
		const id = normalizeSinkId(value);
		if (!id || normalized.includes(id)) continue;
		normalized.push(id);
	}
	return normalized;
}

function redactedSourceUrl(value: string): string {
	try {
		const parsed = new URL(value);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return `${parsed.protocol}//${parsed.host}/…`;
		}
		return `${parsed.protocol}…`;
	} catch {
		const separator = value.indexOf(":");
		return separator > 0 ? `${value.slice(0, separator + 1)}…` : "opaque:…";
	}
}

function playbackOwnerSourceKind(value: string): PlaybackOwnerSourceKind {
	try {
		const protocol = new URL(value).protocol.toLowerCase();
		if (protocol === "http:" || protocol === "https:") return "remote";
		if (protocol === "blob:") return "blob";
		if (protocol === "file:" || protocol === "data:") return "local";
		return "opaque";
	} catch {
		return "opaque";
	}
}

function playbackOwnerApplicationIdentity(loadContext: object | null): {
	readonly trackRef: string;
	readonly playbackIntentId: number;
} | null {
	if (!loadContext || typeof loadContext !== "object") return null;
	const candidate = loadContext as {
		readonly trackKey?: unknown;
		readonly playbackIntentId?: unknown;
	};
	if (
		typeof candidate.trackKey !== "string"
		|| candidate.trackKey.length === 0
		|| !Number.isSafeInteger(candidate.playbackIntentId)
		|| Number(candidate.playbackIntentId) < 0
	) return null;
	return {
		trackRef: candidate.trackKey,
		playbackIntentId: Number(candidate.playbackIntentId),
	};
}

function immutableRoutingSnapshot(
	value: OutputRoutingSnapshot,
): OutputRoutingSnapshot {
	return Object.freeze({
		...value,
		mirrorSinkIds: Object.freeze([...value.mirrorSinkIds]),
		errors: Object.freeze(value.errors.map((error) => Object.freeze({ ...error }))),
	});
}

class PlaybackPlayTimeoutError extends Error {
	constructor() {
		super(`audio play timed out after ${PLAYBACK_PLAY_TIMEOUT_MS}ms`);
		this.name = "PlaybackPlayTimeoutError";
	}
}

class PlaybackPlayCancelledError extends Error {
	constructor() {
		super("audio play attempt cancelled");
		this.name = "PlaybackPlayCancelledError";
	}
}

export class PlaybackAudioRuntime {
	private readonly decks: Deck[];
	private readonly listeners = new Map<PlaybackAudioEventName, Set<PlaybackAudioListener>>();
	private committed: Deck | null = null;
	private pending: Deck | null = null;
	private generation = 0;
	private disposed = false;
	private authorityRevoked = false;
	private readonly frameSource: AudioFrameSource;
	private readonly preparedRecords = new WeakMap<PreparedPlaybackHandle, PreparedRecord>();
	private readonly committedOwnerLeases = new WeakMap<
		CommittedPlaybackOwnerLease,
		CommittedOwnerLeaseRecord
	>();
	private activeCommittedOwnerLease: CommittedOwnerLeaseRecord | null = null;
	private playbackQuiescenceEpoch = 0;
	private currentPrepared: PreparedPlaybackHandle | null = null;
	private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
	private readonly cancelTimeout: (handle: unknown) => void;
	private readonly scheduleInterval: (callback: () => void, delayMs: number) => unknown;
	private readonly cancelInterval: (handle: unknown) => void;
	private readonly now: () => number;
	private readonly isDocumentHidden: () => boolean;
	private readonly createAudioContext: () => AudioContext | null;
	private readonly createElement: () => HTMLAudioElement | null;
	private readonly mediaDevices: Pick<MediaDevices, "enumerateDevices" | "addEventListener" | "removeEventListener"> | null;
	private masterVolume = 1;
	private transitions: NormalizedTransitionPreferences = {
		fadeInMs: PLAYBACK_FADE_IN_MS,
		fadeOutMs: PLAYBACK_FADE_OUT_MS,
		crossfadeMs: PLAYBACK_CROSSFADE_MS,
		crossfadeEnabled: true,
	};
	private fadeSerial = 0;
	private activeFade: { handle: unknown | null; resolve: (completed: boolean) => void } | null = null;
	private graph: PlaybackAudioGraph | null = null;
	private graphReconnects = 0;
	private graphReplacements = 0;
	private readonly replacedDeckGenerations = new Set<string>();
	private ownerProbeGeneration = 0;
	private ownerProbeLastMediaTime = 0;
	private audibilityProbeLastMediaTime = 0;
	private ownerProbeSilentSamples = 0;
	private graphRecoveryBudgetGeneration = 0;
	private graphRecoveryAttempted = false;
	private readonly graphRecoveryGenerations = new Set<number>();
	private graphFrameValidationGeneration = 0;
	private graphFrameBlockedGeneration = 0;
	private graphFailureGeneration = 0;
	private graphFailureCode: GraphFailureCode | null = null;
	private graphFailureBlockedGeneration = 0;
	private readonly graphHealthProbeHandles = new Set<unknown>();
	private readonly audibilityProbeHandles = new Set<unknown>();
	private seekSuppressedUntil = 0;
	private readyRetryAttempts = 0;
	private stallRecoveryRequests = 0;
	private graphRecoveryAttempts = 0;
	private audibilityRecoveryAttempts = 0;
	private lastErrorCode: string | null = null;
	private routingGeneration = 0;
	private routingSnapshot: OutputRoutingSnapshot = immutableRoutingSnapshot({
		enabled: false,
		requestedPrimarySinkId: "",
		effectivePrimarySinkId: "",
		mirrorSinkIds: [],
		virtualBridgeSinkId: "",
		fellBackToDefault: false,
		errors: [],
	});
	private readonly mirrorElements = new Map<string, HTMLAudioElement>();
	private mirrorSyncTimer: unknown | null = null;
	private deviceListenerAttached = false;
	private readonly onDeviceChange = () => { void this.reconcileOutputDevices(); };

	constructor(primaryAudio?: HTMLAudioElement, options: PlaybackAudioRuntimeOptions = {}) {
		this.scheduleTimeout = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.cancelTimeout = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.scheduleInterval = options.setInterval ?? ((callback, delayMs) => globalThis.setInterval(callback, delayMs));
		this.cancelInterval = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
		this.now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
		this.isDocumentHidden = options.isDocumentHidden ?? (() => typeof document !== "undefined" && document.hidden);
		this.createAudioContext = options.createAudioContext ?? createBrowserAudioContext;
		this.createElement = options.createAudioElement ?? createBrowserAudioElement;
		this.mediaDevices = options.mediaDevices === undefined
			? (typeof navigator !== "undefined" ? navigator.mediaDevices ?? null : null)
			: options.mediaDevices;
		const first = primaryAudio ?? this.createElement();
		if (!first) throw new Error("PlaybackAudioRuntime has no audio element bound");
		const second = this.createElement();
		configureAudioElement(first);
		if (second && second !== first) configureAudioElement(second);
		this.decks = [
			{
				id: "a",
				audio: first,
				binding: null,
				nativeRelays: new Map(),
				probeGeneration: 0,
				probeHandles: [],
				probeStartedMediaTime: 0,
				probeStartedBufferedEnd: 0,
				readinessPublished: new Set(),
				cancelPlayAttempt: null,
				cancelReadyWait: null,
				readyRetryGeneration: 0,
				fadeGain: 1,
			},
			...(second && second !== first
				? [{
					id: "b" as const,
					audio: second,
					binding: null,
					nativeRelays: new Map<string, EventListener>(),
					probeGeneration: 0,
					probeHandles: [] as unknown[],
					probeStartedMediaTime: 0,
					probeStartedBufferedEnd: 0,
					readinessPublished: new Set<"waiting" | "stalled" | "canplay">(),
					cancelPlayAttempt: null,
					cancelReadyWait: null,
					readyRetryGeneration: 0,
					fadeGain: 1,
				}]
				: []),
		];
		for (const deck of this.decks) this.bindNativeEvents(deck);
		this.frameSource = () => this.readAudioFrame();
	}

	load(url: string, loadContext?: object): void {
		this.assertPlaybackMutationAllowed();
		this.prepareSource(url, loadContext);
	}

	prepareNext(url: string, loadContext?: object): PreparedPlaybackHandle {
		this.assertPlaybackMutationAllowed();
		const record = this.prepareSource(url, loadContext);
		let handle!: PreparedPlaybackHandle;
		handle = {
			generation: record.generation,
			sourceUrl: record.deck.binding!.sourceUrl,
			loadContext: record.deck.binding!.loadContext,
			get status() { return record.status; },
			abort: () => this.abort(handle),
		};
		this.preparedRecords.set(handle, record);
		this.currentPrepared = handle;
		return handle;
	}

	abort(handle: PreparedPlaybackHandle): void {
		const record = this.preparedRecords.get(handle);
		if (!record || record.status === "aborted" || record.adopted) return;
		if (record.status === "committed") {
			this.rollbackPreparedRecord(record);
			return;
		}
		record.status = "aborted";
		if (this.currentPrepared === handle) this.currentPrepared = null;
		if (this.pending === record.deck && record.deck.binding?.generation === record.generation) {
			this.pending = null;
			this.releaseDeckMedia(record.deck);
		}
	}

	async playPrepared(handle: PreparedPlaybackHandle, options: PlayPreparedOptions = {}): Promise<void> {
		this.assertUsable();
		this.assertPlaybackMutationAllowed();
		const record = this.preparedRecords.get(handle);
		if (!record) throw new Error("unknown prepared playback handle");
		if (record.status === "aborted") throw new Error("aborted prepared playback handle");
		if (
			record.status === "stale"
			|| this.currentPrepared !== handle
			|| this.pending !== record.deck
			|| record.deck.binding?.generation !== record.generation
		) {
			record.status = "stale";
			throw new Error("stale prepared playback handle");
		}
		record.status = "playing";
		record.outgoing = this.committed;
		let ownerCommitted = false;
		const isCurrent = () => ownerCommitted
			? record.status === "committed" && this.committed === record.deck
			: record.status === "playing"
				&& this.currentPrepared === handle
				&& (options.isCurrent?.() ?? true);
		try {
			const commit = await this.playPending("prepared", {
				crossfade: options.crossfade ?? this.transitions.crossfadeEnabled,
				durationMs: options.durationMs ?? this.transitions.crossfadeMs,
				isCurrent,
			});
			record.status = "committed";
			ownerCommitted = true;
			this.observePreparedTransition(record, commit.transition);
		} catch (error) {
			if ((record as PreparedRecord).status !== "aborted") record.status = "failed";
			throw error;
		}
	}

	async prerollPrepared(
		handle: PreparedPlaybackHandle,
		options: PrerollPreparedOptions = {},
	): Promise<void> {
		this.assertUsable();
		this.assertPlaybackMutationAllowed();
		const mutationEpoch = this.playbackQuiescenceEpoch;
		const record = this.preparedRecords.get(handle);
		if (!record) throw new Error("unknown prepared playback handle");
		if (record.prerolled) return;
		if (
			record.status !== "prepared"
			|| this.currentPrepared !== handle
			|| this.pending !== record.deck
			|| record.deck.binding?.generation !== record.generation
			|| !(options.isCurrent?.() ?? true)
		) {
			throw new Error("stale prepared playback handle");
		}
		const deck = record.deck;
		this.setDeckFadeGain(deck, 0);
		deck.audio.muted = true;
		try {
			await this.playDeck(deck, true);
			if (
				mutationEpoch !== this.playbackQuiescenceEpoch
				|| this.activeCommittedOwnerLease
				|| this.currentPrepared !== handle
				|| this.pending !== deck
				|| deck.binding?.generation !== record.generation
				|| !(options.isCurrent?.() ?? true)
			) {
				throw new Error("playback authority expired");
			}
			record.prerolled = true;
		} finally {
			try { deck.audio.pause(); } catch { /* best effort */ }
			try { deck.audio.currentTime = 0; } catch { /* metadata 尚未就绪时保持媒体默认位置 */ }
			deck.audio.muted = false;
			this.setDeckFadeGain(deck, 0);
		}
	}

	adoptPrepared(handle: PreparedPlaybackHandle, loadContext: object): boolean {
		if (this.activeCommittedOwnerLease) return false;
		const record = this.preparedRecords.get(handle);
		const binding = record?.deck.binding;
		if (
			!record
			|| record.status !== "committed"
			|| record.adopted
			|| record.deck !== this.committed
			|| !binding
			|| binding.generation !== record.generation
			|| binding.sourceUrl !== (record.deck.audio.currentSrc || record.deck.audio.src)
		) return false;
		const adoptedBinding = Object.freeze({
			...binding,
			loadContext,
		});
		record.deck.binding = adoptedBinding;
		record.adopted = true;
		this.releaseAdoptedOutgoing(record);
		this.emitOwnerBindingChange(record.deck, binding, adoptedBinding);
		return true;
	}

	private prepareSource(url: string, loadContext?: object): PreparedRecord {
		this.assertUsable();
		this.authorityRevoked = false;
		this.cancelActiveFade(true);
		if (this.currentPrepared) {
			const previous = this.preparedRecords.get(this.currentPrepared);
			if (previous?.status === "committed" && !previous.adopted) {
				this.rollbackPreparedRecord(previous);
			} else {
				if (previous?.adopted) {
					previous.transition = null;
					previous.transitionSettled = true;
					this.releaseAdoptedOutgoing(previous);
				} else if (previous?.status === "prepared" || previous?.status === "playing") {
					previous.status = "stale";
				}
				this.currentPrepared = null;
			}
		}
		for (const activeDeck of this.decks) this.cancelDeckPlaybackWaits(activeDeck);
		const deck = this.selectPendingDeck();
		this.clearLoadProbes(deck);
		configureAudioElement(deck.audio);
		deck.audio.src = url;
		deck.binding = Object.freeze({
			loadContext: loadContext ?? null,
			sourceUrl: deck.audio.src,
			generation: ++this.generation,
		});
		deck.audio.load();
		this.pending = deck;
		return {
			deck,
			generation: deck.binding.generation,
			status: "prepared",
			adopted: false,
			outgoing: null,
			prerolled: false,
			transition: null,
			transitionSettled: false,
		};
	}

	private rollbackPreparedRecord(record: PreparedRecord): void {
		const outgoing = record.outgoing;
		const incoming = record.deck;
		record.status = "aborted";
		if (this.currentPrepared && this.preparedRecords.get(this.currentPrepared) === record) {
			this.currentPrepared = null;
		}
		if (!outgoing || this.committed !== incoming || !outgoing.binding) return;
		this.cancelActiveFade(false);
		this.clearOwnerProbes();
		this.committed = outgoing;
		this.pending = null;
		this.setDeckFadeGain(incoming, 0);
		this.setDeckFadeGain(outgoing, 1);
		this.releaseDeckMedia(incoming);
		this.scheduleOwnerProbes(outgoing);
		this.emitOwnerChange(incoming, outgoing, "prepared");
		void this.playDeck(outgoing, true).catch(() => {});
		void this.ensureMirrors();
	}

	private observePreparedTransition(record: PreparedRecord, transition: Promise<boolean> | null): void {
		record.transition = transition;
		record.transitionSettled = transition === null;
		if (!transition) return;
		void transition.then(() => {
			if (record.transition !== transition) return;
			record.transition = null;
			record.transitionSettled = true;
			this.releaseAdoptedOutgoing(record);
		});
	}

	private releaseAdoptedOutgoing(record: PreparedRecord): void {
		if (!record.adopted || !record.transitionSettled) return;
		const outgoing = record.outgoing;
		record.outgoing = null;
		if (outgoing && outgoing !== record.deck) this.releaseDeckMedia(outgoing);
		if (this.currentPrepared && this.preparedRecords.get(this.currentPrepared) === record) {
			this.currentPrepared = null;
		}
	}

	async play(): Promise<void> {
		this.assertUsable();
		this.assertPlaybackMutationAllowed();
		const mutationEpoch = this.playbackQuiescenceEpoch;
		this.authorityRevoked = false;
		if (this.pending) {
			await this.playPending("play", { crossfade: false, isCurrent: () => true });
			return;
		}
		if (!this.committed) {
			const legacyDeck = this.decks[0];
			if (!legacyDeck) throw new Error("PlaybackAudioRuntime has no prepared source");
			await this.resumeAudioContext(legacyDeck);
			await this.playWithTimeout(legacyDeck);
			this.committed = legacyDeck;
			return;
		}
		const committed = this.committed;
		await this.playDeck(committed, true);
		if (
			mutationEpoch !== this.playbackQuiescenceEpoch
			|| this.activeCommittedOwnerLease
		) {
			try { committed.audio.pause(); } catch { /* quiescence 必须保持静默 */ }
			throw new Error("playback quiescence is active");
		}
	}

	private async playPending(
		reason: OwnerChangePayload["reason"],
		transition: {
			crossfade: boolean;
			durationMs?: number;
			isCurrent: () => boolean;
		},
	): Promise<PendingPlaybackCommit> {
		const incoming = this.pending;
		if (!incoming) throw new Error("PlaybackAudioRuntime has no prepared source");
		this.assertPlaybackMutationAllowed();
		const mutationEpoch = this.playbackQuiescenceEpoch;
		const previous = this.committed;
		if (!transition.isCurrent()) throw new Error("playback authority expired");
		if (previous && previous !== incoming) this.setDeckFadeGain(incoming, 0);
		await this.playDeck(incoming, true);
		if (
			mutationEpoch !== this.playbackQuiescenceEpoch
			|| this.activeCommittedOwnerLease
		) {
			this.rejectIncomingDeck(incoming);
			throw new Error("playback quiescence is active");
		}
		if (!transition.isCurrent()) {
			this.rejectIncomingDeck(incoming);
			throw new Error("playback authority expired");
		}
		if (this.pending !== incoming) {
			this.rejectIncomingDeck(incoming);
			throw new Error("stale prepared playback handle");
		}
		this.cancelActiveFade(false);
		this.committed = incoming;
		this.pending = null;
		if (previous && previous !== incoming) this.clearLoadProbes(previous);
		this.scheduleOwnerProbes(incoming);
		this.emitOwnerChange(previous, incoming, reason);
		void this.ensureMirrors();
		this.emit("play", this.mediaPayload(incoming));
		this.emit("playing", this.mediaPayload(incoming));
		if (!previous || previous === incoming) {
			this.setDeckFadeGain(incoming, 1);
			return { transition: null };
		}
		if (reason === "prepared" && !transition.crossfade) {
			this.setDeckFadeGain(previous, 0);
			this.setDeckFadeGain(incoming, 1);
			try { previous.audio.pause(); } catch { /* best effort */ }
			return { transition: null };
		}
		const fade = transition.crossfade
			? this.runEqualPowerCrossfade(previous, incoming, transition.durationMs ?? this.transitions.crossfadeMs, transition.isCurrent)
			: this.runSwitchFade(previous, incoming, transition.isCurrent);
		return { transition: fade };
	}

	private async playDeck(deck: Deck, allowReadyRetry: boolean): Promise<void> {
		this.ensureGraph();
		await this.resumeAudioContext(deck);
		try {
			await this.playWithTimeout(deck);
			return;
		} catch (firstError) {
			if (firstError instanceof PlaybackPlayTimeoutError || firstError instanceof PlaybackPlayCancelledError) throw firstError;
			const generation = deck.binding?.generation;
			if (!allowReadyRetry || generation === undefined || !this.deckGenerationIsActive(deck, generation)) throw firstError;
			if (deck.readyRetryGeneration === generation) throw firstError;
			deck.readyRetryGeneration = generation;
			this.readyRetryAttempts += 1;
			const ready = await this.waitForReady(deck, generation);
			if (!ready || !this.deckGenerationIsActive(deck, generation)) throw firstError;
			await this.playWithTimeout(deck);
		}
	}

	private deckGenerationIsActive(deck: Deck, generation: number): boolean {
		return !this.disposed
			&& deck.binding?.generation === generation
			&& (deck === this.pending || deck === this.committed);
	}

	private playWithTimeout(deck: Deck): Promise<void> {
		deck.cancelPlayAttempt?.();
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			let timeout: unknown;
			let latePlayGuard: (() => boolean) | null = null;
			let cancelAttempt: Deck["cancelPlayAttempt"] = null;
			const finish = (error?: unknown) => {
				if (settled) return;
				settled = true;
				this.cancelTimeout(timeout);
				if (deck.cancelPlayAttempt === cancelAttempt) {
					deck.cancelPlayAttempt = null;
				}
				if (error === undefined) resolve();
				else {
					if (error instanceof PlaybackPlayTimeoutError) this.lastErrorCode = "play-timeout";
					else if (!(error instanceof PlaybackPlayCancelledError)) this.lastErrorCode = "play-rejected";
					reject(error);
				}
			};
			timeout = this.scheduleTimeout(() => {
				finish(new PlaybackPlayTimeoutError());
			}, PLAYBACK_PLAY_TIMEOUT_MS);
			cancelAttempt = (guard) => {
				latePlayGuard = guard ?? null;
				finish(new PlaybackPlayCancelledError());
			};
			deck.cancelPlayAttempt = cancelAttempt;
			Promise.resolve(deck.audio.play()).then(
				() => {
					if (latePlayGuard?.()) {
						try { deck.audio.pause(); } catch { /* 迟到的 native play 不得突破静默门禁 */ }
					}
					finish();
				},
				(error) => finish(error),
			);
		});
	}

	private waitForReady(deck: Deck, generation: number): Promise<boolean> {
		if (Number(deck.audio.readyState) >= 3) return Promise.resolve(true);
		deck.cancelReadyWait?.();
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (ready: boolean) => {
				if (settled) return;
				settled = true;
				this.cancelTimeout(timeout);
				deck.audio.removeEventListener("canplay", onReady);
				deck.audio.removeEventListener("loadeddata", onReady);
				deck.audio.removeEventListener("error", onError);
				deck.cancelReadyWait = null;
				resolve(ready && deck.binding?.generation === generation);
			};
			const onReady = () => finish(true);
			const onError = () => finish(false);
			const timeout = this.scheduleTimeout(() => finish(false), PLAYBACK_READY_RETRY_TIMEOUT_MS);
			deck.cancelReadyWait = () => finish(false);
			deck.audio.addEventListener("canplay", onReady, { once: true });
			deck.audio.addEventListener("loadeddata", onReady, { once: true });
			deck.audio.addEventListener("error", onError, { once: true });
		});
	}

	pause(): void {
		if (this.activeCommittedOwnerLease) return;
		this.cancelActiveFade(true);
		this.requireActiveDeck().audio.pause();
		this.syncMirrors();
	}

	/**
	 * 只捕获 owner，不产生暂停副作用。调用方可先持久化 checkpoint，随后再显式
	 * 调用 pauseCommittedOwnerLease()，从而固定 prepare-before-pause 顺序。
	 */
	stageCommittedOwnerLease(): CommittedPlaybackOwnerLease | null {
		this.assertUsable();
		if (this.activeCommittedOwnerLease) return null;
		const deck = this.committed;
		const binding = deck?.binding;
		if (!deck || !binding) return null;
		const applicationIdentity = playbackOwnerApplicationIdentity(binding.loadContext);
		const lease = Object.freeze({
			deckId: deck.id,
			generation: binding.generation,
			originallyPlaying: !deck.audio.paused && !deck.audio.ended,
			sourceKind: playbackOwnerSourceKind(binding.sourceUrl),
			trackRef: applicationIdentity?.trackRef ?? null,
			playbackIntentId: applicationIdentity?.playbackIntentId ?? null,
		}) satisfies CommittedPlaybackOwnerLease;
		const record: CommittedOwnerLeaseRecord = {
			deck,
			generation: binding.generation,
			sourceUrl: binding.sourceUrl,
			originallyPlaying: lease.originallyPlaying,
			phase: "staged",
			rollbackResult: null,
		};
		this.playbackQuiescenceEpoch += 1;
		this.cancelActiveFade(true);
		if (this.pending && this.pending !== deck) this.setDeckFadeGain(this.pending, 0);
		this.committedOwnerLeases.set(lease, record);
		this.activeCommittedOwnerLease = record;
		return lease;
	}

	pauseCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean {
		const record = this.committedOwnerLeases.get(lease);
		if (!record) return false;
		if (record.phase === "paused") return true;
		if (record.phase !== "staged") return false;
		if (!this.committedOwnerLeaseIsCurrent(record)) {
			record.phase = "stale";
			record.rollbackResult = false;
			this.clearCommittedOwnerLeaseGate(record);
			return false;
		}
		this.cancelActiveFade(true);
		this.cancelDeckPlaybackWaits(record.deck, () => (
			this.disposed
			|| this.activeCommittedOwnerLease === record
			|| !record.originallyPlaying
			|| !this.committedOwnerLeaseIsCurrent(record)
		));
		if (!this.committedOwnerLeaseIsCurrent(record)) {
			record.phase = "stale";
			record.rollbackResult = false;
			this.clearCommittedOwnerLeaseGate(record);
			return false;
		}
		try {
			record.deck.audio.pause();
		} catch {
			record.phase = "stale";
			record.rollbackResult = false;
			this.clearCommittedOwnerLeaseGate(record);
			return false;
		}
		this.syncMirrors();
		record.phase = "paused";
		return true;
	}

	async rollbackCommittedOwnerLease(
		lease: CommittedPlaybackOwnerLease,
	): Promise<boolean> {
		const record = this.committedOwnerLeases.get(lease);
		if (!record) return false;
		if (record.phase === "rolled-back") return true;
		if (record.phase === "stale") return false;
		if (record.phase === "staged") {
			record.phase = "rolled-back";
			record.rollbackResult = true;
			this.clearCommittedOwnerLeaseGate(record);
			return true;
		}
		if (!this.committedOwnerLeaseIsCurrent(record)) {
			record.phase = "stale";
			record.rollbackResult = false;
			this.clearCommittedOwnerLeaseGate(record);
			return false;
		}
		if (record.originallyPlaying) {
			try {
				await this.playDeck(record.deck, true);
			} catch {
				record.phase = "stale";
				record.rollbackResult = false;
				this.clearCommittedOwnerLeaseGate(record);
				return false;
			}
			if (!this.committedOwnerLeaseIsCurrent(record)) {
				try { record.deck.audio.pause(); } catch { /* 旧 deck 不得在 handoff 后继续发声 */ }
				record.phase = "stale";
				record.rollbackResult = false;
				this.clearCommittedOwnerLeaseGate(record);
				return false;
			}
		} else if (!record.deck.audio.paused) {
			try {
				record.deck.audio.pause();
			} catch {
				record.phase = "stale";
				record.rollbackResult = false;
				this.clearCommittedOwnerLeaseGate(record);
				return false;
			}
		}
		this.syncMirrors();
		record.phase = "rolled-back";
		record.rollbackResult = true;
		this.clearCommittedOwnerLeaseGate(record);
		return true;
	}

	releaseCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean {
		const record = this.committedOwnerLeases.get(lease);
		if (!record || record.phase === "stale" || record.phase === "rolled-back") return false;
		if (!this.committedOwnerLeaseIsCurrent(record)) {
			record.phase = "stale";
			record.rollbackResult = false;
			this.clearCommittedOwnerLeaseGate(record);
			return false;
		}
		if (record.phase === "sealed-for-exit") return true;
		record.phase = "sealed-for-exit";
		record.rollbackResult = true;
		return true;
	}

	cancelCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean {
		const record = this.committedOwnerLeases.get(lease);
		if (!record || record.phase !== "staged") return false;
		if (!this.committedOwnerLeaseIsCurrent(record)) {
			record.phase = "stale";
			record.rollbackResult = false;
			this.clearCommittedOwnerLeaseGate(record);
			return false;
		}
		record.phase = "rolled-back";
		record.rollbackResult = true;
		this.clearCommittedOwnerLeaseGate(record);
		return true;
	}

	private clearCommittedOwnerLeaseGate(record: CommittedOwnerLeaseRecord): void {
		if (this.activeCommittedOwnerLease === record) this.activeCommittedOwnerLease = null;
	}

	private invalidateActiveCommittedOwnerLease(): void {
		const record = this.activeCommittedOwnerLease;
		if (!record) return;
		record.phase = "stale";
		record.rollbackResult = false;
		this.activeCommittedOwnerLease = null;
	}

	private assertPlaybackMutationAllowed(): void {
		if (this.activeCommittedOwnerLease) {
			throw new Error("playback quiescence is active");
		}
	}

	private committedOwnerLeaseIsCurrent(record: CommittedOwnerLeaseRecord): boolean {
		const binding = record.deck.binding;
		return !this.disposed
			&& this.committed === record.deck
			&& binding?.generation === record.generation
			&& binding.sourceUrl === record.sourceUrl;
	}

	seek(timeMs: number): void {
		if (this.activeCommittedOwnerLease) return;
		this.cancelActiveFade(true);
		this.requireActiveDeck().audio.currentTime = timeMs / 1000;
		this.seekSuppressedUntil = this.now() + PLAYBACK_SEEK_PROBE_SUPPRESSION_MS;
		this.syncMirrors();
	}

	setVolume(volume: number): void {
		this.masterVolume = Math.max(0, Math.min(1, volume));
		for (const deck of this.decks) this.applyDeckGain(deck);
		this.syncMirrors();
	}

	setTransitionPreferences(preferences: PlaybackTransitionPreferences): void {
		this.transitions = {
			fadeInMs: clampFadeDuration(preferences.fadeInMs, this.transitions.fadeInMs),
			fadeOutMs: clampFadeDuration(preferences.fadeOutMs, this.transitions.fadeOutMs),
			crossfadeMs: clampFadeDuration(preferences.crossfadeMs, this.transitions.crossfadeMs),
			crossfadeEnabled: preferences.crossfadeEnabled ?? this.transitions.crossfadeEnabled,
		};
	}

	async setOutputRouting(config: OutputRoutingConfig): Promise<OutputRoutingSnapshot> {
		this.assertUsable();
		const routingGeneration = ++this.routingGeneration;
		const enabled = config.enabled ?? true;
		const requestedPrimarySinkId = normalizeSinkId(config.primarySinkId);
		const virtualBridgeSinkId = normalizeSinkId(config.virtualBridgeSinkId);
		let effectivePrimarySinkId = enabled ? (virtualBridgeSinkId || requestedPrimarySinkId) : "";
		const mirrorSinkIds = enabled
			? normalizeSinkIds(config.mirrorSinkIds).filter((id) => id !== effectivePrimarySinkId).slice(0, PLAYBACK_MAX_MIRRORS)
			: [];
		const errors: OutputRoutingError[] = [];
		let fellBackToDefault = false;

		if (!enabled) {
			const contextTarget = this.graph && typeof (this.graph.context as AudioContext & {
				setSinkId?: (id: string) => Promise<void>;
			}).setSinkId === "function"
				? this.graph.context as unknown
				: null;
			if (contextTarget) {
				const contextError = await this.applySink(contextTarget, "", "context");
				if (!this.routingIsCurrent(routingGeneration)) return this.routingSnapshot;
				if (contextError) {
					errors.push(contextError);
					for (const deck of this.decks) {
						const error = await this.applySink(deck.audio, "", "primary");
						if (!this.routingIsCurrent(routingGeneration)) return this.routingSnapshot;
						if (error) errors.push(error);
					}
				}
			} else {
				for (const deck of this.decks) {
					const error = await this.applySink(deck.audio, "", "primary");
					if (!this.routingIsCurrent(routingGeneration)) return this.routingSnapshot;
					if (error) errors.push(error);
				}
			}
			this.routingSnapshot = immutableRoutingSnapshot({
				enabled: false,
				requestedPrimarySinkId,
				effectivePrimarySinkId: "",
				mirrorSinkIds: [],
				virtualBridgeSinkId,
				fellBackToDefault: false,
				errors,
			});
			this.clearRoutingResources();
			return this.routingSnapshot;
		}
		if (effectivePrimarySinkId) this.ensureGraph();

		const deckTargets = this.decks.map((deck) => ({
			target: "primary" as const,
			value: deck.audio as unknown,
		}));
		const contextTarget = this.graph && typeof (this.graph.context as AudioContext & {
			setSinkId?: (id: string) => Promise<void>;
		}).setSinkId === "function"
			? { target: "context" as const, value: this.graph.context as unknown }
			: null;
		let targets: Array<{ target: "primary" | "context"; value: unknown }> = contextTarget
			? [contextTarget]
			: deckTargets;
		let notFound = false;
		for (const target of targets) {
			const error = await this.applySink(target.value, effectivePrimarySinkId, target.target);
			if (!this.routingIsCurrent(routingGeneration)) {
				await this.reconcileStalePrimaryTarget(target.value, target.target);
				return this.routingSnapshot;
			}
			if (!error) continue;
			errors.push(error);
			if (error.name === "NotFoundError") notFound = true;
		}
		if (contextTarget && errors.length > 0 && !notFound) {
			targets = deckTargets;
			for (const target of targets) {
				const error = await this.applySink(target.value, effectivePrimarySinkId, target.target);
				if (!this.routingIsCurrent(routingGeneration)) {
					await this.reconcileStalePrimaryTarget(target.value, target.target);
					return this.routingSnapshot;
				}
				if (!error) continue;
				errors.push(error);
				if (error.name === "NotFoundError") notFound = true;
			}
		}
		if (notFound && effectivePrimarySinkId) {
			fellBackToDefault = true;
			effectivePrimarySinkId = "";
			for (const target of targets) {
				await this.applySink(target.value, "", target.target);
				if (!this.routingIsCurrent(routingGeneration)) {
					await this.reconcileStalePrimaryTarget(target.value, target.target);
					return this.routingSnapshot;
				}
			}
		}

		if (!this.routingIsCurrent(routingGeneration)) return this.routingSnapshot;
		this.routingSnapshot = immutableRoutingSnapshot({
			enabled: true,
			requestedPrimarySinkId,
			effectivePrimarySinkId,
			mirrorSinkIds: mirrorSinkIds.filter((id) => id !== effectivePrimarySinkId),
			virtualBridgeSinkId,
			fellBackToDefault,
			errors,
		});
		this.updateDeviceListener();
		await this.ensureMirrors(routingGeneration);
		return this.routingSnapshot;
	}

	private routingIsCurrent(generation: number): boolean {
		return !this.disposed && generation === this.routingGeneration;
	}

	private async reconcileStalePrimaryTarget(
		target: unknown,
		targetName: "primary" | "context",
	): Promise<void> {
		for (let attempt = 0; attempt < 3 && !this.disposed; attempt += 1) {
			const generation = this.routingGeneration;
			const sinkId = this.routingSnapshot.enabled
				? this.routingSnapshot.effectivePrimarySinkId
				: "";
			await this.applySink(target, sinkId, targetName);
			if (generation === this.routingGeneration) return;
		}
	}

	async listOutputDevices(): Promise<readonly AudioOutputDevice[]> {
		if (!this.mediaDevices?.enumerateDevices) return [];
		try {
			const devices = await this.mediaDevices.enumerateDevices();
			return Object.freeze(devices
				.filter((device) => device.kind === "audiooutput")
				.map((device) => Object.freeze({
					deviceId: String(device.deviceId || ""),
					label: String(device.label || ""),
					groupId: String(device.groupId || ""),
					isDefault: !device.deviceId || device.deviceId === "default",
				})));
		} catch {
			return [];
		}
	}

	on<E extends PlaybackAudioEventName>(event: E, handler: PlaybackAudioHandlerForEvent<E>): () => void {
		const listener = handler as PlaybackAudioListener;
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return () => set?.delete(listener);
	}

	getActiveElement(): HTMLAudioElement | null {
		return this.committed?.audio ?? this.pending?.audio ?? this.decks[0]?.audio ?? null;
	}

	getAudioFrameSource(): AudioFrameSource {
		return this.frameSource;
	}

	diagnostics(): PlaybackAudioDiagnostics {
		const graph = Object.freeze({
			state: this.graph?.context.state ?? "missing" as AudioContextState | "missing",
			reconnects: this.graphReconnects,
			replacements: this.graphReplacements,
		});
		const routing = Object.freeze({
			...this.routingSnapshot,
			mirrorSinkIds: Object.freeze([...this.routingSnapshot.mirrorSinkIds]),
			errors: Object.freeze(this.routingSnapshot.errors.map((error) => Object.freeze({ ...error }))),
			mirrorCount: this.mirrorElements.size,
			syncTimerActive: this.mirrorSyncTimer !== null,
			deviceListenerActive: this.deviceListenerAttached,
		});
		const timers = Object.freeze({
			playDeadlineCount: this.decks.filter((deck) => deck.cancelPlayAttempt !== null).length,
			readyWaitCount: this.decks.filter((deck) => deck.cancelReadyWait !== null).length,
			loadProbeCount: this.decks.reduce((count, deck) => count + deck.probeHandles.length, 0),
			graphHealthProbeCount: this.graphHealthProbeHandles.size,
			audibilityProbeCount: this.audibilityProbeHandles.size,
			handoffActive: this.activeFade !== null,
		});
		const recovery = Object.freeze({
			readyRetries: this.readyRetryAttempts,
			stallRequests: this.stallRecoveryRequests,
			graphRecoveries: this.graphRecoveryAttempts,
			audibilityRecoveries: this.audibilityRecoveryAttempts,
			lastErrorCode: this.lastErrorCode,
		});
		return Object.freeze({
			disposed: this.disposed,
			deckCount: this.disposed ? 0 : this.decks.length,
			listenerCount: [...this.listeners.values()].reduce((count, set) => count + set.size, 0),
			preparedCount: this.currentPrepared ? 1 : 0,
			handoffCount: this.activeFade ? 1 : 0,
			committed: this.deckDiagnostics(this.committed),
			pending: this.deckDiagnostics(this.pending),
			graph,
			routing,
			timers,
			recovery,
		});
	}

	stop(): void {
		if (this.disposed) return;
		if (this.activeCommittedOwnerLease) return;
		this.routingGeneration += 1;
		this.cancelActiveFade(false);
		this.authorityRevoked = true;
		this.clearOwnerProbes();
		for (const deck of this.decks) {
			this.releaseDeckMedia(deck);
			this.setDeckFadeGain(deck, 1);
		}
		if (this.currentPrepared) {
			const record = this.preparedRecords.get(this.currentPrepared);
			if (record && record.status !== "committed") record.status = "aborted";
		}
		this.currentPrepared = null;
		this.pending = null;
		this.committed = null;
		for (const id of [...this.mirrorElements.keys()]) this.removeMirror(id);
		this.updateMirrorTimer();
	}

	dispose(): void {
		if (this.disposed) return;
		this.invalidateActiveCommittedOwnerLease();
		this.disposed = true;
		this.routingGeneration += 1;
		this.cancelActiveFade(false);
		this.clearOwnerProbes();
		if (this.currentPrepared) {
			const record = this.preparedRecords.get(this.currentPrepared);
			if (record && record.status !== "committed") record.status = "aborted";
		}
		this.currentPrepared = null;
		this.clearRoutingResources();
		for (const deck of this.decks) {
			this.unbindNativeEvents(deck);
			this.releaseDeckMedia(deck);
		}
		this.disposeGraph();
		this.listeners.clear();
		this.committed = null;
		this.pending = null;
	}

	private selectPendingDeck(): Deck {
		if (this.pending && this.pending !== this.committed) return this.pending;
		return this.decks.find((deck) => deck !== this.committed) ?? this.decks[0]!;
	}

	private cancelDeckPlaybackWaits(
		deck: Deck,
		latePlayGuard?: () => boolean,
	): void {
		const cancelPlayAttempt = deck.cancelPlayAttempt;
		deck.cancelPlayAttempt = null;
		cancelPlayAttempt?.(latePlayGuard);
		const cancelReadyWait = deck.cancelReadyWait;
		deck.cancelReadyWait = null;
		cancelReadyWait?.();
	}

	private releaseDeckMedia(deck: Deck): void {
		this.cancelDeckPlaybackWaits(deck);
		this.clearLoadProbes(deck);
		try { deck.audio.pause(); } catch { /* best effort */ }
		try {
			deck.audio.removeAttribute("src");
			deck.audio.load();
		} catch { /* best effort */ }
		deck.audio.muted = false;
		deck.binding = null;
	}

	private requireActiveDeck(): Deck {
		this.assertUsable();
		const deck = this.committed ?? this.pending ?? this.decks[0];
		if (!deck) throw new Error("PlaybackAudioRuntime has no prepared source");
		return deck;
	}

	private emitOwnerChange(previous: Deck | null, current: Deck, reason: OwnerChangePayload["reason"]): void {
		const binding = current.binding;
		if (!binding) return;
		const payload: OwnerChangePayload = {
			...this.bindingPayload(current, binding),
			previous: previous?.binding ? this.bindingPayload(previous, previous.binding) : null,
			current: this.bindingPayload(current, binding),
			reason,
		};
		for (const listener of this.listeners.get("ownerchange") ?? []) listener(payload);
	}

	private emitOwnerBindingChange(
		deck: Deck,
		previous: SourceBinding,
		current: SourceBinding,
	): void {
		const payload: OwnerChangePayload = {
			...this.bindingPayload(deck, current),
			previous: this.bindingPayload(deck, previous),
			current: this.bindingPayload(deck, current),
			reason: "adopted",
		};
		for (const listener of this.listeners.get("ownerchange") ?? []) listener(payload);
	}

	private bindNativeEvents(deck: Deck): void {
		const eventNames = [
			"play",
			"playing",
			"pause",
			"timeupdate",
			"durationchange",
			"ended",
			"error",
			"waiting",
			"stalled",
			"canplay",
		] as const;
		for (const eventName of eventNames) {
			const relay: EventListener = () => this.relayNativeEvent(deck, eventName);
			deck.nativeRelays.set(eventName, relay);
			deck.audio.addEventListener(eventName, relay);
		}
	}

	private unbindNativeEvents(deck: Deck): void {
		for (const [eventName, relay] of deck.nativeRelays) {
			deck.audio.removeEventListener(eventName, relay);
		}
		deck.nativeRelays.clear();
	}

	private relayNativeEvent(deck: Deck, eventName: Exclude<PlaybackAudioEventName, "ownerchange">): void {
		if (!this.nativeEventHasAuthority(deck, eventName)) return;
		if (eventName === "timeupdate" || eventName === "durationchange") {
			const payload: TimeUpdatePayload = {
				...this.mediaPayload(deck),
				positionMs: Math.max(0, Math.floor(deck.audio.currentTime * 1000)),
				durationMs: Number.isFinite(deck.audio.duration)
					? Math.floor(deck.audio.duration * 1000)
					: null,
			};
			this.emit(eventName, payload);
			return;
		}
		if (eventName === "error") {
			const mediaError = deck.audio.error;
			this.emit("error", {
				...this.mediaPayload(deck),
				code: mediaError?.code ?? 0,
				message: mediaError?.message ?? "playback error",
			} satisfies ErrorPayload);
			return;
		}
		if (eventName === "waiting" || eventName === "stalled") {
			if (deck === this.committed && deck.binding) {
				this.scheduleLoadProbes(deck, deck.binding.generation);
			}
			return;
		}
		if (eventName === "canplay") {
			this.publishReadiness(deck, eventName, "native");
			return;
		}
		this.emit(eventName, this.mediaPayload(deck));
	}

	private nativeEventHasAuthority(
		deck: Deck,
		_eventName: Exclude<PlaybackAudioEventName, "ownerchange">,
	): boolean {
		return deck === this.committed;
	}

	private mediaPayload(deck: Deck): MediaEventPayload {
		const sourceUrl = deck.audio.currentSrc || deck.audio.src;
		const binding = deck.binding;
		return {
			loadContext: binding?.sourceUrl === sourceUrl ? binding.loadContext : null,
			sourceUrl,
			generation: binding?.sourceUrl === sourceUrl ? binding.generation : 0,
			deckId: deck.id,
		};
	}

	private emit(eventName: PlaybackAudioEventName, payload: PlaybackAudioEventPayload): void {
		for (const listener of this.listeners.get(eventName) ?? []) listener(payload);
	}

	private runEqualPowerCrossfade(
		outgoing: Deck,
		incoming: Deck,
		requestedDurationMs: number,
		isCurrent: () => boolean,
	): Promise<boolean> {
		const durationMs = clampFadeDuration(requestedDurationMs, this.transitions.crossfadeMs);
		return this.runFadeTransition(durationMs, (_progress, elapsedMs) => {
			const sample = sampleAlbumGaplessCrossfade({ elapsedMs, durationMs });
			this.setDeckFadeGain(outgoing, sample.outgoingGain);
			this.setDeckFadeGain(incoming, sample.incomingGain);
		}, () => {
			this.setDeckFadeGain(outgoing, 0);
			this.setDeckFadeGain(incoming, 1);
			try { outgoing.audio.pause(); } catch { /* best effort */ }
		}, isCurrent);
	}

	private runSwitchFade(outgoing: Deck, incoming: Deck, isCurrent: () => boolean): Promise<boolean> {
		const fadeInMs = this.transitions.fadeInMs;
		const fadeOutMs = this.transitions.fadeOutMs;
		const durationMs = Math.max(fadeInMs, fadeOutMs);
		return this.runFadeTransition(durationMs, (progress, elapsedMs) => {
			const incomingProgress = fadeInMs <= 0 ? 1 : Math.min(1, elapsedMs / fadeInMs);
			const outgoingProgress = fadeOutMs <= 0 ? 1 : Math.min(1, elapsedMs / fadeOutMs);
			this.setDeckFadeGain(incoming, incomingProgress * incomingProgress * (3 - 2 * incomingProgress));
			const outgoingEase = outgoingProgress * outgoingProgress * (3 - 2 * outgoingProgress);
			this.setDeckFadeGain(outgoing, 1 - outgoingEase);
			void progress;
		}, () => {
			this.setDeckFadeGain(outgoing, 0);
			this.setDeckFadeGain(incoming, 1);
			this.releaseDeckMedia(outgoing);
		}, isCurrent);
	}

	private runFadeTransition(
		durationMs: number,
		apply: (progress: number, elapsedMs: number) => void,
		complete: () => void,
		isCurrent: () => boolean,
	): Promise<boolean> {
		this.cancelActiveFade(false);
		const serial = ++this.fadeSerial;
		const startedAt = this.now();
		return new Promise<boolean>((resolve) => {
			const cancelForAuthority = () => {
				if (serial !== this.fadeSerial) return;
				const active = this.activeFade;
				this.activeFade = null;
				if (active?.handle !== null && active?.handle !== undefined) this.cancelTimeout(active.handle);
				this.fadeSerial += 1;
				resolve(false);
			};
			const finish = () => {
				if (serial !== this.fadeSerial) return;
				if (this.activeFade?.handle !== null) this.cancelTimeout(this.activeFade?.handle);
				this.activeFade = null;
				apply(1, durationMs);
				complete();
				resolve(true);
			};
			const tick = () => {
				if (serial !== this.fadeSerial) return;
				if (!isCurrent()) {
					cancelForAuthority();
					return;
				}
				if (this.isDocumentHidden()) {
					finish();
					return;
				}
				const elapsedMs = Math.max(0, this.now() - startedAt);
				const progress = durationMs <= 0 ? 1 : Math.min(1, elapsedMs / durationMs);
				apply(progress, elapsedMs);
				if (progress >= 1) {
					finish();
					return;
				}
				const handle = this.scheduleTimeout(tick, Math.min(PLAYBACK_FADE_STEP_MS, durationMs - elapsedMs));
				if (this.activeFade) this.activeFade.handle = handle;
			};
			this.activeFade = { handle: null, resolve };
			if (!isCurrent()) {
				cancelForAuthority();
				return;
			}
			if (durationMs <= 0 || this.isDocumentHidden()) {
				finish();
				return;
			}
			apply(0, 0);
			this.activeFade.handle = this.scheduleTimeout(tick, Math.min(PLAYBACK_FADE_STEP_MS, durationMs));
		});
	}

	private rejectIncomingDeck(incoming: Deck): void {
		if (this.pending === incoming) this.pending = null;
		this.setDeckFadeGain(incoming, 0);
		this.releaseDeckMedia(incoming);
		if (this.committed) this.setDeckFadeGain(this.committed, 1);
	}

	private rollbackCommittedDeck(outgoing: Deck, incoming: Deck): void {
		if (this.committed !== incoming) return;
		this.committed = outgoing;
		this.setDeckFadeGain(incoming, 0);
		this.setDeckFadeGain(outgoing, 1);
		this.releaseDeckMedia(incoming);
		this.emitOwnerChange(incoming, outgoing, "prepared");
		void this.ensureMirrors();
	}

	private cancelActiveFade(convergeOwner: boolean): void {
		this.fadeSerial += 1;
		const active = this.activeFade;
		this.activeFade = null;
		if (active?.handle !== null && active?.handle !== undefined) this.cancelTimeout(active.handle);
		active?.resolve(false);
		if (!active) return;
		if (!convergeOwner) return;
		for (const deck of this.decks) {
			const ownsPlayback = deck === this.committed;
			this.setDeckFadeGain(deck, ownsPlayback ? 1 : 0);
			if (!ownsPlayback) {
				try { deck.audio.pause(); } catch { /* best effort */ }
			}
		}
	}

	private setDeckFadeGain(deck: Deck, value: number): void {
		deck.fadeGain = Math.max(0, Math.min(1, value));
		this.applyDeckGain(deck);
	}

	private applyDeckGain(deck: Deck): void {
		const graphGain = this.graph?.deckBindings.get(deck.id)?.gain;
		if (graphGain) {
			graphGain.gain.value = deck.fadeGain;
			deck.audio.volume = this.masterVolume;
			return;
		}
		deck.audio.volume = Math.max(0, Math.min(1, this.masterVolume * deck.fadeGain));
	}

	private ensureGraph(): boolean {
		if (this.disposed) return false;
		if (this.graph?.context.state === "closed") this.disposeGraph(false);
		const graphGeneration = this.pending?.binding?.generation
			?? this.committed?.binding?.generation
			?? 0;
		if (!this.graph) {
			if (!this.graphAttemptIsAllowed("graph-create-failed", graphGeneration)) return false;
			let context: AudioContext | null = null;
			let ownedContext = false;
			for (const deck of this.decks) {
				const cached = (deck.audio as RuntimeAudioElement)[MINERADIO_AUDIO_CONTEXT_KEY];
				if (cached && cached.state !== "closed") {
					context = cached;
					break;
				}
			}
			if (!context) {
				try { context = this.createAudioContext(); } catch { context = null; }
				ownedContext = !!context;
			}
			if (!context) {
				this.recordGraphFailure("graph-create-failed", graphGeneration);
				return false;
			}
			if (context.state === "closed") {
				this.recordGraphFailure("graph-create-failed", graphGeneration);
				return false;
			}
			try {
				const mainAnalyser = context.createAnalyser();
				mainAnalyser.fftSize = 2048;
				mainAnalyser.smoothingTimeConstant = 0.58;
				const beatAnalyser = context.createAnalyser();
				beatAnalyser.fftSize = 2048;
				beatAnalyser.smoothingTimeConstant = 0.10;
				mainAnalyser.connect(context.destination);
				const deckBindings = new Map<PlaybackDeckId, DeckGraphBinding>();
				for (const deck of this.decks) {
					const gain = context.createGain();
					gain.gain.value = deck.fadeGain;
					gain.connect(mainAnalyser);
					gain.connect(beatAnalyser);
					deckBindings.set(deck.id, { gain, source: null, connected: false });
				}
				this.graph = {
					context,
					ownedContext,
					mainAnalyser,
					beatAnalyser,
					deckBindings,
					mainFreqData: new Uint8Array(mainAnalyser.frequencyBinCount),
					mainTimeData: new Uint8Array(mainAnalyser.fftSize),
					beatFreqData: new Uint8Array(beatAnalyser.frequencyBinCount),
					beatTimeData: new Uint8Array(beatAnalyser.fftSize),
				};
				this.clearGraphFailure("graph-create-failed", graphGeneration);
			} catch {
				if (ownedContext) void context.close().catch(() => {});
				this.graph = null;
				this.recordGraphFailure("graph-create-failed", graphGeneration);
				return false;
			}
		}
		let attached = true;
		for (const deck of this.decks) {
			const graphBinding = this.graph?.deckBindings.get(deck.id);
			const wasConnected = graphBinding?.connected === true;
			if (deck.binding || deck === this.committed) {
				const generation = deck.binding?.generation ?? 0;
				if (!this.graphAttemptIsAllowed("graph-attach-failed", generation)) {
					attached = false;
				} else if (!this.ensureDeckGraphSource(deck)) {
					this.recordGraphFailure("graph-attach-failed", generation);
					attached = false;
				} else {
					this.clearGraphFailure("graph-attach-failed", generation);
				}
			}
			if (!wasConnected && graphBinding?.connected) this.applyDeckGain(deck);
		}
		return attached;
	}

	private ensureDeckGraphSource(deck: Deck): boolean {
		const graph = this.graph;
		const graphBinding = graph?.deckBindings.get(deck.id);
		if (!graph || !graphBinding) return false;
		if (graphBinding.source && graphBinding.connected) return true;
		const audio = deck.audio as RuntimeAudioElement;
		try {
			let source = audio[MINERADIO_MEDIA_SOURCE_KEY];
			const sourceContext = audio[MINERADIO_AUDIO_CONTEXT_KEY];
			if (!source || sourceContext !== graph.context) {
				if (source && sourceContext && sourceContext !== graph.context) {
					const generation = deck.binding?.generation ?? 0;
					return generation > 0 && this.replaceDeckElementForGraph(deck, generation);
				}
				source = graph.context.createMediaElementSource(audio);
				audio[MINERADIO_MEDIA_SOURCE_KEY] = source;
				audio[MINERADIO_AUDIO_CONTEXT_KEY] = graph.context;
			}
			try { source.disconnect(); } catch { /* 首次连接时允许 no-op */ }
			source.connect(graphBinding.gain);
			graphBinding.source = source;
			graphBinding.connected = true;
			return true;
		} catch {
			graphBinding.connected = false;
			return false;
		}
	}

	private readAudioFrame(): AudioFrameBytes {
		const generation = this.committed?.binding?.generation ?? 0;
		if (generation > 0 && this.graphFrameBlockedGeneration === generation) {
			return this.readFallbackAudioFrame();
		}
		if (!this.ensureGraph() || !this.graph) return this.readFallbackAudioFrame();
		const graph = this.graph;
		try {
			graph.mainAnalyser.getByteFrequencyData(graph.mainFreqData);
			graph.mainAnalyser.getByteTimeDomainData(graph.mainTimeData);
			graph.beatAnalyser.getByteFrequencyData(graph.beatFreqData);
			graph.beatAnalyser.getByteTimeDomainData(graph.beatTimeData);
			if (this.graphFrameValidationGeneration === generation) {
				this.graphFrameValidationGeneration = 0;
			}
		} catch {
			this.lastErrorCode = "graph-frame-read-failed";
			if (generation > 0 && this.graphFrameValidationGeneration === generation) {
				this.graphFrameValidationGeneration = 0;
				this.graphFrameBlockedGeneration = generation;
			} else if (this.claimGraphRecovery(generation)) {
				this.reconnectGraph();
				this.graphFrameValidationGeneration = generation;
			} else if (generation > 0) {
				this.graphFrameBlockedGeneration = generation;
			}
			return this.readFallbackAudioFrame();
		}
		const activeDeck = this.committed;
		const active = activeDeck?.audio ?? null;
		const context = activeDeck?.binding?.loadContext as Record<string, unknown> | null | undefined;
		return {
			mainFreqData: graph.mainFreqData,
			mainTimeData: graph.mainTimeData,
			mainSampleRate: graph.context.sampleRate,
			mainFftSize: graph.mainAnalyser.fftSize,
			beatFreqData: graph.beatFreqData,
			beatTimeData: graph.beatTimeData,
			beatSampleRate: graph.context.sampleRate,
			beatFftSize: graph.beatAnalyser.fftSize,
			playing: !!active && !active.paused && !active.ended,
			currentTimeSeconds: active?.currentTime ?? 0,
			trackKey: typeof context?.trackKey === "string" ? context.trackKey : null,
		};
	}

	private reconnectGraph(): boolean {
		const graph = this.graph;
		if (!graph) return false;
		this.graphReconnects += 1;
		let connected = true;
		for (const binding of graph.deckBindings.values()) {
			if (!binding.source) continue;
			try {
				binding.source.disconnect();
				binding.source.connect(binding.gain);
				binding.connected = true;
			} catch {
				binding.connected = false;
				connected = false;
			}
		}
		return connected;
	}

	private graphAttemptIsAllowed(code: GraphFailureCode, generation: number): boolean {
		if (generation <= 0) return true;
		if (this.graphFailureBlockedGeneration === generation) return false;
		if (this.graphFailureGeneration !== generation || this.graphFailureCode !== code) return true;
		if (this.claimGraphRecovery(generation)) return true;
		this.graphFailureBlockedGeneration = generation;
		return false;
	}

	private recordGraphFailure(code: GraphFailureCode, generation: number): void {
		this.lastErrorCode = code;
		if (generation <= 0) return;
		const repeated = this.graphFailureGeneration === generation && this.graphFailureCode === code;
		this.graphFailureGeneration = generation;
		this.graphFailureCode = code;
		if (repeated && this.graphRecoveryGenerations.has(generation)) {
			this.graphFailureBlockedGeneration = generation;
		}
	}

	private clearGraphFailure(code: GraphFailureCode, generation: number): void {
		if (this.graphFailureGeneration !== generation || this.graphFailureCode !== code) return;
		this.graphFailureGeneration = 0;
		this.graphFailureCode = null;
		this.graphFailureBlockedGeneration = 0;
	}

	private scheduleOwnerProbes(deck: Deck): void {
		this.clearOwnerProbes(false);
		const generation = deck.binding?.generation ?? 0;
		if (!generation) return;
		this.ownerProbeGeneration = generation;
		this.ownerProbeLastMediaTime = Number(deck.audio.currentTime) || 0;
		this.audibilityProbeLastMediaTime = this.ownerProbeLastMediaTime;
		this.ownerProbeSilentSamples = 0;
		this.graphRecoveryBudgetGeneration = generation;
		this.graphRecoveryAttempted = this.graphRecoveryGenerations.has(generation);
		if (this.graphFrameValidationGeneration !== generation) this.graphFrameValidationGeneration = 0;
		if (this.graphFrameBlockedGeneration !== generation) this.graphFrameBlockedGeneration = 0;
		if (this.graphFailureGeneration !== generation) {
			this.graphFailureGeneration = 0;
			this.graphFailureCode = null;
			this.graphFailureBlockedGeneration = 0;
		}
		for (const delayMs of PLAYBACK_GRAPH_HEALTH_PROBE_MS) {
			let handle: unknown;
			handle = this.scheduleTimeout(() => {
				this.graphHealthProbeHandles.delete(handle);
				this.runGraphHealthProbe(deck, generation);
			}, delayMs);
			this.graphHealthProbeHandles.add(handle);
		}
		for (const delayMs of PLAYBACK_AUDIBILITY_PROBE_MS) {
			let handle: unknown;
			handle = this.scheduleTimeout(() => {
				this.audibilityProbeHandles.delete(handle);
				this.runAudibilityProbe(deck, generation);
			}, delayMs);
			this.audibilityProbeHandles.add(handle);
		}
	}

	private runGraphHealthProbe(deck: Deck, generation: number): void {
		if (
			!this.ownerGenerationIsCurrent(deck, generation)
			|| deck.audio.paused
			|| deck.audio.ended
			|| deck.audio.muted
			|| this.masterVolume <= 0
			|| this.activeFade !== null
			|| this.now() <= this.seekSuppressedUntil
			|| !this.ensureGraph()
			|| !this.graph
		) return;
		const graph = this.graph;
		let signal = 0;
		try {
			graph.mainAnalyser.getByteFrequencyData(graph.mainFreqData);
			graph.mainAnalyser.getByteTimeDomainData(graph.mainTimeData);
			for (const value of graph.mainFreqData) signal = Math.max(signal, value / 255);
			let sum = 0;
			for (const value of graph.mainTimeData) {
				const centered = (value - 128) / 128;
				sum += centered * centered;
			}
			if (graph.mainTimeData.length) signal = Math.max(signal, Math.sqrt(sum / graph.mainTimeData.length));
		} catch {
			signal = 0;
		}
		const mediaTime = Number(deck.audio.currentTime) || 0;
		const clockAdvanced = mediaTime > this.ownerProbeLastMediaTime + 0.01;
		this.ownerProbeLastMediaTime = mediaTime;
		if (!clockAdvanced) return;
		if (signal <= PLAYBACK_SILENT_SIGNAL_THRESHOLD) this.ownerProbeSilentSamples += 1;
		else this.ownerProbeSilentSamples = 0;
		if (this.ownerProbeSilentSamples < 2) return;
		if (this.claimGraphRecovery(generation)) this.reconnectGraph();
	}

	private runAudibilityProbe(deck: Deck, generation: number): void {
		if (!this.ownerGenerationIsCurrent(deck, generation)) return;
		if (this.masterVolume <= 0 || deck.audio.paused || deck.audio.ended) return;
		if (this.activeFade || this.now() < this.seekSuppressedUntil) return;
		const mediaTime = Number(deck.audio.currentTime) || 0;
		const clockAdvanced = mediaTime > this.audibilityProbeLastMediaTime + 0.01;
		this.audibilityProbeLastMediaTime = mediaTime;
		if (!clockAdvanced) return;
		const graphGain = this.graph?.deckBindings.get(deck.id)?.gain.gain.value;
		if (deck.fadeGain < 0.999 || (graphGain !== undefined && graphGain < 0.999)) {
			this.audibilityRecoveryAttempts += 1;
			this.setDeckFadeGain(deck, 1);
		}
	}

	private ownerGenerationIsCurrent(deck: Deck, generation: number): boolean {
		return !this.disposed
			&& this.ownerProbeGeneration === generation
			&& deck === this.committed
			&& deck.binding?.generation === generation;
	}

	private clearOwnerProbes(resetGraphFailure = true): void {
		for (const handle of this.graphHealthProbeHandles) this.cancelTimeout(handle);
		for (const handle of this.audibilityProbeHandles) this.cancelTimeout(handle);
		this.graphHealthProbeHandles.clear();
		this.audibilityProbeHandles.clear();
		this.ownerProbeGeneration = 0;
		this.audibilityProbeLastMediaTime = 0;
		this.ownerProbeSilentSamples = 0;
		this.graphRecoveryBudgetGeneration = 0;
		this.graphRecoveryAttempted = false;
		this.graphFrameValidationGeneration = 0;
		this.graphFrameBlockedGeneration = 0;
		if (resetGraphFailure) {
			this.graphFailureGeneration = 0;
			this.graphFailureCode = null;
			this.graphFailureBlockedGeneration = 0;
		}
	}

	private claimGraphRecovery(generation: number): boolean {
		if (generation <= 0) return false;
		if (this.graphRecoveryGenerations.has(generation)) return false;
		this.graphRecoveryBudgetGeneration = generation;
		this.graphRecoveryAttempted = true;
		this.graphRecoveryGenerations.add(generation);
		this.graphRecoveryAttempts += 1;
		return true;
	}

	private replaceDeckElementForGraph(deck: Deck, generation: number): boolean {
		const key = `${deck.id}:${generation}`;
		if (this.replacedDeckGenerations.has(key)) return false;
		if (!this.claimGraphRecovery(generation)) return false;
		const replacement = this.createElement();
		if (!replacement || this.decks.some((candidate) => candidate.audio === replacement) || [...this.mirrorElements.values()].includes(replacement)) {
			return false;
		}
		const previous = deck.audio;
		const binding = deck.binding;
		if (!binding || binding.generation !== generation) return false;
		const previousTime = Number(previous.currentTime) || 0;
		const wasPlaying = !previous.paused && !previous.ended;
		this.unbindNativeEvents(deck);
		try { previous.pause(); } catch { /* best effort */ }
		const graphBinding = this.graph?.deckBindings.get(deck.id);
		if (graphBinding) {
			try { graphBinding.source?.disconnect(); } catch { /* best effort */ }
			graphBinding.source = null;
			graphBinding.connected = false;
		}
		configureAudioElement(replacement);
		replacement.src = binding.sourceUrl;
		replacement.load();
		try { replacement.currentTime = previousTime; } catch { /* metadata 尚未就绪时由媒体自身归零 */ }
		deck.audio = replacement;
		this.bindNativeEvents(deck);
		this.replacedDeckGenerations.add(key);
		this.graphReplacements += 1;
		this.applyDeckGain(deck);
		const attached = this.ensureDeckGraphSource(deck);
		if (wasPlaying) void Promise.resolve(replacement.play()).catch(() => {});
		if (this.routingSnapshot.enabled) {
			void this.applySink(replacement, this.routingSnapshot.effectivePrimarySinkId, "primary");
		}
		return attached;
	}

	private async resumeAudioContext(deck: Deck): Promise<void> {
		const context = this.graph?.context
			?? (deck.audio as RuntimeAudioElement)[MINERADIO_AUDIO_CONTEXT_KEY]
			?? null;
		if (!context || context.state !== "suspended") return;
		try { await context.resume(); } catch { /* autoplay policy 由 play() error 归一 */ }
	}

	private disposeGraph(closeOwned = true): void {
		const graph = this.graph;
		this.graph = null;
		if (!graph) return;
		for (const binding of graph.deckBindings.values()) {
			try { binding.source?.disconnect(); } catch { /* best effort */ }
			try { binding.gain.disconnect(); } catch { /* best effort */ }
		}
		try { graph.mainAnalyser.disconnect(); } catch { /* best effort */ }
		try { graph.beatAnalyser.disconnect(); } catch { /* best effort */ }
		if (closeOwned && graph.ownedContext && graph.context.state !== "closed") {
			void graph.context.close().catch(() => {});
		}
	}

	private async applySink(
		target: unknown,
		sinkId: string,
		targetName: OutputRoutingError["target"],
	): Promise<OutputRoutingError | null> {
		const sinkTarget = target as { setSinkId?: (id: string) => Promise<void> } | null;
		if (typeof sinkTarget?.setSinkId !== "function") {
			if (!sinkId) return null;
			return {
				target: targetName,
				sinkId,
				name: "NotSupportedError",
				message: "setSinkId is not supported",
			};
		}
		try {
			await sinkTarget.setSinkId(sinkId);
			return null;
		} catch (error) {
			const value = error as { name?: unknown; message?: unknown };
			return {
				target: targetName,
				sinkId,
				name: typeof value?.name === "string" ? value.name : "Error",
				message: typeof value?.message === "string" ? value.message : String(error),
			};
		}
	}

	private async ensureMirrors(generation = this.routingGeneration): Promise<void> {
		if (!this.routingIsCurrent(generation)) return;
		const desired = this.routingSnapshot.enabled ? this.routingSnapshot.mirrorSinkIds : [];
		const active = this.committed?.audio ?? null;
		const sourceUrl = active ? (active.currentSrc || active.src) : "";
		for (const id of [...this.mirrorElements.keys()]) {
			if (!desired.includes(id) || !sourceUrl) this.removeMirror(id);
		}
		if (!sourceUrl || desired.length === 0) {
			this.updateMirrorTimer();
			return;
		}
		const errors = [...this.routingSnapshot.errors];
		for (const id of desired.slice(0, PLAYBACK_MAX_MIRRORS)) {
			if (!this.routingIsCurrent(generation)) return;
			let mirror = this.mirrorElements.get(id) ?? null;
			if (!mirror) {
				const candidate = this.createElement();
				if (!candidate || this.decks.some((deck) => deck.audio === candidate) || [...this.mirrorElements.values()].includes(candidate)) {
					errors.push({ target: "mirror", sinkId: id, name: "NotSupportedError", message: "mirror audio element unavailable" });
					continue;
				}
				mirror = candidate;
				configureAudioElement(mirror);
				this.mirrorElements.set(id, mirror);
			}
			const sinkError = await this.applySink(mirror, id, "mirror");
			if (!this.routingIsCurrent(generation)) {
				if (!this.routingSnapshot.mirrorSinkIds.includes(id)) this.removeMirror(id);
				return;
			}
			if (sinkError) {
				errors.push(sinkError);
				this.removeMirror(id);
				continue;
			}
		}
		if (errors.length !== this.routingSnapshot.errors.length) {
			this.routingSnapshot = immutableRoutingSnapshot({ ...this.routingSnapshot, errors });
		}
		this.syncMirrors();
		this.updateMirrorTimer();
	}

	private syncMirrors(): void {
		const active = this.committed?.audio ?? null;
		if (!active) return;
		const sourceUrl = active.currentSrc || active.src;
		for (const mirror of this.mirrorElements.values()) {
			try {
				if ((mirror.currentSrc || mirror.src) !== sourceUrl) {
					mirror.src = sourceUrl;
					mirror.load();
				}
				mirror.muted = active.muted;
				mirror.volume = active.volume;
				mirror.playbackRate = active.playbackRate || 1;
				if (
					Number.isFinite(active.currentTime)
					&& Math.abs((Number(mirror.currentTime) || 0) - active.currentTime) > PLAYBACK_MIRROR_DRIFT_SECONDS
				) mirror.currentTime = active.currentTime;
				if (active.paused || active.ended) mirror.pause();
				else void Promise.resolve(mirror.play()).catch(() => {});
			} catch {
				// 单个镜像失败不能影响 primary owner。
			}
		}
	}

	private updateMirrorTimer(): void {
		if (this.mirrorElements.size > 0 && this.mirrorSyncTimer === null) {
			this.mirrorSyncTimer = this.scheduleInterval(() => this.syncMirrors(), PLAYBACK_MIRROR_SYNC_MS);
			return;
		}
		if (this.mirrorElements.size === 0 && this.mirrorSyncTimer !== null) {
			this.cancelInterval(this.mirrorSyncTimer);
			this.mirrorSyncTimer = null;
		}
	}

	private removeMirror(id: string): void {
		const mirror = this.mirrorElements.get(id);
		if (!mirror) return;
		this.mirrorElements.delete(id);
		try { mirror.pause(); } catch { /* best effort */ }
		try {
			mirror.removeAttribute("src");
			mirror.load();
		} catch { /* best effort */ }
	}

	private updateDeviceListener(): void {
		const shouldListen = !!(
			this.mediaDevices
			&& this.routingSnapshot.enabled
			&& (this.routingSnapshot.effectivePrimarySinkId || this.routingSnapshot.mirrorSinkIds.length > 0)
		);
		if (shouldListen && !this.deviceListenerAttached) {
			this.mediaDevices!.addEventListener("devicechange", this.onDeviceChange);
			this.deviceListenerAttached = true;
			return;
		}
		if (!shouldListen && this.deviceListenerAttached) {
			this.mediaDevices?.removeEventListener("devicechange", this.onDeviceChange);
			this.deviceListenerAttached = false;
		}
	}

	private clearRoutingResources(): void {
		for (const id of [...this.mirrorElements.keys()]) this.removeMirror(id);
		this.updateMirrorTimer();
		if (this.deviceListenerAttached) {
			this.mediaDevices?.removeEventListener("devicechange", this.onDeviceChange);
			this.deviceListenerAttached = false;
		}
	}

	private async reconcileOutputDevices(): Promise<void> {
		if (!this.routingSnapshot.enabled) return;
		const routingGeneration = this.routingGeneration;
		const available = new Set((await this.listOutputDevices()).map((device) => device.deviceId));
		if (!this.routingIsCurrent(routingGeneration)) return;
		const requested = this.routingSnapshot.requestedPrimarySinkId;
		const bridge = this.routingSnapshot.virtualBridgeSinkId;
		const requestedAvailable = !requested || requested === "default" || available.has(requested);
		const bridgeAvailable = !bridge || bridge === "default" || available.has(bridge);
		await this.setOutputRouting({
			enabled: true,
			primarySinkId: requestedAvailable ? requested : "",
			virtualBridgeSinkId: bridgeAvailable ? bridge : "",
			mirrorSinkIds: this.routingSnapshot.mirrorSinkIds.filter((id) => id === "default" || available.has(id)),
		});
	}

	private scheduleLoadProbes(deck: Deck, generation: number): void {
		if (!this.stallProbeIsEligible(deck)) {
			this.clearLoadProbes(deck);
			return;
		}
		if (
			deck.probeGeneration === generation
			&& (deck.probeHandles.length > 0 || deck.readinessPublished.has("stalled"))
		) return;
		this.clearLoadProbes(deck);
		deck.probeGeneration = generation;
		deck.probeStartedMediaTime = Number(deck.audio.currentTime) || 0;
		deck.probeStartedBufferedEnd = this.readBufferedEnd(deck.audio);
		deck.readinessPublished.clear();
		let earlyHandle: unknown;
		earlyHandle = this.scheduleTimeout(() => {
			deck.probeHandles = deck.probeHandles.filter((handle) => handle !== earlyHandle);
			if (!this.loadGenerationIsCurrent(deck, generation)) return;
			if (this.stallHasRecovered(deck)) {
				this.clearLoadProbes(deck);
				return;
			}
			this.publishReadiness(deck, "waiting", "early");
		}, PLAYBACK_STALL_PROBE_EARLY_MS);
		deck.probeHandles.push(earlyHandle);
		let lateHandle: unknown;
		lateHandle = this.scheduleTimeout(() => {
			deck.probeHandles = deck.probeHandles.filter((handle) => handle !== lateHandle);
			if (!this.loadGenerationIsCurrent(deck, generation)) return;
			if (this.stallHasRecovered(deck)) {
				this.clearLoadProbes(deck);
				return;
			}
			this.publishReadiness(deck, "stalled", "late");
		}, PLAYBACK_STALL_PROBE_LATE_MS);
		deck.probeHandles.push(lateHandle);
	}

	private clearLoadProbes(deck: Deck): void {
		for (const handle of deck.probeHandles) this.cancelTimeout(handle);
		deck.probeHandles = [];
	}

	private stallHasRecovered(deck: Deck): boolean {
		if (!this.stallProbeIsEligible(deck)) return true;
		const mediaTime = Number(deck.audio.currentTime) || 0;
		if (mediaTime > deck.probeStartedMediaTime + 0.05) return true;
		const bufferedEnd = this.readBufferedEnd(deck.audio);
		if (bufferedEnd > Math.max(mediaTime + 0.25, deck.probeStartedBufferedEnd + 0.05)) {
			return true;
		}
		return Number(deck.audio.readyState) >= 3;
	}

	private stallProbeIsEligible(deck: Deck): boolean {
		if (deck.audio.paused || deck.audio.ended) return false;
		const networkState = Number(deck.audio.networkState);
		return networkState === 1 || networkState === 2;
	}

	private readBufferedEnd(audio: HTMLAudioElement): number {
		try {
			const buffered = audio.buffered;
			if (!buffered || buffered.length === 0) return 0;
			return Number(buffered.end(buffered.length - 1)) || 0;
		} catch {
			return 0;
		}
	}

	private loadGenerationIsCurrent(deck: Deck, generation: number): boolean {
		return !this.disposed
			&& deck.binding?.generation === generation
			&& deck.probeGeneration === generation
			&& deck === this.committed;
	}

	private publishReadiness(
		deck: Deck,
		eventName: "waiting" | "stalled" | "canplay",
		probe: PlaybackReadinessPayload["probe"],
	): void {
		if (deck.readinessPublished.has(eventName)) return;
		deck.readinessPublished.add(eventName);
		if (eventName === "stalled") this.stallRecoveryRequests += 1;
		if (eventName === "canplay") this.clearLoadProbes(deck);
		const binding = deck.binding;
		if (!binding) return;
		this.emit(eventName, {
			...this.bindingPayload(deck, binding),
			probe,
		} satisfies PlaybackReadinessPayload);
	}

	private bindingPayload(deck: Deck, binding: SourceBinding): MediaEventPayload {
		return {
			loadContext: binding.loadContext,
			sourceUrl: binding.sourceUrl,
			generation: binding.generation,
			deckId: deck.id,
		};
	}

	private deckDiagnostics(deck: Deck | null): PlaybackDeckDiagnostics | null {
		if (!deck?.binding) return null;
		return Object.freeze({
			id: deck.id,
			generation: deck.binding.generation,
			sourceUrl: redactedSourceUrl(deck.binding.sourceUrl),
			paused: deck.audio.paused,
		});
	}

	private readFallbackAudioFrame(): AudioFrameBytes {
		const active = this.committed?.audio ?? null;
		return {
			mainFreqData: new Uint8Array(0),
			mainTimeData: new Uint8Array(0),
			mainSampleRate: 0,
			mainFftSize: 0,
			beatFreqData: new Uint8Array(0),
			beatTimeData: new Uint8Array(0),
			beatSampleRate: 0,
			beatFftSize: 0,
			playing: !!active && !active.paused && !active.ended,
			currentTimeSeconds: active?.currentTime ?? 0,
		};
	}

	private assertUsable(): void {
		if (this.disposed) throw new Error("PlaybackAudioRuntime is disposed");
	}
}

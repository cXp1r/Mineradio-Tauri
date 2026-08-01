import {
	authorizeAlbumGaplessPreload,
	canCommitAlbumGaplessPreload,
	claimAlbumGaplessAdvance,
	claimAlbumGaplessPreloadCommit,
	createAlbumGaplessHandoffState,
	disposeAlbumGaplessHandoff,
	getAlbumGaplessTimingDecision,
	invalidateAlbumGaplessHandoff,
	type AlbumGaplessContext,
	type AlbumGaplessAdvanceTrigger,
	type AlbumGaplessHandoffState,
	type AlbumGaplessTrack,
	type PreloadAuthority,
} from "./playback-handoff-policy";

export interface GaplessPlaybackContext<
	Track extends AlbumGaplessTrack = AlbumGaplessTrack,
> {
	readonly enabled: boolean;
	readonly crossfade: boolean;
	readonly queue: readonly Track[];
	readonly currentIndex: number;
	readonly mode: string;
	readonly sessionId: number;
	readonly intentId: number;
}

export interface GaplessResolvedSource {
	readonly audioUrl: string;
	readonly rawUrl: string;
}

export interface GaplessPreparedHandle {
	abort(): void;
}

export interface GaplessResolveContext {
	readonly authority: PreloadAuthority;
	readonly signal: AbortSignal;
}

export interface GaplessPrepareContext<Track extends AlbumGaplessTrack> {
	readonly authority: PreloadAuthority;
	readonly candidate: Track;
	readonly source: GaplessResolvedSource;
	readonly signal: AbortSignal;
}

export interface GaplessPreparedHandoffCommit<
	Track extends AlbumGaplessTrack,
	Handle extends GaplessPreparedHandle,
> {
	readonly candidate: Track;
	readonly handle: Handle;
	readonly source: GaplessResolvedSource;
	readonly authority: PreloadAuthority;
	readonly trigger: AlbumGaplessAdvanceTrigger;
	readonly expectedIntentId: number;
	readonly expectedOutgoingTrackKey: string;
}

export type GaplessAdoptedPlayback<
	Track extends AlbumGaplessTrack,
	Handle extends GaplessPreparedHandle,
> = GaplessPreparedHandoffCommit<Track, Handle>;

export interface GaplessPlaybackPorts<
	Track extends AlbumGaplessTrack,
	Handle extends GaplessPreparedHandle,
> {
	getContext(): GaplessPlaybackContext<Track>;
	resolve(
		candidate: Track,
		context: GaplessResolveContext,
	): Promise<GaplessResolvedSource>;
	prepareNext(
		audioUrl: string,
		context: GaplessPrepareContext<Track>,
	): Handle | Promise<Handle>;
	prerollPrepared?(
		handle: Handle,
		options: {
			readonly isCurrent: () => boolean;
		},
	): Promise<void>;
	playPrepared(
		handle: Handle,
		options: {
			readonly crossfadeMs: number;
			readonly isCurrent: () => boolean;
		},
	): Promise<void>;
	commitPreparedHandoff(
		request: GaplessPreparedHandoffCommit<Track, Handle>,
	): boolean | Promise<boolean>;
	onCommitted(
		adopted: GaplessAdoptedPlayback<Track, Handle>,
	): void | Promise<void>;
}

export type GaplessPlaybackPhase =
	| "idle"
	| "resolving"
	| "preparing"
	| "prepared"
	| "handoff"
	| "adopted"
	| "failed"
	| "disposed";

export interface GaplessPlaybackDiagnostics {
	readonly phase: GaplessPlaybackPhase;
	readonly generation: number;
	readonly candidateTrackKey: string;
	readonly disposed: boolean;
	readonly lastError: string | null;
	readonly resolveCount: number;
	readonly preparedCount: number;
	readonly committedCount: number;
}

interface PreparedRecord<
	Track extends AlbumGaplessTrack,
	Handle extends GaplessPreparedHandle,
> {
	readonly authority: PreloadAuthority;
	readonly candidate: Track;
	readonly source: GaplessResolvedSource;
	readonly handle: Handle;
	readonly abortController: AbortController;
}

interface GaplessContextSnapshot {
	readonly sessionId: number;
	readonly intentId: number;
	readonly currentIndex: number;
	readonly mode: string;
	readonly queue: readonly {
		readonly provider: string;
		readonly id: string;
		readonly album: string;
		readonly coverUrl: string;
	}[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class GaplessPlaybackController<
	Track extends AlbumGaplessTrack,
	Handle extends GaplessPreparedHandle,
> {
	private policyState: AlbumGaplessHandoffState =
		createAlbumGaplessHandoffState();
	private preloadPromise: Promise<void> | null = null;
	private preloadAbort: AbortController | null = null;
	private prepared: PreparedRecord<Track, Handle> | null = null;
	private prerollPromise: Promise<void> | null = null;
	private prerollGeneration: number | null = null;
	private adopted: GaplessAdoptedPlayback<Track, Handle> | null = null;
	private advancePromise: Promise<boolean> | null = null;
	private generationContext: GaplessContextSnapshot | null = null;
	private phase: GaplessPlaybackPhase = "idle";
	private lastError: string | null = null;
	private resolveCount = 0;
	private preparedCount = 0;
	private committedCount = 0;

	constructor(private readonly ports: GaplessPlaybackPorts<Track, Handle>) {}

	async onTimeUpdate(remainingSeconds: number): Promise<boolean> {
		if (this.policyState.disposed) return false;
		if (
			this.policyState.authority &&
			!this.matchesGenerationContext(this.ports.getContext())
		) {
			this.invalidate("context-changed");
			return false;
		}
		const timing = getAlbumGaplessTimingDecision(remainingSeconds);
		if (!timing.preloadDue) return false;
		await this.ensurePreload();
		if (!this.prepared) return false;
		if (timing.prerollDue) await this.ensurePreroll();
		const current = this.ports.getContext();
		if (
			!current.crossfade ||
			remainingSeconds > timing.crossfadeDurationMs / 1_000
		) {
			return false;
		}
		return this.advance(
			"handoff",
			timing.crossfadeDurationMs,
		);
	}

	onEnded(): Promise<boolean> {
		if (this.policyState.disposed) return Promise.resolve(false);
		if (this.advancePromise) return this.advancePromise;
		if (this.adopted) return Promise.resolve(true);
		if (!this.prepared) {
			if (this.policyState.authority) this.invalidate("ended-before-prepared");
			return Promise.resolve(false);
		}
		if (!this.matchesGenerationContext(this.ports.getContext())) {
			this.invalidate("ended-context-stale");
			return Promise.resolve(false);
		}
		return this.advance("ended", 0);
	}

	diagnostics(): GaplessPlaybackDiagnostics {
		return {
			phase: this.phase,
			generation: this.policyState.generation,
			candidateTrackKey:
				this.policyState.authority?.candidateTrackKey ?? "",
			disposed: this.policyState.disposed,
			lastError: this.lastError,
			resolveCount: this.resolveCount,
			preparedCount: this.preparedCount,
			committedCount: this.committedCount,
		};
	}

	/**
	 * React/store 输入变化后主动收回旧 prepared authority，避免等待下一次
	 * timeupdate/ended 才释放 pending deck。
	 */
	reconcileContext(): boolean {
		if (this.policyState.disposed) return false;
		if (!this.policyState.authority) return true;
		if (this.matchesGenerationContext(this.ports.getContext())) return true;
		this.invalidate("context-changed");
		return false;
	}

	invalidate(_reason = "invalidated"): void {
		if (this.policyState.disposed) return;
		this.preloadAbort?.abort();
		this.preloadAbort = null;
		this.prerollPromise = null;
		this.prerollGeneration = null;
		// 旧 promise 即使忽略 AbortSignal 也不能阻塞新 session 建立 generation。
		this.preloadPromise = null;
		if (this.prepared) {
			try {
				this.prepared.handle.abort();
			} catch {
				// 失效优先保证 generation 前进，媒体清理由 runtime 尽力完成。
			}
		}
		this.prepared = null;
		this.generationContext = null;
		this.advancePromise = null;
		this.policyState = invalidateAlbumGaplessHandoff(this.policyState);
		this.phase = "idle";
		this.lastError = null;
	}

	dispose(): void {
		if (this.policyState.disposed) return;
		this.preloadAbort?.abort();
		this.preloadAbort = null;
		this.preloadPromise = null;
		this.prerollPromise = null;
		this.prerollGeneration = null;
		if (this.prepared) {
			try {
				this.prepared.handle.abort();
			} catch {
				// dispose 必须幂等，底层清理失败不阻止 controller 关闭。
			}
		}
		this.prepared = null;
		this.adopted = null;
		this.generationContext = null;
		this.policyState = disposeAlbumGaplessHandoff(this.policyState);
		this.phase = "disposed";
		this.lastError = null;
	}

	takeAdopted(): GaplessAdoptedPlayback<Track, Handle> | null {
		const adopted = this.adopted;
		this.adopted = null;
		return adopted;
	}

	private toPolicyContext(
		context: GaplessPlaybackContext<Track>,
	): AlbumGaplessContext {
		return {
			enabled: context.enabled,
			playMode: context.mode,
			currentIndex: context.currentIndex,
			playbackSessionId: context.sessionId,
			intentId: context.intentId,
			queue: context.queue,
		};
	}

	private snapshotContext(
		context: GaplessPlaybackContext<Track>,
	): GaplessContextSnapshot {
		return {
			sessionId: context.sessionId,
			intentId: context.intentId,
			currentIndex: context.currentIndex,
			mode: context.mode,
			queue: context.queue.map((track) => ({
				provider: String(track.provider ?? ""),
				id: String(track.id ?? ""),
				album: String(track.album ?? ""),
				coverUrl: String(track.coverUrl ?? ""),
			})),
		};
	}

	private matchesGenerationContext(
		context: GaplessPlaybackContext<Track>,
	): boolean {
		const snapshot = this.generationContext;
		if (
			!snapshot ||
			!context.enabled ||
			context.sessionId !== snapshot.sessionId ||
			context.intentId !== snapshot.intentId ||
			context.currentIndex !== snapshot.currentIndex ||
			context.mode !== snapshot.mode ||
			context.queue.length !== snapshot.queue.length
		) {
			return false;
		}
		return context.queue.every((track, index) => {
			const expected = snapshot.queue[index];
			return !!(
				expected &&
				String(track.provider ?? "") === expected.provider &&
				String(track.id ?? "") === expected.id &&
				String(track.album ?? "") === expected.album &&
				String(track.coverUrl ?? "") === expected.coverUrl
			);
		});
	}

	private async ensurePreload(): Promise<void> {
		if (this.preloadPromise) return this.preloadPromise;
		if (this.policyState.authority || this.policyState.disposed) return;
		const current = this.ports.getContext();
		const authorized = authorizeAlbumGaplessPreload(
			this.policyState,
			this.toPolicyContext(current),
		);
		if (!authorized) return;

		this.policyState = authorized.state;
		this.generationContext = this.snapshotContext(current);
		this.phase = "resolving";
		this.lastError = null;
		const abortController = new AbortController();
		this.preloadAbort = abortController;
		const candidate = current.queue[authorized.authority.candidateIndex];
		if (!candidate) return;

		let task!: Promise<void>;
		task = this.runPreload(
			authorized.authority,
			candidate,
			abortController,
		).finally(() => {
			if (this.preloadPromise === task) this.preloadPromise = null;
		});
		this.preloadPromise = task;
		return task;
	}

	private ensurePreroll(): Promise<void> {
		const prepared = this.prepared;
		const prerollPrepared = this.ports.prerollPrepared;
		if (!prepared || !prerollPrepared) return Promise.resolve();
		if (
			this.prerollGeneration === prepared.authority.generation &&
			this.prerollPromise
		) {
			return this.prerollPromise;
		}
		if (this.prerollGeneration === prepared.authority.generation) {
			return Promise.resolve();
		}
		this.prerollGeneration = prepared.authority.generation;
		const task = Promise.resolve(
			prerollPrepared(prepared.handle, {
				isCurrent: () =>
					!prepared.abortController.signal.aborted &&
					!this.policyState.disposed &&
					this.policyState.authority?.generation ===
						prepared.authority.generation &&
					this.matchesGenerationContext(this.ports.getContext()),
			}),
		)
			.catch((error) => {
				// 静音 preroll 失败不消耗 handoff；边界仍可重新 play 或回退普通 ended。
				this.lastError = errorMessage(error);
			})
			.finally(() => {
				if (this.prerollPromise === task) this.prerollPromise = null;
			});
		this.prerollPromise = task;
		return task;
	}

	private advance(
		trigger: AlbumGaplessAdvanceTrigger,
		crossfadeMs: number,
	): Promise<boolean> {
		if (this.advancePromise) return this.advancePromise;
		const prepared = this.prepared;
		if (!prepared || !this.matchesGenerationContext(this.ports.getContext())) {
			return Promise.resolve(false);
		}
		const claim = claimAlbumGaplessAdvance(
			this.policyState,
			prepared.authority,
			this.toPolicyContext(this.ports.getContext()),
			trigger,
		);
		if (!claim.accepted) return Promise.resolve(false);
		this.policyState = claim.state;
		this.phase = "handoff";
		// 先发布同一个 promise，再进入 port，避免同步 ended 重入绕过 gate。
		const task = Promise.resolve().then(() =>
			this.runAdvance(prepared, trigger, crossfadeMs),
		);
		this.advancePromise = task;
		return task;
	}

	private async runAdvance(
		prepared: PreparedRecord<Track, Handle>,
		trigger: AlbumGaplessAdvanceTrigger,
		crossfadeMs: number,
	): Promise<boolean> {
		try {
			await this.ports.playPrepared(prepared.handle, {
				crossfadeMs,
				isCurrent: () =>
					!prepared.abortController.signal.aborted &&
					!this.policyState.disposed &&
					this.policyState.authority?.generation ===
						prepared.authority.generation &&
					this.matchesGenerationContext(this.ports.getContext()),
			});
		} catch (error) {
			if (
				this.policyState.disposed ||
				prepared.abortController.signal.aborted
			) {
				return false;
			}
			try {
				prepared.handle.abort();
			} catch {
				// play 失败时仍以保留 outgoing 与普通 ended 路径为优先。
			}
			this.prepared = null;
			this.phase = "failed";
			this.lastError = errorMessage(error);
			return false;
		}

		if (
			this.policyState.disposed ||
			prepared.abortController.signal.aborted
		) {
			return false;
		}
		if (!this.matchesGenerationContext(this.ports.getContext())) {
			try {
				prepared.handle.abort();
			} catch {
				// stale handoff 只做尽力清理，绝不提交旧 store 意图。
			}
			this.prepared = null;
			this.phase = "failed";
			this.lastError = "gapless handoff context became stale";
			return false;
		}

		const adopted: GaplessAdoptedPlayback<Track, Handle> = {
			candidate: prepared.candidate,
			handle: prepared.handle,
			source: prepared.source,
			authority: prepared.authority,
			trigger,
			expectedIntentId: prepared.authority.intentId,
			expectedOutgoingTrackKey: prepared.authority.currentTrackKey,
		};
		try {
			const commitResult = this.ports.commitPreparedHandoff(adopted);
			// Zustand compare-and-commit 是同步事务；不要人为插入 microtask，
			// 否则 React 可能先看到新 track，却还取不到 adopted owner。
			const committed = typeof commitResult === "boolean"
				? commitResult
				: await commitResult;
			if (!committed) throw new Error("gapless store handoff was rejected");
			this.committedCount += 1;
		} catch (error) {
			try {
				prepared.handle.abort();
			} catch {
				// store 已拒绝旧意图，不允许继续对外宣称 adopted。
			}
			this.prepared = null;
			this.phase = "failed";
			this.lastError = errorMessage(error);
			return false;
		}

		this.prepared = null;
		this.adopted = adopted;
		this.phase = "adopted";
		try {
			await this.ports.onCommitted(adopted);
		} catch (error) {
			// store 与 deck 已经提交；通知失败不能重新开放 ended，避免双推进。
			this.lastError = errorMessage(error);
		}
		return true;
	}

	private async runPreload(
		authority: PreloadAuthority,
		candidate: Track,
		abortController: AbortController,
	): Promise<void> {
		try {
			this.resolveCount += 1;
			const source = await this.ports.resolve(candidate, {
				authority,
				signal: abortController.signal,
			});
			if (abortController.signal.aborted) return;
			if (
				!this.matchesGenerationContext(this.ports.getContext()) ||
				!canCommitAlbumGaplessPreload(
					this.policyState,
					authority,
					this.toPolicyContext(this.ports.getContext()),
				)
			) {
				this.invalidate("resolved-context-stale");
				return;
			}
			if (!source.audioUrl.trim()) throw new Error("gapless source has no audio URL");

			this.phase = "preparing";
			const handle = await this.ports.prepareNext(source.audioUrl, {
				authority,
				candidate,
				source,
				signal: abortController.signal,
			});
			if (!this.matchesGenerationContext(this.ports.getContext())) {
				handle.abort();
				this.invalidate("prepared-context-stale");
				return;
			}
			const committed = claimAlbumGaplessPreloadCommit(
				this.policyState,
				authority,
				this.toPolicyContext(this.ports.getContext()),
			);
			if (abortController.signal.aborted || !committed.accepted) {
				handle.abort();
				if (!abortController.signal.aborted) {
					this.invalidate("prepared-authority-stale");
				}
				return;
			}

			this.policyState = committed.state;
			this.preparedCount += 1;
			this.prepared = {
				authority,
				candidate,
				source,
				handle,
				abortController,
			};
			this.phase = "prepared";
		} catch (error) {
			if (abortController.signal.aborted) return;
			this.phase = "failed";
			this.lastError = errorMessage(error);
		}
	}
}

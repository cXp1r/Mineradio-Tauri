import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "@mineradio/shared";
import { trackLikeKey } from "../likes/likes-policy";
import {
	beginHomeListenSession,
	isEffectiveHomeListenSession,
	updateHomeListenSession,
	type HomeListenSession,
} from "./home-policy";
import {
	buildHomeListenSummary,
	migrateHomeListenLedger,
	recordHomeListenSession,
	type HomeListenLedgerV2,
	type HomeListenSummary,
} from "./home-listen-ledger";
import type { HomeListenRepository } from "./home-listen-repository";

export interface HomeListenLedgerController {
	ledger: HomeListenLedgerV2;
	summary: HomeListenSummary | null;
	recordPause(): void;
	recordProgress(positionMs: number, durationMs: number | null): void;
	finalize(completed?: boolean): void;
}

export function useHomeListenLedger({
	currentTrack,
	positionMs,
	durationMs,
	repository,
	now = Date.now,
}: {
	currentTrack: Track | null;
	positionMs: number;
	durationMs: number | null;
	repository: HomeListenRepository;
	now?: () => number;
}): HomeListenLedgerController {
	const [ledger, setLedger] = useState(() =>
		migrateHomeListenLedger(repository.read()),
	);
	const ledgerRef = useRef(ledger);
	const persistTailRef = useRef<Promise<void>>(Promise.resolve());
	const repositoryGenerationRef = useRef(0);
	const repositoryRef = useRef(repository);
	const nowRef = useRef(now);
	const playbackRef = useRef({ currentTrack, positionMs, durationMs });
	const lastTrackKeyRef = useRef("");
	const sessionRef = useRef<HomeListenSession | null>(null);
	repositoryRef.current = repository;
	nowRef.current = now;
	playbackRef.current = { currentTrack, positionMs, durationMs };

	useEffect(() => {
		repositoryGenerationRef.current += 1;
		const next = migrateHomeListenLedger(repository.read());
		ledgerRef.current = next;
		persistTailRef.current = Promise.resolve();
		setLedger(next);
	}, [repository]);

	const persist = useCallback((resolveNext: (
		current: HomeListenLedgerV2,
	) => HomeListenLedgerV2) => {
		const targetRepository = repositoryRef.current;
		const generation = repositoryGenerationRef.current;
		const commit = async () => {
			if (generation !== repositoryGenerationRef.current) return;
			try {
				const next = resolveNext(ledgerRef.current);
				await targetRepository.save(next);
				if (generation !== repositoryGenerationRef.current) return;
				ledgerRef.current = next;
				setLedger(next);
			} catch {
				// 收听统计失败不能影响播放主流程，也不能发布未提交快照。
				return;
			}
		};
		persistTailRef.current = persistTailRef.current.then(commit, commit);
	}, []);

	const finalize = useCallback((completed = false) => {
		const snapshot = playbackRef.current;
		const endedAt = nowRef.current();
		const session = updateHomeListenSession(
			sessionRef.current,
			snapshot.positionMs,
			snapshot.durationMs,
			endedAt,
			true,
		);
		sessionRef.current = null;
		if (
			!session ||
			!isEffectiveHomeListenSession(session, completed, snapshot.durationMs)
		) {
			return;
		}
		persist((current) =>
			recordHomeListenSession(current, {
				track: session.track,
				startedAt: session.startedAt,
				endedAt,
				listenMs: session.listenMs,
				completed,
			}),
		);
	}, [persist]);

	const recordPause = useCallback(() => {
		const snapshot = playbackRef.current;
		sessionRef.current = updateHomeListenSession(
			sessionRef.current,
			snapshot.positionMs,
			snapshot.durationMs,
			nowRef.current(),
			true,
		);
	}, []);

	const recordProgress = useCallback(
		(nextPositionMs: number, nextDurationMs: number | null) => {
			sessionRef.current = updateHomeListenSession(
				sessionRef.current,
				nextPositionMs,
				nextDurationMs,
				nowRef.current(),
			);
		},
		[],
	);

	useEffect(() => {
		const key = trackLikeKey(currentTrack);
		if (!currentTrack || !key) {
			finalize(false);
			lastTrackKeyRef.current = "";
			return;
		}
		if (key === lastTrackKeyRef.current) return;
		finalize(false);
		lastTrackKeyRef.current = key;
		sessionRef.current = beginHomeListenSession(
			currentTrack,
			nowRef.current(),
			positionMs,
		);
	}, [currentTrack, finalize, positionMs]);

	const summary = useMemo(
		() => buildHomeListenSummary(ledger, nowRef.current()),
		[ledger],
	);

	return { ledger, summary, recordPause, recordProgress, finalize };
}

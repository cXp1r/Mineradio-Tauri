import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import type { ProviderId, PodcastRadio, Track } from "@mineradio/shared";
import { SidecarClient } from "../../api/sidecar-client";
import { isPlayable, playSearchResult } from "../search/play-search-result";
import { useSearchStore } from "../../stores/search-store";

export type SearchMode = "song" | "netease" | "qq" | "podcast";

export interface SearchShellProps {
	client: SidecarClient | null;
	onFocus?: () => void;
	onUpload?: () => void;
	onClearCustomCover?: () => void;
	onResultPlay?: (track: Track) => void;
	onResultNext?: (track: Track) => void;
	onResultLike?: (track: Track) => void;
	onResultCollect?: (track: Track) => void;
	onArtistSearch?: (artist: string, track: Track) => void;
	isResultLiked?: (track: Track) => boolean;
	isResultLikeBusy?: (track: Track) => boolean;
	hasCustomCover?: boolean;
	peek?: boolean;
	requestedMode?: SearchMode;
	onPodcastOpen?: (radio: PodcastRadio) => void;
}

const HISTORY_CHIPS: Array<{ label: string; mode?: SearchMode; keyword: string }> = [
	{ label: "遇见", keyword: "遇见" },
	{ label: "周杰伦", keyword: "周杰伦" },
	{ label: "播客", mode: "podcast", keyword: "播客" },
];

function modeProvider(mode: SearchMode): ProviderId | undefined {
	if (mode === "netease") return "netease";
	if (mode === "qq") return "qq";
	return undefined;
}

function providerFromMode(mode: SearchMode): ProviderId {
	return mode === "qq" ? "qq" : "netease";
}

function trackArtists(track: Track): string {
	return track.artists.length > 0 ? track.artists.join(" / ") : "未知艺人";
}

export async function searchTracksForMode(
	client: Pick<SidecarClient, "search" | "searchAll">,
	mode: SearchMode,
	keyword: string,
	limit: number,
): Promise<Track[]> {
	const providerFilter = modeProvider(mode);
	return providerFilter
		? client.search(providerFilter, keyword, limit)
		: client.searchAll(keyword, limit);
}

export function clearSearchAfterPlayback(
	ops: {
		nextSearchSeq: () => void;
		setLoading: (loading: boolean) => void;
		setKeyword: (keyword: string) => void;
		setResults: (results: Track[]) => void;
		setError: (error: string | null) => void;
	},
): void {
	ops.nextSearchSeq();
	ops.setLoading(false);
	ops.setKeyword("");
	ops.setResults([]);
	ops.setError(null);
}

function HeartIcon(): ReactElement {
	return (
		<svg className="heart-svg" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M12 21.45c-.32 0-.62-.12-.86-.34l-1.23-1.12C5.54 16.03 2.25 13.05 2.25 8.9 2.25 5.48 4.88 2.9 8.28 2.9c1.7 0 3.35.72 4.52 1.96C13.97 3.62 15.62 2.9 17.32 2.9c3.4 0 6.03 2.58 6.03 6 0 4.15-3.29 7.13-7.66 11.09l-1.23 1.12c-.24.22-.54.34-.86.34z" />
		</svg>
	);
}

function CollectIcon(): ReactElement {
	return (
		<svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M12 5v14" />
			<path d="M5 12h14" />
		</svg>
	);
}

export function SearchShell({
	client,
	onFocus,
	onUpload,
	onClearCustomCover,
	onResultPlay,
	onResultNext,
	onResultLike,
	onResultCollect,
	onArtistSearch,
	isResultLiked,
	isResultLikeBusy,
	hasCustomCover = false,
	peek = false,
	requestedMode,
	onPodcastOpen,
}: SearchShellProps): ReactElement {
	const provider = useSearchStore((s) => s.provider);
	const keyword = useSearchStore((s) => s.keyword);
	const results = useSearchStore((s) => s.results);
	const loading = useSearchStore((s) => s.loading);
	const error = useSearchStore((s) => s.error);
	const setProvider = useSearchStore((s) => s.setProvider);
	const setKeyword = useSearchStore((s) => s.setKeyword);
	const setResults = useSearchStore((s) => s.setResults);
	const setLoading = useSearchStore((s) => s.setLoading);
	const setError = useSearchStore((s) => s.setError);
	const reset = useSearchStore((s) => s.reset);
	const modeRef = useRef<SearchMode>("song");
	const searchSeqRef = useRef(0);
	const [podcastResults, setPodcastResults] = useState<PodcastRadio[]>([]);

	const runSearch = useCallback(
		async (nextKeyword: string, nextMode: SearchMode = modeRef.current) => {
			const trimmed = nextKeyword.trim();
			setKeyword(nextKeyword);
			modeRef.current = nextMode;
			setProvider(providerFromMode(nextMode));
			if (nextMode === "podcast") {
				setResults([]);
				if (!client) {
					setPodcastResults([]);
					setError("sidecar 尚未就绪，稍后再试");
					return;
				}
				const seq = searchSeqRef.current + 1;
				searchSeqRef.current = seq;
				setLoading(true);
				setError(null);
				try {
					const podcastClient = client as Pick<SidecarClient, "podcastSearch" | "podcastHot">;
					const detail = trimmed
						? await podcastClient.podcastSearch(trimmed, 30)
						: await podcastClient.podcastHot(18, 0);
					if (searchSeqRef.current === seq) {
						setPodcastResults(detail.podcasts);
						setLoading(false);
					}
				} catch (e) {
					if (searchSeqRef.current !== seq) return;
					setPodcastResults([]);
					const message = e instanceof Error ? e.message : "播客加载失败";
					setError(message);
				}
				return;
			}
			setPodcastResults([]);
			if (!trimmed) {
				setResults([]);
				setError(null);
				return;
			}
			if (!client) {
				setResults([]);
				setError("sidecar 尚未就绪，稍后再试");
				return;
			}
			const seq = searchSeqRef.current + 1;
			searchSeqRef.current = seq;
			setLoading(true);
			setError(null);
			try {
				const tracks = await searchTracksForMode(client, nextMode, trimmed, 30);
				if (searchSeqRef.current === seq) setResults(tracks);
			} catch (e) {
				if (searchSeqRef.current !== seq) return;
				const message = e instanceof Error ? e.message : "搜索失败";
				setError(message);
			}
		},
		[client, setError, setKeyword, setLoading, setProvider, setResults],
	);

	useEffect(() => {
		if (!keyword.trim() && modeRef.current !== "podcast") {
			searchSeqRef.current += 1;
			setLoading(false);
			setResults([]);
			setPodcastResults([]);
			setError(null);
			return;
		}
		const timer = setTimeout(() => {
			void runSearch(keyword, modeRef.current);
		}, 180);
		return () => clearTimeout(timer);
	}, [keyword, runSearch]);

	useEffect(() => {
		if (!requestedMode) return;
		modeRef.current = requestedMode;
		setProvider(providerFromMode(requestedMode));
		if (requestedMode === "podcast") {
			void runSearch(keyword.trim() ? keyword : "", "podcast");
		} else if (keyword.trim()) {
			void runSearch(keyword, requestedMode);
		} else {
			setPodcastResults([]);
			setResults([]);
			setError(null);
		}
	}, [keyword, requestedMode, runSearch, setError, setProvider, setResults]);

	const selectMode = (mode: SearchMode) => {
		modeRef.current = mode;
		setProvider(providerFromMode(mode));
		setResults([]);
		setPodcastResults([]);
		setError(null);
		if (mode === "podcast") {
			void runSearch(keyword.trim() ? keyword : "", mode);
		} else if (keyword.trim()) {
			void runSearch(keyword, mode);
		}
	};

	const submit = () => {
		void runSearch(keyword, modeRef.current);
	};

	const playResult = (track: Track) => {
		playSearchResult(track);
		clearSearchAfterPlayback({
			nextSearchSeq: () => {
				searchSeqRef.current += 1;
			},
			setLoading,
			setKeyword,
			setResults,
			setError,
		});
		onResultPlay?.(track);
	};

	const openArtist = (track: Track) => {
		const artist = track.artists.find((name) => name.trim().length > 0)?.trim();
		if (!artist) return;
		onArtistSearch?.(artist, track);
	};

	const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			submit();
		}
		if (event.key === "Escape") {
			reset();
		}
	};

	const showResults = results.length > 0 || podcastResults.length > 0 || !!error || loading || keyword.trim().length > 0 || modeRef.current === "podcast";
	const effectivePeek = peek || showResults;

	return (
		<div id="search-area" className={effectivePeek ? "peek" : ""} data-shell="home-search">
			<div id="search-stack">
				<div id="search-box">
					<svg id="search-icon" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="11" cy="11" r="7" />
						<path d="m20 20-3.5-3.5" />
					</svg>
					<input
						id="search-input"
						type="text"
						placeholder="搜索歌曲、歌手..."
						aria-label="搜索歌曲、歌手、播客"
						autoComplete="off"
						spellCheck={false}
						value={keyword}
						onChange={(event) => setKeyword(event.target.value)}
						onFocus={onFocus}
						onKeyDown={onInputKeyDown}
					/>
				</div>
				<div id="search-mode-tabs" className="search-mode-tabs" role="tablist" aria-label="Search mode">
					<button id="search-mode-song" className={modeRef.current === "song" ? "active" : ""} type="button" aria-selected={modeRef.current === "song"} onClick={() => selectMode("song")}>All</button>
					<button id="search-mode-netease" className={modeRef.current === "netease" ? "active" : ""} type="button" aria-selected={modeRef.current === "netease"} onClick={() => selectMode("netease")}>NE</button>
					<button id="search-mode-qq" className={modeRef.current === "qq" ? "active" : ""} type="button" aria-selected={modeRef.current === "qq"} onClick={() => selectMode("qq")}>QQ</button>
					<button id="search-mode-podcast" className={modeRef.current === "podcast" ? "active" : ""} type="button" aria-selected={modeRef.current === "podcast"} onClick={() => selectMode("podcast")}>Podcast</button>
				</div>
				<div id="search-results" className={showResults ? "show" : ""} aria-live="polite">
					{!showResults ? (
						<div className="search-history">
							<div className="search-history-head">
								<span>搜索历史</span>
							</div>
							<div className="search-history-list">
								{HISTORY_CHIPS.map((chip) => (
									<button
										className="search-history-chip"
										type="button"
										key={chip.label}
										onClick={() => {
											modeRef.current = chip.mode ?? "song";
											void runSearch(chip.keyword, modeRef.current);
										}}
									>
										{chip.label}
									</button>
								))}
							</div>
						</div>
					) : null}
					{loading ? <div className="search-shell-state">搜索中...</div> : null}
					{error ? <div className="search-shell-error">{error}</div> : null}
					{!loading && !error && showResults && results.length === 0 && podcastResults.length === 0 ? (
						<div className="search-shell-state">没有找到结果</div>
					) : null}
					{podcastResults.length > 0 ? (
						<ul className="search-shell-list search-shell-podcast-list">
							{podcastResults.map((radio) => (
								<li key={radio.id || radio.rid}>
									<button
										type="button"
										className="search-result podcast-result"
										data-podcast-id={radio.id || radio.rid}
										onClick={() => onPodcastOpen?.(radio)}
									>
										{radio.coverUrl ? <img src={radio.coverUrl} alt="" /> : <div className="search-result-cover-placeholder" />}
										<div className="search-result-info">
											<div className="search-result-title">{radio.name}<span className="tag-podcast">Podcast</span></div>
											<div className="search-result-meta">{radio.djName || radio.category || `${radio.programCount || 0} episodes`}</div>
										</div>
									</button>
								</li>
							))}
						</ul>
					) : null}
					{results.length > 0 ? (
						<ul className="search-shell-list">
							{results.map((track, index) => {
								const disabled = !isPlayable(track.playableState);
								const liked = isResultLiked?.(track) === true;
								const likeBusy = isResultLikeBusy?.(track) === true;
								return (
									<li key={`${track.provider}-${track.id}-${index}`} className="search-shell-row" data-disabled={disabled ? "true" : "false"}>
										<button
											type="button"
											className="search-shell-row-btn"
											disabled={disabled}
											onClick={() => {
												if (!disabled) playResult(track);
											}}
										>
											<span className="search-shell-cover" style={track.coverUrl ? { backgroundImage: `url("${track.coverUrl}")` } : undefined} />
											<span className="search-shell-meta">
												<span className="search-shell-title">{track.title}</span>
												<span
													className="search-shell-sub search-artist-link"
													role="button"
													tabIndex={0}
													onClick={(event) => {
														event.stopPropagation();
														openArtist(track);
													}}
													onKeyDown={(event) => {
														if (event.key !== "Enter" && event.key !== " ") return;
														event.preventDefault();
														event.stopPropagation();
														openArtist(track);
													}}
												>
													{trackArtists(track)}
												</span>
											</span>
											<span className="search-shell-provider">{track.provider === provider ? track.provider : track.provider.toUpperCase()}</span>
										</button>
										<div className="search-shell-actions" aria-label="歌曲操作">
											<button
												type="button"
												className={`search-shell-action song-action-btn search-shell-like${liked ? " liked" : ""}${likeBusy ? " busy" : ""}`}
												title={liked ? "取消红心" : "红心喜欢"}
												aria-label={liked ? "取消红心" : "红心喜欢"}
												disabled={likeBusy}
												onClick={(event) => {
													event.stopPropagation();
													onResultLike?.(track);
												}}
											>
												<HeartIcon />
											</button>
											<button
												type="button"
												className="search-shell-action song-action-btn search-shell-collect"
												title="收藏到歌单"
												aria-label="收藏到歌单"
												onClick={(event) => {
													event.stopPropagation();
													onResultCollect?.(track);
												}}
											>
												<CollectIcon />
											</button>
											<button
												type="button"
												className="search-shell-action add-btn search-shell-next"
												title="下一首播放"
												aria-label="下一首播放"
												disabled={disabled}
												onClick={(event) => {
													event.stopPropagation();
													if (!disabled) onResultNext?.(track);
												}}
											>
												+
											</button>
										</div>
									</li>
								);
							})}
						</ul>
					) : null}
				</div>
			</div>
			<div id="upload-actions">
				<button id="upload-btn" className="icon-btn" type="button" title="导入音乐或封面" aria-label="导入音乐或封面" onClick={onUpload}>
					<svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
						<polyline points="17 8 12 3 7 8" />
						<line x1="12" y1="3" x2="12" y2="15" />
					</svg>
				</button>
				<button
					id="clear-cover-btn"
					className={hasCustomCover ? "icon-btn has-cover" : "icon-btn"}
					type="button"
					title={hasCustomCover ? "取消自定义封面" : "当前没有自定义封面"}
					aria-label={hasCustomCover ? "取消自定义封面" : "当前没有自定义封面"}
					onClick={() => {
						if (hasCustomCover) onClearCustomCover?.();
						else setError("当前没有自定义封面");
					}}
				>×</button>
				<div id="upload-tip" role="status" aria-live="polite">
					<button className="upload-tip-close" type="button" aria-label="关闭提示" onClick={() => setError(null)}>×</button>
					<span className="upload-tip-title">导入入口</span>
					这里支持上传歌曲，也可以给当前曲目换自定义封面。
				</div>
			</div>
		</div>
	);
}

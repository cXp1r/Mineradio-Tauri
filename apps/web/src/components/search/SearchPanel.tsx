import { memo, useCallback, useState, type FormEvent, type ReactElement } from "react";
import type { PlayableState, ProviderId, Track } from "@mineradio/shared";
import { SidecarClient } from "../../api/sidecar-client";
import { useSearchStore } from "../../stores/search-store";
import { isPlayable, playSearchResult } from "./play-search-result";

export interface SearchPanelProps {
	client: SidecarClient;
}

const PROVIDERS: ProviderId[] = ["netease", "qq"];

const STATE_LABELS: Record<PlayableState, string> = {
	unknown: "未知",
	playable: "可播放",
	login_required: "需登录",
	vip_required: "VIP",
	paid_required: "付费",
	copyright_unavailable: "无音源",
	trial_only: "试听",
	unavailable: "无音源",
};

const DISABLED_STATES: ReadonlySet<PlayableState> = new Set([
	"unavailable",
	"paid_required",
	"vip_required",
	"login_required",
]);

function stateLabel(state: PlayableState): string {
	return STATE_LABELS[state] ?? "未知";
}

function stateTestId(state: PlayableState): string {
	return `playable-state-${state}`;
}

function SearchPanelImpl({ client }: SearchPanelProps): ReactElement {
	const provider = useSearchStore((s) => s.provider);
	const setProvider = useSearchStore((s) => s.setProvider);
	const keyword = useSearchStore((s) => s.keyword);
	const setKeyword = useSearchStore((s) => s.setKeyword);
	const results = useSearchStore((s) => s.results);
	const loading = useSearchStore((s) => s.loading);
	const error = useSearchStore((s) => s.error);
	const setResults = useSearchStore((s) => s.setResults);
	const setLoading = useSearchStore((s) => s.setLoading);
	const setError = useSearchStore((s) => s.setError);

	const [keywordInput, setKeywordInput] = useState(keyword);

	const onProviderChange = (value: ProviderId) => {
		setProvider(value);
	};

	const onSubmit = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			const trimmed = keywordInput.trim();
			if (!trimmed) return;
			setKeyword(trimmed);
			if (provider === "qq") return;
			setLoading(true);
			setError(null);
			try {
				const tracks = await client.search(provider, trimmed, 30);
				setResults(tracks);
			} catch (e) {
				const message = e instanceof Error ? e.message : "search failed";
				setError(message);
			}
		},
		[
			client,
			keywordInput,
			provider,
			setKeyword,
			setError,
			setLoading,
			setResults,
		],
	);

	const isQQ = provider === "qq";

	return (
		<section className="search-panel" data-provider={provider}>
			<form className="search-form" onSubmit={onSubmit}>
				<select
					className="search-provider-select"
					value={provider}
					onChange={(e) => onProviderChange(e.target.value as ProviderId)}
					aria-label="provider"
				>
					{PROVIDERS.map((p) => (
						<option key={p} value={p}>
							{p}
						</option>
					))}
				</select>
				<input
					type="search"
					className="search-input"
					placeholder="搜索歌曲、歌手、专辑"
					value={keywordInput}
					onChange={(e) => setKeywordInput(e.target.value)}
					aria-label="keyword"
				/>
				<button type="submit" className="search-submit" disabled={loading || isQQ}>
					{loading ? "搜索中…" : "搜索"}
				</button>
			</form>
			{isQQ && (
				<p className="search-provider-note" title="QQ provider 不在 P4.5 接入范围">
					QQ provider 不在 P4.5 接入范围
				</p>
			)}
			{error && <p className="search-error">{error}</p>}
			<ul className="search-results">
				{results.map((track, index) => {
					const disabled = DISABLED_STATES.has(track.playableState);
					const hint =
						track.playableState === "login_required" ? "需登录" : null;
					return (
						<li
							key={`${track.provider}-${track.id}-${index}`}
							className="search-row"
							data-track-id={track.id}
							data-disabled={disabled ? "true" : "false"}
							data-playable-state={track.playableState}
						>
							<button
								type="button"
								className="search-row-button"
								disabled={disabled}
								onClick={() => {
									if (isQQ || disabled) return;
									if (!isPlayable(track.playableState)) return;
									playSearchResult(track);
								}}
							>
								{track.coverUrl ? (
									<img className="search-row-cover" src={track.coverUrl} alt="" />
								) : (
									<span className="search-row-cover search-row-cover--placeholder" />
								)}
								<span className="search-row-title">{track.title}</span>
								<span className="search-row-artists">
									{track.artists.join(", ")}
								</span>
								{track.album ? (
									<span className="search-row-album">{track.album}</span>
								) : null}
								<span
									className={`search-row-state ${stateTestId(track.playableState)}`}
								>
									{hint ?? stateLabel(track.playableState)}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export const SearchPanel = memo(SearchPanelImpl);
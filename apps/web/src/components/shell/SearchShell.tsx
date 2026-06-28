import { type ReactElement } from "react";

export interface SearchShellProps {
	onFocus?: () => void;
}

export function SearchShell({ onFocus }: SearchShellProps): ReactElement {
	return (
		<div id="search-area" className="peek" data-shell="home-search">
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
						onFocus={onFocus}
					/>
				</div>
				<div id="search-mode-tabs" className="search-mode-tabs" role="tablist" aria-label="Search mode">
					<button id="search-mode-song" className="active" type="button" aria-selected="true">All</button>
					<button id="search-mode-netease" type="button" aria-selected="false">NE</button>
					<button id="search-mode-qq" type="button" aria-selected="false">QQ</button>
					<button id="search-mode-podcast" type="button" aria-selected="false">Podcast</button>
				</div>
				<div id="search-results" aria-live="polite">
					<div className="search-history">
						<div className="search-history-head">
							<span>搜索历史</span>
						</div>
						<div className="search-history-list">
							<button className="search-history-chip" type="button">遇见</button>
							<button className="search-history-chip" type="button">周杰伦</button>
							<button className="search-history-chip" type="button">播客</button>
						</div>
					</div>
				</div>
			</div>
			<div id="upload-actions">
				<button id="upload-btn" className="icon-btn" type="button" title="导入音乐或封面" aria-label="导入音乐或封面">
					<svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
						<polyline points="17 8 12 3 7 8" />
						<line x1="12" y1="3" x2="12" y2="15" />
					</svg>
				</button>
				<button id="clear-cover-btn" className="icon-btn" type="button" title="取消自定义封面" aria-label="取消自定义封面">×</button>
				<div id="upload-tip" role="status" aria-live="polite">
					<button className="upload-tip-close" type="button" aria-label="关闭提示">×</button>
					<span className="upload-tip-title">导入入口</span>
					这里支持上传歌曲，也可以给当前曲目换自定义封面。
				</div>
			</div>
		</div>
	);
}

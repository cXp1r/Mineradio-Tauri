import { type ReactElement } from "react";

export interface EmptyHomeHostProps {
	onSearchFocus?: () => void;
	onOpenLibrary?: () => void;
	onOpenConsole?: () => void;
}

const STARTER_TILES = [
	{ tone: "search", title: "搜索歌曲", sub: "从歌名、歌手或播客开始" },
	{ tone: "local", title: "导入本地", sub: "播放本地音频文件" },
	{ tone: "guide", title: "视觉引导", sub: "熟悉粒子、歌词和歌单架" },
	{ tone: "playlist", title: "打开歌单", sub: "登录后同步你的音乐库" },
	{ tone: "library", title: "继续探索", sub: "推荐会随播放逐步补全" },
];

export function EmptyHomeHost(props: EmptyHomeHostProps): ReactElement {
	return (
		<section id="empty-home" aria-label="Mineradio home">
			<div className="empty-home-shell">
				<div className="home-hero">
					<div className="home-hero-inner home-construction-inner">
						<div className="home-title home-construction-title">🚧此处施工，敬请期待🚧</div>
						<button className="home-chip home-console-chip" type="button" onClick={props.onOpenConsole}>
							展开播放器控制台
						</button>
					</div>
				</div>

				<div className="home-grid">
					<button className="home-card" data-home-tone="library" type="button" onClick={props.onOpenLibrary}>
						<div className="home-card-label">Library</div>
						<div className="home-card-title" id="home-weather-card-title">我的歌单</div>
						<div className="home-card-sub" id="home-weather-card-sub">打开左侧歌单库</div>
						<div className="home-card-art" id="home-weather-art" />
					</button>
					<button className="home-card" data-home-tone="mix" type="button" onClick={props.onSearchFocus}>
						<div className="home-card-label">Daily</div>
						<div className="home-card-title" id="home-daily-title">每日推荐</div>
						<div className="home-card-sub" id="home-daily-sub">登录后同步你的今日歌曲</div>
						<div className="home-card-art" id="home-daily-art" />
					</button>
					<button className="home-card" data-home-tone="playlist" type="button" onClick={props.onSearchFocus}>
						<div className="home-card-label">Song</div>
						<div className="home-card-title" id="home-private-title">私人电台</div>
						<div className="home-card-sub" id="home-private-sub">从你的推荐和歌单里开播</div>
						<div className="home-card-art" id="home-private-art" />
					</button>
					<button className="home-card" data-home-tone="mix" type="button" onClick={props.onSearchFocus}>
						<div className="home-card-label">Continue</div>
						<div className="home-card-title" id="home-continue-title">继续听</div>
						<div className="home-card-sub" id="home-continue-sub">最近播放会出现在这里</div>
						<div className="home-card-art" id="home-continue-art" />
					</button>
					<button className="home-card" data-home-tone="local" type="button" onClick={props.onSearchFocus}>
						<div className="home-card-label">Profile</div>
						<div className="home-card-title" id="home-profile-title">听歌画像</div>
						<div className="home-card-sub" id="home-profile-sub">播放几首后生成偏好</div>
						<div className="home-card-art" id="home-profile-art" />
					</button>
					<button className="home-card" data-home-tone="local" type="button" onClick={props.onSearchFocus}>
						<div className="home-card-label">Song</div>
						<div className="home-card-title" id="home-library-title">常听歌手</div>
						<div className="home-card-sub" id="home-library-sub">你的偏好会在这里汇总</div>
						<div className="home-card-art" id="home-library-art" />
					</button>
				</div>

				<div className="home-rail">
					<div className="home-section-head">
						<div className="home-section-title" id="home-rail-title">为你准备</div>
						<div className="home-section-note" id="home-rail-note">正在整理推荐</div>
					</div>
					<div id="home-tile-row" className="home-tile-row">
						{STARTER_TILES.map((tile) => (
							<button className="home-tile" data-home-tone={tile.tone} type="button" onClick={props.onSearchFocus} key={tile.title}>
								<div className="home-tile-cover" />
								<div className="home-tile-title">{tile.title}</div>
								<div className="home-tile-sub">{tile.sub}</div>
							</button>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

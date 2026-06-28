import { type ReactElement } from "react";

export interface TopRightControlsProps {
	onHome?: () => void;
}

export function TopRightControls({ onHome }: TopRightControlsProps): ReactElement {
	return (
		<div id="top-right">
			<button
				id="user-capsule-hide-btn"
				className="user-capsule-hide-btn"
				type="button"
				title="自动隐藏账号胶囊"
				aria-label="自动隐藏账号胶囊"
			>
				‹
			</button>
			<button
				id="home-btn"
				className="icon-btn"
				type="button"
				onClick={onHome}
				title="回到 Home"
				aria-label="回到 Home"
			>
				<svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M3 10.8 12 3l9 7.8" />
					<path d="M5 10v10h14V10" />
					<path d="M9.5 20v-5h5v5" />
				</svg>
			</button>
			<button id="user-btn" className="icon-btn logged-out" type="button" title="登录账号" aria-label="登录账号">
				<span className="login-word">登录</span>
			</button>
		</div>
	);
}

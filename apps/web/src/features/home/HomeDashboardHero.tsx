import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ReactElement,
} from "react";
import type { HomeHeroVideoRepository } from "./home-hero-video";
import { useHomeHeroVideo } from "./useHomeHeroVideo";
import "./home-dashboard.css";

const HOME_REVIEW_QUOTES = [
	{ text: "有些歌不是突然好听，而是终于听懂了。", source: "每日热评" },
	{ text: "慢一点没关系，重要的是一直在向喜欢的生活靠近。", source: "每日热评" },
	{ text: "错过落日余晖，还会有满天星辰。", source: "每日热评" },
	{ text: "保持热爱，奔赴下一场山海。", source: "每日热评" },
	{ text: "答案在路上，自由在风里。", source: "每日热评" },
	{ text: "让今天的声音，从你喜欢的地方开始。", source: "Mineradio" },
] as const;

function localDayNumber(now: number): number {
	const date = new Date(now);
	return Math.floor(
		new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() /
			86_400_000,
	);
}

function formatClock(now: number): { date: string; time: string } {
	const value = new Date(now);
	return {
		date: value.toLocaleDateString("zh-CN", {
			year: "numeric",
			month: "long",
			day: "numeric",
			weekday: "long",
		}),
		time: `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`,
	};
}

export function HomeDashboardHero({
	active,
	onOpenConsole,
	onNotice,
	repository,
}: {
	active: boolean;
	onOpenConsole?: () => void;
	onNotice?: (message: string) => void;
	repository?: HomeHeroVideoRepository;
}): ReactElement {
	const [now, setNow] = useState(Date.now);
	const [reviewOffset, setReviewOffset] = useState(0);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { snapshot, videoRef, choose, clear, reportPlaybackError } =
		useHomeHeroVideo({ active, repository, onNotice });

	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => setNow(Date.now()), 15_000);
		return () => window.clearInterval(timer);
	}, [active]);

	const clock = useMemo(() => formatClock(now), [now]);
	const review = useMemo(() => {
		const index =
			((localDayNumber(now) + reviewOffset) % HOME_REVIEW_QUOTES.length +
				HOME_REVIEW_QUOTES.length) %
			HOME_REVIEW_QUOTES.length;
		return HOME_REVIEW_QUOTES[index] ?? HOME_REVIEW_QUOTES[0];
	}, [now, reviewOffset]);

	const handleFile = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			const file = event.currentTarget.files?.[0];
			event.currentTarget.value = "";
			if (file) void choose(file);
		},
		[choose],
	);

	return (
		<div className="home-hero-inner daily-review-card">
			{snapshot.url ? (
				<video
					aria-hidden="true"
					autoPlay
					className="home-dashboard-video"
					loop
					muted
					onError={reportPlaybackError}
					playsInline
					preload="metadata"
					ref={videoRef}
					src={snapshot.url}
				/>
			) : null}
			<div className="daily-review-date">{clock.date}</div>
			<div className="daily-review-time">{clock.time}</div>
			<div className="daily-review-quote">“{review.text}”</div>
			<div className="daily-review-source">— {review.source}</div>
			{snapshot.error ? (
				<div className="daily-review-video-error" role="status">
					{snapshot.error}
				</div>
			) : null}
			<div className="daily-review-actions">
				<button type="button" onClick={() => setReviewOffset((value) => value + 1)}>
					换一条
				</button>
				<button type="button" onClick={() => fileInputRef.current?.click()}>
					{snapshot.meta ? "更换 MP4" : "选择 MP4"}
				</button>
				{snapshot.meta ? (
					<button type="button" onClick={() => void clear()}>
						移除视频
					</button>
				) : null}
				<button
					className="home-console-chip"
					data-home-chip="console"
					type="button"
					onClick={onOpenConsole}
				>
					展开播放器控制台
				</button>
			</div>
			<input
				accept=".mp4,video/mp4"
				aria-hidden="true"
				hidden
				onChange={handleFile}
				ref={fileInputRef}
				type="file"
			/>
		</div>
	);
}

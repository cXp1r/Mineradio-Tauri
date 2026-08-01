import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type RefObject,
} from "react";
import {
	HomeHeroVideoController,
	HomeHeroVideoValidationError,
	type HomeHeroVideoRepository,
	type HomeHeroVideoSnapshot,
} from "./home-hero-video";
import { IndexedDbHomeHeroVideoRepository } from "./home-hero-video-repository";

export interface HomeHeroVideoBinding {
	snapshot: HomeHeroVideoSnapshot;
	videoRef: RefObject<HTMLVideoElement | null>;
	choose(file: File): Promise<void>;
	clear(): Promise<void>;
	reportPlaybackError(): void;
}

function pauseVideo(video: HTMLVideoElement | null): void {
	if (!video) return;
	try {
		video.pause();
	} catch {
		// WebView 正在销毁时 pause 可能失败，资源释放仍由 controller 保证。
	}
}

export function useHomeHeroVideo({
	active,
	repository,
	onNotice,
}: {
	active: boolean;
	repository?: HomeHeroVideoRepository;
	onNotice?(message: string): void;
}): HomeHeroVideoBinding {
	const [controller] = useState(
		() =>
			new HomeHeroVideoController(
				repository ?? new IndexedDbHomeHeroVideoRepository(),
			),
	);
	const [snapshot, setSnapshot] = useState(controller.getSnapshot);
	const videoRef = useRef<HTMLVideoElement>(null);
	const noticeRef = useRef(onNotice);
	noticeRef.current = onNotice;

	useEffect(
		() => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
		[controller],
	);

	useEffect(() => {
		const release = () => {
			pauseVideo(videoRef.current);
			controller.deactivate();
		};
		const updatePower = () => {
			const visible = active && !document.hidden;
			if (visible) void controller.activate();
			else release();
		};
		updatePower();
		document.addEventListener("visibilitychange", updatePower);
		window.addEventListener("pagehide", release);
		return () => {
			document.removeEventListener("visibilitychange", updatePower);
			window.removeEventListener("pagehide", release);
			release();
		};
	}, [active, controller]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !snapshot.url || !snapshot.active) return;
		void video.play().catch(() => undefined);
	}, [snapshot.active, snapshot.url]);

	const choose = useCallback(
		async (file: File) => {
			try {
				await controller.replace(file);
				noticeRef.current?.("主页 MP4 已保存");
			} catch (error) {
				const message =
					error instanceof HomeHeroVideoValidationError
						? error.message
						: "主页 MP4 保存失败";
				noticeRef.current?.(message);
			}
		},
		[controller],
	);

	const clear = useCallback(async () => {
		try {
			await controller.clear();
			noticeRef.current?.("已恢复主页默认动画");
		} catch {
			noticeRef.current?.("主页 MP4 删除失败");
		}
	}, [controller]);

	const reportPlaybackError = useCallback(() => {
		controller.reportPlaybackError();
		noticeRef.current?.("这个 MP4 无法解码，请换成 H.264 编码的 MP4");
	}, [controller]);

	return { snapshot, videoRef, choose, clear, reportPlaybackError };
}

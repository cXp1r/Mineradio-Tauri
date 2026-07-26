import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { LyricPayload, Track } from "@mineradio/shared";
import {
	clearCustomCoverForTrack,
	customCoverKeyForTrack,
	hasCustomCoverForTrack,
	saveCustomCoverForTrack,
	withStoredCustomCover,
} from "../../cover/custom-cover";
import {
	deleteCustomLyricForTrack,
	getCustomLyricPreferenceForTrack,
	getCustomLyricTextForTrack,
	resolveLyricsForTrack,
	saveCustomLyricForTrack,
	setCustomLyricPreferenceForTrack,
} from "../../lyrics/custom-lyrics";
import { readLocalFileAsDataUrl } from "../../audio/local-audio-import";
import { useLyricsStore } from "../../stores/lyrics-store";
import { usePlaybackStore } from "../../stores/playback-store";

export interface TrackCustomizationControllerResult {
	customLyricModalOpen: boolean;
	setCustomLyricModalOpen(open: boolean): void;
	customLyricText: string;
	setCustomLyricText(text: string): void;
	customLyricStatus: { text: string; tone?: "good" | "fail" };
	customLyricInputRef: RefObject<HTMLTextAreaElement | null>;
	currentLyricPreference: ReturnType<typeof getCustomLyricPreferenceForTrack>;
	currentCustomLyricText: string | null;
	currentHasCustomCover: boolean;
	applyCustomCoverImage(file: Blob, explicitTrack?: Track): Promise<void>;
	clearCustomCoverImage(): void;
	applyOriginalLyrics(): void;
	applyCustomLyrics(track?: Track | null): boolean;
	openCustomLyricModal(): void;
	chooseCustomLyrics(): void;
	saveCustomLyric(): void;
	deleteCustomLyric(): void;
}

export function useTrackCustomizationController({
	currentTrack,
	originalLyricsPayloadRef,
	setLyricsPayload,
	showToast,
}: {
	currentTrack: Track | null;
	originalLyricsPayloadRef: RefObject<LyricPayload | null>;
	setLyricsPayload(payload: LyricPayload): void;
	showToast(message: string): void;
}): TrackCustomizationControllerResult {
	const [customLyricModalOpen, setCustomLyricModalOpen] = useState(false);
	const [customLyricText, setCustomLyricText] = useState("");
	const [customLyricStatus, setCustomLyricStatus] = useState<{
		text: string;
		tone?: "good" | "fail";
	}>({ text: "" });
	const [, setCustomLyricVersion] = useState(0);
	const customLyricInputRef = useRef<HTMLTextAreaElement | null>(null);
	const dependenciesRef = useRef({ setLyricsPayload, showToast });
	dependenciesRef.current = { setLyricsPayload, showToast };

	const patchCustomCoverTrack = useCallback((target: Track, nextTrack: Track) => {
		const key = customCoverKeyForTrack(target);
		if (!key) return;
		const runtime = nextTrack as Track & {
			customCover?: string;
			defaultCoverUrl?: string;
		};
		const merge = (track: Track): Track => {
			if (customCoverKeyForTrack(track) !== key) return track;
			const patched = { ...track, coverUrl: nextTrack.coverUrl } as Track & {
				customCover?: string;
				defaultCoverUrl?: string;
			};
			if (runtime.customCover) patched.customCover = runtime.customCover;
			else delete patched.customCover;
			if (runtime.defaultCoverUrl) patched.defaultCoverUrl = runtime.defaultCoverUrl;
			else delete patched.defaultCoverUrl;
			return patched;
		};
		usePlaybackStore.setState((state) => ({
			currentTrack: state.currentTrack ? merge(state.currentTrack) : state.currentTrack,
			queue: state.queue.map(merge),
		}));
	}, []);

	const applyCustomCoverImage = useCallback(
		async (file: Blob, explicitTrack?: Track) => {
			const current = dependenciesRef.current;
			const target = explicitTrack ?? usePlaybackStore.getState().currentTrack;
			if (!target) {
				current.showToast("先播放或选择一首歌");
				return;
			}
			try {
				const dataUrl = await readLocalFileAsDataUrl(file);
				const result = saveCustomCoverForTrack(target, dataUrl);
				patchCustomCoverTrack(target, result.track);
				current.showToast(
					result.saved ? "封面已保存" : "封面已应用，存储空间不足",
				);
			} catch {
				current.showToast("封面读取失败");
			}
		},
		[patchCustomCoverTrack],
	);

	const clearCustomCoverImage = useCallback(() => {
		const current = dependenciesRef.current;
		const target = usePlaybackStore.getState().currentTrack;
		if (!target) {
			current.showToast("先播放或选择一首歌");
			return;
		}
		const result = clearCustomCoverForTrack(target);
		if (!result.existed) {
			current.showToast("当前没有自定义封面");
			return;
		}
		patchCustomCoverTrack(target, result.track);
		current.showToast("已恢复默认封面");
	}, [patchCustomCoverTrack]);

	const applyOriginalLyrics = useCallback(() => {
		const current = dependenciesRef.current;
		const track = usePlaybackStore.getState().currentTrack;
		if (track) setCustomLyricPreferenceForTrack(track, "original");
		const original = originalLyricsPayloadRef.current;
		if (original) current.setLyricsPayload(original);
		setCustomLyricVersion((version) => version + 1);
		current.showToast("已切换到原歌词");
	}, [originalLyricsPayloadRef]);

	const applyCustomLyrics = useCallback((track = usePlaybackStore.getState().currentTrack) => {
		const currentPayload = useLyricsStore.getState().payload;
		const text = getCustomLyricTextForTrack(track);
		if (!track || !currentPayload || !text?.trim()) return false;
		const resolved = resolveLyricsForTrack({
			track,
			original: currentPayload,
			durationMs: usePlaybackStore.getState().durationMs ?? track.durationMs,
		});
		if (resolved.source !== "custom") return false;
		dependenciesRef.current.setLyricsPayload(resolved.payload);
		setCustomLyricVersion((version) => version + 1);
		return true;
	}, []);

	const openCustomLyricModal = useCallback(() => {
		const current = dependenciesRef.current;
		const track = usePlaybackStore.getState().currentTrack;
		if (!track) {
			current.showToast("先播放或选择一首歌");
			return;
		}
		const text = getCustomLyricTextForTrack(track) ?? "";
		setCustomLyricText(text);
		setCustomLyricStatus({
			text: text
				? "已读取本地自定义歌词"
				: "提示：带 [00:12.00] 时间轴会更精准；纯文本会自动铺开",
			tone: text ? "good" : undefined,
		});
		setCustomLyricModalOpen(true);
	}, []);

	const chooseCustomLyrics = useCallback(() => {
		const current = dependenciesRef.current;
		const track = usePlaybackStore.getState().currentTrack;
		if (!track) {
			current.showToast("先播放或选择一首歌");
			return;
		}
		setCustomLyricPreferenceForTrack(track, "custom");
		setCustomLyricVersion((version) => version + 1);
		if (!applyCustomLyrics(track)) openCustomLyricModal();
		else {
			current.showToast("已切换到自定义歌词");
			openCustomLyricModal();
		}
	}, [applyCustomLyrics, openCustomLyricModal]);

	const saveCustomLyric = useCallback(() => {
		const current = dependenciesRef.current;
		const track = usePlaybackStore.getState().currentTrack;
		const text = (customLyricInputRef.current?.value ?? customLyricText).trim();
		if (!track) {
			setCustomLyricStatus({ text: "请先播放或选择一首歌", tone: "fail" });
			current.showToast("先播放或选择一首歌");
			return;
		}
		if (!text) {
			setCustomLyricStatus({ text: "请输入歌词内容", tone: "fail" });
			return;
		}
		const result = saveCustomLyricForTrack(track, text);
		if (result.lines.length === 0) {
			setCustomLyricStatus({ text: "没有识别到可显示的歌词行", tone: "fail" });
			return;
		}
		applyCustomLyrics(track);
		setCustomLyricText(text);
		setCustomLyricStatus({
			text: result.saved
				? `已保存 ${result.lines.length} 行，并切换为自定义歌词`
				: "已应用，但本地存储空间不足",
			tone: result.saved ? "good" : "fail",
		});
		current.showToast(result.saved ? "自定义歌词已保存" : "自定义歌词已应用");
		setCustomLyricModalOpen(false);
	}, [applyCustomLyrics, customLyricText]);

	const deleteCustomLyric = useCallback(() => {
		const current = dependenciesRef.current;
		const track = usePlaybackStore.getState().currentTrack;
		if (!track) {
			setCustomLyricStatus({ text: "请先播放或选择一首歌", tone: "fail" });
			return;
		}
		if (!deleteCustomLyricForTrack(track)) {
			setCustomLyricStatus({ text: "当前歌曲没有自定义歌词", tone: "fail" });
			return;
		}
		setCustomLyricText("");
		setCustomLyricStatus({ text: "已删除，恢复原歌词", tone: "good" });
		setCustomLyricVersion((version) => version + 1);
		current.showToast("已恢复原歌词");
	}, []);

	useEffect(() => {
		if (!currentTrack) return;
		const hydrated = withStoredCustomCover(currentTrack);
		if (
			hydrated === currentTrack ||
			hydrated.coverUrl === currentTrack.coverUrl
		) {
			return;
		}
		patchCustomCoverTrack(currentTrack, hydrated);
	}, [currentTrack, patchCustomCoverTrack]);

	return {
		customLyricModalOpen,
		setCustomLyricModalOpen,
		customLyricText,
		setCustomLyricText,
		customLyricStatus,
		customLyricInputRef,
		currentLyricPreference: getCustomLyricPreferenceForTrack(currentTrack),
		currentCustomLyricText: getCustomLyricTextForTrack(currentTrack),
		currentHasCustomCover: hasCustomCoverForTrack(currentTrack),
		applyCustomCoverImage,
		clearCustomCoverImage,
		applyOriginalLyrics,
		applyCustomLyrics,
		openCustomLyricModal,
		chooseCustomLyrics,
		saveCustomLyric,
		deleteCustomLyric,
	};
}

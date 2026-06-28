import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { SidecarClient, SidecarClientError } from "../api/sidecar-client";
import { PlayerController } from "../audio/player-controller";
import {
	deleteCustomLyricForTrack,
	getCustomLyricPreferenceForTrack,
	getCustomLyricTextForTrack,
	resolveLyricsForTrack,
	saveCustomLyricForTrack,
	setCustomLyricPreferenceForTrack,
} from "../lyrics/custom-lyrics";
import { selectCurrentIndex } from "../lyrics/select-current-index";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { useProviderStore } from "../stores/provider-store";
import { useSearchStore } from "../stores/search-store";
import {
	loadShelfSettingsFromStorage,
	saveShelfSettingsToStorage,
	useShelfStore,
	type ShelfCameraMode,
	type ShelfMode,
	type ShelfPresence,
} from "../stores/shelf-store";
import { useUiStore } from "../stores/ui-store";
import { useUpdateStore } from "../stores/update-store";
import {
	closeDesktopLyricsWindow,
	configureGlobalHotkeys,
	getRuntimeConfig,
	getSidecarStatus,
	getWindowState,
	importJsonFile,
	listenWindowState,
	listenGlobalHotkey,
	minimizeWindow,
	openProviderLoginWindow,
	showDesktopLyricsWindow,
	toggleWindowMaximize,
	toggleWindowFullscreen,
	updateDesktopLyricsPayload,
	type GlobalHotkeyBinding,
	type RuntimeConfig,
	type SidecarStatus,
	type WindowState,
} from "../tauri/runtime";
import { checkForUpdate, getUpdaterStatus } from "../tauri/updater";
import { BottomControlsHost } from "../components/shell/BottomControlsHost";
import { SearchShell } from "../components/shell/SearchShell";
import { SidecarRecoveryNotice, type SidecarRecoveryNoticeState } from "../components/shell/SidecarRecoveryNotice";
import { TopRightControls } from "../components/shell/TopRightControls";
import { UpdateHost } from "../components/shell/UpdateHost";
import { EmptyHomeHost } from "../home/EmptyHomeHost";
import { SplashHost, type SplashHostProps } from "../visual/SplashHost";
import { VisualEngineHost } from "../visual/VisualEngineHost";
import { createShelfDetailContentLoader, handleShelfDetailRowAction } from "../visual/shelf-detail-data";
import type { PlaybackQuality, PlaylistSummary, ProviderId, ProviderLoginStatus } from "@mineradio/shared";

const SHOW_SPLASH = import.meta.env.VITE_SPLASH !== "0";
const SIDECAR_STATUS_POLL_MS = 1500;
const SIDECAR_RECOVERED_NOTICE_MS = 2600;
const PLAYBACK_QUALITY_STORE_KEY = "mineradio-playback-quality-v1";
const DEFAULT_GLOBAL_HOTKEYS: GlobalHotkeyBinding[] = [
	{ action: "togglePlay", accelerator: "Control+Alt+Space" },
	{ action: "prevTrack", accelerator: "Control+Alt+ArrowLeft" },
	{ action: "nextTrack", accelerator: "Control+Alt+ArrowRight" },
	{ action: "volumeUp", accelerator: "Control+Alt+ArrowUp" },
	{ action: "volumeDown", accelerator: "Control+Alt+ArrowDown" },
	{ action: "toggleFullscreen", accelerator: "Control+Alt+KeyF" },
	{ action: "toggleDesktopLyrics", accelerator: "Control+Alt+KeyL" },
];

function placeholderRuntimeConfig(): RuntimeConfig {
	return {
		sidecarBaseUrl: "",
		appDataDir: "",
		appVersion: "0.0.0-dev",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
}

function audioElementSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		"HTMLAudioElement" in globalThis
	);
}

function readPlaybackQualityPreference(): PlaybackQuality {
	if (typeof localStorage === "undefined") return "hires";
	const raw = localStorage.getItem(PLAYBACK_QUALITY_STORE_KEY);
	if (raw === "jymaster" || raw === "hires" || raw === "lossless" || raw === "exhigh" || raw === "standard") return raw;
	return "hires";
}

function savePlaybackQualityPreference(quality: PlaybackQuality): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(PLAYBACK_QUALITY_STORE_KEY, quality);
}

export function isHomeBlankDismissElement(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	const home = target.closest("#empty-home");
	if (!home) return false;
	return !target.closest([
		".home-card",
		".home-tile",
		".home-chip",
		"button",
		"input",
		"textarea",
		"#search-area",
		"#top-right",
		"#bottom-bar",
		"#bottom-handle",
		".modal",
		"#login-modal",
	].join(","));
}

export interface EmptyHomeStateInput {
	splashActive: boolean;
	homeForcedOpen: boolean;
	homeSuppressed: boolean;
	hasCurrentTrack: boolean;
	queueLength: number;
	isPlaying: boolean;
	immersiveActive?: boolean;
	shelfDetailOpen?: boolean;
	shelfPinnedOpen?: boolean;
}

export function shouldShowEmptyHome(input: EmptyHomeStateInput): boolean {
	if (input.splashActive) return false;
	if (input.homeForcedOpen) return true;
	if (input.homeSuppressed) return false;
	if (input.immersiveActive) return false;
	if (input.shelfDetailOpen) return false;
	if (input.shelfPinnedOpen) return false;
	if (input.hasCurrentTrack) return false;
	if (input.queueLength > 0) return false;
	if (input.isPlaying) return false;
	return true;
}

export function deriveSidecarRecoveryNoticeState(
	status: SidecarStatus,
	previous: SidecarRecoveryNoticeState | null
): SidecarRecoveryNoticeState {
	const recovered = status.phase === "ready" && !!previous && (
		previous.phase === "recovering" ||
		previous.phase === "stopped" ||
		previous.phase === "error" ||
		status.restarts > previous.restarts
	);
	return {
		phase: status.phase,
		restarts: status.restarts,
		lastError: status.lastError,
		recovered,
	};
}

export function isDesktopWindowFullscreen(state: WindowState): boolean {
	return !!(
		state.isFullScreen ||
		state.isNativeFullScreen ||
		state.isHtmlFullScreen ||
		state.isWindowFullScreen ||
		(typeof document !== "undefined" && document.fullscreenElement)
	);
}

export function applyDesktopWindowShellState(state: WindowState): void {
	if (typeof document === "undefined") return;
	document.documentElement.classList.add("desktop-shell-root");
	document.body.classList.add("desktop-shell");
	document.body.classList.toggle("desktop-maximized", !!state.isMaximized);
	document.body.classList.toggle("desktop-fullscreen", isDesktopWindowFullscreen(state));
}

export type AppProps = {
	SplashComponent?: (props: SplashHostProps) => ReactElement | null;
	VisualComponent?: typeof VisualEngineHost;
};

export function App({ SplashComponent = SplashHost, VisualComponent = VisualEngineHost }: AppProps = {}): ReactElement {
	const [sidecarClient, setSidecarClient] = useState<SidecarClient | null>(null);
	const [sidecarBaseUrl, setSidecarBaseUrl] = useState("");
	const [splashActive, setSplashActive] = useState<boolean>(SHOW_SPLASH);
	const [loginModalOpen, setLoginModalOpen] = useState(false);
	const [neteaseStatus, setNeteaseStatus] = useState<ProviderLoginStatus | null>(null);
	const [qqStatus, setQqStatus] = useState<ProviderLoginStatus | null>(null);
	const [shelfPlaylists, setShelfPlaylists] = useState<PlaylistSummary[]>([]);
	const [homeForcedOpen, setHomeForcedOpen] = useState(false);
	const [homeSuppressed, setHomeSuppressed] = useState(false);
	const [sidecarRecoveryState, setSidecarRecoveryState] = useState<SidecarRecoveryNoticeState | null>(null);
	const [playbackQuality, setPlaybackQualityState] = useState<PlaybackQuality>(readPlaybackQualityPreference);
	const [playbackQualityReloadSeq, setPlaybackQualityReloadSeq] = useState(0);
	const [customLyricModalOpen, setCustomLyricModalOpen] = useState(false);
	const [customLyricText, setCustomLyricText] = useState("");
	const [customLyricStatus, setCustomLyricStatus] = useState<{ text: string; tone?: "good" | "fail" }>({ text: "" });
	const [customLyricVersion, setCustomLyricVersion] = useState(0);
	const [desktopLyricsEnabled, setDesktopLyricsEnabled] = useState(false);
	const [updateModalOpen, setUpdateModalOpen] = useState(false);

	const currentTrack = usePlaybackStore((s) => s.currentTrack);
	const queue = usePlaybackStore((s) => s.queue);
	const isPlaying = usePlaybackStore((s) => s.isPlaying);
	const positionMs = usePlaybackStore((s) => s.positionMs);
	const durationMs = usePlaybackStore((s) => s.durationMs);
	const volume = usePlaybackStore((s) => s.volume);
	const muted = usePlaybackStore((s) => s.muted);
	const setMatrix = useProviderStore((s) => s.setMatrix);
	const shelfMode = useShelfStore((s) => s.mode);
	const shelfCameraMode = useShelfStore((s) => s.cameraMode);
	const shelfPresence = useShelfStore((s) => s.presence);
	const setShelfMode = useShelfStore((s) => s.setMode);
	const setShelfCameraMode = useShelfStore((s) => s.setCameraMode);
	const setShelfPresence = useShelfStore((s) => s.setPresence);
	const applyShelfSettings = useShelfStore((s) => s.applySettings);
	const consoleVisible = useUiStore((s) => s.consoleVisible);
	const setConsole = useUiStore((s) => s.setConsole);
	const miniQueueOpen = useUiStore((s) => s.miniQueueOpen);
	const setMiniQueue = useUiStore((s) => s.setMiniQueue);
	const toggleMiniQueue = useUiStore((s) => s.toggleMiniQueue);
	const toast = useUiStore((s) => s.toast);
	const showToast = useUiStore((s) => s.showToast);
	const clearToast = useUiStore((s) => s.clearToast);
	const updateState = useUpdateStore();
	const applyUpdateCheckResult = useUpdateStore((s) => s.applyCheckResult);
	const setUpdateStatus = useUpdateStore((s) => s.setStatus);

	const lyricsPayload = useLyricsStore((s) => s.payload);
	const setLyricsPayload = useLyricsStore((s) => s.setPayload);
	const setLyricsLoading = useLyricsStore((s) => s.setLoading);
	const setLyricsError = useLyricsStore((s) => s.setError);
	const setLyricsIndex = useLyricsStore((s) => s.setCurrentIndex);
	const lyricsReset = useLyricsStore((s) => s.reset);

	const togglePlay = usePlaybackStore((s) => s.togglePlay);
	const setPlaying = usePlaybackStore((s) => s.setPlaying);
	const setPositionMs = usePlaybackStore((s) => s.setPosition);
	const setDurationMs = usePlaybackStore((s) => s.setDuration);
	const setVolume = usePlaybackStore((s) => s.setVolume);
	const toggleMute = usePlaybackStore((s) => s.toggleMute);
	const setPlaybackMode = usePlaybackStore((s) => s.setMode);
	const playbackMode = usePlaybackStore((s) => s.mode);
	const nextTrack = usePlaybackStore((s) => s.next);
	const previousTrack = usePlaybackStore((s) => s.previous);
	const playQueueAt = usePlaybackStore((s) => s.playAt);
	const removeQueueAt = usePlaybackStore((s) => s.removeAt);
	const insertQueueNext = usePlaybackStore((s) => s.insertNext);
	const setSearchKeyword = useSearchStore((s) => s.setKeyword);
	const setSearchError = useSearchStore((s) => s.setError);

	const cancelledRef = useRef(false);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const controllerRef = useRef<PlayerController | null>(null);
	const lastLoadedKeyRef = useRef<string>("");
	const playbackRequestSeqRef = useRef(0);
	const neteaseCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
	const qqCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
	const customLyricInputRef = useRef<HTMLTextAreaElement | null>(null);

	const positionRef = useRef(positionMs);
	positionRef.current = positionMs;
	const lyricsPayloadRef = useRef(lyricsPayload);
	lyricsPayloadRef.current = lyricsPayload;
	const originalLyricsPayloadRef = useRef(lyricsPayload);

	const initSidecar = useCallback((cfg: RuntimeConfig) => {
		const client = new SidecarClient(cfg.sidecarBaseUrl);
		setSidecarClient(client);
		setSidecarBaseUrl(cfg.sidecarBaseUrl);
		return client;
	}, []);

	const emptyHomeCoreAllowed = shouldShowEmptyHome({
		splashActive: false,
		homeForcedOpen: false,
		homeSuppressed: false,
		hasCurrentTrack: !!currentTrack,
		queueLength: queue.length,
		isPlaying,
	});
	const emptyHomeActive = shouldShowEmptyHome({
		splashActive,
		homeForcedOpen,
		homeSuppressed,
		hasCurrentTrack: !!currentTrack,
		queueLength: queue.length,
		isPlaying,
	});
	const homeControlsLocked = emptyHomeActive && homeForcedOpen && !consoleVisible && emptyHomeCoreAllowed;
	const currentLyricPreference = getCustomLyricPreferenceForTrack(currentTrack);
	const currentCustomLyricText = getCustomLyricTextForTrack(currentTrack);
	void customLyricVersion;

	const revealConsole = useCallback(() => {
		setHomeForcedOpen(false);
		setHomeSuppressed(false);
		setConsole(true);
	}, [setConsole]);

	const focusSearch = useCallback(() => {
		if (typeof document === "undefined") return;
		const input = document.getElementById("search-input");
		if (input instanceof HTMLInputElement) input.focus();
	}, []);

	const searchQuery = useCallback((query: string) => {
		setHomeSuppressed(false);
		setSearchKeyword(query);
		focusSearch();
	}, [focusSearch, setSearchKeyword]);

	const showUnavailable = useCallback((message: string) => {
		setSearchError(message);
		showToast(message);
		focusSearch();
	}, [focusSearch, setSearchError, showToast]);

	const showNotice = useCallback((message: string) => {
		showToast(message);
	}, [showToast]);

	const applyOriginalLyrics = useCallback(() => {
		const track = usePlaybackStore.getState().currentTrack;
		if (track) setCustomLyricPreferenceForTrack(track, "original");
		const original = originalLyricsPayloadRef.current;
		if (original) setLyricsPayload(original);
		setCustomLyricVersion((version) => version + 1);
		showToast("已切换到原歌词");
	}, [setLyricsPayload, showToast]);

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
		setLyricsPayload(resolved.payload);
		setCustomLyricVersion((version) => version + 1);
		return true;
	}, [setLyricsPayload]);

	const openCustomLyricModal = useCallback(() => {
		const track = usePlaybackStore.getState().currentTrack;
		if (!track) {
			showToast("先播放或选择一首歌");
			return;
		}
		const text = getCustomLyricTextForTrack(track) ?? "";
		setCustomLyricText(text);
		setCustomLyricStatus({
			text: text ? "已读取本地自定义歌词" : "提示：带 [00:12.00] 时间轴会更精准；纯文本会自动铺开",
			tone: text ? "good" : undefined,
		});
		setCustomLyricModalOpen(true);
	}, [showToast]);

	const chooseCustomLyrics = useCallback(() => {
		const track = usePlaybackStore.getState().currentTrack;
		if (!track) {
			showToast("先播放或选择一首歌");
			return;
		}
		setCustomLyricPreferenceForTrack(track, "custom");
		setCustomLyricVersion((version) => version + 1);
		if (!applyCustomLyrics(track)) openCustomLyricModal();
		else {
			showToast("已切换到自定义歌词");
			openCustomLyricModal();
		}
	}, [applyCustomLyrics, openCustomLyricModal, showToast]);

	const saveCustomLyric = useCallback(() => {
		const track = usePlaybackStore.getState().currentTrack;
		const text = (customLyricInputRef.current?.value ?? customLyricText).trim();
		if (!track) {
			setCustomLyricStatus({ text: "请先播放或选择一首歌", tone: "fail" });
			showToast("先播放或选择一首歌");
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
			text: result.saved ? `已保存 ${result.lines.length} 行，并切换为自定义歌词` : "已应用，但本地存储空间不足",
			tone: result.saved ? "good" : "fail",
		});
		showToast(result.saved ? "自定义歌词已保存" : "自定义歌词已应用");
		setCustomLyricModalOpen(false);
	}, [applyCustomLyrics, customLyricText, showToast]);

	const deleteCustomLyric = useCallback(() => {
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
		showToast("已恢复原歌词");
	}, [showToast]);

	const enterPlaybackSurface = useCallback(() => {
		setHomeForcedOpen(false);
		setHomeSuppressed(true);
		setConsole(true);
		setMiniQueue(false);
	}, [setConsole, setMiniQueue]);

	const goHome = useCallback(() => {
		if (homeForcedOpen || emptyHomeActive) {
			setHomeForcedOpen(false);
			setHomeSuppressed(true);
			setConsole(false);
			setMiniQueue(false);
			showToast("已关闭 Home");
			return;
		}
		setHomeSuppressed(false);
		setHomeForcedOpen(true);
		setConsole(false);
		setMiniQueue(false);
		focusSearch();
		showToast("已回到 Home");
	}, [emptyHomeActive, focusSearch, homeForcedOpen, setConsole, setMiniQueue, showToast]);

	const importLocalJson = useCallback(async () => {
		try {
			const result = await importJsonFile();
			if (result.cancelled) {
				showToast("本地导入需要在 Tauri 窗口中选择文件");
				return;
			}
			showToast(result.path ? `已读取 ${result.path}` : "已读取导入文件");
		} catch (e) {
			const message = e instanceof Error ? e.message : "本地导入失败";
			showToast(message);
		}
	}, [showToast]);

	const refreshUpdateStatus = useCallback(async (manual = false) => {
		try {
			if (manual) setUpdateStatus("checking");
			const result = manual ? await checkForUpdate() : await getUpdaterStatus();
			applyUpdateCheckResult(result);
			if (manual) {
				if (result.error) showToast(result.message || result.error);
				else if (result.available) showToast(result.signatureGate ? "发现新版本，签名密钥未配置" : `发现新版本 v${result.version ?? ""}`);
				else showToast("当前已是最新版本");
			}
		} catch (e) {
			setUpdateStatus("error");
			showToast(e instanceof Error ? e.message : "更新检测失败");
		}
	}, [applyUpdateCheckResult, setUpdateStatus, showToast]);

	const setProviderStatus = useCallback((status: ProviderLoginStatus) => {
		if (status.provider === "netease") setNeteaseStatus(status);
		else setQqStatus(status);
	}, []);

	const providerLabel = useCallback((provider: ProviderId) => provider === "netease" ? "网易云" : "QQ 音乐", []);

	const refreshShelfPlaylists = useCallback(async (client: SidecarClient | null) => {
		if (!client) {
			setShelfPlaylists([]);
			return;
		}
		const results = await Promise.allSettled([
			client.playlistList("netease"),
			client.playlistList("qq"),
		]);
		setShelfPlaylists(results.flatMap((result) => result.status === "fulfilled" ? result.value : []));
	}, []);

	const refreshProviderStatus = useCallback(async (provider: ProviderId) => {
		const client = sidecarClient;
		if (!client) {
			showToast("sidecar 未连接，稍后再试");
			return;
		}
		try {
			const status = await client.loginStatus(provider);
			setProviderStatus(status);
			void refreshShelfPlaylists(client);
			const label = providerLabel(provider);
			showToast(status.loggedIn ? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}` : `${label}未登录`);
		} catch (e) {
			const message = e instanceof Error ? e.message : "登录状态读取失败";
			showToast(message);
		}
	}, [providerLabel, refreshShelfPlaylists, setProviderStatus, showToast, sidecarClient]);

	const openLoginModal = useCallback(() => {
		setLoginModalOpen(true);
		void refreshProviderStatus("netease");
		void refreshProviderStatus("qq");
	}, [refreshProviderStatus]);

	const openHomeLibrary = useCallback(() => {
		if (neteaseStatus?.loggedIn || qqStatus?.loggedIn) {
			searchQuery("我的歌单");
			showToast("正在用账号歌单关键词打开搜索入口");
			return;
		}
		openLoginModal();
		showToast("登录后同步歌单库");
	}, [neteaseStatus?.loggedIn, openLoginModal, qqStatus?.loggedIn, searchQuery, showToast]);

	const closeLoginModal = useCallback(() => {
		setLoginModalOpen(false);
		if (neteaseCookieInputRef.current) neteaseCookieInputRef.current.value = "";
		if (qqCookieInputRef.current) qqCookieInputRef.current.value = "";
	}, []);

	const importProviderCookie = useCallback(async (provider: ProviderId) => {
		const client = sidecarClient;
		const input = provider === "netease" ? neteaseCookieInputRef.current : qqCookieInputRef.current;
		const cookie = input?.value.trim() ?? "";
		const label = providerLabel(provider);
		if (!client) {
			showToast("sidecar 未连接，稍后再试");
			return;
		}
		if (!cookie) {
			showToast(`请粘贴${label} cookie`);
			return;
		}
		try {
			await client.setProviderSessionCookie(provider, cookie);
			if (input) input.value = "";
			const status = await client.loginStatus(provider);
			setProviderStatus(status);
			void refreshShelfPlaylists(client);
			showToast(status.loggedIn ? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}` : `${label}会话已保存，但账号态未确认`);
		} catch (e) {
			if (input) input.value = "";
			const message = e instanceof Error ? e.message : "手动导入失败";
			showToast(message);
		}
	}, [providerLabel, refreshShelfPlaylists, setProviderStatus, showToast, sidecarClient]);

	const openProviderWebLogin = useCallback(async (provider: ProviderId) => {
		const client = sidecarClient;
		const label = providerLabel(provider);
		if (!client) {
			showToast("sidecar 未连接，稍后再试");
			return;
		}
		try {
			const result = await openProviderLoginWindow(provider);
			if (!result.stored) {
				showToast(`${label}登录未完成`);
				return;
			}
			const status = await client.loginStatus(provider);
			setProviderStatus(status);
			void refreshShelfPlaylists(client);
			const suffix = provider === "qq" && result.partial ? "，播放授权不完整，部分歌曲会自动换源" : "";
			showToast(status.loggedIn ? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}${suffix}` : `${label}会话已保存，但账号态未确认`);
		} catch (e) {
			const message = e instanceof Error ? e.message : `${label}登录失败`;
			showToast(message);
		}
	}, [providerLabel, refreshShelfPlaylists, setProviderStatus, showToast, sidecarClient]);

	const logoutProvider = useCallback(async (provider: ProviderId) => {
		const client = sidecarClient;
		const label = providerLabel(provider);
		if (!client) {
			showToast("sidecar 未连接，稍后再试");
			return;
		}
		try {
			await client.logout(provider);
			setProviderStatus({ provider, loggedIn: false });
			void refreshShelfPlaylists(client);
			showToast(`${label}会话已清除`);
		} catch (e) {
			const message = e instanceof Error ? e.message : "退出登录失败";
			showToast(message);
		}
	}, [providerLabel, refreshShelfPlaylists, setProviderStatus, showToast, sidecarClient]);

	const togglePlayback = useCallback(() => {
		if (!usePlaybackStore.getState().currentTrack) {
			showToast("先搜索或打开歌单选择一首歌");
			return;
		}
		const controller = controllerRef.current;
		if (!controller) {
			togglePlay();
			return;
		}
		if (usePlaybackStore.getState().isPlaying) controller.pause();
		else void controller.play();
	}, [showToast, togglePlay]);

	const playMiniQueueIndex = useCallback((index: number) => {
		playQueueAt(index);
		setMiniQueue(false);
	}, [playQueueAt, setMiniQueue]);

	const insertMiniQueueNext = useCallback((index: number) => {
		const track = usePlaybackStore.getState().queue[index];
		if (!track) return;
		insertQueueNext(track);
		showToast(`已设为下一首: ${track.title}`);
	}, [insertQueueNext, showToast]);

	const seekPlayback = useCallback((position: number) => {
		controllerRef.current?.seek(position);
		setPositionMs(position);
	}, [setPositionMs]);

	const updateShelfMode = useCallback((mode: ShelfMode) => {
		setShelfMode(mode);
		saveShelfSettingsToStorage();
	}, [setShelfMode]);

	const updateShelfCameraMode = useCallback((mode: ShelfCameraMode) => {
		setShelfCameraMode(mode);
		saveShelfSettingsToStorage();
		showToast(mode === "static" ? "3D歌单架: 静态镜头" : "3D歌单架: 动态镜头");
	}, [setShelfCameraMode, showToast]);

	const updateShelfPresence = useCallback((presence: ShelfPresence) => {
		setShelfPresence(presence);
		saveShelfSettingsToStorage();
		showToast(presence === "always" ? "3D歌单架: 常驻" : "3D歌单架: 自动隐藏");
	}, [setShelfPresence, showToast]);

	const setPlaybackQuality = useCallback((quality: PlaybackQuality) => {
		setPlaybackQualityState(quality);
		savePlaybackQualityPreference(quality);
		if (!usePlaybackStore.getState().currentTrack) {
			showToast("音质偏好已保存，下次播放生效");
			return;
		}
		const resumeAt = controllerRef.current ? usePlaybackStore.getState().positionMs : 0;
		if (resumeAt > 0) controllerRef.current?.pause();
		lastLoadedKeyRef.current = "";
		playbackRequestSeqRef.current += 1;
		setPositionMs(resumeAt);
		setPlaybackQualityReloadSeq((seq) => seq + 1);
		showToast("正在切换音质");
	}, [setPositionMs, showToast]);

	const currentDesktopLyricText = useCallback(() => {
		const payload = useLyricsStore.getState().payload;
		const position = usePlaybackStore.getState().positionMs;
		const index = selectCurrentIndex(position, payload);
		const line = index >= 0 ? payload?.lines[index] : null;
		const text = line?.text?.trim();
		if (text) return text;
		const track = usePlaybackStore.getState().currentTrack;
		return track ? `${track.title} - ${track.artists.join(" / ")}` : "";
	}, []);

	const toggleDesktopLyrics = useCallback(async () => {
		if (desktopLyricsEnabled) {
			await closeDesktopLyricsWindow();
			setDesktopLyricsEnabled(false);
			return;
		}
		const playback = usePlaybackStore.getState();
		const duration = playback.durationMs ?? 0;
		const text = currentDesktopLyricText();
		await updateDesktopLyricsPayload({
			enabled: true,
			text,
			progress: duration > 0 ? Math.min(1, Math.max(0, playback.positionMs / duration)) : 0,
		});
		await showDesktopLyricsWindow();
		setDesktopLyricsEnabled(true);
	}, [currentDesktopLyricText, desktopLyricsEnabled]);

	const executeGlobalHotkeyAction = useCallback((action: string) => {
		switch (action) {
			case "togglePlay":
				togglePlayback();
				break;
			case "prevTrack":
				previousTrack();
				break;
			case "nextTrack":
				nextTrack();
				break;
			case "volumeUp":
				setVolume(usePlaybackStore.getState().volume + 0.05);
				break;
			case "volumeDown":
				setVolume(usePlaybackStore.getState().volume - 0.05);
				break;
			case "toggleFullscreen":
				void toggleWindowFullscreen();
				break;
			case "toggleDesktopLyrics":
				void toggleDesktopLyrics();
				break;
			default:
				break;
		}
	}, [nextTrack, previousTrack, setVolume, toggleDesktopLyrics, togglePlayback]);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		void configureGlobalHotkeys(DEFAULT_GLOBAL_HOTKEYS);
		void listenGlobalHotkey((payload) => {
			if (!disposed && payload?.action) executeGlobalHotkeyAction(payload.action);
		}).then((dispose) => {
			if (disposed) dispose();
			else unlisten = dispose;
		});
		return () => {
			disposed = true;
			unlisten?.();
			void configureGlobalHotkeys([]);
		};
	}, [executeGlobalHotkeyAction]);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;
		void getWindowState().then((state) => {
			if (!disposed) applyDesktopWindowShellState(state);
		});
		void listenWindowState((state) => {
			if (!disposed) applyDesktopWindowShellState(state);
		}).then((dispose) => {
			if (disposed) dispose();
			else unlisten = dispose;
		});
		return () => {
			disposed = true;
			unlisten?.();
			if (typeof document !== "undefined") {
				document.documentElement.classList.remove("desktop-shell-root");
				document.body.classList.remove("desktop-shell", "desktop-maximized", "desktop-fullscreen");
			}
		};
	}, []);

	useEffect(() => {
		if (typeof document === "undefined") return;
		document.body.classList.toggle("splash-active", splashActive);
		document.body.classList.toggle("empty-home-active", emptyHomeActive);
		document.body.classList.toggle("controls-visible", consoleVisible);
		document.body.classList.toggle("home-wallpaper-preview", emptyHomeActive);
		document.body.classList.toggle("home-controls-locked", homeControlsLocked);
		return () => {
			document.body.classList.remove("splash-active", "empty-home-active", "controls-visible", "home-wallpaper-preview", "home-controls-locked");
		};
	}, [consoleVisible, emptyHomeActive, homeControlsLocked, splashActive]);

	useEffect(() => {
		const settings = loadShelfSettingsFromStorage();
		if (settings) applyShelfSettings(settings);
	}, [applyShelfSettings]);

	useEffect(() => {
		if (typeof document === "undefined") return;
		const stageMode = shelfMode === "stage";
		document.getElementById("search-area")?.classList.toggle("stage-mode", stageMode);
		document.getElementById("bottom-bar")?.classList.toggle("stage-mode", stageMode);
	}, [shelfMode]);

	useEffect(() => {
		if (!emptyHomeActive || typeof document === "undefined") return;
		const onBlankClick = (event: MouseEvent) => {
			if (!isHomeBlankDismissElement(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			setHomeForcedOpen(false);
			setHomeSuppressed(true);
			setConsole(false);
			setMiniQueue(false);
		};
		document.addEventListener("click", onBlankClick, true);
		return () => document.removeEventListener("click", onBlankClick, true);
	}, [emptyHomeActive, setConsole, setMiniQueue]);

	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => clearToast(), 2600);
		return () => clearTimeout(timer);
	}, [clearToast, toast]);

	useEffect(() => {
		void refreshUpdateStatus(false);
	}, [refreshUpdateStatus]);

	useEffect(() => {
		if (!desktopLyricsEnabled) return;
		void updateDesktopLyricsPayload({
			enabled: true,
			text: currentDesktopLyricText(),
			progress: (durationMs ?? 0) > 0 ? Math.min(1, Math.max(0, positionMs / (durationMs ?? 1))) : 0,
		});
	}, [currentDesktopLyricText, desktopLyricsEnabled, durationMs, lyricsPayload, positionMs]);

	useEffect(() => {
		if (!sidecarBaseUrl) return;
		let cancelled = false;
		let pollTimer: ReturnType<typeof setTimeout> | null = null;
		let clearRecoveredTimer: ReturnType<typeof setTimeout> | null = null;

		async function pollStatus(): Promise<void> {
			try {
				const status = await getSidecarStatus();
				if (cancelled) return;
				setSidecarRecoveryState((previous) => {
					const next = deriveSidecarRecoveryNoticeState(status, previous);
					if (next.recovered) {
						if (clearRecoveredTimer) clearTimeout(clearRecoveredTimer);
						clearRecoveredTimer = setTimeout(() => {
							setSidecarRecoveryState((current) => current?.recovered ? { ...current, recovered: false } : current);
						}, SIDECAR_RECOVERED_NOTICE_MS);
					}
					return next;
				});
			} finally {
				if (!cancelled) {
					pollTimer = setTimeout(() => {
						void pollStatus();
					}, SIDECAR_STATUS_POLL_MS);
				}
			}
		}

		void pollStatus();
		return () => {
			cancelled = true;
			if (pollTimer) clearTimeout(pollTimer);
			if (clearRecoveredTimer) clearTimeout(clearRecoveredTimer);
		};
	}, [sidecarBaseUrl]);

	useEffect(() => {
		if (!miniQueueOpen || typeof document === "undefined") return;
		const closeOnPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Element && target.closest("#bottom-bar")) return;
			setMiniQueue(false);
		};
		document.addEventListener("pointerdown", closeOnPointerDown);
		return () => document.removeEventListener("pointerdown", closeOnPointerDown);
	}, [miniQueueOpen, setMiniQueue]);

	useEffect(() => {
		controllerRef.current?.setVolume(muted ? 0 : volume);
	}, [muted, volume]);

	useEffect(() => {
		cancelledRef.current = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		async function boot(): Promise<void> {
			let cfg: RuntimeConfig;
			try {
				cfg = await getRuntimeConfig();
			} catch {
				cfg = placeholderRuntimeConfig();
			}
			if (cancelledRef.current) return;

			if (!cfg.sidecarBaseUrl) {
				console.warn("sidecar base url not configured", {
					code: "NO_RUNTIME",
					message: "sidecar base url not configured",
				});
				return;
			}

			const client = initSidecar(cfg);
			let attempts = 0;

			async function poll(): Promise<void> {
				try {
					await client.health();
					if (cancelledRef.current) return;
					try {
						const caps = await client.capabilities();
						if (!cancelledRef.current) setMatrix(caps);
					} catch {
						// 能力矩阵仅用于运行期同步，失败不阻断视觉宿主。
					}
					if (!cancelledRef.current) void refreshShelfPlaylists(client);
				} catch (e) {
					if (cancelledRef.current) return;
					attempts += 1;
					if (e instanceof SidecarClientError) {
						console.warn("sidecar health failed", { code: e.code, message: e.message });
					} else {
						console.warn("sidecar health failed", { code: "UNKNOWN", message: "unknown error" });
					}
					if (attempts < 5) {
						timer = setTimeout(() => {
							void poll();
						}, 800);
					}
				}
			}

			void poll();
		}

		void boot();
		return () => {
			cancelledRef.current = true;
			if (timer) clearTimeout(timer);
		};
	}, [initSidecar, refreshShelfPlaylists, setMatrix]);

	useEffect(() => {
		if (!audioElementSupported()) return;
		if (controllerRef.current) return;
		const audio = new Audio();
		audio.preload = "metadata";
		audioRef.current = audio;
		const controller = new PlayerController(audio);
		const playback = usePlaybackStore.getState();
		controller.setVolume(playback.muted ? 0 : playback.volume);
		controllerRef.current = controller;

		let lastDuration: number | null = null;

		controller.on("timeupdate", (payload) => {
			setPositionMs(payload.positionMs);
			if (payload.durationMs !== null && payload.durationMs !== lastDuration) {
				lastDuration = payload.durationMs;
				setDurationMs(payload.durationMs);
			}
			const idx = selectCurrentIndex(payload.positionMs, lyricsPayloadRef.current);
			setLyricsIndex(idx);
		});
		controller.on("durationchange", (payload) => {
			if (payload.durationMs !== null) {
				setDurationMs(payload.durationMs);
			}
		});
		controller.on("play", () => {
			setPlaying(true);
		});
		controller.on("pause", () => {
			setPlaying(false);
		});
		controller.on("ended", () => {
			setPositionMs(0);
			usePlaybackStore.getState().ended();
			if (usePlaybackStore.getState().mode === "single" && controllerRef.current) {
				controllerRef.current.seek(0);
				void controllerRef.current.play();
			}
		});
		controller.on("error", (payload) => {
			const message = payload.message || "音频播放失败";
			setSearchError(message);
			showToast(message);
			console.warn("audio playback failed", { code: `AUDIO_${payload.code}`, message });
		});
		return () => {
			controllerRef.current = null;
			audioRef.current = null;
		};
	}, [setDurationMs, setLyricsIndex, setPlaying, setPositionMs, setSearchError, showToast]);

	useEffect(() => {
		const controller = controllerRef.current;
		const client = sidecarClient;
		if (!controller || !client) return;
		if (!currentTrack) {
			lastLoadedKeyRef.current = "";
			playbackRequestSeqRef.current += 1;
			controller.pause();
			lyricsReset();
			return;
		}
		const key = `${currentTrack.provider}:${currentTrack.id}`;
		if (key === lastLoadedKeyRef.current) return;
		lastLoadedKeyRef.current = key;
		const seq = playbackRequestSeqRef.current + 1;
		playbackRequestSeqRef.current = seq;

		void (async () => {
			try {
				const result = await client.resolveSongUrl(currentTrack, playbackQuality);
				if (playbackRequestSeqRef.current !== seq) return;
				const audioUrl = result.proxied ? result.url : client.audioProxyUrl(result.url);
				controller.load(audioUrl);
				if (positionRef.current > 0) controller.seek(positionRef.current);
				await controller.play();
				if (playbackRequestSeqRef.current !== seq) return;
				setHomeForcedOpen(false);
				setHomeSuppressed(true);
			} catch (e) {
				if (playbackRequestSeqRef.current !== seq) return;
				const code = e instanceof SidecarClientError ? e.code : "AUDIO_UNKNOWN";
				const message = e instanceof Error ? e.message : "playback error";
				setPlaying(false);
				setSearchError(message);
				showToast(message);
				console.warn("playback load failed", { code, message });
			}
			try {
				setLyricsLoading(true);
				const lyric = await client.lyric(currentTrack);
				if (playbackRequestSeqRef.current !== seq) return;
				originalLyricsPayloadRef.current = lyric;
				const resolvedLyric = resolveLyricsForTrack({
					track: currentTrack,
					original: lyric,
					durationMs: usePlaybackStore.getState().durationMs ?? currentTrack.durationMs,
				});
				setLyricsPayload(resolvedLyric.payload);
			} catch (e) {
				if (playbackRequestSeqRef.current !== seq) return;
				const message = e instanceof Error ? e.message : "lyrics failed";
				setLyricsError(message);
			}
		})();
	}, [currentTrack, playbackQuality, playbackQualityReloadSeq, sidecarClient, setLyricsError, setLyricsLoading, setLyricsPayload, setPlaying, setSearchError, showToast, lyricsReset]);

	return (
		<>
			{SHOW_SPLASH && splashActive && (
				<SplashComponent
					onDismissed={() => setSplashActive(false)}
				/>
			)}
			<VisualComponent
				audioElementRef={audioRef}
				controllerRef={controllerRef}
				lyricsPayload={lyricsPayload}
				positionMs={positionMs}
				isPlaying={isPlaying}
				queue={queue}
				playlists={shelfPlaylists}
				currentTrack={currentTrack}
				currentCoverUrl={currentTrack?.coverUrl}
				sidecarBaseUrl={sidecarBaseUrl}
				coverResolution={1.55}
				shelfSettings={{
					mode: shelfMode,
					cameraMode: shelfCameraMode,
					presence: shelfPresence,
				}}
				splashActive={splashActive}
				homeActive={emptyHomeActive}
				onShelfModeChange={updateShelfMode}
				onShelfPlayQueueIndex={(index) => usePlaybackStore.getState().playAt(index)}
				onShelfDetailRowClick={handleShelfDetailRowAction}
				onShelfOpenDetailContent={(payload, contentList) => {
					const loader = createShelfDetailContentLoader({
						client: sidecarClient,
						getContentList: () => contentList,
					});
					void loader(payload);
				}}
			/>
			<EmptyHomeHost
				onSearchFocus={focusSearch}
				onOpenLibrary={openHomeLibrary}
				onOpenConsole={revealConsole}
				onSearchQuery={searchQuery}
				onUpload={() => void importLocalJson()}
				onGuide={() => {
					revealConsole();
					showToast("视觉引导已打开播放器控制台，播放后会进入粒子与歌词舞台");
				}}
			/>
			<SearchShell client={sidecarClient} onFocus={focusSearch} onUpload={() => void importLocalJson()} onResultPlay={enterPlaybackSurface} />
			<TopRightControls
				onHome={goHome}
				onLogin={openLoginModal}
				onHideCapsule={() => showUnavailable("账号胶囊自动隐藏已记录，登录完成后生效")}
				loggedIn={!!neteaseStatus?.loggedIn || !!qqStatus?.loggedIn}
				accountLabel={neteaseStatus?.nickname ?? qqStatus?.nickname ?? neteaseStatus?.userId ?? qqStatus?.userId ?? undefined}
				updateSlot={(
					<div id="update-shell">
						<UpdateHost
							state={updateState}
							open={updateModalOpen}
							onOpen={() => setUpdateModalOpen(true)}
							onClose={() => setUpdateModalOpen(false)}
							onCheck={() => void refreshUpdateStatus(true)}
						/>
					</div>
				)}
			/>
			<BottomControlsHost
				visible={consoleVisible}
				onReveal={revealConsole}
				onTogglePlay={togglePlayback}
				onPrevious={previousTrack}
				onNext={nextTrack}
				onModeChange={setPlaybackMode}
				onQueue={toggleMiniQueue}
				onLyrics={() => showNotice(lyricsPayload ? "歌词已载入舞台层" : "播放歌曲后会自动加载歌词")}
				onLyricSourceChange={(mode) => {
					if (mode === "custom") chooseCustomLyrics();
					else applyOriginalLyrics();
				}}
				onOpenCustomLyrics={openCustomLyricModal}
				onClose={() => {
					setConsole(false);
					setMiniQueue(false);
				}}
				onNotice={showNotice}
				onSeek={seekPlayback}
				onVolumeChange={setVolume}
				onToggleMute={toggleMute}
				onQualityChange={setPlaybackQuality}
				onShelfModeChange={updateShelfMode}
				onShelfCameraModeChange={updateShelfCameraMode}
				onShelfPresenceChange={updateShelfPresence}
				onPlayQueueIndex={playMiniQueueIndex}
				onRemoveQueueIndex={removeQueueAt}
				onInsertQueueNext={insertMiniQueueNext}
				onMinimize={() => void minimizeWindow()}
				onToggleMaximize={() => void toggleWindowMaximize()}
				onToggleFullscreen={() => void toggleWindowFullscreen()}
				mode={playbackMode}
				isPlaying={isPlaying}
				currentTitle={currentTrack?.title}
				currentArtist={currentTrack?.artists.join(" / ")}
				currentCoverUrl={currentTrack?.coverUrl}
				queue={queue}
				currentTrack={currentTrack}
				miniQueueOpen={miniQueueOpen}
				positionMs={positionMs}
				durationMs={durationMs}
				volume={volume}
				muted={muted}
				playbackQuality={playbackQuality}
				shelfMode={shelfMode}
				shelfCameraMode={shelfCameraMode}
				shelfPresence={shelfPresence}
				lyricSourceMode={currentLyricPreference === "custom" ? "custom" : "original"}
				hasCustomLyric={!!currentCustomLyricText}
			/>
			{sidecarRecoveryState ? <SidecarRecoveryNotice state={sidecarRecoveryState} /> : null}
			{customLyricModalOpen ? (
				<div id="custom-lyric-modal" className="modal-mask show" role="presentation" onClick={(event) => {
					if (event.target === event.currentTarget) setCustomLyricModalOpen(false);
				}}>
					<div className="modal custom-lyric-modal" role="dialog" aria-modal="true" aria-labelledby="custom-lyric-heading">
						<h2 id="custom-lyric-heading">自定义歌词</h2>
						<div className="custom-lyric-track">
							<div id="custom-lyric-title" className="custom-lyric-title">{currentTrack?.title ?? "当前歌曲"}</div>
							<div id="custom-lyric-sub" className="custom-lyric-sub">
								{(currentTrack?.artists.join(" / ") || "") + (currentCustomLyricText ? " · 已保存自定义歌词" : " · 可粘贴 LRC 或逐行输入")}
							</div>
						</div>
						<textarea
							ref={customLyricInputRef}
							id="custom-lyric-input"
							className="custom-lyric-input"
							spellCheck={false}
							defaultValue={customLyricText}
							placeholder={"[00:12.00] 第一行歌词\n[00:16.50] 第二行歌词\n\n没有时间轴也可以，每一行会按歌曲时长自动铺开"}
							onChange={(event) => setCustomLyricText(event.currentTarget.value)}
						/>
						<div id="custom-lyric-status" className={`custom-lyric-status ${customLyricStatus.tone ?? ""}`.trim()}>{customLyricStatus.text}</div>
						<div className="btn-row">
							<button className="modal-btn" type="button" onClick={deleteCustomLyric}>删除</button>
							<button className="modal-btn" type="button" onClick={() => setCustomLyricModalOpen(false)}>关闭</button>
							<button id="custom-lyric-save" className="modal-btn primary" type="button" onClick={saveCustomLyric}>保存使用</button>
						</div>
					</div>
				</div>
			) : null}
			{loginModalOpen ? (
				<div id="login-modal" className="modal-mask show" role="presentation" onClick={(event) => {
					if (event.target === event.currentTarget) closeLoginModal();
				}}>
					<div className="modal dual-login-modal" role="dialog" aria-modal="true" aria-labelledby="login-modal-title">
						<h2 id="login-modal-title">音乐账号</h2>
						<div id="login-modal-desc" className="desc">
							手动导入 cookie 只会发送到本机 sidecar 运行时会话，不会写入前端状态、仓库或 diagnostics。
						</div>
						<div className="manual-cookie-grid">
							<div className="manual-cookie-panel">
								<div className="manual-cookie-title">网易云</div>
								<textarea ref={neteaseCookieInputRef} id="netease-cookie-input" className="manual-cookie-input" spellCheck={false} autoComplete="off" placeholder="MUSIC_U=...; __csrf=..." />
								<div className="account-status-line">
									{neteaseStatus?.loggedIn ? `已登录 ${neteaseStatus.nickname ?? neteaseStatus.userId ?? ""}` : "未确认登录"}
								</div>
								<div className="account-mini-actions">
									<button className="modal-btn primary" type="button" onClick={() => void openProviderWebLogin("netease")}>网页登录</button>
									<button className="modal-btn" type="button" onClick={() => void refreshProviderStatus("netease")}>刷新</button>
									<button className="modal-btn" type="button" onClick={() => void logoutProvider("netease")}>退出</button>
									<button className="modal-btn" type="button" onClick={() => void importProviderCookie("netease")}>导入</button>
								</div>
							</div>
							<div className="manual-cookie-panel">
								<div className="manual-cookie-title">QQ 音乐</div>
								<textarea ref={qqCookieInputRef} id="qq-cookie-input" className="manual-cookie-input" spellCheck={false} autoComplete="off" placeholder="uin=...; qm_keyst=...; qqmusic_key=..." />
								<div className="account-status-line">
									{qqStatus?.loggedIn ? `已登录 ${qqStatus.nickname ?? qqStatus.userId ?? ""}` : "未确认登录"}
								</div>
								<div className="account-mini-actions">
									<button className="modal-btn primary" type="button" onClick={() => void openProviderWebLogin("qq")}>扫码登录</button>
									<button className="modal-btn" type="button" onClick={() => void refreshProviderStatus("qq")}>刷新</button>
									<button className="modal-btn" type="button" onClick={() => void logoutProvider("qq")}>退出</button>
									<button className="modal-btn" type="button" onClick={() => void importProviderCookie("qq")}>导入</button>
								</div>
							</div>
						</div>
						<div className="btn-row">
							<button className="modal-btn" type="button" onClick={closeLoginModal}>关闭</button>
						</div>
					</div>
				</div>
			) : null}
			<div id="toast" className={toast ? "show" : ""} role="status" aria-live="polite">{toast ?? ""}</div>
		</>
	);
}

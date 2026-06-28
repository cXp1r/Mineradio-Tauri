import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { SidecarClient, SidecarClientError } from "../api/sidecar-client";
import { PlayerController } from "../audio/player-controller";
import { selectCurrentIndex } from "../lyrics/select-current-index";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { useProviderStore } from "../stores/provider-store";
import { useSearchStore } from "../stores/search-store";
import { useUiStore } from "../stores/ui-store";
import { getRuntimeConfig, importJsonFile, type RuntimeConfig } from "../tauri/runtime";
import { BottomControlsHost } from "../components/shell/BottomControlsHost";
import { SearchShell } from "../components/shell/SearchShell";
import { TopRightControls } from "../components/shell/TopRightControls";
import { EmptyHomeHost } from "../home/EmptyHomeHost";
import { SplashHost, type SplashHostProps } from "../visual/SplashHost";
import { VisualEngineHost } from "../visual/VisualEngineHost";
import { createShelfDetailContentLoader, playShelfDetailRow } from "../visual/shelf-detail-data";
import type { ProviderId, ProviderLoginStatus } from "@mineradio/shared";

const SHOW_SPLASH = import.meta.env.VITE_SPLASH !== "0";

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

export type AppProps = {
	SplashComponent?: (props: SplashHostProps) => ReactElement | null;
};

export function App({ SplashComponent = SplashHost }: AppProps = {}): ReactElement {
	const [sidecarClient, setSidecarClient] = useState<SidecarClient | null>(null);
	const [splashActive, setSplashActive] = useState<boolean>(SHOW_SPLASH);
	const [loginModalOpen, setLoginModalOpen] = useState(false);
	const [neteaseStatus, setNeteaseStatus] = useState<ProviderLoginStatus | null>(null);
	const [qqStatus, setQqStatus] = useState<ProviderLoginStatus | null>(null);
	const [homeForcedOpen, setHomeForcedOpen] = useState(false);
	const [homeSuppressed, setHomeSuppressed] = useState(false);

	const currentTrack = usePlaybackStore((s) => s.currentTrack);
	const queue = usePlaybackStore((s) => s.queue);
	const isPlaying = usePlaybackStore((s) => s.isPlaying);
	const positionMs = usePlaybackStore((s) => s.positionMs);
	const durationMs = usePlaybackStore((s) => s.durationMs);
	const volume = usePlaybackStore((s) => s.volume);
	const muted = usePlaybackStore((s) => s.muted);
	const setMatrix = useProviderStore((s) => s.setMatrix);
	const consoleVisible = useUiStore((s) => s.consoleVisible);
	const setConsole = useUiStore((s) => s.setConsole);
	const miniQueueOpen = useUiStore((s) => s.miniQueueOpen);
	const setMiniQueue = useUiStore((s) => s.setMiniQueue);
	const toggleMiniQueue = useUiStore((s) => s.toggleMiniQueue);
	const toast = useUiStore((s) => s.toast);
	const showToast = useUiStore((s) => s.showToast);
	const clearToast = useUiStore((s) => s.clearToast);

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

	const positionRef = useRef(positionMs);
	positionRef.current = positionMs;
	const lyricsPayloadRef = useRef(lyricsPayload);
	lyricsPayloadRef.current = lyricsPayload;

	const initSidecar = useCallback((cfg: RuntimeConfig) => {
		const client = new SidecarClient(cfg.sidecarBaseUrl);
		setSidecarClient(client);
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

	const setProviderStatus = useCallback((status: ProviderLoginStatus) => {
		if (status.provider === "netease") setNeteaseStatus(status);
		else setQqStatus(status);
	}, []);

	const providerLabel = useCallback((provider: ProviderId) => provider === "netease" ? "网易云" : "QQ 音乐", []);

	const refreshProviderStatus = useCallback(async (provider: ProviderId) => {
		const client = sidecarClient;
		if (!client) {
			showToast("sidecar 未连接，稍后再试");
			return;
		}
		try {
			const status = await client.loginStatus(provider);
			setProviderStatus(status);
			const label = providerLabel(provider);
			showToast(status.loggedIn ? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}` : `${label}未登录`);
		} catch (e) {
			const message = e instanceof Error ? e.message : "登录状态读取失败";
			showToast(message);
		}
	}, [providerLabel, setProviderStatus, showToast, sidecarClient]);

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
			showToast(status.loggedIn ? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}` : `${label}会话已保存，但账号态未确认`);
		} catch (e) {
			if (input) input.value = "";
			const message = e instanceof Error ? e.message : "手动导入失败";
			showToast(message);
		}
	}, [providerLabel, setProviderStatus, showToast, sidecarClient]);

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
			showToast(`${label}会话已清除`);
		} catch (e) {
			const message = e instanceof Error ? e.message : "退出登录失败";
			showToast(message);
		}
	}, [providerLabel, setProviderStatus, showToast, sidecarClient]);

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
	}, [initSidecar, setMatrix]);

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
				const result = await client.resolveSongUrl(currentTrack);
				if (playbackRequestSeqRef.current !== seq) return;
				const audioUrl = result.proxied ? result.url : client.audioProxyUrl(result.url);
				controller.load(audioUrl);
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
				setLyricsPayload(lyric);
			} catch (e) {
				if (playbackRequestSeqRef.current !== seq) return;
				const message = e instanceof Error ? e.message : "lyrics failed";
				setLyricsError(message);
			}
		})();
	}, [currentTrack, sidecarClient, setLyricsError, setLyricsLoading, setLyricsPayload, setPlaying, setSearchError, showToast, lyricsReset]);

	return (
		<>
			{SHOW_SPLASH && splashActive && (
				<SplashComponent
					onDismissed={() => setSplashActive(false)}
				/>
			)}
			<VisualEngineHost
				audioElementRef={audioRef}
				controllerRef={controllerRef}
				lyricsPayload={lyricsPayload}
				positionMs={positionMs}
				isPlaying={isPlaying}
				queue={queue}
				currentTrack={currentTrack}
				coverResolution={1.55}
				splashActive={splashActive}
				homeActive={emptyHomeActive}
				onShelfPlayQueueIndex={(index) => usePlaybackStore.getState().playAt(index)}
				onShelfDetailRowClick={playShelfDetailRow}
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
				onClose={() => {
					setConsole(false);
					setMiniQueue(false);
				}}
				onNotice={showNotice}
				onSeek={seekPlayback}
				onVolumeChange={setVolume}
				onToggleMute={toggleMute}
				onPlayQueueIndex={playMiniQueueIndex}
				onRemoveQueueIndex={removeQueueAt}
				onInsertQueueNext={insertMiniQueueNext}
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
			/>
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
									<button className="modal-btn" type="button" onClick={() => void refreshProviderStatus("netease")}>刷新</button>
									<button className="modal-btn" type="button" onClick={() => void logoutProvider("netease")}>退出</button>
									<button className="modal-btn primary" type="button" onClick={() => void importProviderCookie("netease")}>导入</button>
								</div>
							</div>
							<div className="manual-cookie-panel">
								<div className="manual-cookie-title">QQ 音乐</div>
								<textarea ref={qqCookieInputRef} id="qq-cookie-input" className="manual-cookie-input" spellCheck={false} autoComplete="off" placeholder="uin=...; qm_keyst=...; qqmusic_key=..." />
								<div className="account-status-line">
									{qqStatus?.loggedIn ? `已登录 ${qqStatus.nickname ?? qqStatus.userId ?? ""}` : "未确认登录"}
								</div>
								<div className="account-mini-actions">
									<button className="modal-btn" type="button" onClick={() => void refreshProviderStatus("qq")}>刷新</button>
									<button className="modal-btn" type="button" onClick={() => void logoutProvider("qq")}>退出</button>
									<button className="modal-btn primary" type="button" onClick={() => void importProviderCookie("qq")}>导入</button>
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

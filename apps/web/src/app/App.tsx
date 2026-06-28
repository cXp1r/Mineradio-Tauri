import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { SidecarClient, SidecarClientError } from "../api/sidecar-client";
import { PlayerController } from "../audio/player-controller";
import { selectCurrentIndex } from "../lyrics/select-current-index";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { useProviderStore } from "../stores/provider-store";
import { useUiStore } from "../stores/ui-store";
import { getRuntimeConfig, type RuntimeConfig } from "../tauri/runtime";
import { BottomControlsHost } from "../components/shell/BottomControlsHost";
import { SearchShell } from "../components/shell/SearchShell";
import { TopRightControls } from "../components/shell/TopRightControls";
import { EmptyHomeHost } from "../home/EmptyHomeHost";
import { SplashHost } from "../visual/SplashHost";
import { VisualEngineHost } from "../visual/VisualEngineHost";
import { createShelfDetailContentLoader, playShelfDetailRow } from "../visual/shelf-detail-data";

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

export function App(): ReactElement {
	const [sidecarClient, setSidecarClient] = useState<SidecarClient | null>(null);
	const [splashActive, setSplashActive] = useState<boolean>(SHOW_SPLASH);

	const currentTrack = usePlaybackStore((s) => s.currentTrack);
	const queue = usePlaybackStore((s) => s.queue);
	const isPlaying = usePlaybackStore((s) => s.isPlaying);
	const positionMs = usePlaybackStore((s) => s.positionMs);
	const setMatrix = useProviderStore((s) => s.setMatrix);
	const consoleVisible = useUiStore((s) => s.consoleVisible);
	const setConsole = useUiStore((s) => s.setConsole);

	const lyricsPayload = useLyricsStore((s) => s.payload);
	const setLyricsPayload = useLyricsStore((s) => s.setPayload);
	const setLyricsLoading = useLyricsStore((s) => s.setLoading);
	const setLyricsError = useLyricsStore((s) => s.setError);
	const setLyricsIndex = useLyricsStore((s) => s.setCurrentIndex);
	const lyricsReset = useLyricsStore((s) => s.reset);

	const togglePlay = usePlaybackStore((s) => s.togglePlay);
	const setPositionMs = usePlaybackStore((s) => s.setPosition);
	const setDurationMs = usePlaybackStore((s) => s.setDuration);

	const cancelledRef = useRef(false);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const controllerRef = useRef<PlayerController | null>(null);
	const lastLoadedKeyRef = useRef<string>("");

	const positionRef = useRef(positionMs);
	positionRef.current = positionMs;
	const lyricsPayloadRef = useRef(lyricsPayload);
	lyricsPayloadRef.current = lyricsPayload;

	const initSidecar = useCallback((cfg: RuntimeConfig) => {
		const client = new SidecarClient(cfg.sidecarBaseUrl);
		setSidecarClient(client);
		return client;
	}, []);

	const emptyHomeActive = !splashActive && !currentTrack && queue.length === 0 && !isPlaying;

	const revealConsole = useCallback(() => {
		setConsole(true);
	}, [setConsole]);

	const focusSearch = useCallback(() => {
		if (typeof document === "undefined") return;
		const input = document.getElementById("search-input");
		if (input instanceof HTMLInputElement) input.focus();
	}, []);

	const goHome = useCallback(() => {
		setConsole(false);
		focusSearch();
	}, [focusSearch, setConsole]);

	useEffect(() => {
		if (typeof document === "undefined") return;
		document.body.classList.toggle("splash-active", splashActive);
		document.body.classList.toggle("empty-home-active", emptyHomeActive);
		document.body.classList.toggle("controls-visible", consoleVisible);
		return () => {
			document.body.classList.remove("splash-active", "empty-home-active", "controls-visible");
		};
	}, [consoleVisible, emptyHomeActive, splashActive]);

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
			if (!usePlaybackStore.getState().isPlaying) togglePlay();
		});
		controller.on("pause", () => {
			if (usePlaybackStore.getState().isPlaying) togglePlay();
		});
		controller.on("ended", () => {
			setPositionMs(0);
			usePlaybackStore.getState().next();
		});
		controller.on("error", (payload) => {
			console.warn("audio playback failed", { code: `AUDIO_${payload.code}`, message: payload.message });
		});
		return () => {
			controllerRef.current = null;
			audioRef.current = null;
		};
	}, [setDurationMs, setLyricsIndex, setPositionMs, togglePlay]);

	useEffect(() => {
		const controller = controllerRef.current;
		const client = sidecarClient;
		if (!controller || !client) return;
		if (!currentTrack) {
			lastLoadedKeyRef.current = "";
			controller.pause();
			lyricsReset();
			return;
		}
		const key = `${currentTrack.provider}:${currentTrack.id}`;
		if (key === lastLoadedKeyRef.current) return;
		lastLoadedKeyRef.current = key;

		void (async () => {
			try {
				const result = await client.songUrl(currentTrack);
				controller.load(result.url);
				await controller.play();
			} catch (e) {
				const code = e instanceof SidecarClientError ? e.code : "AUDIO_UNKNOWN";
				const message = e instanceof Error ? e.message : "playback error";
				console.warn("playback load failed", { code, message });
			}
			try {
				setLyricsLoading(true);
				const lyric = await client.lyric(currentTrack);
				setLyricsPayload(lyric);
			} catch (e) {
				const message = e instanceof Error ? e.message : "lyrics failed";
				setLyricsError(message);
			}
		})();
	}, [currentTrack, sidecarClient, setLyricsError, setLyricsLoading, setLyricsPayload, lyricsReset]);

	return (
		<>
			{SHOW_SPLASH && (
				<SplashHost
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
				onOpenLibrary={focusSearch}
				onOpenConsole={revealConsole}
			/>
			<SearchShell onFocus={focusSearch} />
			<TopRightControls onHome={goHome} />
			<BottomControlsHost visible={consoleVisible} onReveal={revealConsole} />
		</>
	);
}

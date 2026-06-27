import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { HealthResponse, ProviderId } from "@mineradio/shared";
import { SidecarClient, SidecarClientError } from "../api/sidecar-client";
import { LyricView } from "../components/lyrics/LyricView";
import { SearchPanel } from "../components/search/SearchPanel";
import { PlayerController } from "../audio/player-controller";
import { selectCurrentIndex } from "../lyrics/select-current-index";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { useProviderStore } from "../stores/provider-store";
import { getRuntimeConfig, type RuntimeConfig } from "../tauri/runtime";

type Phase = "loading" | "connected" | "error";

interface SidecarError {
	code: string;
	message: string;
}

const PROVIDER_ROWS: ProviderId[] = ["netease", "qq"];

function placeholderRuntimeConfig(): RuntimeConfig {
	return {
		sidecarBaseUrl: "",
		appDataDir: "",
		appVersion: "0.0.0-dev",
		schemaVersion: "0.1.0",
	};
}

function audioElementSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		"HTMLAudioElement" in globalThis
	);
}

export function App(): ReactElement {
	const [phase, setPhase] = useState<Phase>("loading");
	const [health, setHealth] = useState<HealthResponse | null>(null);
	const [error, setError] = useState<SidecarError | null>(null);
	const [sidecarClient, setSidecarClient] = useState<SidecarClient | null>(null);

	const currentTrack = usePlaybackStore((s) => s.currentTrack);
	const isPlaying = usePlaybackStore((s) => s.isPlaying);
	const positionMs = usePlaybackStore((s) => s.positionMs);
	const status = useProviderStore((s) => s.status);
	const matrix = useProviderStore((s) => s.matrix);
	const setMatrix = useProviderStore((s) => s.setMatrix);

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
				setPhase("error");
				setError({
					code: "NO_RUNTIME",
					message: "sidecar base url not configured",
				});
				return;
			}

			const client = initSidecar(cfg);
			let attempts = 0;

			async function poll(): Promise<void> {
				try {
					const h = await client.health();
					if (cancelledRef.current) return;
					setHealth(h);
					setPhase("connected");
					try {
						const caps = await client.capabilities();
						if (!cancelledRef.current) setMatrix(caps);
					} catch {
						// capabilities are best-effort in the shell phase
					}
				} catch (e) {
					if (cancelledRef.current) return;
					attempts += 1;
					if (e instanceof SidecarClientError) {
						setError({ code: e.code, message: e.message });
					} else {
						setError({ code: "UNKNOWN", message: "unknown error" });
					}
					if (attempts < 5) {
						timer = setTimeout(() => {
							void poll();
						}, 800);
					} else {
						setPhase("error");
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
			setError({ code: `AUDIO_${payload.code}`, message: payload.message });
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
				setError({ code, message });
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

	const lyricsSignedIndex = useMemo(
		() => selectCurrentIndex(positionMs, lyricsPayload),
		[positionMs, lyricsPayload],
	);

	function providerRow(id: ProviderId): string {
		if (status && status[id]) {
			return status[id].available
				? `available — ${status[id].message ?? "online"}`
				: `pending — ${status[id].message ?? "not available"}`;
		}
		if (matrix) {
			return "pending";
		}
		return "pending";
	}

	return (
		<main className="shell">
			<section className="status-panel">
				<p className="eyebrow">Mineradio Tauri Rewrite</p>
				<h1>Tauri Rewrite Shell</h1>
				<dl>
					<div>
						<dt>Sidecar</dt>
						<dd>
							{phase === "loading" && "loading…"}
							{phase === "connected" && health && (
								<span>
									connected · api {health.apiVersion} · schema {health.schemaVersion} · providers {health.providers.join(",") || "—"}
								</span>
							)}
							{phase === "error" && error && `${error.code}: ${error.message}`}
						</dd>
					</div>
					<div>
						<dt>Providers</dt>
						<dd>
							<ul className="provider-rows">
								{PROVIDER_ROWS.map((id) => (
									<li key={id}>
										{id}: {providerRow(id)}
									</li>
								))}
							</ul>
						</dd>
					</div>
					<div>
						<dt>Playback</dt>
						<dd>
							{currentTrack
								? `${currentTrack.title} — ${isPlaying ? "playing" : "paused"}`
								: "no track"}
						</dd>
					</div>
					<div>
						<dt>Search</dt>
						<dd>
							{sidecarClient ? (
								<SearchPanel client={sidecarClient} />
							) : (
								<span>connecting…</span>
							)}
						</dd>
					</div>
					<div>
						<dt>Lyrics</dt>
						<dd>
							<LyricView payload={lyricsPayload} positionMs={positionMs} />
							{lyricsPayload && ` · line ${lyricsSignedIndex + 1}`}
						</dd>
					</div>
					<div>
						<dt>Visual Host</dt>
						<dd>
							<div id="visual-host" className="visual-host" />
						</dd>
					</div>
				</dl>
			</section>
		</main>
	);
}
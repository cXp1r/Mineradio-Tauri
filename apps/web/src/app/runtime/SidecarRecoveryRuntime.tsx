import { useEffect, useState } from "react";
import type {
	CapabilityMatrix,
	ProviderId,
	ProviderLoginStatus,
} from "@mineradio/shared";
import type {
	ApplicationPorts,
	ApplicationRuntimePort,
} from "../../ports/application-runtime-port";
import type { ApiRuntimePort } from "../../ports/api-runtime-port";
import type { SidecarRecoveryNoticeState } from "../../components/shell/SidecarRecoveryNotice";
import {
	SIDECAR_RECOVERED_NOTICE_MS,
	SIDECAR_STATUS_POLL_MS,
	deriveSidecarRecoveryNoticeState,
	nextSidecarStatusPollDelayMs,
} from "./sidecar-recovery-policy";

export interface SidecarRecoveryRuntimeProps {
	applicationRuntime: ApplicationRuntimePort;
	loginProviders: readonly ProviderId[];
	onConnection: (ports: ApplicationPorts) => void;
	onCapabilities: (matrix: CapabilityMatrix) => void;
	onProviderStatus: (status: ProviderLoginStatus) => void;
	onRefreshLibrary: (ports: ApplicationPorts) => void;
	onRecoveryState: (state: SidecarRecoveryNoticeState) => void;
}

export function SidecarRecoveryRuntime({
	applicationRuntime,
	loginProviders,
	onConnection,
	onCapabilities,
	onProviderStatus,
	onRefreshLibrary,
	onRecoveryState,
}: SidecarRecoveryRuntimeProps) {
	const [apiRuntime, setApiRuntime] = useState<ApiRuntimePort | null>(null);

	useEffect(() => {
		let cancelled = false;
		let healthTimer: ReturnType<typeof setTimeout> | null = null;

		async function boot(): Promise<void> {
			let connectedPorts: ApplicationPorts | null;
			try {
				connectedPorts = await applicationRuntime.connect();
			} catch {
				return;
			}
			if (cancelled || !connectedPorts) return;
			const ports = connectedPorts;

			setApiRuntime(ports.apiRuntime);
			onConnection(ports);

			let attempts = 0;
			async function pollHealth(): Promise<void> {
				try {
					await ports.apiRuntime.health();
					if (cancelled) return;
					try {
						const capabilities = await ports.apiRuntime.capabilities();
						if (!cancelled) onCapabilities(capabilities);
					} catch {
						// 能力矩阵同步失败不阻断现有播放器启动。
					}
					const statusResults = await Promise.allSettled(
						loginProviders.map((provider) => (
							ports.music.accounts.loginStatus(provider)
						)),
					);
					if (cancelled) return;
					for (const result of statusResults) {
						if (result.status === "fulfilled") onProviderStatus(result.value);
					}
					onRefreshLibrary(ports);
				} catch {
					if (cancelled) return;
					attempts += 1;
					if (attempts < 5) {
						healthTimer = setTimeout(() => {
							void pollHealth();
						}, 800);
					}
				}
			}

			void pollHealth();
		}

		void boot();
		return () => {
			cancelled = true;
			if (healthTimer) clearTimeout(healthTimer);
		};
	}, [
		applicationRuntime,
		loginProviders,
		onCapabilities,
		onConnection,
		onProviderStatus,
		onRefreshLibrary,
	]);

	useEffect(() => {
		if (!apiRuntime) return;
		const runtime = apiRuntime;
		let cancelled = false;
		let pollTimer: ReturnType<typeof setTimeout> | null = null;
		let clearRecoveredTimer: ReturnType<typeof setTimeout> | null = null;
		let consecutiveReadyPolls = 0;
		let previousState: SidecarRecoveryNoticeState | null = null;

		async function pollStatus(): Promise<void> {
			let nextDelayMs = SIDECAR_STATUS_POLL_MS;
			try {
				const status = await runtime.getStatus();
				if (cancelled) return;
				const next = deriveSidecarRecoveryNoticeState(status, previousState);
				previousState = next;
				onRecoveryState(next);
				if (next.recovered) {
					if (clearRecoveredTimer) clearTimeout(clearRecoveredTimer);
					clearRecoveredTimer = setTimeout(() => {
						if (cancelled || !previousState?.recovered) return;
						previousState = { ...previousState, recovered: false };
						onRecoveryState(previousState);
					}, SIDECAR_RECOVERED_NOTICE_MS);
				}
				nextDelayMs = nextSidecarStatusPollDelayMs({
					status,
					consecutiveReadyPolls,
					documentHidden:
						typeof document !== "undefined" &&
						document.visibilityState === "hidden",
				});
				consecutiveReadyPolls = status.phase === "ready"
					? consecutiveReadyPolls + 1
					: 0;
			} catch {
				consecutiveReadyPolls = 0;
			} finally {
				if (!cancelled) {
					pollTimer = setTimeout(() => {
						void pollStatus();
					}, nextDelayMs);
				}
			}
		}

		void pollStatus();
		return () => {
			cancelled = true;
			if (pollTimer) clearTimeout(pollTimer);
			if (clearRecoveredTimer) clearTimeout(clearRecoveredTimer);
		};
	}, [apiRuntime, onRecoveryState]);

	return null;
}

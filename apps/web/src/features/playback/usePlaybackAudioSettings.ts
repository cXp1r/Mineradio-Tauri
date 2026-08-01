import {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { PreferencesRepository } from "../../ports/preferences-repository";
import {
	PLAYBACK_AUDIO_PREFERENCE,
	type PlaybackAudioPreference,
} from "../../preferences/keys";

export interface PlaybackTransitionPreferences {
	readonly fadeInMs?: number;
	readonly fadeOutMs?: number;
	readonly crossfadeMs?: number;
	readonly crossfadeEnabled?: boolean;
}

export interface PlaybackOutputRoutingConfig {
	readonly enabled?: boolean;
	readonly primarySinkId?: string | null;
	readonly mirrorSinkIds?: readonly string[];
	readonly virtualBridgeSinkId?: string | null;
}

export interface PlaybackOutputRoutingError {
	readonly target: "primary" | "mirror" | "context";
	readonly sinkId: string;
	readonly name: string;
	readonly message: string;
}

export interface PlaybackOutputRoutingSnapshot {
	readonly enabled: boolean;
	readonly requestedPrimarySinkId: string;
	readonly effectivePrimarySinkId: string;
	readonly mirrorSinkIds: readonly string[];
	readonly virtualBridgeSinkId: string;
	readonly fellBackToDefault: boolean;
	readonly errors: readonly PlaybackOutputRoutingError[];
}

export interface PlaybackAudioOutputDevice {
	readonly deviceId: string;
	readonly label: string;
	readonly groupId: string;
	readonly isDefault: boolean;
}

export type PlaybackAudioOutputState =
	| "selected"
	| "pending"
	| "ready-or-playing"
	| "unavailable"
	| "unsupported";

export interface PlaybackAudioOutputTargetViewModel {
	readonly deviceId: string;
	readonly label: string;
	readonly state: PlaybackAudioOutputState;
}

export interface PlaybackAudioOutputViewModel {
	readonly primary: PlaybackAudioOutputTargetViewModel;
	readonly mirrors: readonly PlaybackAudioOutputTargetViewModel[];
	readonly bridge: PlaybackAudioOutputTargetViewModel | null;
}

export interface PlaybackAudioSettingsDiagnostics {
	readonly routing?: PlaybackOutputRoutingSnapshot;
}

export interface PlaybackAudioSettingsController {
	setTransitionPreferences(preference: PlaybackTransitionPreferences): void;
	setOutputRouting(
		config: PlaybackOutputRoutingConfig,
	): Promise<PlaybackOutputRoutingSnapshot>;
	listOutputDevices(): Promise<readonly PlaybackAudioOutputDevice[]>;
	diagnostics?(): PlaybackAudioSettingsDiagnostics;
}

export interface PlaybackMediaDevicesEventSource {
	addEventListener(type: "devicechange", listener: EventListener): void;
	removeEventListener(type: "devicechange", listener: EventListener): void;
}

export interface UsePlaybackAudioSettingsOptions {
	readonly controllerRef: {
		readonly current: PlaybackAudioSettingsController | null;
	};
	readonly preferences?: PreferencesRepository | null;
	readonly mediaDevices?: PlaybackMediaDevicesEventSource | null;
}

export interface PlaybackAudioSettingsResult {
	readonly hydrated: boolean;
	readonly busy: boolean;
	readonly preference: PlaybackAudioPreference;
	readonly devices: readonly PlaybackAudioOutputDevice[];
	readonly error: string | null;
	readonly refreshing: boolean;
	readonly controllerReady: boolean;
	readonly outputSupported: boolean;
	readonly routing: PlaybackOutputRoutingSnapshot | null;
	readonly output: PlaybackAudioOutputViewModel;
	setFadeInMs(value: number): Promise<void>;
	setFadeOutMs(value: number): Promise<void>;
	setGaplessEnabled(enabled: boolean): Promise<void>;
	setCrossfadeEnabled(enabled: boolean): Promise<void>;
	setPrimaryOutputId(deviceId: string): Promise<void>;
	toggleMirrorOutput(deviceId: string): Promise<void>;
	setVirtualBridgeSinkId(deviceId: string): Promise<void>;
	handleControllerReady(
		controller?: PlaybackAudioSettingsController | null,
	): Promise<void>;
	applyToController(
		controller?: PlaybackAudioSettingsController | null,
	): Promise<void>;
	setPanelOpen(open: boolean): void;
	refreshDevices(): Promise<void>;
}

function normalizedPreference(value: unknown): PlaybackAudioPreference {
	return PLAYBACK_AUDIO_PREFERENCE.parse(value)
		?? PLAYBACK_AUDIO_PREFERENCE.defaultValue();
}

function transitionPreference(
	preference: PlaybackAudioPreference,
): PlaybackTransitionPreferences {
	return {
		fadeInMs: preference.fadeInMs,
		fadeOutMs: preference.fadeOutMs,
		crossfadeMs: 720,
		crossfadeEnabled: preference.crossfadeEnabled,
	};
}

function routingConfig(
	preference: PlaybackAudioPreference,
): PlaybackOutputRoutingConfig {
	const virtualBridgeSinkId = preference.inputBridge.enabled
		? preference.inputBridge.deviceId
		: "";
	const primarySinkId = virtualBridgeSinkId || preference.primaryOutputId;
	return {
		enabled: !!(
			primarySinkId
			|| preference.mirrorOutputIds.length
			|| virtualBridgeSinkId
		),
		primarySinkId,
		mirrorSinkIds: preference.mirrorOutputIds.filter(
			(deviceId) => deviceId !== primarySinkId,
		),
		virtualBridgeSinkId,
	};
}

function defaultOutputPreference(
	preference: PlaybackAudioPreference,
): PlaybackAudioPreference {
	return normalizedPreference({
		...preference,
		primaryOutputId: "",
		inputBridge: { enabled: false, deviceId: "" },
	});
}

function routeIsActive(preference: PlaybackAudioPreference): boolean {
	return !!(
		preference.primaryOutputId
		|| preference.mirrorOutputIds.length
		|| (preference.inputBridge.enabled && preference.inputBridge.deviceId)
	);
}

function browserMediaDevices(): PlaybackMediaDevicesEventSource | null {
	if (typeof navigator === "undefined") return null;
	const source = navigator.mediaDevices;
	if (!source?.addEventListener || !source.removeEventListener) return null;
	return source;
}

function normalizedDevices(
	devices: readonly PlaybackAudioOutputDevice[],
): readonly PlaybackAudioOutputDevice[] {
	const result: PlaybackAudioOutputDevice[] = [];
	const seen = new Set<string>();
	for (const device of devices) {
		const deviceId = String(device.deviceId || "").trim();
		if (!deviceId || deviceId === "default" || device.isDefault || seen.has(deviceId)) {
			continue;
		}
		seen.add(deviceId);
		result.push(Object.freeze({
			deviceId,
			label: String(device.label || "").trim(),
			groupId: String(device.groupId || ""),
			isDefault: false,
		}));
	}
	return Object.freeze(result);
}

type OutputTargetRole = "primary" | "mirror" | "bridge";

function outputFallbackLabel(
	deviceId: string,
	role: OutputTargetRole,
): string {
	if (!deviceId) return "系统默认输出";
	const stableId = deviceId.slice(0, 8) || "unknown";
	return `${role === "bridge" ? "虚拟输出" : "输出设备"} ${stableId}`;
}

function outputTargetLabel(
	deviceId: string,
	role: OutputTargetRole,
	devicesById: ReadonlyMap<string, PlaybackAudioOutputDevice>,
): string {
	const label = devicesById.get(deviceId)?.label.trim();
	return label || outputFallbackLabel(deviceId, role);
}

function routingErrorForTarget(
	role: OutputTargetRole,
	deviceId: string,
	routing: PlaybackOutputRoutingSnapshot | null,
): PlaybackOutputRoutingError | undefined {
	return routing?.errors.find((entry) => {
		if (role === "mirror") {
			return entry.target === "mirror" && entry.sinkId === deviceId;
		}
		return (entry.target === "primary" || entry.target === "context")
			&& (!entry.sinkId || entry.sinkId === deviceId);
	});
}

function outputTargetState(
	role: OutputTargetRole,
	deviceId: string,
	options: {
		readonly devicesById: ReadonlyMap<string, PlaybackAudioOutputDevice>;
		readonly devicesLoaded: boolean;
		readonly pending: boolean;
		readonly controllerReady: boolean;
		readonly outputSupported: boolean;
		readonly routing: PlaybackOutputRoutingSnapshot | null;
	},
): PlaybackAudioOutputState {
	const error = routingErrorForTarget(role, deviceId, options.routing);
	if (deviceId && (!options.outputSupported || error?.name === "NotSupportedError")) {
		return "unsupported";
	}
	if (deviceId && (
		error
		|| (options.devicesLoaded && !options.devicesById.has(deviceId))
	)) {
		return "unavailable";
	}
	if (options.pending) return "pending";
	if (!options.controllerReady || !options.routing) return "selected";

	const ready = role === "mirror"
		? options.routing.mirrorSinkIds.includes(deviceId)
		: role === "bridge"
			? options.routing.virtualBridgeSinkId === deviceId
				&& options.routing.effectivePrimarySinkId === deviceId
			: options.routing.effectivePrimarySinkId === deviceId;
	return ready ? "ready-or-playing" : "selected";
}

export function createPlaybackAudioOutputViewModel(options: {
	readonly preference: PlaybackAudioPreference;
	readonly devices: readonly PlaybackAudioOutputDevice[];
	readonly devicesLoaded: boolean;
	readonly pending: boolean;
	readonly controllerReady: boolean;
	readonly outputSupported: boolean;
	readonly routing: PlaybackOutputRoutingSnapshot | null;
}): PlaybackAudioOutputViewModel {
	const devicesById = new Map(options.devices.map((device) => [device.deviceId, device]));
	const primaryDeviceId = options.preference.inputBridge.enabled
		? options.preference.inputBridge.deviceId
		: options.preference.primaryOutputId;
	const target = (
		deviceId: string,
		role: OutputTargetRole,
	): PlaybackAudioOutputTargetViewModel => Object.freeze({
		deviceId,
		label: outputTargetLabel(deviceId, role, devicesById),
		state: outputTargetState(role, deviceId, {
			...options,
			devicesById,
		}),
	});

	return Object.freeze({
		primary: target(primaryDeviceId, "primary"),
		mirrors: Object.freeze(options.preference.mirrorOutputIds.map(
			(deviceId) => target(deviceId, "mirror"),
		)),
		bridge: options.preference.inputBridge.enabled
			? target(options.preference.inputBridge.deviceId, "bridge")
			: null,
	});
}

export function usePlaybackAudioSettings({
	controllerRef,
	preferences,
	mediaDevices,
}: UsePlaybackAudioSettingsOptions): PlaybackAudioSettingsResult {
	const [hydrated, setHydrated] = useState(false);
	const [busy, setBusy] = useState(false);
	const [routingPending, setRoutingPending] = useState(false);
	const [routingRequest, setRoutingRequest] = useState<PlaybackAudioPreference | null>(null);
	const [preference, setPreference] = useState<PlaybackAudioPreference>(() =>
		PLAYBACK_AUDIO_PREFERENCE.defaultValue());
	const [devices, setDevices] = useState<readonly PlaybackAudioOutputDevice[]>([]);
	const [devicesLoaded, setDevicesLoaded] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [controllerReady, setControllerReady] = useState(false);
	const [outputSupported, setOutputSupported] = useState(true);
	const [routing, setRouting] = useState<PlaybackOutputRoutingSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [panelOpen, setPanelOpenState] = useState(false);
	const [controllerEpoch, setControllerEpoch] = useState(0);
	const preferenceRef = useRef(preference);
	const hydratedRef = useRef(false);
	const readyControllerRef = useRef<PlaybackAudioSettingsController | null>(null);
	const refreshDevicesRef = useRef<() => Promise<void>>(async () => {});
	const mountedRef = useRef(true);
	preferenceRef.current = preference;
	const outputRouteActive = routeIsActive(preference);
	const mediaDeviceSource = mediaDevices === undefined
		? browserMediaDevices()
		: mediaDevices;

	const publishPreference = useCallback((next: PlaybackAudioPreference) => {
		preferenceRef.current = next;
		if (mountedRef.current) setPreference(next);
	}, []);

	const applyPreferenceToController = useCallback(async (
		controller: PlaybackAudioSettingsController,
		requested: PlaybackAudioPreference,
	): Promise<PlaybackAudioPreference> => {
		controller.setTransitionPreferences(transitionPreference(requested));
		const routing = await controller.setOutputRouting(routingConfig(requested));
		if (mountedRef.current) {
			setRouting(routing);
			setOutputSupported(
				!routing.errors.some((entry) => entry.name === "NotSupportedError"),
			);
		}
		if (!routing.fellBackToDefault) return requested;
		const fallback = defaultOutputPreference(requested);
		// Runtime 已回退到系统默认；canonical 可用时同步持久化。
		await preferences?.set(PLAYBACK_AUDIO_PREFERENCE, fallback);
		return fallback;
	}, [preferences]);

	useEffect(() => {
		mountedRef.current = true;
		let current = true;
		void (async () => {
			try {
				let hydratedPreference = normalizedPreference(
					preferences
						? await preferences.get(PLAYBACK_AUDIO_PREFERENCE)
						: PLAYBACK_AUDIO_PREFERENCE.defaultValue(),
				);
				const controller = readyControllerRef.current ?? controllerRef.current;
				if (controller) {
					readyControllerRef.current = controller;
					setControllerReady(true);
					hydratedPreference = await applyPreferenceToController(
						controller,
						hydratedPreference,
					);
				}
				if (!current) return;
				hydratedRef.current = true;
				publishPreference(hydratedPreference);
				setHydrated(true);
				if (controller) setControllerEpoch((value) => value + 1);
			} catch (cause) {
				if (!current) return;
				hydratedRef.current = true;
				setError(cause instanceof Error ? cause.message : String(cause));
				setHydrated(true);
			}
		})();
		return () => {
			current = false;
			hydratedRef.current = false;
			mountedRef.current = false;
		};
	}, [applyPreferenceToController, controllerRef, preferences, publishPreference]);

	const handleControllerReady = useCallback(async (
		controller: PlaybackAudioSettingsController | null = controllerRef.current,
	) => {
		readyControllerRef.current = controller;
		if (mountedRef.current) {
			setControllerReady(!!controller);
			setControllerEpoch((value) => value + 1);
		}
		if (!controller || !hydratedRef.current) return;
		try {
			const applied = await applyPreferenceToController(
				controller,
				preferenceRef.current,
			);
			publishPreference(applied);
			if (mountedRef.current) setError(null);
		} catch (cause) {
			if (mountedRef.current) {
				if (
					cause instanceof DOMException
					&& cause.name === "NotSupportedError"
				) {
					setOutputSupported(false);
				}
				setError(cause instanceof Error ? cause.message : String(cause));
			}
			throw cause;
		}
	}, [applyPreferenceToController, controllerRef, publishPreference]);

	const refreshDevices = useCallback(async () => {
		const controller = readyControllerRef.current ?? controllerRef.current;
		if (!controller) return;
		if (mountedRef.current) {
			setRefreshing(true);
			setError(null);
		}
		try {
			const listed = normalizedDevices(await controller.listOutputDevices());
			if (mountedRef.current) {
				setDevices(listed);
				setDevicesLoaded(true);
			}
			if (routeIsActive(preferenceRef.current)) {
				const applied = await applyPreferenceToController(
					controller,
					preferenceRef.current,
				);
				publishPreference(applied);
			}
		} catch (cause) {
			if (mountedRef.current) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		} finally {
			if (mountedRef.current) setRefreshing(false);
		}
	}, [applyPreferenceToController, controllerRef, publishPreference]);
	refreshDevicesRef.current = refreshDevices;

	useEffect(() => {
		if (!panelOpen || !readyControllerRef.current) return;
		void refreshDevicesRef.current();
	}, [controllerEpoch, panelOpen]);

	useEffect(() => {
		if (
			!mediaDeviceSource
			|| !readyControllerRef.current
			|| (!panelOpen && !outputRouteActive)
		) {
			return;
		}
		const handleDeviceChange: EventListener = () => {
			void refreshDevicesRef.current();
		};
		mediaDeviceSource.addEventListener("devicechange", handleDeviceChange);
		return () => {
			mediaDeviceSource.removeEventListener("devicechange", handleDeviceChange);
		};
	}, [controllerEpoch, mediaDeviceSource, outputRouteActive, panelOpen]);

	const commitTransitionPatch = useCallback(async (
		patch: Partial<PlaybackAudioPreference>,
	) => {
		const next = normalizedPreference({
			...preferenceRef.current,
			...patch,
		});
		if (mountedRef.current) {
			setBusy(true);
			setError(null);
		}
		try {
			// canonical commit 成功后才允许 Runtime 和 UI 观察到新值。
			await preferences?.set(PLAYBACK_AUDIO_PREFERENCE, next);
			(readyControllerRef.current ?? controllerRef.current)?.setTransitionPreferences(
				transitionPreference(next),
			);
			preferenceRef.current = next;
			if (mountedRef.current) setPreference(next);
		} catch (cause) {
			if (mountedRef.current) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
			throw cause;
		} finally {
			if (mountedRef.current) setBusy(false);
		}
	}, [controllerRef, preferences]);

	const setFadeInMs = useCallback(
		(value: number) => commitTransitionPatch({ fadeInMs: value }),
		[commitTransitionPatch],
	);

	const setFadeOutMs = useCallback(
		(value: number) => commitTransitionPatch({ fadeOutMs: value }),
		[commitTransitionPatch],
	);

	const commitGaplessPreference = useCallback(async (enabled: boolean) => {
		const next = normalizedPreference({
			...preferenceRef.current,
			gaplessEnabled: enabled,
		});
		if (mountedRef.current) {
			setBusy(true);
			setError(null);
		}
		try {
			await preferences?.set(PLAYBACK_AUDIO_PREFERENCE, next);
			publishPreference(next);
		} catch (cause) {
			if (mountedRef.current) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
			throw cause;
		} finally {
			if (mountedRef.current) setBusy(false);
		}
	}, [preferences, publishPreference]);

	const setCrossfadeEnabled = useCallback(
		(enabled: boolean) => commitTransitionPatch({ crossfadeEnabled: enabled }),
		[commitTransitionPatch],
	);

	const commitRoutingPreference = useCallback(async (
		createNext: (current: PlaybackAudioPreference) => PlaybackAudioPreference,
	) => {
		const requested = normalizedPreference(createNext(preferenceRef.current));
		if (mountedRef.current) {
			setBusy(true);
			setRoutingPending(true);
			setRoutingRequest(requested);
			setError(null);
		}
		try {
			// 先写 canonical，再修改实际路由；写失败时 UI 与 Runtime 均保持旧值。
			await preferences?.set(PLAYBACK_AUDIO_PREFERENCE, requested);
			let applied = requested;
			const controller = readyControllerRef.current ?? controllerRef.current;
			if (controller) {
				const routing = await controller.setOutputRouting(routingConfig(requested));
				if (mountedRef.current) {
					setRouting(routing);
					setOutputSupported(
						!routing.errors.some((entry) => entry.name === "NotSupportedError"),
					);
				}
				if (routing.fellBackToDefault) {
					applied = defaultOutputPreference(requested);
					await preferences?.set(PLAYBACK_AUDIO_PREFERENCE, applied);
				}
			}
			publishPreference(applied);
		} catch (cause) {
			if (mountedRef.current) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
			throw cause;
		} finally {
			if (mountedRef.current) {
				setBusy(false);
				setRoutingPending(false);
				setRoutingRequest(null);
			}
		}
	}, [controllerRef, preferences, publishPreference]);

	const setPrimaryOutputId = useCallback((value: string) => {
		const deviceId = String(value || "").trim();
		return commitRoutingPreference((current) => ({
			...current,
			primaryOutputId: deviceId,
			mirrorOutputIds: current.mirrorOutputIds.filter((id) => id !== deviceId),
			inputBridge: { enabled: false, deviceId: "" },
		}));
	}, [commitRoutingPreference]);

	const toggleMirrorOutput = useCallback((value: string) => {
		const deviceId = String(value || "").trim();
		if (!deviceId) return Promise.resolve();
		return commitRoutingPreference((current) => {
			const primaryId = current.inputBridge.enabled
				? current.inputBridge.deviceId
				: current.primaryOutputId;
			if (deviceId === primaryId) return current;
			const mirrors = [...current.mirrorOutputIds];
			const index = mirrors.indexOf(deviceId);
			if (index >= 0) mirrors.splice(index, 1);
			else if (mirrors.length < 4) mirrors.push(deviceId);
			return { ...current, mirrorOutputIds: mirrors };
		});
	}, [commitRoutingPreference]);

	const setVirtualBridgeSinkId = useCallback((value: string) => {
		const deviceId = String(value || "").trim();
		return commitRoutingPreference((current) => {
			if (!deviceId) {
				const wasBridgePrimary = current.inputBridge.enabled
					&& current.primaryOutputId === current.inputBridge.deviceId;
				return {
					...current,
					primaryOutputId: wasBridgePrimary ? "" : current.primaryOutputId,
					inputBridge: { enabled: false, deviceId: "" },
				};
			}
			return {
				...current,
				primaryOutputId: deviceId,
				mirrorOutputIds: current.mirrorOutputIds.filter((id) => id !== deviceId),
				inputBridge: { enabled: true, deviceId },
			};
		});
	}, [commitRoutingPreference]);

	const setPanelOpen = useCallback((open: boolean) => {
		setPanelOpenState(open);
	}, []);

	const output = createPlaybackAudioOutputViewModel({
		preference: routingRequest ?? preference,
		devices,
		devicesLoaded,
		pending: routingPending,
		controllerReady,
		outputSupported,
		routing,
	});

	return {
		hydrated,
		busy,
		preference,
		devices,
		error,
		refreshing,
		controllerReady,
		outputSupported,
		routing,
		output,
		setFadeInMs,
		setFadeOutMs,
		setGaplessEnabled: commitGaplessPreference,
		setCrossfadeEnabled,
		setPrimaryOutputId,
		toggleMirrorOutput,
		setVirtualBridgeSinkId,
		handleControllerReady,
		applyToController: handleControllerReady,
		setPanelOpen,
		refreshDevices,
	};
}

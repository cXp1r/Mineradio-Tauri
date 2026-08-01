import { afterEach, expect, test } from "bun:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type {
	PreferenceKey,
	PreferencesRepository,
	PreferencesTransaction,
} from "../../ports/preferences-repository";
import {
	PLAYBACK_AUDIO_PREFERENCE,
	type PlaybackAudioPreference,
} from "../../preferences/keys";
import {
	createPlaybackAudioOutputViewModel,
	usePlaybackAudioSettings,
	type PlaybackAudioSettingsController,
	type PlaybackAudioSettingsResult,
} from "./usePlaybackAudioSettings";

const reactTestEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

afterEach(() => {
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

test("typed 输出模型对 primary、mirror 和 bridge 使用一致的五态语义", () => {
	const preference = PLAYBACK_AUDIO_PREFERENCE.parse({
		...PLAYBACK_AUDIO_PREFERENCE.defaultValue(),
		primaryOutputId: "virtual-cable",
		mirrorOutputIds: ["monitor-a"],
		inputBridge: { enabled: true, deviceId: "virtual-cable" },
	})!;
	const devices = [
		{ deviceId: "virtual-cable", label: "虚拟线缆", groupId: "g1", isDefault: false },
		{ deviceId: "monitor-a", label: "监听音箱", groupId: "g2", isDefault: false },
	];
	const readyRouting = {
		enabled: true,
		requestedPrimarySinkId: "virtual-cable",
		effectivePrimarySinkId: "virtual-cable",
		mirrorSinkIds: ["monitor-a"],
		virtualBridgeSinkId: "virtual-cable",
		fellBackToDefault: false,
		errors: [],
	};
	const cases = [
		{
			state: "selected",
			options: { devices, devicesLoaded: false, pending: false, controllerReady: false, outputSupported: true, routing: null },
		},
		{
			state: "pending",
			options: { devices, devicesLoaded: false, pending: true, controllerReady: true, outputSupported: true, routing: null },
		},
		{
			state: "ready-or-playing",
			options: { devices, devicesLoaded: true, pending: false, controllerReady: true, outputSupported: true, routing: readyRouting },
		},
		{
			state: "unavailable",
			options: { devices: [], devicesLoaded: true, pending: false, controllerReady: true, outputSupported: true, routing: null },
		},
		{
			state: "unsupported",
			options: { devices, devicesLoaded: true, pending: false, controllerReady: true, outputSupported: false, routing: null },
		},
	] as const;

	for (const entry of cases) {
		const output = createPlaybackAudioOutputViewModel({
			preference,
			...entry.options,
		});
		expect([
			output.primary.state,
			output.mirrors[0]?.state,
			output.bridge?.state,
		]).toEqual([entry.state, entry.state, entry.state]);
	}
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function clonePreference(value: Readonly<PlaybackAudioPreference>): PlaybackAudioPreference {
	return JSON.parse(JSON.stringify(value)) as PlaybackAudioPreference;
}

function createRepository(
	initial = PLAYBACK_AUDIO_PREFERENCE.defaultValue(),
): PreferencesRepository & { current: PlaybackAudioPreference } {
	const repository: PreferencesRepository & { current: PlaybackAudioPreference } = {
		current: clonePreference(initial),
		get: async <T,>(key: PreferenceKey<T>) => (
			key.name === PLAYBACK_AUDIO_PREFERENCE.name
				? clonePreference(repository.current) as T
				: key.defaultValue()
		),
		set: async <T,>(key: PreferenceKey<T>, value: T) => {
			if (key.name === PLAYBACK_AUDIO_PREFERENCE.name) {
				repository.current = clonePreference(value as PlaybackAudioPreference);
			}
		},
		remove: async () => undefined,
		transaction: async <T,>(work: (tx: PreferencesTransaction) => Promise<T>) =>
			work(repository),
	};
	return repository;
}

function createController(): PlaybackAudioSettingsController & {
	transitionCalls: Array<{ fadeInMs?: number; fadeOutMs?: number }>;
	routingCalls: number;
	listCalls: number;
} {
	return {
		transitionCalls: [],
		routingCalls: 0,
		listCalls: 0,
		setTransitionPreferences(preference) {
			this.transitionCalls.push(preference);
		},
		async setOutputRouting(config) {
			this.routingCalls += 1;
			return {
				enabled: config.enabled === true,
				requestedPrimarySinkId: config.primarySinkId ?? "",
				effectivePrimarySinkId: config.primarySinkId ?? "",
				mirrorSinkIds: [...(config.mirrorSinkIds ?? [])],
				virtualBridgeSinkId: config.virtualBridgeSinkId ?? "",
				fellBackToDefault: false,
				errors: [],
			};
		},
		async listOutputDevices() {
			this.listCalls += 1;
			return [];
		},
	};
}

class FakeMediaDevices {
	readonly listeners = new Set<EventListener>();
	addCalls = 0;
	removeCalls = 0;

	addEventListener(type: "devicechange", listener: EventListener): void {
		if (type !== "devicechange") return;
		this.addCalls += 1;
		this.listeners.add(listener);
	}

	removeEventListener(type: "devicechange", listener: EventListener): void {
		if (type !== "devicechange") return;
		this.removeCalls += 1;
		this.listeners.delete(listener);
	}

	emitDeviceChange(): void {
		for (const listener of this.listeners) listener(new Event("devicechange"));
	}
}

test("canonical preference 提交完成后才发布 fade 设置和 Runtime 变更", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const committed = deferred<void>();
	const preferences = createRepository();
	const originalSet = preferences.set.bind(preferences);
	let writes = 0;
	preferences.set = async <T,>(key: PreferenceKey<T>, value: T) => {
		writes += 1;
		await committed.promise;
		await originalSet(key, value);
	};
	const controller = createController();
	const controllerRef = { current: controller };
	let current: PlaybackAudioSettingsResult | null = null;

	function Harness() {
		current = usePlaybackAudioSettings({ controllerRef, preferences, mediaDevices: null });
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => Promise.resolve());
	expect(current!.hydrated).toBe(true);
	const callsAfterHydration = controller.transitionCalls.length;

	let pending!: Promise<void>;
	await act(async () => {
		pending = current!.setFadeInMs(1_200);
		await Promise.resolve();
	});
	expect(writes).toBe(1);
	expect(current!.preference.fadeInMs).toBe(460);
	expect(controller.transitionCalls.length).toBe(callsAfterHydration);
	expect(current!.output.primary.state).toBe("ready-or-playing");

	committed.resolve();
	await act(async () => pending);
	expect(current!.preference.fadeInMs).toBe(1_200);
	expect(controller.transitionCalls.at(-1)?.fadeInMs).toBe(1_200);

	await act(async () => root.unmount());
	host.remove();
});

test("输出路由提交期间 typed view model 指向新的 pending 目标", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const preferences = createRepository();
	const controller = createController();
	const controllerRef = { current: controller };
	let current: PlaybackAudioSettingsResult | null = null;

	function Harness() {
		current = usePlaybackAudioSettings({ controllerRef, preferences, mediaDevices: null });
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => Promise.resolve());

	const routeCommit = deferred<{
		enabled: boolean;
		requestedPrimarySinkId: string;
		effectivePrimarySinkId: string;
		mirrorSinkIds: readonly string[];
		virtualBridgeSinkId: string;
		fellBackToDefault: boolean;
		errors: readonly [];
	}>();
	controller.setOutputRouting = async () => routeCommit.promise;
	let pending!: Promise<void>;
	await act(async () => {
		pending = current!.setPrimaryOutputId("speaker-a");
		await Promise.resolve();
	});

	expect(current!.output.primary.deviceId).toBe("speaker-a");
	expect(current!.output.primary.state).toBe("pending");

	routeCommit.resolve({
		enabled: true,
		requestedPrimarySinkId: "speaker-a",
		effectivePrimarySinkId: "speaker-a",
		mirrorSinkIds: [],
		virtualBridgeSinkId: "",
		fellBackToDefault: false,
		errors: [],
	});
	await act(async () => pending);
	expect(current!.preference.primaryOutputId).toBe("speaker-a");
	expect(current!.output.primary.state).toBe("ready-or-playing");

	await act(async () => root.unmount());
	host.remove();
});

test("Runtime 将 NotFound 主输出回退为系统默认后同步 canonical preference", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const initial = clonePreference(PLAYBACK_AUDIO_PREFERENCE.defaultValue());
	initial.primaryOutputId = "missing-device";
	initial.inputBridge = { enabled: true, deviceId: "missing-device" };
	const preferences = createRepository(initial);
	const writes: PlaybackAudioPreference[] = [];
	const originalSet = preferences.set.bind(preferences);
	preferences.set = async <T,>(key: PreferenceKey<T>, value: T) => {
		writes.push(clonePreference(value as PlaybackAudioPreference));
		await originalSet(key, value);
	};
	const controller = createController();
	controller.setOutputRouting = async (config) => ({
		enabled: false,
		requestedPrimarySinkId: config.primarySinkId ?? "",
		effectivePrimarySinkId: "",
		mirrorSinkIds: [...(config.mirrorSinkIds ?? [])],
		virtualBridgeSinkId: "",
		fellBackToDefault: true,
		errors: [{
			target: "primary",
			sinkId: config.primarySinkId ?? "",
			name: "NotFoundError",
			message: "device missing",
		}],
	});
	const controllerRef = { current: controller };
	let current: PlaybackAudioSettingsResult | null = null;

	function Harness() {
		current = usePlaybackAudioSettings({
			controllerRef,
			preferences,
			mediaDevices: null,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => Promise.resolve());

	expect(writes.length).toBe(1);
	expect(writes[0]?.primaryOutputId).toBe("");
	expect(writes[0]?.inputBridge).toEqual({ enabled: false, deviceId: "" });
	expect(current!.preference.primaryOutputId).toBe("");
	expect(current!.preference.inputBridge.enabled).toBe(false);

	await act(async () => root.unmount());
	host.remove();
});

test("controller 延迟 ready 时重放 hydrated preference，默认路由不枚举或常驻监听", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const preferences = createRepository();
	const controller = createController();
	const controllerRef: { current: PlaybackAudioSettingsController | null } = {
		current: null,
	};
	const mediaDevices = new FakeMediaDevices();
	let current: PlaybackAudioSettingsResult | null = null;

	function Harness() {
		current = usePlaybackAudioSettings({
			controllerRef,
			preferences,
			mediaDevices,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => Promise.resolve());
	expect(current!.hydrated).toBe(true);
	expect(controller.transitionCalls.length).toBe(0);
	expect(controller.listCalls).toBe(0);
	expect(mediaDevices.addCalls).toBe(0);

	await act(async () => {
		await current!.handleControllerReady(controller);
	});
	expect(controller.transitionCalls.at(-1)?.fadeInMs).toBe(460);
	expect(controller.routingCalls).toBe(1);
	expect(controller.listCalls).toBe(0);
	expect(mediaDevices.addCalls).toBe(0);

	await act(async () => current!.setPanelOpen(true));
	expect(mediaDevices.addCalls).toBe(1);
	expect(mediaDevices.listeners.size).toBe(1);
	expect(controller.listCalls).toBe(1);
	await act(async () => current!.setPanelOpen(true));
	expect(mediaDevices.addCalls).toBe(1);
	expect(controller.listCalls).toBe(1);

	await act(async () => mediaDevices.emitDeviceChange());
	await act(async () => Promise.resolve());
	expect(controller.listCalls).toBe(2);

	await act(async () => current!.setPanelOpen(false));
	expect(mediaDevices.removeCalls).toBe(1);
	expect(mediaDevices.listeners.size).toBe(0);

	await act(async () => root.unmount());
	expect(mediaDevices.listeners.size).toBe(0);
	host.remove();
});

test("PreferencesRepository 不可用时使用会话默认值且不阻止 Runtime 设置", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const controller = createController();
	const controllerRef: { current: PlaybackAudioSettingsController | null } = {
		current: null,
	};
	let current: PlaybackAudioSettingsResult | null = null;

	function Harness() {
		current = usePlaybackAudioSettings({
			controllerRef,
			preferences: null,
			mediaDevices: null,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => Promise.resolve());
	expect(current!.hydrated).toBe(true);
	expect(current!.preference.fadeOutMs).toBe(420);

	await act(async () => current!.handleControllerReady(controller));
	await act(async () => current!.setFadeOutMs(900));
	expect(current!.preference.fadeOutMs).toBe(900);
	expect(controller.transitionCalls.at(-1)?.fadeOutMs).toBe(900);

	await act(async () => root.unmount());
	host.remove();
});

test("手动刷新与 routing actions 维护 primary、四个 mirrors 和 Virtual Bridge 互斥", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const preferences = createRepository();
	const controller = createController();
	const outputDevices = [
		{ deviceId: "default", label: "系统默认", groupId: "g0", isDefault: true },
		{ deviceId: "a", label: "扬声器 A", groupId: "g1", isDefault: false },
		{ deviceId: "b", label: "扬声器 B", groupId: "g2", isDefault: false },
		{ deviceId: "c", label: "扬声器 C", groupId: "g3", isDefault: false },
		{ deviceId: "d", label: "扬声器 D", groupId: "g4", isDefault: false },
		{ deviceId: "e", label: "扬声器 E", groupId: "g5", isDefault: false },
		{ deviceId: "virtual", label: "VB-Audio Cable Input", groupId: "g6", isDefault: false },
	];
	controller.listOutputDevices = async () => {
		controller.listCalls += 1;
		return outputDevices;
	};
	const controllerRef = { current: controller };
	let current: PlaybackAudioSettingsResult | null = null;

	function Harness() {
		current = usePlaybackAudioSettings({ controllerRef, preferences, mediaDevices: null });
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => Promise.resolve());

	await act(async () => current!.refreshDevices());
	expect(current!.devices.map((device) => device.deviceId)).toEqual([
		"a", "b", "c", "d", "e", "virtual",
	]);

	await act(async () => current!.setPrimaryOutputId("a"));
	for (const sinkId of ["b", "c", "d", "e", "virtual"]) {
		await act(async () => current!.toggleMirrorOutput(sinkId));
	}
	expect(current!.preference.primaryOutputId).toBe("a");
	expect(current!.preference.mirrorOutputIds).toEqual(["b", "c", "d", "e"]);

	await act(async () => current!.setPrimaryOutputId("b"));
	expect(current!.preference.primaryOutputId).toBe("b");
	expect(current!.preference.mirrorOutputIds).not.toContain("b");

	await act(async () => current!.setVirtualBridgeSinkId("virtual"));
	expect(current!.preference.primaryOutputId).toBe("virtual");
	expect(current!.preference.inputBridge).toEqual({
		enabled: true,
		deviceId: "virtual",
	});
	expect(current!.preference.mirrorOutputIds).not.toContain("virtual");

	await act(async () => current!.setVirtualBridgeSinkId(""));
	expect(current!.preference.primaryOutputId).toBe("");
	expect(current!.preference.inputBridge).toEqual({ enabled: false, deviceId: "" });

	await act(async () => root.unmount());
	host.remove();
});

test("devicechange 触发 Runtime NotFound 回退并移除默认路由监听", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const initial = clonePreference(PLAYBACK_AUDIO_PREFERENCE.defaultValue());
	initial.primaryOutputId = "speaker-a";
	const preferences = createRepository(initial);
	const controller = createController();
	controller.listOutputDevices = async () => {
		controller.listCalls += 1;
		return [];
	};
	const mediaDevices = new FakeMediaDevices();
	const controllerRef = { current: controller };
	let current: PlaybackAudioSettingsResult | null = null;

	function Harness() {
		current = usePlaybackAudioSettings({ controllerRef, preferences, mediaDevices });
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => Promise.resolve());
	expect(mediaDevices.addCalls).toBe(1);

	controller.setOutputRouting = async (config) => ({
		enabled: false,
		requestedPrimarySinkId: config.primarySinkId ?? "",
		effectivePrimarySinkId: "",
		mirrorSinkIds: [],
		virtualBridgeSinkId: "",
		fellBackToDefault: true,
		errors: [{
			target: "primary",
			sinkId: config.primarySinkId ?? "",
			name: "NotFoundError",
			message: "device removed",
		}],
	});
	await act(async () => {
		mediaDevices.emitDeviceChange();
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(controller.listCalls).toBe(1);
	expect(current!.preference.primaryOutputId).toBe("");
	expect(preferences.current.primaryOutputId).toBe("");
	expect(mediaDevices.removeCalls).toBe(1);
	expect(mediaDevices.listeners.size).toBe(0);

	await act(async () => root.unmount());
	host.remove();
});

test("已选镜像设备从枚举结果消失后仍保留 typed unavailable 状态", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const initial = clonePreference(PLAYBACK_AUDIO_PREFERENCE.defaultValue());
	initial.mirrorOutputIds = ["missing-mirror"];
	const preferences = createRepository(initial);
	const controller = createController();
	controller.listOutputDevices = async () => {
		controller.listCalls += 1;
		return [{
			deviceId: "speaker-a",
			label: "扬声器 A",
			groupId: "group-a",
			isDefault: false,
		}];
	};
	const controllerRef = { current: controller };
	let current: PlaybackAudioSettingsResult | null = null;

	function Harness() {
		current = usePlaybackAudioSettings({ controllerRef, preferences, mediaDevices: null });
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(<Harness />));
	await act(async () => Promise.resolve());
	await act(async () => current!.refreshDevices());

	expect(current!.output.mirrors).toEqual([{
		deviceId: "missing-mirror",
		label: "输出设备 missing-",
		state: "unavailable",
	}]);

	await act(async () => root.unmount());
	host.remove();
});

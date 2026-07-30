import {
	useEffect,
	type ChangeEvent,
	type ReactElement,
} from "react";
import type {
	PlaybackAudioOutputDevice,
	PlaybackAudioOutputState,
	PlaybackAudioOutputTargetViewModel,
	PlaybackAudioSettingsResult,
} from "./usePlaybackAudioSettings";

export interface PlaybackAudioSettingsProps {
	readonly settings: PlaybackAudioSettingsResult;
	readonly active?: boolean;
	readonly className?: string;
}

const VIRTUAL_OUTPUT_PATTERN = /(?:vb-audio|voicemeeter|virtual|loopback|blackhole|sonar|stereo mix|立体声混音|虚拟|线缆|cable input)/i;

function isVirtualOutputDevice(device: PlaybackAudioOutputDevice): boolean {
	return VIRTUAL_OUTPUT_PATTERN.test(device.label);
}

function fadeSeconds(milliseconds: number): string {
	return (milliseconds / 1_000).toFixed(2);
}

function outputDeviceLabel(
	device: PlaybackAudioOutputDevice,
	prefix = "输出设备",
): string {
	if (device.label) return device.label;
	const stableId = device.deviceId.slice(0, 8) || "unknown";
	return `${prefix} ${stableId}`;
}

function runSettingCommit(commit: Promise<void>): void {
	void commit.catch(() => {
		// Hook 已发布可展示的错误；事件处理器只避免未处理 rejection。
	});
}

function outputStateLabel(state: PlaybackAudioOutputState): string {
	switch (state) {
		case "selected": return "已选择";
		case "pending": return "正在应用";
		case "ready-or-playing": return "已就绪或正在播放";
		case "unavailable": return "不可用";
		case "unsupported": return "不受支持";
	}
}

function OutputStateBadge({
	target,
}: {
	readonly target: PlaybackAudioOutputTargetViewModel;
}): ReactElement {
	return (
		<small
			className={`playback-audio-settings__route-state is-${target.state}`}
			data-output-state={target.state}
		>
			{outputStateLabel(target.state)}
		</small>
	);
}

function outputStatus(settings: PlaybackAudioSettingsResult): string {
	if (!settings.hydrated) return "正在加载音频设置…";
	if (!settings.controllerReady) return "播放器音频 Runtime 尚未就绪";
	if (!settings.outputSupported) return "当前内核不支持输出设备切换";
	if (settings.refreshing) return "正在刷新输出设备…";
	if (settings.error) return `输出设置失败：${settings.error}`;
	const targets = [
		settings.output.primary,
		...settings.output.mirrors,
		...(settings.output.bridge ? [settings.output.bridge] : []),
	];
	if (targets.some((target) => target.state === "pending")) {
		return "正在应用输出路由…";
	}
	if (targets.some((target) => target.state === "unsupported")) {
		return "当前内核不支持所选输出路由";
	}
	if (settings.output.bridge?.state === "unavailable") {
		return "虚拟设备桥接不可用，已保留设置供设备恢复";
	}
	if (settings.output.primary.state === "unavailable") {
		return "所选主输出不可用，已保留设置供设备恢复";
	}
	const unavailableMirrors = settings.output.mirrors.filter(
		(target) => target.state === "unavailable",
	);
	if (unavailableMirrors.length > 0) {
		return `${unavailableMirrors.length} 个镜像输出不可用`;
	}
	if (settings.preference.inputBridge.enabled) return "虚拟设备桥接已启用";
	if (settings.preference.primaryOutputId) return "已选择自定义主输出";
	if (settings.preference.mirrorOutputIds.length) {
		return `系统默认主输出，已启用 ${settings.preference.mirrorOutputIds.length} 个镜像`;
	}
	return "当前使用系统默认输出";
}

export function PlaybackAudioSettings({
	settings,
	active = true,
	className = "",
}: PlaybackAudioSettingsProps): ReactElement {
	useEffect(() => {
		settings.setPanelOpen(active);
		return () => settings.setPanelOpen(false);
	}, [active, settings.setPanelOpen]);

	const controlsDisabled = !settings.hydrated || settings.busy;
	const routingDisabled = controlsDisabled
		|| !settings.controllerReady
		|| !settings.outputSupported;
	const selectedPrimary = settings.output.primary.deviceId;
	const mirrorLimitReached = settings.output.mirrors.length >= 4;
	const virtualDevices = settings.devices.filter(isVirtualOutputDevice);
	const primaryMissing = !!selectedPrimary
		&& !settings.devices.some((device) => device.deviceId === selectedPrimary);
	const bridgeMissing = !!settings.output.bridge
		&& !virtualDevices.some(
			(device) => device.deviceId === settings.output.bridge?.deviceId,
		);
	const mirrorTargetsById = new Map(
		settings.output.mirrors.map((target) => [target.deviceId, target]),
	);
	const mirrorRows = [
		...settings.devices.map((device) => ({
			deviceId: device.deviceId,
			label: outputDeviceLabel(device),
			target: mirrorTargetsById.get(device.deviceId) ?? null,
		})),
		...settings.output.mirrors
			.filter((target) => !settings.devices.some(
				(device) => device.deviceId === target.deviceId,
			))
			.map((target) => ({
				deviceId: target.deviceId,
				label: target.label,
				target,
			})),
	];
	const classes = ["playback-audio-settings", className].filter(Boolean).join(" ");

	const handleFadeIn = (event: ChangeEvent<HTMLInputElement>) => {
		runSettingCommit(settings.setFadeInMs(Number(event.currentTarget.value) * 1_000));
	};
	const handleFadeOut = (event: ChangeEvent<HTMLInputElement>) => {
		runSettingCommit(settings.setFadeOutMs(Number(event.currentTarget.value) * 1_000));
	};

	return (
		<section className={classes} aria-busy={settings.busy || settings.refreshing}>
			<header className="playback-audio-settings__header">
				<div>
					<p className="playback-audio-settings__eyebrow">Playback 2.0</p>
					<h2>音频设置</h2>
				</div>
				<button
					type="button"
					className="playback-audio-settings__refresh"
					disabled={routingDisabled || settings.refreshing}
					onClick={() => runSettingCommit(settings.refreshDevices())}
				>
					{settings.refreshing ? "正在刷新…" : "刷新输出设备"}
				</button>
			</header>

			<div className="playback-audio-settings__status" role="status" aria-live="polite">
				{outputStatus(settings)}
			</div>
			{settings.error ? (
				<p className="playback-audio-settings__error" role="alert">
					{settings.error}
				</p>
			) : null}

			<fieldset className="playback-audio-settings__group" disabled={controlsDisabled}>
				<legend>播放过渡</legend>
				<label className="playback-audio-settings__range">
					<span>淡入</span>
					<input
						type="range"
						min="0"
						max="3"
						step="0.05"
						value={fadeSeconds(settings.preference.fadeInMs)}
						onChange={handleFadeIn}
					/>
					<output>{fadeSeconds(settings.preference.fadeInMs)}s</output>
				</label>
				<label className="playback-audio-settings__range">
					<span>淡出</span>
					<input
						type="range"
						min="0"
						max="3"
						step="0.05"
						value={fadeSeconds(settings.preference.fadeOutMs)}
						onChange={handleFadeOut}
					/>
					<output>{fadeSeconds(settings.preference.fadeOutMs)}s</output>
				</label>
				<label className="playback-audio-settings__toggle">
					<input
						type="checkbox"
						checked={settings.preference.gaplessEnabled}
						onChange={(event) => runSettingCommit(
							settings.setGaplessEnabled(event.currentTarget.checked),
						)}
					/>
					<span>同专辑无缝衔接</span>
				</label>
				<label className="playback-audio-settings__toggle">
					<input
						type="checkbox"
						checked={settings.preference.crossfadeEnabled}
						disabled={!settings.preference.gaplessEnabled}
						onChange={(event) => runSettingCommit(
							settings.setCrossfadeEnabled(event.currentTarget.checked),
						)}
					/>
					<span>等功率交叉淡化</span>
				</label>
			</fieldset>

			<fieldset className="playback-audio-settings__group" disabled={routingDisabled}>
				<legend>主输出</legend>
				<label>
					<span>播放设备</span>
					<select
						value={selectedPrimary}
						onChange={(event) => runSettingCommit(
							settings.setPrimaryOutputId(event.currentTarget.value),
						)}
					>
						<option value="">系统默认输出</option>
						{settings.devices.map((device) => (
							<option key={device.deviceId} value={device.deviceId}>
								{outputDeviceLabel(device)}
							</option>
						))}
						{primaryMissing ? (
							<option value={settings.output.primary.deviceId}>
								{settings.output.primary.label}（不可用）
							</option>
						) : null}
					</select>
					<OutputStateBadge target={settings.output.primary} />
				</label>
			</fieldset>

			<fieldset className="playback-audio-settings__group" disabled={routingDisabled}>
				<legend>镜像输出（最多 4 个）</legend>
				{mirrorRows.length ? mirrorRows.map((row) => {
					const checked = mirrorTargetsById.has(row.deviceId);
					const isPrimary = row.deviceId === selectedPrimary;
					return (
						<label key={row.deviceId} className="playback-audio-settings__toggle">
							<input
								type="checkbox"
								checked={checked}
								disabled={isPrimary || (!checked && mirrorLimitReached)}
								onChange={() => runSettingCommit(
									settings.toggleMirrorOutput(row.deviceId),
								)}
							/>
							<span>{row.label}</span>
							{row.target ? <OutputStateBadge target={row.target} /> : null}
						</label>
					);
				}) : <p>请先刷新输出设备。</p>}
			</fieldset>

			<fieldset className="playback-audio-settings__group" disabled={routingDisabled}>
				<legend>虚拟设备桥接</legend>
				<p>将播放器主输出发送到虚拟音频设备，不会开启麦克风采集。</p>
				<select
					value={settings.output.bridge?.deviceId ?? ""}
					onChange={(event) => runSettingCommit(
						settings.setVirtualBridgeSinkId(event.currentTarget.value),
					)}
				>
					<option value="">关闭虚拟设备桥接</option>
					{virtualDevices.map((device) => (
						<option key={device.deviceId} value={device.deviceId}>
							{outputDeviceLabel(device, "虚拟输出")}
						</option>
					))}
					{bridgeMissing && settings.output.bridge ? (
						<option value={settings.output.bridge.deviceId}>
							{settings.output.bridge.label}（不可用）
						</option>
					) : null}
				</select>
				{settings.output.bridge
					? <OutputStateBadge target={settings.output.bridge} />
					: null}
				{virtualDevices.length === 0 ? <small>未检测到虚拟音频输出设备。</small> : null}
			</fieldset>
		</section>
	);
}

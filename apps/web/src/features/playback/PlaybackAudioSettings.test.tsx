import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PLAYBACK_AUDIO_PREFERENCE } from "../../preferences/keys";
import {
	PlaybackAudioSettings,
} from "./PlaybackAudioSettings";
import type { PlaybackAudioSettingsResult } from "./usePlaybackAudioSettings";

function settingsFixture(
	overrides: Partial<PlaybackAudioSettingsResult> = {},
): PlaybackAudioSettingsResult {
	return {
		hydrated: true,
		busy: false,
		refreshing: false,
		controllerReady: true,
		outputSupported: true,
		routing: null,
		output: {
			primary: {
				deviceId: "",
				label: "系统默认输出",
				state: "ready-or-playing",
			},
			mirrors: [],
			bridge: null,
		},
		preference: PLAYBACK_AUDIO_PREFERENCE.defaultValue(),
		devices: [
			{ deviceId: "speaker", label: "桌面扬声器", groupId: "g1", isDefault: false },
			{ deviceId: "cable", label: "VB-Audio Cable Input", groupId: "g2", isDefault: false },
		],
		error: null,
		setFadeInMs: async () => undefined,
		setFadeOutMs: async () => undefined,
		setGaplessEnabled: async () => undefined,
		setCrossfadeEnabled: async () => undefined,
		setPrimaryOutputId: async () => undefined,
		toggleMirrorOutput: async () => undefined,
		setVirtualBridgeSinkId: async () => undefined,
		handleControllerReady: async () => undefined,
		applyToController: async () => undefined,
		setPanelOpen: () => undefined,
		refreshDevices: async () => undefined,
		...overrides,
	};
}

test("音频设置面板呈现 fade、gapless、crossfade 和三类输出路由", () => {
	const html = renderToStaticMarkup(
		<PlaybackAudioSettings settings={settingsFixture()} active={true} />,
	);

	expect(html).toContain("播放过渡");
	expect(html).toContain("淡入");
	expect(html).toContain("淡出");
	expect(html).toContain('min="0"');
	expect(html).toContain('max="3"');
	expect(html).toContain("同专辑无缝衔接");
	expect(html).toContain("等功率交叉淡化");
	expect(html).toContain("刷新输出设备");
	expect(html).toContain("系统默认输出");
	expect(html).toContain("镜像输出（最多 4 个）");
	expect(html).toContain("桌面扬声器");
	expect(html).toContain("虚拟设备桥接");
	expect(html).toContain("VB-Audio Cable Input");
});

test("不支持 setSinkId 时显示明确提示并禁用路由设置", () => {
	const html = renderToStaticMarkup(
		<PlaybackAudioSettings
			settings={settingsFixture({ outputSupported: false })}
			active={true}
		/>,
	);

	expect(html).toContain("当前内核不支持输出设备切换");
	expect(html).toContain("disabled");
});

test("镜像设备失败时显示 unavailable 而不是伪造已连接", () => {
	const preference = {
		...PLAYBACK_AUDIO_PREFERENCE.defaultValue(),
		mirrorOutputIds: ["speaker"],
	};
	const html = renderToStaticMarkup(
		<PlaybackAudioSettings
			settings={settingsFixture({
				preference,
				output: {
					primary: {
						deviceId: "",
						label: "系统默认输出",
						state: "ready-or-playing",
					},
					mirrors: [{
						deviceId: "speaker",
						label: "桌面扬声器",
						state: "unavailable",
					}],
					bridge: null,
				},
				routing: {
					enabled: true,
					requestedPrimarySinkId: "",
					effectivePrimarySinkId: "",
					mirrorSinkIds: ["speaker"],
					virtualBridgeSinkId: "",
					fellBackToDefault: false,
					errors: [{
						target: "mirror",
						sinkId: "speaker",
						name: "NotFoundError",
						message: "device removed",
					}],
				},
			})}
		/>,
	);

	expect(html).toContain("1 个镜像输出不可用");
	expect(html).not.toContain("已启用 1 个镜像");
});

test("已选但已消失的镜像仍显示在面板中并标记为不可用", () => {
	const preference = {
		...PLAYBACK_AUDIO_PREFERENCE.defaultValue(),
		mirrorOutputIds: ["missing-mirror"],
	};
	const html = renderToStaticMarkup(
		<PlaybackAudioSettings
			settings={settingsFixture({
				preference,
				devices: [],
				output: {
					primary: {
						deviceId: "",
						label: "系统默认输出",
						state: "ready-or-playing",
					},
					mirrors: [{
						deviceId: "missing-mirror",
						label: "输出设备 missing-",
						state: "unavailable",
					}],
					bridge: null,
				},
			})}
		/>,
	);

	expect(html).toContain("输出设备 missing-");
	expect(html).toContain("不可用");
	expect(html).not.toContain("已启用 1 个镜像");
	expect(html).not.toContain("已连接");
});

test("路由提交期间控件选择与 typed pending 目标保持一致", () => {
	const html = renderToStaticMarkup(
		<PlaybackAudioSettings
			settings={settingsFixture({
				busy: true,
				output: {
					primary: {
						deviceId: "speaker",
						label: "桌面扬声器",
						state: "pending",
					},
					mirrors: [],
					bridge: null,
				},
			})}
		/>,
	);

	expect(html).toContain('<option value="speaker" selected="">桌面扬声器</option>');
	expect(html).toContain('data-output-state="pending"');
	expect(html).toContain("正在应用");
});

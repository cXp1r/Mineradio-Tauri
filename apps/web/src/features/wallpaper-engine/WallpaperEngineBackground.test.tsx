import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	WallpaperProjectSummary,
	WallpaperRuntimeState,
} from "../../ports/wallpaper-engine-runtime-port";
import { WallpaperEngineBackground } from "./WallpaperEngineBackground";

const project: WallpaperProjectSummary = {
	id: "a".repeat(24),
	title: "Wallpaper",
	projectType: "video",
	mediaType: "video",
	playable: true,
	enginePlayable: false,
	previewOnly: false,
	safetyMode: "directMedia",
	source: "imported",
	sourceLabel: "test",
	hasPreview: true,
	previewAnimated: false,
	updatedAt: 1,
	mediaUrl: `http://mineradio-wallpaper.localhost/project/${"a".repeat(24)}/media?revision=1`,
};

const activeScene: WallpaperRuntimeState = {
	available: true,
	phase: "active",
	pending: false,
	active: true,
	projectId: "a".repeat(24),
	sessionId: "a".repeat(24),
	sourceId: "source",
	captureMode: "dwmThumbnail",
	sourceWindowAligned: true,
	dwmSurfaceReady: true,
	glassSamplerReady: false,
	audioMuted: true,
	cleanupRequired: false,
	fullDesktopMode: "disabled",
};

test("direct media is rendered as a full application background instead of a control-panel preview", () => {
	const html = renderToStaticMarkup(<WallpaperEngineBackground
		project={project}
		runtime={null}
		fullDesktopMode="disabled"
	/>);

	expect(html).toContain('data-wallpaper-engine-background="video"');
	expect(html).toContain("<video");
	expect(html).toContain('class="wallpaper-engine-background-media"');
	expect(html).toContain(`src="http://mineradio-wallpaper.localhost/project/${"a".repeat(24)}/media?revision=1"`);
});

test("an active native Scene leaves a transparent marker for the DWM surface", () => {
	const html = renderToStaticMarkup(<WallpaperEngineBackground
		project={{ ...project, projectType: "scene", safetyMode: "nativeEngine", enginePlayable: true }}
		runtime={activeScene}
		fullDesktopMode="interactive"
	/>);

	expect(html).toContain('data-wallpaper-engine-background="scene"');
	expect(html).not.toContain("<img");
	expect(html).not.toContain("<video");
});

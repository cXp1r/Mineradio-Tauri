import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WallpaperProjectSummary } from "../../ports/wallpaper-engine-runtime-port";
import { WallpaperEngineControls } from "./WallpaperEngineControls";

const projectId = "b".repeat(24);
const directVideo: WallpaperProjectSummary = {
	id: projectId,
	title: "Direct video",
	projectType: "video",
	mediaType: "video",
	playable: true,
	enginePlayable: false,
	previewOnly: false,
	safetyMode: "directMedia",
	source: "imported",
	sourceLabel: "test",
	hasPreview: true,
	previewAnimated: true,
	previewMediaType: "video",
	updatedAt: 1,
	mediaUrl: `http://mineradio-wallpaper.localhost/project/${projectId}/media?revision=1`,
	previewUrl: `http://mineradio-wallpaper.localhost/project/${projectId}/preview?revision=1`,
};

test("control panel never starts a second decoder for a direct video background", () => {
	const html = renderToStaticMarkup(<WallpaperEngineControls
		library={{ projects: [directVideo], roots: [], updatedAt: 1 }}
		selected={directVideo}
		runtime={null}
		busy={false}
		error={null}
		refresh={async () => {}}
		select={async () => {}}
		importDirectory={async () => {}}
		importProjectFile={async () => {}}
		removeDirectory={async () => {}}
		startScene={async () => {}}
		stopScene={async () => {}}
		recover={async () => {}}
		preparePassiveFallback={async () => {}}
		fullDesktopMode="disabled"
	/>);

	expect(html).not.toContain("<video");
	expect(html).not.toContain(directVideo.mediaUrl!);
});

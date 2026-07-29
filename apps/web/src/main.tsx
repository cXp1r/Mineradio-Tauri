import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import {
	applyHydratedShellPreferencesSnapshot,
	loadHydratedShellPreferencesSnapshot,
} from "./app/runtime/useShellPreferences";
import { DesktopLyricsRoot, isDesktopLyricsRoute } from "./desktop-lyrics/DesktopLyricsRoot";
import {
	createHomeListenLegacyPreferenceMapping,
	createPreferencesHomeListenRepository,
} from "./features/home/home-preferences-adapter";
import { configureSearchPreferences } from "./features/search/search-session-runtime";
import { createPreferencesRepository } from "./preferences/create-preferences-repository";
import "./styles.css";

const isM4ParityRoute = new URLSearchParams(window.location.search).get("m4-parity") === "1";

async function createApplicationRoot(): Promise<React.ReactNode> {
	if (isDesktopLyricsRoute(window.location)) {
		document.body.classList.add("desktop-lyrics-root");
		return <DesktopLyricsRoot />;
	}
	if (isM4ParityRoute) {
		return React.createElement(
			React.lazy(() =>
				import("./visual/parity/M4ParityRoot").then((module) => ({
					default: module.M4ParityRoot,
				})),
			),
		);
	}
	try {
		const preferences = await createPreferencesRepository({
			additionalLegacyMappings: [createHomeListenLegacyPreferenceMapping()],
		});
		await configureSearchPreferences(preferences);
		const hydratedPreferences =
			await loadHydratedShellPreferencesSnapshot(preferences);
		// React 首次读取 Zustand 前先应用 canonical 快照，避免 legacy 首帧闪回。
		applyHydratedShellPreferencesSnapshot(hydratedPreferences);
		const homeListenRepository =
			await createPreferencesHomeListenRepository(preferences);
		return (
			<App
				preferences={preferences}
				hydratedPreferences={hydratedPreferences}
				homeListenRepository={homeListenRepository}
			/>
		);
	} catch (error) {
		// 偏好存储故障不能阻止播放器启动；各 legacy Adapter 仍可回退读取。
		console.warn("M8 preferences bootstrap failed", error);
		return <App />;
	}
}

void createApplicationRoot().then((root) => {
	createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<React.Suspense fallback={null}>{root}</React.Suspense>
		</React.StrictMode>,
	);
});

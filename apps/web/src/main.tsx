import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { DesktopLyricsRoot, isDesktopLyricsRoute } from "./desktop-lyrics/DesktopLyricsRoot";
import "./styles.css";

const isM4ParityRoute = new URLSearchParams(window.location.search).get("m4-parity") === "1";

const root = isDesktopLyricsRoute(window.location)
	? <DesktopLyricsRoot />
	: isM4ParityRoute
		? React.createElement(React.lazy(() => import("./visual/parity/M4ParityRoot").then((module) => ({ default: module.M4ParityRoot }))))
		: <App />;

if (isDesktopLyricsRoute(window.location)) {
	document.body.classList.add("desktop-lyrics-root");
}

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<React.Suspense fallback={null}>{root}</React.Suspense>
	</React.StrictMode>
);

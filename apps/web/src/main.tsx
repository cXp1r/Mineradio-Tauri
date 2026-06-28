import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { DesktopLyricsRoot, isDesktopLyricsRoute } from "./desktop-lyrics/DesktopLyricsRoot";
import "./styles.css";

const root = isDesktopLyricsRoute(window.location) ? (
	<DesktopLyricsRoot />
) : (
	<App />
);

if (isDesktopLyricsRoute(window.location)) {
	document.body.classList.add("desktop-lyrics-root");
}

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		{root}
	</React.StrictMode>
);

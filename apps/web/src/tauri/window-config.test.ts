import { expect, test } from "bun:test";
import tauriConfig from "../../../desktop/src-tauri/tauri.conf.json";

test("main transparent frameless window disables native shadow to avoid a visible rounded border", () => {
	const mainWindow = tauriConfig.app.windows.find((window) => window.label === "main");

	expect(mainWindow).not.toBe(undefined);
	expect(mainWindow?.decorations).toBe(false);
	expect(mainWindow?.transparent).toBe(true);
	expect(mainWindow?.shadow).toBe(false);
});

test("production CSP allows required desktop runtime sources", () => {
	const csp = tauriConfig.app.security.csp;
	const devCsp = tauriConfig.app.security.devCsp;

	expect(csp).toContain("style-src 'self' 'unsafe-inline'");
	expect(csp).toContain("http://ipc.localhost");
	expect(csp).toContain("http://*.music.126.net");
	expect(csp).toContain("https://*.music.126.net");
	expect(csp).toContain("http://*.y.qq.com");
	expect(csp).toContain("https://*.y.qq.com");
	expect(csp).toContain("https://*.douyinpic.com");
	expect(csp).toContain("media-src 'self' blob: http://127.0.0.1:*");
	expect(devCsp).toContain("http://*.y.qq.com");
	expect(devCsp).toContain("https://*.y.qq.com");
	expect(devCsp).toContain("https://*.douyinpic.com");
});

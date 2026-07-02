import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const worktreeRoot = process.env.MINERADIO_PERF_WORKTREE_ROOT
	? path.resolve(process.env.MINERADIO_PERF_WORKTREE_ROOT)
	: path.join(os.tmpdir(), "mineradio-perf-worktrees");
const resultRoot = path.join(repoRoot, "tmp", "perf-results");
const docsRoot = path.join(repoRoot, "docs");

const versions = [
	{
		key: "electron-original",
		label: "Electron 原项目",
		ref: "6b13010",
		path: path.join(worktreeRoot, "electron-original"),
		kind: "electron",
	},
	{
		key: "tauri-baseline",
		label: "Tauri 优化前",
		ref: "9d590d2",
		path: path.join(worktreeRoot, "tauri-baseline"),
		kind: "tauri",
	},
	{
		key: "tauri-optimized",
		label: "Tauri 当前优化版",
		ref: "HEAD",
		path: path.join(worktreeRoot, "tauri-optimized"),
		kind: "tauri",
	},
];

function quoteArg(value) {
	const raw = String(value);
	if (!/[^\w./:@\\=-]/.test(raw)) return raw;
	return `"${raw.replace(/"/g, '\\"')}"`;
}

function run(command, args, cwd, opts = {}) {
	const commandLine = [command, ...args].map(quoteArg).join(" ");
	const result = spawnSync(commandLine, {
		cwd,
		env: { ...process.env, ...(opts.env ?? {}) },
		encoding: "utf8",
		shell: true,
		stdio: opts.capture ? "pipe" : "inherit",
		timeout: opts.timeoutMs,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = opts.capture ? `\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}` : "";
		throw new Error(`Command failed (${result.status}): ${commandLine}${detail}`);
	}
	return result;
}

function ensureDir(dir) {
	mkdirSync(dir, { recursive: true });
}

function ensureWorktrees() {
	ensureDir(worktreeRoot);
	for (const version of versions) {
		const targetRef = version.ref === "HEAD"
			? run("git", ["rev-parse", "HEAD"], repoRoot, { capture: true }).stdout.trim()
			: version.ref;
		if (existsSync(path.join(version.path, ".git"))) {
			run("git", ["checkout", "--detach", targetRef], version.path);
			continue;
		}
		run("git", ["worktree", "add", "--detach", version.path, targetRef], repoRoot);
	}
}

function ensureDependencies() {
	for (const version of versions) {
		if (version.kind === "tauri") {
			if (!existsSync(path.join(version.path, "node_modules"))) {
				run("bun", ["install"], version.path);
			}
			continue;
		}
		if (!existsSync(path.join(version.path, "node_modules", "electron"))) {
			run("npm", ["ci"], version.path);
		}
	}
}

function collectDistStats(root) {
	const stats = { totalBytes: 0, jsBytes: 0, cssBytes: 0, fileCount: 0 };
	function walk(dir) {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const full = path.join(dir, name);
			const item = statSync(full);
			if (item.isDirectory()) {
				walk(full);
				continue;
			}
			stats.fileCount += 1;
			stats.totalBytes += item.size;
			if (name.endsWith(".js")) stats.jsBytes += item.size;
			else if (name.endsWith(".css")) stats.cssBytes += item.size;
		}
	}
	walk(root);
	return stats;
}

function buildTauriWeb(version) {
	cleanupTauriHarness(version);
	run("bun", ["run", "web:build"], version.path, { timeoutMs: 120_000 });
	return collectDistStats(path.join(version.path, "apps", "web", "dist"));
}

function cleanupTauriHarness(version) {
	for (const relativePath of [
		path.join("apps", "web", "src", "__perf_render_harness__.ts"),
		path.join("apps", "web", "__perf_render_harness__.ts"),
	]) {
		const fullPath = path.join(version.path, relativePath);
		if (existsSync(fullPath)) rmSync(fullPath, { force: true });
	}
}

function collectOriginalStaticStats(version) {
	return {
		totalBytes:
			statSync(path.join(version.path, "public", "index.html")).size +
			collectDistStats(path.join(version.path, "public", "vendor")).totalBytes,
		jsBytes: collectDistStats(path.join(version.path, "public", "vendor")).jsBytes,
		cssBytes: 0,
		fileCount: 1 + collectDistStats(path.join(version.path, "public", "vendor")).fileCount,
	};
}

function writeTauriRenderHarness(version) {
	const harnessPath = path.join(version.path, "apps", "web", "__perf_render_harness__.ts");
	ensureDir(path.dirname(harnessPath));
	writeFileSync(
		harnessPath,
		String.raw`
import React from "react";
import { performance } from "node:perf_hooks";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { LyricPayload, PlaylistDetail, PlaylistSummary, PodcastCollection, Track } from "@mineradio/shared";
import { LyricView } from "./src/components/lyrics/LyricView";
import { PlaylistPanelHost } from "./src/components/shell/PlaylistPanelHost";
import { SearchShell } from "./src/components/shell/SearchShell";
import { PlayerConsoleHost } from "./src/visual/PlayerConsoleHost";
import { useSearchStore } from "./src/stores/search-store";
import { buildEdgeAndDepthCanvas } from "../../packages/visual-engine/src/home-visual/cover-depth";

await import("../../packages/visual-engine/src/runtime/happy-dom-preload");

function makeTrack(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: "Song " + id,
		artists: ["Alice"],
		album: "Album",
		coverUrl: "",
		durationMs: 180000,
		qualityHints: [],
		playableState: "playable",
	};
}

function makePodcastCollection(index: number): PodcastCollection {
	return {
		key: "podcast-" + index,
		title: "Podcast " + index,
		sub: "Radio",
		itemType: "radio",
		count: index,
		coverUrl: "",
	};
}

function makeLyricPayload(count: number): LyricPayload {
	return {
		provider: "netease",
		trackId: "lyric-perf",
		lines: Array.from({ length: count }, (_, index) => ({
			timeMs: index * 1000,
			text: "Lyric line " + index,
		})),
		hasTranslation: false,
		isWordByWord: false,
	};
}

function gcNow(): void {
	try {
		(globalThis as unknown as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc?.(true);
	} catch {}
}

function median(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function summarize(samples: Array<Record<string, number>>): Record<string, number> {
	const keys = Object.keys(samples[0] ?? {});
	const out: Record<string, number> = {};
	for (const key of keys) out[key] = median(samples.map((sample) => sample[key] ?? 0));
	return out;
}

async function mount(element: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	flushSync(() => root.render(element));
	await new Promise((resolve) => setTimeout(resolve, 0));
	return {
		container,
		unmount: () => {
			root.unmount();
			container.remove();
		},
	};
}

async function measureScenario(name: string, scenario: () => Promise<Record<string, number>>): Promise<Record<string, number>> {
	const samples: Array<Record<string, number>> = [];
	for (let i = 0; i < 9; i += 1) {
		gcNow();
		const heapBefore = process.memoryUsage().heapUsed;
		const cpuBefore = process.cpuUsage();
		const t0 = performance.now();
		const data = await scenario();
		const wallMs = performance.now() - t0;
		const cpu = process.cpuUsage(cpuBefore);
		gcNow();
		const heapAfter = process.memoryUsage().heapUsed;
		if (i >= 2) {
			samples.push({
				...data,
				wallMs,
				cpuMs: (cpu.user + cpu.system) / 1000,
				heapDeltaBytes: heapAfter - heapBefore,
			});
		}
	}
	return { name, ...summarize(samples) };
}

async function measureQueuePanel(): Promise<Record<string, number>> {
	const queue = Array.from({ length: 240 }, (_, index) => makeTrack(String(index)));
	const { container, unmount } = await mount(
		React.createElement(PlaylistPanelHost, {
			open: true,
			tab: "queue",
			queue,
			currentTrack: queue[0] ?? null,
			mode: "loop",
			playlists: [],
			podcastCollections: [],
			onTabChange: () => undefined,
		}),
	);
	const rowCount = container.querySelectorAll(".queue-item").length;
	const nodeCount = container.querySelectorAll("*").length;
	const virtualized = container.querySelector("#queue-list")?.getAttribute("data-virtualized") === "true" ? 1 : 0;
	unmount();
	return { rowCount, nodeCount, virtualized };
}

async function measurePlaylistDetail(): Promise<Record<string, number>> {
	const playlist: PlaylistSummary = {
		provider: "netease",
		id: "pl-big",
		name: "超大歌单",
		coverUrl: "",
		trackCount: 600,
		trackIds: [],
		subscribed: false,
	};
	const tracks = Array.from({ length: 600 }, (_, index) => makeTrack(String(index)));
	const { container, unmount } = await mount(
		React.createElement(PlaylistPanelHost, {
			open: true,
			tab: "playlists",
			queue: [],
			currentTrack: null,
			mode: "loop",
			playlists: [playlist],
			podcastCollections: [],
			onTabChange: () => undefined,
			onLoadPlaylistDetail: async (): Promise<PlaylistDetail> => ({ ...playlist, tracks }),
		}),
	);
	(container.querySelector(".pl-card") as HTMLDivElement).click();
	for (let i = 0; i < 12 && !container.querySelector("[data-pl-detail]"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const rowCount = container.querySelectorAll(".pl-detail-row").length;
	const nodeCount = container.querySelectorAll("*").length;
	const virtualized = container.querySelector(".pl-detail-list")?.getAttribute("data-virtualized") === "true" ? 1 : 0;
	unmount();
	return { rowCount, nodeCount, virtualized };
}

async function measurePodcastCollections(): Promise<Record<string, number>> {
	const podcastCollections = Array.from({ length: 180 }, (_, index) => makePodcastCollection(index));
	const { container, unmount } = await mount(
		React.createElement(PlaylistPanelHost, {
			open: true,
			tab: "podcasts",
			queue: [],
			currentTrack: null,
			mode: "loop",
			playlists: [],
			podcastCollections,
			onTabChange: () => undefined,
		}),
	);
	const rowCount = container.querySelectorAll(".podcast-card").length;
	const nodeCount = container.querySelectorAll("*").length;
	const virtualized = container.querySelector("#podcast-list")?.getAttribute("data-virtualized") === "true" ? 1 : 0;
	unmount();
	return { rowCount, nodeCount, virtualized };
}

async function measureMiniQueue(): Promise<Record<string, number>> {
	const queue = Array.from({ length: 240 }, (_, index) => makeTrack(String(index)));
	const { container, unmount } = await mount(
		React.createElement(PlayerConsoleHost, {
			miniQueueOpen: true,
			queue,
			currentTrack: queue[0] ?? null,
		}),
	);
	const rowCount = container.querySelectorAll(".mini-queue-item").length;
	const nodeCount = container.querySelectorAll("*").length;
	const virtualized = container.querySelector("#mini-queue-list")?.getAttribute("data-virtualized") === "true" ? 1 : 0;
	unmount();
	return { rowCount, nodeCount, virtualized };
}

async function measureLyricView(): Promise<Record<string, number>> {
	const { container, unmount } = await mount(
		React.createElement(LyricView, {
			payload: makeLyricPayload(240),
			positionMs: 2200,
		}),
	);
	const rowCount = container.querySelectorAll(".lyric-line").length;
	const nodeCount = container.querySelectorAll("*").length;
	const virtualized = container.querySelector(".lyric-lines")?.getAttribute("data-virtualized") === "true" ? 1 : 0;
	unmount();
	return { rowCount, nodeCount, virtualized };
}

async function measureSearchResults(): Promise<Record<string, number>> {
	const results = Array.from({ length: 180 }, (_, index) => makeTrack(String(index)));
	useSearchStore.setState({
		results,
		loading: false,
		error: null,
		provider: "netease",
		keyword: "Song",
	});
	const { container, unmount } = await mount(
		React.createElement(SearchShell, {
			client: null,
		}),
	);
	const rowCount = container.querySelectorAll(".search-shell-row").length;
	const nodeCount = container.querySelectorAll("*").length;
	const virtualized = container.querySelector(".search-shell-list")?.getAttribute("data-virtualized") === "true" ? 1 : 0;
	unmount();
	useSearchStore.setState({
		results: [],
		loading: false,
		error: null,
		provider: "netease",
		keyword: "",
	});
	return { rowCount, nodeCount, virtualized };
}

function makeSourceCanvas(width: number, height: number, data: Uint8ClampedArray) {
	return {
		width,
		height,
		getContext() {
			return {
				drawImage() {},
				getImageData() {
					return { data };
				},
			};
		},
	};
}

function makeOutputCanvas(sourceData?: Uint8ClampedArray) {
	const out = {
		width: 0,
		height: 0,
		imageData: null as { data: Uint8ClampedArray; width: number; height: number } | null,
		getContext() {
			return {
				drawImage() {},
				getImageData() {
					return { data: sourceData ?? new Uint8ClampedArray(256 * 256 * 4) };
				},
				createImageData(width: number, height: number) {
					return { data: new Uint8ClampedArray(width * height * 4), width, height };
				},
				putImageData(imageData: { data: Uint8ClampedArray; width: number; height: number }) {
					out.imageData = imageData;
				},
			};
		},
	};
	return out;
}

async function measureCoverDepthBuild(): Promise<Record<string, number>> {
	const srcData = new Uint8ClampedArray(256 * 256 * 4);
	for (let y = 0; y < 256; y += 1) {
		for (let x = 0; x < 256; x += 1) {
			const i = (y * 256 + x) * 4;
			const v = (x * 17 + y * 31) & 255;
			srcData[i] = v;
			srcData[i + 1] = (v * 3) & 255;
			srcData[i + 2] = 255 - v;
			srcData[i + 3] = 255;
		}
	}
	const source = makeSourceCanvas(256, 256, srcData);
	let largeAllocations = 0;
	const realFloat32Array = globalThis.Float32Array;
	(globalThis as unknown as { Float32Array: Float32ArrayConstructor }).Float32Array = new Proxy(realFloat32Array, {
		construct(target, args) {
			if (args[0] === 256 * 256) largeAllocations += 1;
			return Reflect.construct(target, args);
		},
	}) as Float32ArrayConstructor;
	try {
		const normalized = makeOutputCanvas(srcData);
		const output = makeOutputCanvas();
		buildEdgeAndDepthCanvas(source as never, {
			createCanvas: (width, height) => {
				const canvas = normalized.width === 0 ? normalized : output;
				canvas.width = width;
				canvas.height = height;
				return canvas as never;
			},
		});
		return {
			largeFloat32Allocations: largeAllocations,
			largeFloat32Bytes: largeAllocations * 256 * 256 * 4,
			outputBytes: output.imageData?.data.byteLength ?? 0,
		};
	} finally {
		(globalThis as unknown as { Float32Array: Float32ArrayConstructor }).Float32Array = realFloat32Array;
	}
}

const results = {
	queuePanel: await measureScenario("queuePanel", measureQueuePanel),
	playlistDetail: await measureScenario("playlistDetail", measurePlaylistDetail),
	podcastCollections: await measureScenario("podcastCollections", measurePodcastCollections),
	miniQueue: await measureScenario("miniQueue", measureMiniQueue),
	lyricView: await measureScenario("lyricView", measureLyricView),
	searchResults: await measureScenario("searchResults", measureSearchResults),
	coverDepthBuild: await measureScenario("coverDepthBuild", measureCoverDepthBuild),
};

console.log("PERF_JSON:" + JSON.stringify(results));
`,
		"utf8",
	);
	return harnessPath;
}

function runTauriRenderBenchmark(version) {
	const harnessPath = writeTauriRenderHarness(version);
	const result = run("bun", [path.relative(version.path, harnessPath)], version.path, {
		capture: true,
		timeoutMs: 120_000,
	});
	const marker = (result.stdout ?? "").split(/\r?\n/).find((line) => line.startsWith("PERF_JSON:"));
	if (!marker) throw new Error(`Missing PERF_JSON from ${version.key} render benchmark:\n${result.stdout}\n${result.stderr}`);
	return JSON.parse(marker.slice("PERF_JSON:".length));
}

function writeElectronPageHarness(electronVersion) {
	const harnessPath = path.join(electronVersion.path, "tmp", "electron-page-metrics.cjs");
	ensureDir(path.dirname(harnessPath));
	writeFileSync(
		harnessPath,
		String.raw`
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

app.commandLine.appendSwitch("enable-precise-memory-info");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const target = JSON.parse(fs.readFileSync(process.env.MINERADIO_PERF_TARGET, "utf8"));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findOpenPort(startPort) {
	return new Promise((resolve, reject) => {
		function tryPort(port) {
			const server = net.createServer();
			server.once("error", (error) => {
				if (error.code === "EADDRINUSE" || error.code === "EACCES") tryPort(port + 1);
				else reject(error);
			});
			server.once("listening", () => server.close(() => resolve(port)));
			server.listen(port, "127.0.0.1");
		}
		tryPort(startPort);
	});
}

function registerNoopIpcHandlers() {
	const channels = [
		"desktop-window-minimize",
		"desktop-window-toggle-maximize",
		"desktop-window-toggle-fullscreen",
		"desktop-window-exit-fullscreen-windowed",
		"desktop-window-close",
		"netease-music-open-login",
		"netease-music-clear-login",
		"qq-music-open-login",
		"qq-music-clear-login",
		"mineradio-open-update-installer",
		"mineradio-restart-app",
		"mineradio-export-json-file",
		"mineradio-import-json-file",
		"mineradio-desktop-lyrics-set-enabled",
		"mineradio-desktop-lyrics-update",
		"mineradio-wallpaper-set-enabled",
		"mineradio-wallpaper-update",
	];
	for (const channel of channels) {
		ipcMain.handle(channel, () => ({ ok: true }));
	}
	ipcMain.handle("desktop-window-get-state", () => ({ maximized: false, fullscreen: false, focused: true }));
	ipcMain.handle("mineradio-hotkeys-configure-global", () => ({ ok: true, results: [] }));
}

function summarizeAppMetrics() {
	const byType = {};
	let workingSetKb = 0;
	let privateKb = 0;
	let cpuPercent = 0;
	for (const metric of app.getAppMetrics()) {
		const type = metric.type || "unknown";
		if (!byType[type]) byType[type] = { count: 0, workingSetKb: 0, privateKb: 0, cpuPercent: 0 };
		byType[type].count += 1;
		byType[type].workingSetKb += metric.memory?.workingSetSize ?? 0;
		byType[type].privateKb += metric.memory?.privateBytes ?? 0;
		byType[type].cpuPercent += metric.cpu?.percentCPUUsage ?? 0;
		workingSetKb += metric.memory?.workingSetSize ?? 0;
		privateKb += metric.memory?.privateBytes ?? 0;
		cpuPercent += metric.cpu?.percentCPUUsage ?? 0;
	}
	return { workingSetKb, privateKb, cpuPercent, byType };
}

function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function startTargetServer() {
	if (target.kind === "static-dir") {
		const port = await findOpenPort(4210);
		const root = path.resolve(target.root);
		const mime = {
			".html": "text/html; charset=utf-8",
			".js": "application/javascript; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".json": "application/json; charset=utf-8",
			".png": "image/png",
			".jpg": "image/jpeg",
			".svg": "image/svg+xml",
			".ico": "image/x-icon",
		};
		const server = http.createServer((req, res) => {
			try {
				const url = new URL(req.url || "/", "http://127.0.0.1");
				let pathname = decodeURIComponent(url.pathname);
				if (pathname === "/") pathname = "/index.html";
				const fullPath = path.resolve(root, "." + pathname);
				if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
					res.writeHead(403);
					res.end("Forbidden");
					return;
				}
				fs.readFile(fullPath, (error, data) => {
					if (error) {
						res.writeHead(404);
						res.end("Not Found");
						return;
					}
					res.writeHead(200, { "Content-Type": mime[path.extname(fullPath)] || "application/octet-stream" });
					res.end(data);
				});
			} catch (error) {
				res.writeHead(500);
				res.end(String(error && error.message ? error.message : error));
			}
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", resolve);
		});
		return {
			url: "http://127.0.0.1:" + port,
			close: async () => new Promise((resolve) => server.close(resolve)),
		};
	}
	if (target.kind !== "electron-original") return { url: target.url, close: async () => {} };
	const port = await findOpenPort(3210);
	process.env.HOST = "127.0.0.1";
	process.env.PORT = String(port);
	process.env.COOKIE_FILE = path.join(target.root, "tmp", ".perf-cookie");
	process.env.QQ_COOKIE_FILE = path.join(target.root, "tmp", ".perf-qq-cookie");
	process.env.MINERADIO_UPDATE_DIR = path.join(target.root, "tmp", "updates");
	const server = require(path.join(target.root, "server.js"));
	if (!server.listening) await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	return {
		url: "http://127.0.0.1:" + port,
		close: async () => new Promise((resolve) => server.close(resolve)),
	};
}

async function main() {
	registerNoopIpcHandlers();
	await app.whenReady();
	const server = await startTargetServer();
	const win = new BrowserWindow({
		width: 1280,
		height: 720,
		show: false,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		webPreferences: {
			preload: target.preload || undefined,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			backgroundThrottling: false,
		},
	});
	const consoleMessages = [];
	win.webContents.on("console-message", (_event, level, message) => {
		if (consoleMessages.length < 12) consoleMessages.push({ level, message });
	});
	const t0 = Date.now();
	if (server.url) await win.loadURL(server.url);
	else await win.loadFile(target.file);
	const loadWallMs = Date.now() - t0;
	await wait(target.settleMs ?? 5000);
	summarizeAppMetrics();
	const samples = [];
	for (let i = 0; i < 7; i += 1) {
		await wait(500);
		samples.push(summarizeAppMetrics());
	}
	const pageScript = [
		"(() => {",
		"const nav = performance.getEntriesByType('navigation')[0];",
		"const resources = performance.getEntriesByType('resource');",
		"const transferBytes = resources.reduce((sum, item) => sum + (item.transferSize || item.encodedBodySize || 0), 0);",
		"return {",
		"title: document.title,",
		"readyState: document.readyState,",
		"domNodes: document.querySelectorAll('*').length,",
		"htmlChars: document.documentElement.outerHTML.length,",
		"bodyTextChars: document.body ? (document.body.innerText || '').length : 0,",
		"resourceCount: resources.length,",
		"resourceTransferBytes: transferBytes,",
		"navDurationMs: nav ? nav.duration : performance.now(),",
		"domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,",
		"jsHeapUsedBytes: performance.memory ? performance.memory.usedJSHeapSize : null,",
		"jsHeapTotalBytes: performance.memory ? performance.memory.totalJSHeapSize : null",
		"};",
		"})()",
	].join("");
	const page = await win.webContents.executeJavaScript(pageScript, true);
	win.destroy();
	await server.close();
	const sampleSummary = {
		workingSetKb: median(samples.map((sample) => sample.workingSetKb)),
		privateKb: median(samples.map((sample) => sample.privateKb)),
		cpuPercent: median(samples.map((sample) => sample.cpuPercent)),
	};
	console.log("PERF_JSON:" + JSON.stringify({
		target: target.key,
		loadWallMs,
		page,
		appMetrics: sampleSummary,
		consoleMessages,
	}));
	app.quit();
}

main().catch((error) => {
	console.error(error && error.stack ? error.stack : error);
	app.exit(1);
});
`,
		"utf8",
	);
	return harnessPath;
}

function runElectronPageMetric(electronVersion, target) {
	const harnessPath = writeElectronPageHarness(electronVersion);
	const targetPath = path.join(resultRoot, `${target.key}-electron-target.json`);
	writeFileSync(targetPath, JSON.stringify(target), "utf8");
	const electronBin = path.join(electronVersion.path, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
	const result = run(electronBin, [harnessPath], electronVersion.path, {
		capture: true,
		env: { MINERADIO_PERF_TARGET: targetPath },
		timeoutMs: 90_000,
	});
	const marker = (result.stdout ?? "").split(/\r?\n/).find((line) => line.startsWith("PERF_JSON:"));
	if (!marker) throw new Error(`Missing PERF_JSON from ${target.key} page benchmark:\n${result.stdout}\n${result.stderr}`);
	return JSON.parse(marker.slice("PERF_JSON:".length));
}

function collectSourceDerivedMetrics(version) {
	if (version.kind === "electron") {
		const html = readFileSync(path.join(version.path, "public", "index.html"), "utf8");
		return {
			indexHtmlChars: html.length,
			inlineScriptTags: (html.match(/<script\b/gi) ?? []).length,
			inlineStyleChars: (html.match(/<style\b[\s\S]*?<\/style>/gi) ?? []).reduce((sum, item) => sum + item.length, 0),
		};
	}
	const appSource = readFileSync(path.join(version.path, "apps", "web", "src", "app", "App.tsx"), "utf8");
	const coverDepthSource = readFileSync(path.join(version.path, "packages", "visual-engine", "src", "home-visual", "cover-depth.ts"), "utf8");
	const buildFunction = coverDepthSource.match(/export function buildEdgeAndDepthCanvas[\s\S]*?return out;\n}/)?.[0] ?? "";
	return {
		sidecarHiddenPollMs: Number((appSource.match(/SIDECAR_STATUS_HIDDEN_MAX_POLL_MS\s*=\s*(\d+)/) ?? [])[1] ?? 0),
		sidecarReadyMaxPollMs: Number((appSource.match(/SIDECAR_STATUS_READY_MAX_POLL_MS\s*=\s*(\d+)/) ?? [])[1] ?? 0),
		depthBuildLargeFloat32Sites: (buildFunction.match(/new Float32Array\(count\)/g) ?? []).length,
		hasVirtualListHelper: existsSync(path.join(version.path, "apps", "web", "src", "components", "shell", "virtual-list.ts")) ? 1 : 0,
	};
}

function bytesToMiB(bytes) {
	return bytes / 1024 / 1024;
}

function kbToMiB(kb) {
	return kb / 1024;
}

function formatNumber(value, digits = 1) {
	if (value == null || Number.isNaN(value)) return "n/a";
	return Number(value).toFixed(digits);
}

function pctDrop(before, after) {
	if (!before || before <= 0 || after == null) return null;
	return ((before - after) / before) * 100;
}

function pctChange(before, after) {
	if (!before || before <= 0 || after == null) return null;
	return ((after - before) / before) * 100;
}

function formatDrop(before, after) {
	const value = pctDrop(before, after);
	if (value == null) return "n/a";
	return `${formatNumber(value, 1)}%`;
}

function formatChange(before, after) {
	const value = pctChange(before, after);
	if (value == null) return "n/a";
	const sign = value > 0 ? "+" : "";
	return `${sign}${formatNumber(value, 1)}%`;
}

function metricTable(rows) {
	const widths = [];
	for (const row of rows) {
		row.forEach((cell, index) => {
			widths[index] = Math.max(widths[index] ?? 0, String(cell).length);
		});
	}
	return rows
		.map((row, rowIndex) => {
			const line = `| ${row.map((cell, index) => String(cell).padEnd(widths[index])).join(" | ")} |`;
			if (rowIndex !== 0) return line;
			return `${line}\n| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
		})
		.join("\n");
}

function buildReport(results) {
	const electron = results.versions["electron-original"];
	const baseline = results.versions["tauri-baseline"];
	const optimized = results.versions["tauri-optimized"];
	const baselineRender = baseline.render;
	const optimizedRender = optimized.render;
	const rows = [];
	rows.push("# MineRadio 三版本性能开销对比");
	rows.push("");
	rows.push(`生成时间: ${new Date().toISOString()}`);
	rows.push("");
	rows.push("## 版本");
	rows.push("");
	rows.push(metricTable([
		["版本", "Ref", "量测路径"],
		[electron.label, electron.ref, electron.path],
		[baseline.label, baseline.ref, baseline.path],
		[optimized.label, optimized.ref, optimized.path],
	]));
	rows.push("");
	rows.push("## 初始页面负载 (Electron 离屏窗口，同 1280x720)");
	rows.push("");
	rows.push(metricTable([
		["版本", "DOM 节点", "JS Heap MiB", "Electron RSS MiB", "CPU %", "导航 ms", "资源数"],
		[electron.label, electron.page.page.domNodes, formatNumber(bytesToMiB(electron.page.page.jsHeapUsedBytes), 1), formatNumber(kbToMiB(electron.page.appMetrics.workingSetKb), 1), formatNumber(electron.page.appMetrics.cpuPercent, 2), formatNumber(electron.page.page.navDurationMs, 1), electron.page.page.resourceCount],
		[baseline.label, baseline.page.page.domNodes, formatNumber(bytesToMiB(baseline.page.page.jsHeapUsedBytes), 1), formatNumber(kbToMiB(baseline.page.appMetrics.workingSetKb), 1), formatNumber(baseline.page.appMetrics.cpuPercent, 2), formatNumber(baseline.page.page.navDurationMs, 1), baseline.page.page.resourceCount],
		[optimized.label, optimized.page.page.domNodes, formatNumber(bytesToMiB(optimized.page.page.jsHeapUsedBytes), 1), formatNumber(kbToMiB(optimized.page.appMetrics.workingSetKb), 1), formatNumber(optimized.page.appMetrics.cpuPercent, 2), formatNumber(optimized.page.page.navDurationMs, 1), optimized.page.page.resourceCount],
	]));
	rows.push("");
	rows.push(`当前优化版相对 Tauri 优化前: 初始 JS Heap 变化 ${formatChange(baseline.page.page.jsHeapUsedBytes, optimized.page.page.jsHeapUsedBytes)}，Electron RSS 变化 ${formatChange(baseline.page.appMetrics.workingSetKb, optimized.page.appMetrics.workingSetKb)}，CPU 样本变化 ${formatChange(baseline.page.appMetrics.cpuPercent, optimized.page.appMetrics.cpuPercent)}。`);
	rows.push(`当前优化版相对 Electron 原项目: 初始 JS Heap 变化 ${formatChange(electron.page.page.jsHeapUsedBytes, optimized.page.page.jsHeapUsedBytes)}，Electron RSS 变化 ${formatChange(electron.page.appMetrics.workingSetKb, optimized.page.appMetrics.workingSetKb)}，CPU 样本变化 ${formatChange(electron.page.appMetrics.cpuPercent, optimized.page.appMetrics.cpuPercent)}。`);
	rows.push("");
	rows.push("## Tauri 热点渲染开销");
	rows.push("");
	rows.push(metricTable([
		["场景", "优化前 rows", "优化后 rows", "rows 下降", "优化前 DOM", "优化后 DOM", "DOM 下降", "CPU ms 变化", "Wall ms 变化"],
		["队列面板 240 首", baselineRender.queuePanel.rowCount, optimizedRender.queuePanel.rowCount, formatDrop(baselineRender.queuePanel.rowCount, optimizedRender.queuePanel.rowCount), baselineRender.queuePanel.nodeCount, optimizedRender.queuePanel.nodeCount, formatDrop(baselineRender.queuePanel.nodeCount, optimizedRender.queuePanel.nodeCount), formatChange(baselineRender.queuePanel.cpuMs, optimizedRender.queuePanel.cpuMs), formatChange(baselineRender.queuePanel.wallMs, optimizedRender.queuePanel.wallMs)],
		["歌单详情 600 首", baselineRender.playlistDetail.rowCount, optimizedRender.playlistDetail.rowCount, formatDrop(baselineRender.playlistDetail.rowCount, optimizedRender.playlistDetail.rowCount), baselineRender.playlistDetail.nodeCount, optimizedRender.playlistDetail.nodeCount, formatDrop(baselineRender.playlistDetail.nodeCount, optimizedRender.playlistDetail.nodeCount), formatChange(baselineRender.playlistDetail.cpuMs, optimizedRender.playlistDetail.cpuMs), formatChange(baselineRender.playlistDetail.wallMs, optimizedRender.playlistDetail.wallMs)],
		["播客集合 180 个", baselineRender.podcastCollections.rowCount, optimizedRender.podcastCollections.rowCount, formatDrop(baselineRender.podcastCollections.rowCount, optimizedRender.podcastCollections.rowCount), baselineRender.podcastCollections.nodeCount, optimizedRender.podcastCollections.nodeCount, formatDrop(baselineRender.podcastCollections.nodeCount, optimizedRender.podcastCollections.nodeCount), formatChange(baselineRender.podcastCollections.cpuMs, optimizedRender.podcastCollections.cpuMs), formatChange(baselineRender.podcastCollections.wallMs, optimizedRender.podcastCollections.wallMs)],
		["迷你队列 240 首", baselineRender.miniQueue.rowCount, optimizedRender.miniQueue.rowCount, formatDrop(baselineRender.miniQueue.rowCount, optimizedRender.miniQueue.rowCount), baselineRender.miniQueue.nodeCount, optimizedRender.miniQueue.nodeCount, formatDrop(baselineRender.miniQueue.nodeCount, optimizedRender.miniQueue.nodeCount), formatChange(baselineRender.miniQueue.cpuMs, optimizedRender.miniQueue.cpuMs), formatChange(baselineRender.miniQueue.wallMs, optimizedRender.miniQueue.wallMs)],
		["歌词视图 240 行", baselineRender.lyricView.rowCount, optimizedRender.lyricView.rowCount, formatDrop(baselineRender.lyricView.rowCount, optimizedRender.lyricView.rowCount), baselineRender.lyricView.nodeCount, optimizedRender.lyricView.nodeCount, formatDrop(baselineRender.lyricView.nodeCount, optimizedRender.lyricView.nodeCount), formatChange(baselineRender.lyricView.cpuMs, optimizedRender.lyricView.cpuMs), formatChange(baselineRender.lyricView.wallMs, optimizedRender.lyricView.wallMs)],
		["搜索结果 180 首", baselineRender.searchResults.rowCount, optimizedRender.searchResults.rowCount, formatDrop(baselineRender.searchResults.rowCount, optimizedRender.searchResults.rowCount), baselineRender.searchResults.nodeCount, optimizedRender.searchResults.nodeCount, formatDrop(baselineRender.searchResults.nodeCount, optimizedRender.searchResults.nodeCount), formatChange(baselineRender.searchResults.cpuMs, optimizedRender.searchResults.cpuMs), formatChange(baselineRender.searchResults.wallMs, optimizedRender.searchResults.wallMs)],
	]));
	rows.push("");
	rows.push("## Depth / 轮询 / 构建产物");
	rows.push("");
	rows.push(metricTable([
		["指标", "优化前", "优化后", "变化"],
		["depth 热路径新增大 Float32Array 次数", baselineRender.coverDepthBuild.largeFloat32Allocations, optimizedRender.coverDepthBuild.largeFloat32Allocations, formatDrop(baselineRender.coverDepthBuild.largeFloat32Allocations, optimizedRender.coverDepthBuild.largeFloat32Allocations)],
		["depth 热路径新增大 Float32Array MiB", formatNumber(bytesToMiB(baselineRender.coverDepthBuild.largeFloat32Bytes), 2), formatNumber(bytesToMiB(optimizedRender.coverDepthBuild.largeFloat32Bytes), 2), formatDrop(baselineRender.coverDepthBuild.largeFloat32Bytes, optimizedRender.coverDepthBuild.largeFloat32Bytes)],
		["隐藏稳定 sidecar 轮询间隔 ms", baseline.derived.sidecarHiddenPollMs || 24000, optimized.derived.sidecarHiddenPollMs, `${formatNumber(((optimized.derived.sidecarHiddenPollMs / (baseline.derived.sidecarHiddenPollMs || 24000)) - 1) * 100, 1)}% 间隔`],
		["隐藏稳定 sidecar 轮询频率", formatNumber(60000 / (baseline.derived.sidecarHiddenPollMs || 24000), 2) + "/min", formatNumber(60000 / optimized.derived.sidecarHiddenPollMs, 2) + "/min", formatDrop(60000 / (baseline.derived.sidecarHiddenPollMs || 24000), 60000 / optimized.derived.sidecarHiddenPollMs)],
		["前端产物总 MiB", formatNumber(bytesToMiB(baseline.dist.totalBytes), 2), formatNumber(bytesToMiB(optimized.dist.totalBytes), 2), formatChange(baseline.dist.totalBytes, optimized.dist.totalBytes)],
		["前端 JS MiB", formatNumber(bytesToMiB(baseline.dist.jsBytes), 2), formatNumber(bytesToMiB(optimized.dist.jsBytes), 2), formatChange(baseline.dist.jsBytes, optimized.dist.jsBytes)],
	]));
	rows.push("");
	rows.push("## 结论");
	rows.push("");
	rows.push(`- 当前优化版在大列表渲染上收益最明显: 队列 rows 下降 ${formatDrop(baselineRender.queuePanel.rowCount, optimizedRender.queuePanel.rowCount)}，歌单详情 rows 下降 ${formatDrop(baselineRender.playlistDetail.rowCount, optimizedRender.playlistDetail.rowCount)}，播客集合 rows 下降 ${formatDrop(baselineRender.podcastCollections.rowCount, optimizedRender.podcastCollections.rowCount)}，迷你队列 rows 下降 ${formatDrop(baselineRender.miniQueue.rowCount, optimizedRender.miniQueue.rowCount)}，歌词视图 rows 下降 ${formatDrop(baselineRender.lyricView.rowCount, optimizedRender.lyricView.rowCount)}，搜索结果 rows 下降 ${formatDrop(baselineRender.searchResults.rowCount, optimizedRender.searchResults.rowCount)}。`);
	rows.push(`- Depth 连续构建热路径新增大 scratch 分配从 ${baselineRender.coverDepthBuild.largeFloat32Allocations} 次降到 ${optimizedRender.coverDepthBuild.largeFloat32Allocations} 次，大数组新增分配下降 ${formatDrop(baselineRender.coverDepthBuild.largeFloat32Bytes, optimizedRender.coverDepthBuild.largeFloat32Bytes)}。`);
	rows.push(`- 隐藏且 ready 的 sidecar 状态轮询频率从 ${formatNumber(60000 / (baseline.derived.sidecarHiddenPollMs || 24000), 2)}/min 降到 ${formatNumber(60000 / optimized.derived.sidecarHiddenPollMs, 2)}/min，稳定后台轮询下降 ${formatDrop(60000 / (baseline.derived.sidecarHiddenPollMs || 24000), 60000 / optimized.derived.sidecarHiddenPollMs)}。`);
	rows.push("");
	rows.push("## 下一步优化方向");
	rows.push("");
	rows.push("- 将我的歌单概览页做扁平化虚拟列表，处理多平台歌单很多时的 DOM 压力。");
	rows.push("- 继续收敛 cover depth 的临时 canvas 与 ImageData 分配，优先复用归一化 canvas，避免连续切歌时触发额外 GC。");
	rows.push("- 给 AI depth 增加尺寸/来源维度的 LRU 和失败冷却，避免同封面不同 URL 参数重复估计。");
	rows.push("- 加一个 CI 可跑的轻量 perf budget，只检查 DOM rows、depth 大数组次数、关键 bundle size，避免性能回退。");
	rows.push("");
	rows.push("## 限制");
	rows.push("");
	rows.push("- 初始页面负载使用同一个 Electron 离屏窗口加载三版页面，适合比较前端页面负载，不等价于最终 Tauri/WebView2 发布包的完整桌面进程占用。");
	rows.push("- 热点渲染开销只对 Tauri 优化前后同组件同输入比较；Electron 原项目是单文件前端，无法和 React 组件做一一对应挂载量测。");
	rows.push("- CPU 样本是短窗口采样，绝对值会随机器后台负载波动，重点看同机同脚本的相对变化。");
	rows.push("");
	return `${rows.join("\n")}\n`;
}

function main() {
	ensureDir(resultRoot);
	ensureDir(docsRoot);
	ensureWorktrees();
	ensureDependencies();

	const results = { generatedAt: new Date().toISOString(), versions: {} };
	const electronVersion = versions.find((version) => version.kind === "electron");
	for (const version of versions) {
		results.versions[version.key] = {
			label: version.label,
			ref: version.ref === "HEAD" ? "HEAD" : version.ref,
			path: version.path,
			derived: collectSourceDerivedMetrics(version),
			dist: version.kind === "tauri" ? buildTauriWeb(version) : collectOriginalStaticStats(version),
		};
	}

	for (const version of versions.filter((item) => item.kind === "tauri")) {
		results.versions[version.key].render = runTauriRenderBenchmark(version);
	}

	const pageTargets = [
		{
			key: "electron-original",
			kind: "electron-original",
			root: versions[0].path,
			preload: path.join(versions[0].path, "desktop", "preload.js"),
			settleMs: 5000,
		},
		{
			key: "tauri-baseline",
			kind: "static-dir",
			root: path.join(versions[1].path, "apps", "web", "dist"),
			settleMs: 5000,
		},
		{
			key: "tauri-optimized",
			kind: "static-dir",
			root: path.join(versions[2].path, "apps", "web", "dist"),
			settleMs: 5000,
		},
	];
	for (const target of pageTargets) {
		results.versions[target.key].page = runElectronPageMetric(electronVersion, target);
	}

	const jsonPath = path.join(resultRoot, "perf-overhead-comparison.json");
	const reportPath = path.join(docsRoot, "performance-overhead-comparison.md");
	writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf8");
	writeFileSync(reportPath, buildReport(results), "utf8");
	console.log(`Wrote ${jsonPath}`);
	console.log(`Wrote ${reportPath}`);
}

main();

import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type {
	WallpaperEngineRuntimePort,
	WallpaperProjectSummary,
	WallpaperRuntimeState,
} from "../../ports/wallpaper-engine-runtime-port";
import { type WallpaperEngineRuntimeController, useWallpaperEngineRuntime } from "./useWallpaperEngineRuntime";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

const project = (id: string): WallpaperProjectSummary => ({
	id, title: id, projectType: "image", mediaType: "image", playable: true, enginePlayable: false,
	previewOnly: false, safetyMode: "directMedia", source: "imported", sourceLabel: "test",
	hasPreview: true, previewAnimated: false, updatedAt: 1, mediaUrl: `mineradio-media://${id}/media`,
});
const runtime = (): WallpaperRuntimeState => ({
	available: true, phase: "idle", pending: false, active: false, projectId: "", sessionId: "",
	sourceId: "", captureMode: "none", sourceWindowAligned: false, dwmSurfaceReady: false,
	glassSamplerReady: false, audioMuted: false, cleanupRequired: false, fullDesktopMode: "disabled",
});

test("wallpaper controller discards stale refresh after a newer project selection", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const stale = deferred<{ projects: WallpaperProjectSummary[]; roots: []; updatedAt: number }>();
	let loads = 0;
	const port: WallpaperEngineRuntimePort = {
		listProjects: async () => {
			loads += 1;
			return loads === 1 ? { projects: [project("old")], roots: [], updatedAt: 1 } : stale.promise;
		},
		getProjectDetails: async (id) => project(id),
		chooseDirectory: async () => ({ ok: true, canceled: true }), chooseProjectFile: async () => ({ ok: true, canceled: true }),
		removeDirectory: async () => ({ projects: [], roots: [], updatedAt: 1 }), getRuntimeStatus: async () => runtime(),
		startScene: async () => runtime(), stopScene: async () => runtime(), recover: async () => runtime(),
	};
	const controllerRef: { current: WallpaperEngineRuntimeController | null } = { current: null };
	function Harness() { controllerRef.current = useWallpaperEngineRuntime(port); return null; }
	const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
	await act(async () => { root.render(React.createElement(Harness)); await Promise.resolve(); });
	await act(async () => { void controllerRef.current!.refresh(true); await Promise.resolve(); });
	await act(async () => { await controllerRef.current!.select("new"); });
	stale.resolve({ projects: [project("old")], roots: [], updatedAt: 2 });
	await act(async () => { await Promise.resolve(); await Promise.resolve(); });

	expect(controllerRef.current?.selected?.id).toBe("new");
	await act(async () => root.unmount()); host.remove();
});

test("passive desktop gate rejects when the exact scene did not stop", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const active = { ...runtime(), phase: "active" as const, active: true, sessionId: "a".repeat(24) };
	const cleanupRequired = {
		...active,
		phase: "cleanupRequired" as const,
		cleanupRequired: true,
	};
	let stopRequest: { sessionId?: string } | undefined;
	const port: WallpaperEngineRuntimePort = {
		listProjects: async () => ({ projects: [], roots: [], updatedAt: 1 }),
		getProjectDetails: async () => null,
		chooseDirectory: async () => ({ ok: true, canceled: true }),
		chooseProjectFile: async () => ({ ok: true, canceled: true }),
		removeDirectory: async () => ({ projects: [], roots: [], updatedAt: 1 }),
		getRuntimeStatus: async () => active,
		startScene: async () => active,
		stopScene: async (request) => {
			stopRequest = request;
			return cleanupRequired;
		},
		recover: async () => cleanupRequired,
	};
	const controllerRef: { current: WallpaperEngineRuntimeController | null } = { current: null };
	function Harness() { controllerRef.current = useWallpaperEngineRuntime(port); return null; }
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => { root.render(React.createElement(Harness)); await Promise.resolve(); });
	await act(async () => { await Promise.resolve(); await Promise.resolve(); });

	let failure: unknown;
	await act(async () => {
		try {
			await controllerRef.current!.preparePassiveFallback();
		} catch (cause) {
			failure = cause;
		}
	});

	expect(stopRequest).toEqual({ sessionId: "a".repeat(24) });
	expect(String(failure)).toContain("已阻止进入被动桌面");
	expect(controllerRef.current?.runtime?.cleanupRequired).toBe(true);
	await act(async () => root.unmount());
	host.remove();
});

test("wallpaper controller restores the persisted project selection from the current library", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.setItem("mineradio.wallpaper-engine.selection.v1", "kept");
	const kept = project("kept");
	const port: WallpaperEngineRuntimePort = {
		listProjects: async () => ({ projects: [kept], roots: [], updatedAt: 1 }),
		getProjectDetails: async (id) => id === kept.id ? kept : null,
		chooseDirectory: async () => ({ ok: true, canceled: true }),
		chooseProjectFile: async () => ({ ok: true, canceled: true }),
		removeDirectory: async () => ({ projects: [kept], roots: [], updatedAt: 1 }),
		getRuntimeStatus: async () => runtime(),
		startScene: async () => runtime(),
		stopScene: async () => runtime(),
		recover: async () => runtime(),
	};
	const controllerRef: { current: WallpaperEngineRuntimeController | null } = { current: null };
	function Harness() { controllerRef.current = useWallpaperEngineRuntime(port); return null; }
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(controllerRef.current?.selected?.id).toBe("kept");
	await act(async () => root.unmount());
	host.remove();
	localStorage.removeItem("mineradio.wallpaper-engine.selection.v1");
});

test("wallpaper selection becomes visible only after canonical preference commit", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	const selectedProject = project("canonical");
	const commit = deferred<void>();
	const persisted: Array<string | null> = [];
	const port: WallpaperEngineRuntimePort = {
		listProjects: async () => ({ projects: [selectedProject], roots: [], updatedAt: 1 }),
		getProjectDetails: async () => selectedProject,
		chooseDirectory: async () => ({ ok: true, canceled: true }),
		chooseProjectFile: async () => ({ ok: true, canceled: true }),
		removeDirectory: async () => ({ projects: [], roots: [], updatedAt: 1 }),
		getRuntimeStatus: async () => runtime(),
		startScene: async () => runtime(),
		stopScene: async () => runtime(),
		recover: async () => runtime(),
	};
	const controllerRef: { current: WallpaperEngineRuntimeController | null } = { current: null };
	function Harness() {
		controllerRef.current = useWallpaperEngineRuntime(port, {
			initialSelection: null,
			persistSelection: async (projectId) => {
				persisted.push(projectId);
				await commit.promise;
			},
		});
		return null;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});

	let selection: Promise<void> = Promise.resolve();
	await act(async () => {
		selection = controllerRef.current!.select("canonical");
		await Promise.resolve();
	});
	expect(persisted).toEqual(["canonical"]);
	expect(controllerRef.current?.selected).toBeNull();
	expect(localStorage.getItem("mineradio.wallpaper-engine.selection.v1")).toBeNull();
	commit.resolve(undefined);
	await act(async () => selection);
	expect(controllerRef.current?.selected?.id).toBe("canonical");

	await act(async () => root.unmount());
	host.remove();
});

test("a transient library miss hides the selection without erasing its persisted intent", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.setItem("mineradio.wallpaper-engine.selection.v1", "kept");
	const kept = project("kept");
	let scan = 0;
	const port: WallpaperEngineRuntimePort = {
		listProjects: async () => {
			scan += 1;
			return { projects: scan === 2 ? [] : [kept], roots: [], updatedAt: scan };
		},
		getProjectDetails: async () => kept,
		chooseDirectory: async () => ({ ok: true, canceled: true }),
		chooseProjectFile: async () => ({ ok: true, canceled: true }),
		removeDirectory: async () => ({ projects: [], roots: [], updatedAt: 1 }),
		getRuntimeStatus: async () => runtime(),
		startScene: async () => runtime(),
		stopScene: async () => runtime(),
		recover: async () => runtime(),
	};
	const controllerRef: { current: WallpaperEngineRuntimeController | null } = { current: null };
	function Harness() { controllerRef.current = useWallpaperEngineRuntime(port); return null; }
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});
	expect(controllerRef.current?.selected?.id).toBe("kept");

	await act(async () => { await controllerRef.current!.refresh(true); });
	expect(controllerRef.current?.selected).toBeNull();
	expect(localStorage.getItem("mineradio.wallpaper-engine.selection.v1")).toBe("kept");
	await act(async () => { await controllerRef.current!.refresh(true); });
	expect(controllerRef.current?.selected?.id).toBe("kept");
	await act(async () => { await controllerRef.current!.removeDirectory("root"); });
	expect(controllerRef.current?.selected).toBeNull();
	expect(localStorage.getItem("mineradio.wallpaper-engine.selection.v1")).toBeNull();

	await act(async () => root.unmount());
	host.remove();
	localStorage.removeItem("mineradio.wallpaper-engine.selection.v1");
});

test("restoring a window refreshes native state and creates a new Scene session for the previous running intent", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.removeItem("mineradio.wallpaper-engine.selection.v1");
	const scene: WallpaperProjectSummary = {
		...project("scene"),
		projectType: "scene",
		mediaType: undefined,
		playable: true,
		enginePlayable: true,
		safetyMode: "nativeEngine",
	};
	let nativeRuntime = runtime();
	let startCalls = 0;
	const statusRequests: Array<{ refresh?: boolean } | undefined> = [];
	const port: WallpaperEngineRuntimePort = {
		listProjects: async () => ({ projects: [scene], roots: [], updatedAt: 1 }),
		getProjectDetails: async (id) => id === scene.id ? scene : null,
		chooseDirectory: async () => ({ ok: true, canceled: true }),
		chooseProjectFile: async () => ({ ok: true, canceled: true }),
		removeDirectory: async () => ({ projects: [scene], roots: [], updatedAt: 1 }),
		getRuntimeStatus: async (request) => {
			statusRequests.push(request);
			return nativeRuntime;
		},
		startScene: async () => {
			startCalls += 1;
			nativeRuntime = {
				...runtime(),
				phase: "active",
				active: true,
				projectId: scene.id,
				sessionId: String(startCalls).repeat(24),
			};
			return nativeRuntime;
		},
		stopScene: async () => runtime(),
		recover: async () => runtime(),
	};
	const controllerRef: { current: WallpaperEngineRuntimeController | null } = { current: null };
	function Harness({ visible, minimized }: { visible: boolean; minimized: boolean }) {
		controllerRef.current = useWallpaperEngineRuntime(port, {
			windowState: { isVisible: visible, isMinimized: minimized },
		});
		return null;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(<Harness visible={true} minimized={false} />);
		await Promise.resolve();
		await Promise.resolve();
	});
	await act(async () => { await controllerRef.current!.select(scene.id); });
	await act(async () => { await controllerRef.current!.startScene(); });
	expect(startCalls).toBe(1);
	// 模拟 Native 在窗口状态事件前已经停止 Scene，Web 不得因刷新到 idle 而丢失用户运行意图。
	nativeRuntime = runtime();
	await act(async () => { await controllerRef.current!.refresh(true); });
	expect(controllerRef.current?.runtime?.active).toBe(false);
	const refreshStatusCountBeforeRestore = statusRequests.filter((request) => request?.refresh === true).length;

	await act(async () => {
		root.render(<Harness visible={false} minimized={true} />);
		await Promise.resolve();
	});
	await act(async () => {
		root.render(<Harness visible={true} minimized={false} />);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(statusRequests.filter((request) => request?.refresh === true).length).toBe(refreshStatusCountBeforeRestore + 1);
	expect(startCalls).toBe(2);
	expect(controllerRef.current?.runtime?.sessionId).toBe("2".repeat(24));
	await act(async () => { await controllerRef.current!.stopScene(); });
	await act(async () => {
		root.render(<Harness visible={false} minimized={true} />);
		await Promise.resolve();
		root.render(<Harness visible={true} minimized={false} />);
		await Promise.resolve();
		await Promise.resolve();
	});
	expect(startCalls).toBe(2);
	await act(async () => root.unmount());
	host.remove();
	localStorage.removeItem("mineradio.wallpaper-engine.selection.v1");
});

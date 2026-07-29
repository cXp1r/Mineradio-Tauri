import { useCallback, useEffect, useRef, useState } from "react";
import type {
	WallpaperEngineRuntimePort,
	WallpaperLibrarySnapshot,
	WallpaperProjectSummary,
	WallpaperRuntimeState,
} from "../../ports/wallpaper-engine-runtime-port";
import type { DesktopWindowState } from "../../ports/desktop-runtime-port";
import { createDesktopRequestGuard } from "../desktop/desktop-request-guard";

const WALLPAPER_SELECTION_STORAGE_KEY = "mineradio.wallpaper-engine.selection.v1";

function readPersistedSelection(): string | null {
	try {
		const value = globalThis.localStorage?.getItem(WALLPAPER_SELECTION_STORAGE_KEY)?.trim();
		return value || null;
	} catch {
		return null;
	}
}

function writePersistedSelection(projectId: string | null): void {
	try {
		if (projectId) globalThis.localStorage?.setItem(WALLPAPER_SELECTION_STORAGE_KEY, projectId);
		else globalThis.localStorage?.removeItem(WALLPAPER_SELECTION_STORAGE_KEY);
	} catch {
		// 隐私模式或存储不可用不应阻断 Wallpaper Engine 运行。
	}
}

export interface WallpaperEngineRuntimeController {
	library: WallpaperLibrarySnapshot | null;
	selected: WallpaperProjectSummary | null;
	runtime: WallpaperRuntimeState | null;
	busy: boolean;
	error: string | null;
	refresh(force?: boolean): Promise<void>;
	select(projectId: string): Promise<void>;
	importDirectory(): Promise<void>;
	importProjectFile(): Promise<void>;
	removeDirectory(rootId: string): Promise<void>;
	startScene(): Promise<void>;
	stopScene(): Promise<void>;
	recover(): Promise<void>;
	preparePassiveFallback(): Promise<void>;
}

export interface WallpaperEngineRuntimeOptions {
	windowState?: Pick<DesktopWindowState, "isVisible" | "isMinimized"> | null;
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function useWallpaperEngineRuntime(
	port: WallpaperEngineRuntimePort,
	options: WallpaperEngineRuntimeOptions = {},
): WallpaperEngineRuntimeController {
	const [library, setLibrary] = useState<WallpaperLibrarySnapshot | null>(null);
	const [selected, setSelected] = useState<WallpaperProjectSummary | null>(null);
	const [runtime, setRuntime] = useState<WallpaperRuntimeState | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const guardRef = useRef(createDesktopRequestGuard());
	const busyRef = useRef(false);
	const selectedRef = useRef<WallpaperProjectSummary | null>(null);
	const preferredProjectIdRef = useRef(readPersistedSelection());
	const activeSessionRef = useRef<string | null>(null);
	const resumeSceneOnRestoreRef = useRef(false);
	const windowAvailableRef = useRef<boolean | null>(null);
	const restorePendingRef = useRef(false);
	useEffect(() => {
		activeSessionRef.current = runtime?.active && runtime.sessionId ? runtime.sessionId : null;
	}, [runtime?.active, runtime?.sessionId]);
	useEffect(() => () => {
		const sessionId = activeSessionRef.current;
		if (sessionId) void port.stopScene({ sessionId });
	}, [port]);
	const applyVisibleSelection = useCallback((project: WallpaperProjectSummary | null) => {
		selectedRef.current = project;
		setSelected(project);
	}, []);
	const commitSelection = useCallback((project: WallpaperProjectSummary | null) => {
		applyVisibleSelection(project);
		preferredProjectIdRef.current = project?.id ?? null;
		writePersistedSelection(project?.id ?? null);
	}, [applyVisibleSelection]);

	const windowVisible = options.windowState?.isVisible;
	const windowMinimized = options.windowState?.isMinimized;
	useEffect(() => {
		if (typeof windowVisible !== "boolean" || typeof windowMinimized !== "boolean") return;
		const available = windowVisible && !windowMinimized;
		const previous = windowAvailableRef.current;
		windowAvailableRef.current = available;
		if (previous === true && !available) {
			// Native 可能先完成 stop，再发出窗口隐藏状态；保留已确认的用户运行意图，不能被旧/新快照时序清掉。
			if (activeSessionRef.current !== null) resumeSceneOnRestoreRef.current = true;
			return;
		}
		if (previous === false && available) restorePendingRef.current = true;
		if (!available || !restorePendingRef.current || busyRef.current) return;
		restorePendingRef.current = false;

		const generation = guardRef.current.begin();
		void (async () => {
			try {
				const reconciled = await port.getRuntimeStatus({ refresh: true });
				if (!guardRef.current.isCurrent(generation) || windowAvailableRef.current !== true) return;
				setRuntime(reconciled);
				if (
					!resumeSceneOnRestoreRef.current
					|| reconciled.active
					|| reconciled.cleanupRequired
					|| reconciled.fullDesktopMode === "passive"
				) return;
				const project = selectedRef.current;
				if (!project?.enginePlayable) {
					resumeSceneOnRestoreRef.current = false;
					return;
				}
				const restarted = await port.startScene({ projectId: project.id });
				if (!guardRef.current.isCurrent(generation) || windowAvailableRef.current !== true) return;
				setRuntime(restarted);
				resumeSceneOnRestoreRef.current = restarted.active;
				setError(null);
			} catch (cause) {
				if (guardRef.current.isCurrent(generation)) setError(message(cause));
			}
		})();
	}, [busy, port, windowMinimized, windowVisible]);

	const refresh = useCallback(async (force = false) => {
		if (busyRef.current) return;
		const generation = guardRef.current.begin();
		try {
			const [nextLibrary, nextRuntime] = await Promise.all([
				port.listProjects({ forceRefresh: force }),
				port.getRuntimeStatus({ refresh: force }),
			]);
			if (!guardRef.current.isCurrent(generation)) return;
			setLibrary(nextLibrary);
			setRuntime(nextRuntime);
			const preferredProjectId = selectedRef.current?.id ?? preferredProjectIdRef.current;
			const nextSelected = preferredProjectId
				? nextLibrary.projects.find((project) => project.id === preferredProjectId) ?? null
				: null;
			applyVisibleSelection(nextSelected);
			setError(null);
		} catch (cause) {
			if (guardRef.current.isCurrent(generation)) setError(message(cause));
		}
	}, [applyVisibleSelection, port]);

	useEffect(() => {
		guardRef.current.dispose();
		guardRef.current = createDesktopRequestGuard();
		busyRef.current = false;
		setBusy(false);
		setLibrary(null);
		setSelected(null);
		selectedRef.current = null;
		restorePendingRef.current = false;
		setRuntime(null);
		setError(null);
		void refresh();
		return () => guardRef.current.dispose();
	}, [refresh]);

	const mutate = useCallback(async (
		operation: () => Promise<{
			library?: WallpaperLibrarySnapshot;
			runtime?: WallpaperRuntimeState;
			selected?: WallpaperProjectSummary;
			clearSelection?: boolean;
		}>,
	) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		const generation = guardRef.current.begin();
		try {
			const result = await operation();
			if (!guardRef.current.isCurrent(generation)) return;
			if (result.library) {
				setLibrary(result.library);
				const currentId = selectedRef.current?.id ?? preferredProjectIdRef.current;
				const visibleSelection = currentId
					? result.library.projects.find((project) => project.id === currentId) ?? null
					: null;
				applyVisibleSelection(visibleSelection);
			}
			if (result.runtime) setRuntime(result.runtime);
			if (result.selected) commitSelection(result.selected);
			if (result.clearSelection) commitSelection(null);
			setError(null);
		} catch (cause) {
			if (guardRef.current.isCurrent(generation)) setError(message(cause));
		} finally {
			busyRef.current = false;
			if (guardRef.current.isCurrent(generation)) setBusy(false);
		}
	}, [applyVisibleSelection, commitSelection]);

	const select = useCallback((projectId: string) => mutate(async () => {
		const detail = await port.getProjectDetails(projectId);
		if (!detail) throw new Error("所选 Wallpaper Engine 项目已不存在");
		return { selected: detail };
	}), [mutate, port]);

	const importDirectory = useCallback(() => mutate(async () => {
		const result = await port.chooseDirectory();
		if (result.canceled) return {};
		return { library: await port.listProjects({ forceRefresh: true }) };
	}), [mutate, port]);
	const importProjectFile = useCallback(() => mutate(async () => {
		const result = await port.chooseProjectFile();
		if (result.canceled) return {};
		return { library: await port.listProjects({ forceRefresh: true }) };
	}), [mutate, port]);
	const removeDirectory = useCallback((rootId: string) => mutate(async () => {
		const nextLibrary = await port.removeDirectory(rootId);
		const preferredProjectId = selectedRef.current?.id ?? preferredProjectIdRef.current;
		return {
			library: nextLibrary,
			clearSelection: !!preferredProjectId
				&& !nextLibrary.projects.some((project) => project.id === preferredProjectId),
		};
	}), [mutate, port]);
	const startScene = useCallback(() => mutate(async () => {
		if (!selected?.enginePlayable) throw new Error("当前项目不能由 Wallpaper Engine 启动");
		const started = await port.startScene({ projectId: selected.id });
		resumeSceneOnRestoreRef.current = started.active;
		return { runtime: started };
	}), [mutate, port, selected]);
	const stopScene = useCallback(() => mutate(async () => {
		resumeSceneOnRestoreRef.current = false;
		return {
			runtime: await port.stopScene(runtime?.sessionId ? { sessionId: runtime.sessionId } : {}),
		};
	}), [mutate, port, runtime?.sessionId]);
	const recover = useCallback(() => mutate(async () => ({ runtime: await port.recover() })), [mutate, port]);
	const preparePassiveFallback = useCallback(async () => {
		if (!runtime?.active) return;
		resumeSceneOnRestoreRef.current = false;
		const stopped = await port.stopScene(runtime.sessionId ? { sessionId: runtime.sessionId } : {});
		setRuntime(stopped);
		if (stopped.active || stopped.cleanupRequired) {
			throw new Error("Wallpaper Engine Scene 未确认停止，已阻止进入被动桌面");
		}
	}, [port, runtime]);

	return {
		library, selected, runtime, busy, error, refresh, select, importDirectory, importProjectFile,
		removeDirectory, startScene, stopScene, recover, preparePassiveFallback,
	};
}

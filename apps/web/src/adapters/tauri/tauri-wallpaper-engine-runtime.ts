import type {
	WallpaperEngineRuntimePort,
} from "../../ports/wallpaper-engine-runtime-port";
import {
	chooseWallpaperEngineDirectory,
	chooseWallpaperEngineProjectFile,
	getWallpaperEngineProjectDetails,
	getWallpaperEngineRuntimeStatus,
	listWallpaperEngineProjects,
	recoverWallpaperEngineRuntime,
	removeWallpaperEngineDirectory,
	startWallpaperEngineScene,
	stopWallpaperEngineScene,
} from "../../tauri/runtime";

export interface TauriWallpaperEngineRuntimeDependencies {
	listWallpaperEngineProjects: typeof listWallpaperEngineProjects;
	getWallpaperEngineProjectDetails: typeof getWallpaperEngineProjectDetails;
	chooseWallpaperEngineDirectory: typeof chooseWallpaperEngineDirectory;
	chooseWallpaperEngineProjectFile: typeof chooseWallpaperEngineProjectFile;
	removeWallpaperEngineDirectory: typeof removeWallpaperEngineDirectory;
	getWallpaperEngineRuntimeStatus: typeof getWallpaperEngineRuntimeStatus;
	startWallpaperEngineScene: typeof startWallpaperEngineScene;
	stopWallpaperEngineScene: typeof stopWallpaperEngineScene;
	recoverWallpaperEngineRuntime: typeof recoverWallpaperEngineRuntime;
}

const defaultDependencies: TauriWallpaperEngineRuntimeDependencies = {
	listWallpaperEngineProjects,
	getWallpaperEngineProjectDetails,
	chooseWallpaperEngineDirectory,
	chooseWallpaperEngineProjectFile,
	removeWallpaperEngineDirectory,
	getWallpaperEngineRuntimeStatus,
	startWallpaperEngineScene,
	stopWallpaperEngineScene,
	recoverWallpaperEngineRuntime,
};

export function createTauriWallpaperEngineRuntime(
	dependencies: TauriWallpaperEngineRuntimeDependencies = defaultDependencies,
): WallpaperEngineRuntimePort {
	return {
		listProjects: (request) => dependencies.listWallpaperEngineProjects(request),
		getProjectDetails: (id) => dependencies.getWallpaperEngineProjectDetails(id),
		chooseDirectory: () => dependencies.chooseWallpaperEngineDirectory(),
		chooseProjectFile: () => dependencies.chooseWallpaperEngineProjectFile(),
		removeDirectory: (rootId) => dependencies.removeWallpaperEngineDirectory(rootId),
		getRuntimeStatus: (request) => dependencies.getWallpaperEngineRuntimeStatus(request),
		startScene: (request) => dependencies.startWallpaperEngineScene(request),
		stopScene: (request) => dependencies.stopWallpaperEngineScene(request),
		recover: () => dependencies.recoverWallpaperEngineRuntime(),
	};
}

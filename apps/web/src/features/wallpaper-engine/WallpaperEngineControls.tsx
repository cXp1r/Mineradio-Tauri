import type { WallpaperFullDesktopMode } from "../../ports/wallpaper-engine-runtime-port";
import { resolveWallpaperPresentation } from "./wallpaper-engine-presentation";
import { wallpaperEngineMediaUrl } from "./wallpaper-engine-media-url";
import type { WallpaperEngineRuntimeController } from "./useWallpaperEngineRuntime";

/** Wallpaper Engine 控件与设置搜索共用的唯一文案目录。 */
export const WALLPAPER_ENGINE_CONTROL_DEFINITIONS = Object.freeze({
	sectionLabel: "Wallpaper Engine",
	actions: Object.freeze({
		refreshLibrary: "刷新库",
		importDirectory: "导入目录",
		importProject: "导入项目",
		removeDirectory: "移除目录",
		recover: "恢复 Native 清理",
		startScene: "启动 Scene",
		stopScene: "停止 Scene",
	}),
	libraryLabel: "Wallpaper Engine 库",
	projectsLabel: "Wallpaper Engine 项目",
	rootsLabel: "已导入目录",
	statusLabel: "Wallpaper Engine 状态",
	facts: Object.freeze({ presentation: "呈现", capture: "捕获", mute: "静音" }),
});

export const WALLPAPER_ENGINE_SETTINGS_SEARCH_TERMS = Object.freeze([
	WALLPAPER_ENGINE_CONTROL_DEFINITIONS.sectionLabel,
	...Object.values(WALLPAPER_ENGINE_CONTROL_DEFINITIONS.actions),
	WALLPAPER_ENGINE_CONTROL_DEFINITIONS.libraryLabel,
	WALLPAPER_ENGINE_CONTROL_DEFINITIONS.projectsLabel,
	WALLPAPER_ENGINE_CONTROL_DEFINITIONS.rootsLabel,
	WALLPAPER_ENGINE_CONTROL_DEFINITIONS.statusLabel,
	...Object.values(WALLPAPER_ENGINE_CONTROL_DEFINITIONS.facts),
]);

export function WallpaperEngineControls(props: WallpaperEngineRuntimeController & {
	fullDesktopMode: WallpaperFullDesktopMode;
}) {
	const presentation = resolveWallpaperPresentation(props.selected, props.runtime, props.fullDesktopMode);
	const sceneStartable = !!props.selected?.enginePlayable && props.fullDesktopMode !== "passive";
	const staticControlPreview = props.selected?.previewMediaType === "video"
		? undefined
		: wallpaperEngineMediaUrl(props.selected?.previewUrl);
	return <div className="full-desktop-controls wallpaper-engine-controls" data-wallpaper-engine>
		<div className="fx-section-label">{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.sectionLabel}</div>
		<div className="fx-runtime-summary">
			<strong>{props.runtime?.phase ?? "等待 Native 状态"}</strong>
			<small>{props.selected ? `${props.selected.title} · ${props.selected.safetyMode}` : "尚未选择项目"}</small>
		</div>
		<div className="fx-runtime-actions">
			<button type="button" className="fx-mini-btn ghost" disabled={props.busy} onClick={() => void props.refresh(true)}>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.actions.refreshLibrary}</button>
			<button type="button" className="fx-mini-btn ghost" disabled={props.busy} onClick={() => void props.importDirectory()}>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.actions.importDirectory}</button>
			<button type="button" className="fx-mini-btn ghost" disabled={props.busy} onClick={() => void props.importProjectFile()}>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.actions.importProject}</button>
		</div>
		<div className="fx-runtime-summary" aria-label={WALLPAPER_ENGINE_CONTROL_DEFINITIONS.libraryLabel}>
			<small>{props.library ? `${props.library.projects.length} 个已注册项目` : "正在读取项目库"}</small>
			<div className="fx-seg" role="list" aria-label={WALLPAPER_ENGINE_CONTROL_DEFINITIONS.projectsLabel}>
				{props.library?.projects.slice(0, 8).map((project) => <button
					key={project.id} type="button" role="listitem"
					className={props.selected?.id === project.id ? "active" : ""}
					disabled={props.busy} onClick={() => void props.select(project.id)}
				>{project.title}</button>)}
			</div>
		</div>
		{props.library?.roots.length ? <div className="fx-runtime-actions" aria-label={WALLPAPER_ENGINE_CONTROL_DEFINITIONS.rootsLabel}>
			{props.library.roots.map((root) => <button key={root.id} type="button" className="fx-mini-btn ghost"
				disabled={props.busy} onClick={() => void props.removeDirectory(root.id)}
			>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.actions.removeDirectory} {root.label}（{root.projectCount}）</button>)}
		</div> : null}
		<div className="full-desktop-facts" aria-label={WALLPAPER_ENGINE_CONTROL_DEFINITIONS.statusLabel}>
			<div><span>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.facts.presentation}</span><strong>{presentation.kind === "scene" ? "DWM Scene" : presentation.kind === "none" ? "—" : presentation.staticFallback ? "静态预览" : "直接媒体"}</strong></div>
			<div><span>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.facts.capture}</span><strong>{props.runtime?.captureMode ?? "—"}</strong></div>
			<div><span>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.facts.mute}</span><strong>{props.runtime?.audioMuted ? "已确认" : "—"}</strong></div>
		</div>
		{staticControlPreview ? <img className="wallpaper-engine-preview" src={staticControlPreview} alt="Wallpaper Engine 静态预览" /> : null}
		{props.fullDesktopMode === "passive" ? <div className="fx-runtime-warning">被动桌面仅使用静态预览；回到普通窗口或交互桌面后需手动启动新 Scene。</div> : null}
		{props.runtime?.cleanupRequired ? <button type="button" className="fx-mini-btn fx-runtime-primary-action" disabled={props.busy} onClick={() => void props.recover()}>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.actions.recover}</button> : null}
		<div className="fx-runtime-actions">
			<button type="button" className="fx-mini-btn" disabled={props.busy || !sceneStartable} onClick={() => void props.startScene()}>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.actions.startScene}</button>
			<button type="button" className="fx-mini-btn ghost" disabled={props.busy || !props.runtime?.active} onClick={() => void props.stopScene()}>{WALLPAPER_ENGINE_CONTROL_DEFINITIONS.actions.stopScene}</button>
		</div>
		{props.runtime?.lastError ? <div className="fx-runtime-warning">{props.runtime.lastError}</div> : null}
		{props.error ? <div className="fx-runtime-warning">{props.error}</div> : null}
	</div>;
}

/** Shelf 布局、镜头和交互共用 Electron 2.0.2 的竖屏边界。 */
export function isShelfPortraitViewport(width: number, height: number): boolean {
	return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > width * 1.08;
}

export interface VirtualListWindow {
	startIndex: number;
	endIndex: number;
	paddingTop: number;
	paddingBottom: number;
	virtualized: boolean;
}

export function resolveVirtualListWindow(input: {
	itemCount: number;
	rowHeight: number;
	viewportHeight: number;
	scrollTop: number;
	overscan?: number;
	threshold?: number;
}): VirtualListWindow {
	const itemCount = Math.max(0, Math.floor(input.itemCount));
	const threshold = Math.max(1, Math.floor(input.threshold ?? 80));
	if (itemCount <= threshold) {
		return {
			startIndex: 0,
			endIndex: itemCount,
			paddingTop: 0,
			paddingBottom: 0,
			virtualized: false,
		};
	}
	const rowHeight = Math.max(1, Math.floor(input.rowHeight));
	const viewportHeight = Math.max(rowHeight, Math.floor(input.viewportHeight));
	const overscan = Math.max(0, Math.floor(input.overscan ?? 6));
	const firstVisible = Math.floor(Math.max(0, input.scrollTop) / rowHeight);
	const visibleCount = Math.ceil(viewportHeight / rowHeight);
	const startIndex = Math.max(0, firstVisible - overscan);
	const endIndex = Math.min(itemCount, firstVisible + visibleCount + overscan);
	return {
		startIndex,
		endIndex,
		paddingTop: startIndex * rowHeight,
		paddingBottom: Math.max(0, itemCount - endIndex) * rowHeight,
		virtualized: true,
	};
}

import { memo, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import type { LyricPayload } from "@mineradio/shared";
import { getLyricIndex, selectLyricIndexAtPosition } from "../../lyrics/lyric-index";
import { resolveVirtualListWindow } from "../shell/virtual-list";

export interface LyricViewProps {
	payload: LyricPayload | null;
	positionMs: number;
}

const LYRIC_ROW_HEIGHT = 34;
const LYRIC_VIEWPORT_HEIGHT = 360;
const LYRIC_VIRTUAL_THRESHOLD = 80;

function LyricViewImpl({ payload, positionMs }: LyricViewProps): ReactElement {
	const [scrollTop, setScrollTop] = useState(0);
	const lyricIndex = useMemo(() => getLyricIndex(payload), [payload]);

	const currentIndex = useMemo(
		() => selectLyricIndexAtPosition(lyricIndex, positionMs),
		[positionMs, lyricIndex],
	);

	if (lyricIndex.lines.length === 0) {
		return (
			<div className="lyric-view" data-empty="true">
				<p className="lyric-empty">no lyrics</p>
			</div>
		);
	}

	const window = resolveVirtualListWindow({
		itemCount: lyricIndex.lines.length,
		rowHeight: LYRIC_ROW_HEIGHT,
		viewportHeight: LYRIC_VIEWPORT_HEIGHT,
		scrollTop,
		threshold: LYRIC_VIRTUAL_THRESHOLD,
	});
	const visibleLines = lyricIndex.lines.slice(window.startIndex, window.endIndex);
	const virtualStyle: CSSProperties | undefined = window.virtualized
		? {
			maxHeight: LYRIC_VIEWPORT_HEIGHT,
			overflowY: "auto",
			paddingTop: window.paddingTop,
			paddingBottom: window.paddingBottom,
		}
		: undefined;

	return (
		<div className="lyric-view">
			<ul
				className="lyric-lines"
				data-virtualized={window.virtualized ? "true" : undefined}
				onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
				style={virtualStyle}
			>
				{visibleLines.map(({ line }, localIndex) => {
					const index = window.startIndex + localIndex;
					return (
					<li
						key={`${index}-${line.timeMs}`}
						className={index === currentIndex ? "lyric-line lyric-current" : "lyric-line"}
						data-index={index}
					>
						{line.text || ""}
					</li>
				);
				})}
			</ul>
		</div>
	);
}

export const LyricView = memo(LyricViewImpl);

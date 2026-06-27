import { memo, useMemo, type ReactElement } from "react";
import type { LyricPayload } from "@mineradio/shared";
import { selectCurrentIndex } from "../../lyrics/select-current-index";

export interface LyricViewProps {
	payload: LyricPayload | null;
	positionMs: number;
}

function LyricViewImpl({ payload, positionMs }: LyricViewProps): ReactElement {
	const sortedLines = useMemo(() => {
		if (!payload || payload.lines.length === 0) return null;
		return [...payload.lines].sort((a, b) => a.timeMs - b.timeMs);
	}, [payload]);

	const currentIndex = useMemo(
		() => selectCurrentIndex(positionMs, payload),
		[positionMs, payload],
	);

	if (!sortedLines || sortedLines.length === 0) {
		return (
			<div className="lyric-view" data-empty="true">
				<p className="lyric-empty">no lyrics</p>
			</div>
		);
	}

	return (
		<div className="lyric-view">
			<ul className="lyric-lines">
				{sortedLines.map((line, index) => (
					<li
						key={`${index}-${line.timeMs}`}
						className={index === currentIndex ? "lyric-line lyric-current" : "lyric-line"}
						data-index={index}
					>
						{line.text || ""}
					</li>
				))}
			</ul>
		</div>
	);
}

export const LyricView = memo(LyricViewImpl);
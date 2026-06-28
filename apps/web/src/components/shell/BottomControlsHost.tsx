import { type ReactElement } from "react";
import { PlayerConsoleHost } from "../../visual/PlayerConsoleHost";

export interface BottomControlsHostProps {
	visible: boolean;
	onReveal: () => void;
}

export function BottomControlsHost({ visible, onReveal }: BottomControlsHostProps): ReactElement {
	return (
		<>
			<button
				id="bottom-handle"
				className={visible ? "active" : ""}
				type="button"
				onClick={onReveal}
				onPointerEnter={onReveal}
				aria-label="展开播放器控制台"
				title="展开播放器控制台"
			>
				<span />
			</button>
			<PlayerConsoleHost visible={visible} onReveal={onReveal} />
		</>
	);
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderId } from "@mineradio/shared";
import type { PlaybackPort } from "../../ports/music/playback-port";
import type { SearchPort } from "../../ports/music/search-port";
import {
	SourceSwitchController,
	type SourceSwitchCommitRequest,
	type SourceSwitchPlaybackSnapshot,
} from "./source-switch-controller";

export function useSourceSwitchController({
	search,
	playback,
	getPlaybackSnapshot,
	commit,
	showToast,
}: {
	search: SearchPort | null;
	playback: PlaybackPort | null;
	getPlaybackSnapshot(): SourceSwitchPlaybackSnapshot;
	commit(request: SourceSwitchCommitRequest): boolean;
	showToast(message: string): void;
}): {
	busyProvider: ProviderId | null;
	switchSource(provider: ProviderId): Promise<void>;
	confirmSourcePlayback(): void;
	rollbackFailedSourcePlayback(): Promise<void>;
} {
	const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null);
	const controller = useMemo(
		() =>
			search && playback
				? new SourceSwitchController({
						search,
						playback,
						getPlaybackSnapshot,
						commit,
					})
				: null,
		[commit, getPlaybackSnapshot, playback, search],
	);

	useEffect(() => () => controller?.cancel(), [controller]);

	const switchSource = useCallback(
		async (provider: ProviderId) => {
			if (!controller || busyProvider) return;
			setBusyProvider(provider);
			const result = await controller.switchTo(provider);
			setBusyProvider(null);
			if (result.status === "success") {
				showToast(`已切换到 ${result.resolvedProvider === "netease" ? "网易云" : result.resolvedProvider === "qq" ? "QQ" : "汽水"}`);
				return;
			}
			if (result.status === "stale") return;
			if (result.status === "not-found") {
				showToast("没有找到严格匹配的目标音源");
				return;
			}
			showToast(result.message);
		},
		[busyProvider, controller, showToast],
	);
	const confirmSourcePlayback = useCallback(() => {
		controller?.handlePlaybackReady();
	}, [controller]);
	const rollbackFailedSourcePlayback = useCallback(async () => {
		if (await controller?.handlePlaybackFailure()) {
			showToast("目标音源加载失败，已恢复原音源");
		}
	}, [controller, showToast]);

	return {
		busyProvider,
		switchSource,
		confirmSourcePlayback,
		rollbackFailedSourcePlayback,
	};
}

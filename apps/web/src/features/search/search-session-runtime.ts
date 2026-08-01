import type { PreferencesRepository } from "../../ports/preferences-repository";
import { useSearchStore } from "../../stores/search-store";
import {
	SearchSessionController,
	type SearchSessionSnapshot,
	type SearchSessionState,
} from "./search-session-controller";

const zustandSearchSessionState: SearchSessionState = {
	getSnapshot: () => useSearchStore.getState(),
	setState: (patch: Partial<SearchSessionSnapshot>) => {
		useSearchStore.setState(patch);
	},
};

export const searchSessionController = new SearchSessionController({
	state: zustandSearchSessionState,
});

/**
 * 由应用 bootstrap 在 PreferencesRepository 准备完成后调用；搜索组件不拥有存储实现。
 */
export function configureSearchPreferences(
	preferences: Pick<PreferencesRepository, "get" | "set">,
): Promise<void> {
	searchSessionController.setPreferences(preferences);
	return searchSessionController.hydrateHistory();
}
